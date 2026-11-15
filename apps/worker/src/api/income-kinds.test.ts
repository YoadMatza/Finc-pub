import { ensureAccount, getSetting, ingestBatch, listSecurityEvents, flushSecurityEvents, openDb, runEngine } from '@finc/core';
import type { NormalizedRow } from '@finc/core';
import { describe, expect, it } from 'vitest';
import type { WorkerState } from '../server.js';
import { createApp } from './app.js';

// Now screen, build step 1: the income split on /api/hub, income kinds and spreadExtra on /api/settings, a
// per-payment kind on /api/transactions/:id. Fictional values.

const TOKEN = 'c'.repeat(64);
const HOME = { authorization: `Bearer ${TOKEN}` };
const EDGE = { 'x-finc-edge': 'public', 'x-forwarded-for': '198.51.100.41', 'x-forwarded-proto': 'https' };
const row = (date: string, amount: number, description: string): NormalizedRow => ({ externalAccountId: 'x', date, amount, description, status: 'completed', type: 'normal', identifier: `${description}${date}${amount}`, payload: {} });

function setup() {
  const db = openDb(':memory:');
  const acc = ensureAccount(db, { institutionId: 'beinleumi', institutionKind: 'bank', institutionDisplayName: 'Bank', source: 'scraper:beinleumi', externalId: 'b', type: 'checking' }).accountId;
  const month = new Date().toISOString().slice(0, 7);
  ingestBatch(db, { source: 'scraper:beinleumi', runId: null, accountId: acc, rows: [row(`${month}-01`, 1500000, 'EMPLOYER LTD'), row(`${month}-02`, 1164000, 'CLIENT ALPHA'), row(`${month}-03`, -52000, 'SUPERMARKET')] });
  runEngine(db);
  const c = db.$client;
  c.prepare(`delete from link`).run();
  c.prepare(`update "transaction" set kind = case when amount_ils > 0 then 'income' else 'expense' end, excluded = 0, recurring_stream_id = null, installment_plan_id = null, category_id = null`).run();
  const cat = (k: string) => (c.prepare('select id from category where key = ?').get(k) as { id: number }).id;
  c.prepare(`update "transaction" set category_id = ? where description_raw = 'EMPLOYER LTD'`).run(cat('income.salary'));
  c.prepare(`update "transaction" set category_id = ? where description_raw = 'CLIENT ALPHA'`).run(cat('income.freelance'));
  const id = (d: string) => (c.prepare('select id from "transaction" where description_raw = ?').get(d) as { id: number }).id;
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
  return { db, call, id, month, pairOutside };
}

