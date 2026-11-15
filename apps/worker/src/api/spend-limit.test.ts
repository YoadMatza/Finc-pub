import { currentMonth, ensureAccount, flushSecurityEvents, getSetting, ingestBatch, listSecurityEvents, openDb, runEngine, setSetting } from '@finc/core';
import type { NormalizedRow } from '@finc/core';
import { describe, expect, it } from 'vitest';
import type { WorkerState } from '../server.js';
import { createApp } from './app.js';

// Now screen, build step 2: the monthly spending limit on /api/settings and /api/hub. Fictional values.

const TOKEN = 'c'.repeat(64);
const HOME = { authorization: `Bearer ${TOKEN}` };
const EDGE = { 'x-finc-edge': 'public', 'x-forwarded-for': '198.51.100.42', 'x-forwarded-proto': 'https' };
const row = (date: string, amount: number, description: string): NormalizedRow => ({ externalAccountId: 'x', date, amount, description, status: 'completed', type: 'normal', identifier: `${description}${date}${amount}`, payload: {} });
const shift = (month: string, n: number) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};

function setup() {
  const db = openDb(':memory:');
  const acc = ensureAccount(db, { institutionId: 'beinleumi', institutionKind: 'bank', institutionDisplayName: 'Bank', source: 'scraper:beinleumi', externalId: 'b', type: 'checking' }).accountId;
  const month = currentMonth();
  ingestBatch(db, { source: 'scraper:beinleumi', runId: null, accountId: acc, rows: [row(`${month}-01`, 1500000, 'EMPLOYER LTD'), row(`${month}-01`, -52000, 'SUPERMARKET')] });
  runEngine(db);
  const c = db.$client;
  c.prepare(`delete from link`).run();
  c.prepare(`update "transaction" set kind = case when amount_ils > 0 then 'income' else 'expense' end, excluded = 0, recurring_stream_id = null, installment_plan_id = null, category_id = null`).run();
  const vault = { locked: false, lock() {}, get: () => undefined, has: () => false, list: () => [] };
  const state: WorkerState = { db, vault: vault as never, scheduler: { config: { times: [], jitterMinutes: 0, timezone: 'UTC', monthsBack: 3 }, isRunning: false, nextRun: () => null } as never, startedAt: Date.now() };
  const { app } = createApp(state, { controlToken: TOKEN, webDist: '/nonexistent' });
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await app.request(path, { ...init, headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) } });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
  };
  const pairOutside = async (): Promise<Record<string, string>> => {
    const code = (await call('/api/devices/pairings', { method: 'POST', headers: HOME, body: JSON.stringify({ name: 'phone' }) })).body.code as string;
    const token = (await call('/api/devices/pair', { method: 'POST', headers: EDGE, body: JSON.stringify({ code }) })).body.token as string;
    return { ...EDGE, authorization: `Bearer ${token}` };
  };
  const limitRows = () => (c.prepare(`select key, value from setting where key like 'spend.limit.%' order by key`).all() as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]);
  return { db, call, month, pairOutside, limitRows };
}

