import { createEvent, ensureAccount, ingestBatch, openDb, transactions, type NormalizedRow } from '@finc/core';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { WorkerState } from '../server.js';
import { callerSafe, createApp, queryFlag } from './app.js';

// security research P3-03: smaller input-handling issues

const TOKEN = 'f'.repeat(64);
const HOME = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

function setup() {
  const db = openDb(':memory:');
  const vault = { locked: false, lock() {}, get: () => undefined, has: () => false, list: () => [] };
  const scheduler = { config: { times: [], jitterMinutes: 0, timezone: 'UTC', monthsBack: 3 }, isRunning: false, nextRun: () => null, syncNow: async () => [] };
  const state: WorkerState = { db, vault: vault as never, scheduler: scheduler as never, startedAt: Date.now() };
  const { app } = createApp(state, { controlToken: TOKEN, webDist: '/nonexistent' });
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await app.request(path, { ...init, headers: { ...HOME, ...(init.headers as Record<string, string> | undefined) } });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
  };
  return { db, call };
}

describe('query flags', () => {
  it('"false" and "0" mean no; anything but the four spellings is refused', () => {
    expect(queryFlag.parse('false')).toBe(false);
    expect(queryFlag.parse('0')).toBe(false);
    expect(queryFlag.parse('true')).toBe(true);
    expect(queryFlag.parse('1')).toBe(true);
    expect(queryFlag.safeParse('yes').success).toBe(false);
  });

  it('?archived=false does not list archived events', async () => {
    const { db, call } = setup();
    const e = createEvent(db, { name: 'old trip' });
    db.$client.prepare('update event set archived = 1 where id = ?').run(e.id);
    expect((await call('/api/events?archived=false')).body).toEqual([]);
    expect(((await call('/api/events?archived=true')).body as unknown[]).length).toBe(1);
  });
});

describe('error text for the caller', () => {
  it('never shows a file path', () => {
    expect(callerSafe('no vault at /data/vault.json', 'not found')).toBe('not found');
    expect(callerSafe('no file C:\\finc\\data\\x.db', 'not found')).toBe('not found');
    expect(callerSafe('no such category: food/drink', 'not found')).toBe('no such category: food/drink');
  });
});

describe('PATCH /api/transactions/:id', () => {
  it('a refused re-tag writes nothing, not even the note sent with it', async () => {
    const { db, call } = setup();
    const acc = ensureAccount(db, { institutionId: 'max', institutionKind: 'card', institutionDisplayName: 'Max', source: 'scraper:max', externalId: 'm', type: 'credit_card' }).accountId;
    const row: NormalizedRow = { externalAccountId: 'm', date: '2026-11-01', amount: -5000, description: 'WOLT', status: 'completed', type: 'normal', identifier: 'w1', payload: {} };
    ingestBatch(db, { source: 'scraper:max', runId: null, accountId: acc, rows: [row] });
    const id = db.select().from(transactions).get()!.id;
    const r = await call(`/api/transactions/${id}`, { method: 'PATCH', body: JSON.stringify({ note: 'should not stay', incomeKind: 'regular' }) });
    expect(r.status).toBe(400);
    expect(db.select().from(transactions).where(eq(transactions.id, id)).get()?.note ?? null).toBeNull();
  });
});