describe('Now income split API', () => {
  it('GET /api/hub carries incomeSplit, withoutExtra, typical, spread and explain (summing to left)', async () => {
    const { call, id } = setup();
    const r = await call('/api/hub', { headers: HOME });
    expect(r.status).toBe(200);
    const b = r.body;
    expect(b.incomeSplit.regular).toEqual({ received: 1500000, expected: 0 });
    expect(b.incomeSplit.extra.received).toBe(1164000);
    expect(b.incomeSplit.extra.items).toEqual([{ id: id('CLIENT ALPHA'), name: expect.any(String), amount: 1164000, date: expect.stringMatching(/-02$/), categoryKey: 'income.freelance', status: 'received', incomeCategory: true, askPaidBack: false, canRemember: true }]);
    expect(b.incomeSplit.kinds).toMatchObject({ 'income.salary': 'regular', 'income.freelance': 'extra' });
    expect(b.withoutExtra).toEqual({ left: 1500000 - 52000, tone: 'positive' });
    expect(b.typical).toBeNull();
    expect(b.spread).toMatchObject({ extraExcluded: true, extraIncluded: false, reason: 'large_extra' });
    expect(Object.keys(b.spread).sort()).toEqual(['extraExcluded', 'extraIncluded', 'projectedAll', 'reason', 'stateRegular', 'weeklyAll', 'weeklyRegular']);
    expect(b.spread.weeklyRegular).toBe(b.forecast.weekly.envelope);
    expect(['comfortable', 'tight', 'short']).toContain(b.spread.stateRegular);
    expect(b.incomeSplit.extra.counted).toBe(1164000);
    expect(b.explain).toHaveLength(11);
    expect((b.explain as Array<{ amount: number }>).reduce((a, t) => a + t.amount, 0)).toBe(b.forecast.left);
    for (const t of b.explain as Array<Record<string, unknown>>) expect(Object.keys(t).every((k) => ['key', 'amount', 'items', 'more'].includes(k))).toBe(true);
  });

  it('PATCH /api/settings: incomeKinds and spreadExtra, from home and from outside; GET returns the effective kinds', async () => {
    const { db, call, month, pairOutside } = setup();
    expect((await call('/api/settings', { headers: HOME })).body.incomeKinds).toMatchObject({ 'income.salary': 'regular', 'income.freelance': 'extra', 'income.other': 'extra', 'income.cashback': 'extra' });
    const phone = await pairOutside();
    expect((await call('/api/settings', { method: 'PATCH', headers: phone, body: JSON.stringify({ incomeKinds: { 'income.freelance': 'regular' } }) })).status).toBe(200);
    expect(getSetting(db, 'income.kind.income.freelance')).toBe('regular');
    expect((await call('/api/settings', { headers: phone })).body.incomeKinds['income.freelance']).toBe('regular');
    let hub = (await call('/api/hub', { headers: HOME })).body;
    expect(hub.incomeSplit.regular.received).toBe(2664000);
    expect(hub.spread.reason).toBeNull();
    // back to the default
    expect((await call('/api/settings', { method: 'PATCH', headers: HOME, body: JSON.stringify({ incomeKinds: { 'income.freelance': null } }) })).status).toBe(200);
    expect(getSetting(db, 'income.kind.income.freelance')).toBeNull();

    expect((await call('/api/settings', { method: 'PATCH', headers: phone, body: JSON.stringify({ spreadExtra: { month, value: true } }) })).status).toBe(200);
    expect(getSetting(db, `spend.spreadExtra.${month}`)).toBe('true');
    hub = (await call('/api/hub', { headers: HOME })).body;
    expect(hub.spread).toMatchObject({ extraExcluded: false, extraIncluded: true, reason: 'large_extra', weeklyAll: null, projectedAll: null, stateRegular: 'comfortable' });
    await call('/api/settings', { method: 'PATCH', headers: HOME, body: JSON.stringify({ spreadExtra: { month, value: false } }) });
    expect(getSetting(db, `spend.spreadExtra.${month}`)).toBeNull();

    // recorded in the security log like every settings change
    flushSecurityEvents(db);
    const keys = listSecurityEvents(db, { kind: 'settings.changed' }).events.flatMap((e) => (JSON.parse(e.detail ?? '{}') as { keys?: string[] }).keys ?? []);
    expect(keys).toEqual(expect.arrayContaining(['incomeKinds.income.freelance', `spreadExtra.${month}`]));
  });

  it('PATCH /api/settings refuses bad kinds, non-income keys and bad months, writing nothing', async () => {
    const { db, call } = setup();
    const patch = (body: unknown) => call('/api/settings', { method: 'PATCH', headers: HOME, body: JSON.stringify(body) });
    expect((await patch({ incomeKinds: { 'income.freelance': 'sometimes' } })).status).toBe(400);
    expect((await patch({ incomeKinds: { 'income.freelance': 'regular', 'lifestyle.eating_out': 'regular' } })).status).toBe(400);
    expect(getSetting(db, 'income.kind.income.freelance')).toBeNull();
    // a non-income category used by a confirmed income stream is in the kinds map and may be tagged
    const c = db.$client;
    const catId = (c.prepare(`select id from category where key = 'lifestyle.eating_out'`).get() as { id: number }).id;
    const mer = Number(c.prepare(`insert into merchant (key, name, created_at) values ('tenant', 'Tenant', '2026-01-01')`).run().lastInsertRowid);
    c.prepare(
      `insert into recurring_stream (account_id, merchant_id, category_id, frequency, expected_amount, amount_tolerance, amount_model, expected_day, last_txn_date, occurrences, state, state_source, direction, created_at, updated_at)
       values (1, ?, ?, 'monthly', 300000, 1000, 'fixed', 5, '2026-01-05', 6, 'confirmed', 'user', 'income', '2026-01-01', '2026-01-01')`,
    ).run(mer, catId);
    expect((await call('/api/settings', { headers: HOME })).body.incomeKinds['lifestyle.eating_out']).toBe('regular');
    expect((await patch({ incomeKinds: { 'lifestyle.eating_out': 'extra' } })).status).toBe(200);
    expect(getSetting(db, 'income.kind.lifestyle.eating_out')).toBe('extra');
    expect((await patch({ spreadExtra: { month: '2026-13', value: true } })).status).toBe(400);
    expect((await patch({ spreadExtra: { month: '2026-11' } })).status).toBe(400);
  });

  it('PATCH /api/transactions/:id incomeKind: income rows only (400 otherwise), null clears; detail returns it', async () => {
    const { call, id, pairOutside } = setup();
    const phone = await pairOutside();
    const patch = (txn: number, body: unknown) => call(`/api/transactions/${txn}`, { method: 'PATCH', headers: phone, body: JSON.stringify(body) });
    const r = await patch(id('CLIENT ALPHA'), { incomeKind: 'regular' });
    expect(r.status).toBe(200);
    expect(r.body.transaction.incomeKind).toBe('regular');
    expect((await call(`/api/transactions/${id('CLIENT ALPHA')}`, { headers: HOME })).body.incomeKind).toBe('regular');
    expect((await call('/api/hub', { headers: HOME })).body.incomeSplit.regular.received).toBe(2664000);
    expect((await patch(id('SUPERMARKET'), { incomeKind: 'extra' })).status).toBe(400);
    // a refused re-tag writes nothing else of the same patch
    expect((await patch(id('CLIENT ALPHA'), { note: 'should not be written', excluded: true, incomeKind: 'extra' })).status).toBe(400);
    expect((await patch(id('CLIENT ALPHA'), { note: 'nor this', category: 'lifestyle.eating_out', incomeKind: 'extra' })).status).toBe(400);
    const after = (await call(`/api/transactions/${id('CLIENT ALPHA')}`, { headers: HOME })).body;
    expect(after).toMatchObject({ note: null, excluded: false, categoryKey: 'income.freelance', incomeKind: 'regular' });
    // a category change to a non-income one clears the re-tag
    expect((await patch(id('CLIENT ALPHA'), { category: 'lifestyle.eating_out' })).body.transaction.incomeKind).toBeNull();
    expect((await patch(id('CLIENT ALPHA'), { category: 'income.freelance', incomeKind: 'regular' })).body.transaction.incomeKind).toBe('regular');
    expect((await patch(id('CLIENT ALPHA'), { incomeKind: 'sometimes' })).status).toBe(400);
    expect((await patch(999999, { incomeKind: 'extra' })).status).toBe(404);
    const cleared = await patch(id('CLIENT ALPHA'), { incomeKind: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.transaction.incomeKind).toBeNull();
    expect((await call(`/api/transactions?bucket=income`, { headers: HOME })).body.items.every((i: { incomeKind: unknown }) => i.incomeKind === null)).toBe(true);
  });
});