describe('spending limit API', () => {
  it('PATCH sets and clears (home and phone); GET /api/settings returns the effective limit; logged as settings.changed', async () => {
    const { db, call, month, pairOutside } = setup();
    expect((await call('/api/settings', { headers: HOME })).body.spendLimit).toEqual({ month, amount: null });
    const phone = await pairOutside();
    expect((await call('/api/settings', { method: 'PATCH', headers: phone, body: JSON.stringify({ spendLimit: { month, amount: 600000 } }) })).status).toBe(200);
    expect(getSetting(db, `spend.limit.${month}`)).toBe('600000');
    expect((await call('/api/settings', { headers: phone })).body.spendLimit).toEqual({ month, amount: 600000 });
    // a later month's value; then off from next month on removes it and writes "0"
    const next = shift(month, 1);
    expect((await call('/api/settings', { method: 'PATCH', headers: HOME, body: JSON.stringify({ spendLimit: { month: shift(month, 2), amount: 700000 } }) })).status).toBe(200);
    expect((await call('/api/settings', { method: 'PATCH', headers: HOME, body: JSON.stringify({ spendLimit: { month: next, amount: null } }) })).status).toBe(200);
    expect(getSetting(db, `spend.limit.${next}`)).toBe('0');
    expect(getSetting(db, `spend.limit.${shift(month, 2)}`)).toBeNull();
    expect((await call('/api/settings', { headers: HOME })).body.spendLimit).toEqual({ month, amount: 600000 });
    expect((await call('/api/settings', { method: 'PATCH', headers: HOME, body: JSON.stringify({ spendLimit: { month, amount: null } }) })).status).toBe(200);
    expect(getSetting(db, `spend.limit.${month}`)).toBe('0');
    expect((await call('/api/settings', { headers: HOME })).body.spendLimit).toEqual({ month, amount: null });

    flushSecurityEvents(db);
    const keys = listSecurityEvents(db, { kind: 'settings.changed' }).events.flatMap((e) => (JSON.parse(e.detail ?? '{}') as { keys?: string[] }).keys ?? []);
    expect(keys).toEqual(expect.arrayContaining([`spendLimit.${month}`, `spendLimit.${next}`]));
  });

  it('PATCH refuses a past month and bad amounts, writing nothing (not even the rest of the patch)', async () => {
    const { db, call, month, limitRows } = setup();
    setSetting(db, `spend.limit.${month}`, '500000');
    const patch = (body: unknown) => call('/api/settings', { method: 'PATCH', headers: HOME, body: JSON.stringify(body) });
    expect((await patch({ spendLimit: { month: shift(month, -1), amount: 400000 }, language: 'en' })).status).toBe(400);
    expect(getSetting(db, 'ui.language')).toBeNull();
    for (const amount of [0, -100, 12.5, 100_000_001, '600000']) expect((await patch({ spendLimit: { month, amount } })).status).toBe(400);
    expect((await patch({ spendLimit: { month: '2026-13', amount: 1000 } })).status).toBe(400);
    expect((await patch({ spendLimit: { month } })).status).toBe(400);
    expect((await patch({ spendLimit: { month, amount: 1000, extra: true } })).status).toBe(400);
    expect(limitRows()).toEqual([[`spend.limit.${month}`, '500000']]);
    expect((await patch({ spendLimit: { month, amount: 100_000_000 } })).status).toBe(200);
  });

  it('GET /api/hub carries limit (null without one, and for a future month)', async () => {
    const { call, month } = setup();
    expect((await call('/api/hub', { headers: HOME })).body.limit).toBeNull();
    await call('/api/settings', { method: 'PATCH', headers: HOME, body: JSON.stringify({ spendLimit: { month, amount: 600000 } }) });
    const b = (await call('/api/hub', { headers: HOME })).body;
    expect(Object.keys(b.limit).sort()).toEqual(['amount', 'leftWithin', 'over', 'pace', 'spent', 'targets', 'usedPct', 'week']);
    expect(b.limit).toMatchObject({ amount: 600000, spent: b.forecast.variableSpent, leftWithin: 600000 - b.forecast.variableSpent, over: false, targets: null });
    expect(b.forecast.variableSpent).toBe(52000);
    expect(b.limit.usedPct).toBe(8.7); // 52,000 / 600,000
    expect(Object.keys(b.limit.pace).sort()).toEqual(['byToday', 'delta', 'state']);
    expect(['on', 'ahead', 'under']).toContain(b.limit.pace.state);
    expect(b.limit.pace.delta).toBe(52000 - b.limit.pace.byToday);
    expect(Object.keys(b.limit.week).sort()).toEqual(['limit', 'spent']);
    expect((await call(`/api/hub?month=${shift(month, 1)}`, { headers: HOME })).body.limit).toBeNull();
  });
});
