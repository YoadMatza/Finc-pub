import { ensureAccount, ingestBatch, openDb, runEngine, type NormalizedRow } from '@finc/core';
import { describe, expect, it } from 'vitest';
import type { WorkerState } from '../server.js';
import { createApp } from './app.js';

// wave 5: PUT / DELETE /api/transactions/:id/split (core hub/splits.ts)

const TOKEN = 'd'.repeat(64);
const HEADERS = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

function setup() {
  const db = openDb(':memory:');
  const card = ensureAccount(db, { institutionId: 'max', institutionKind: 'card', institutionDisplayName: 'Card', source: 'scraper:max', externalId: 'c', type: 'credit_card' }).accountId;
  const row: NormalizedRow = { externalAccountId: 'c', date: '2026-10-05', amount: -24000, description: 'DEMO PHARM', status: 'completed', type: 'normal', identifier: 'p1', payload: {} };
  ingestBatch(db, { source: 'scraper:max', runId: null, accountId: card, rows: [row] });
  runEngine(db);
  const vault = { locked: false, lock() {}, get: () => undefined, has: () => false, list: () => [] };
  const scheduler = { config: { times: [], jitterMinutes: 0, timezone: 'UTC', monthsBack: 3 }, isRunning: false, nextRun: () => null, syncNow: async () => [] };
  const state: WorkerState = { db, vault: vault as never, scheduler: scheduler as never, startedAt: Date.now() };
  const { app } = createApp(state, { controlToken: TOKEN, webDist: '/nonexistent' });
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await app.request(path, { ...init, headers: HEADERS });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
  };
  const id = (db.$client.prepare('select id from "transaction"').get() as { id: number }).id;
  return { call, id };
}

describe('split API', () => {
  it('saves a split by category key, returns the detail with its parts, and removes it', async () => {
    const { call, id } = setup();
    const put = await call(`/api/transactions/${id}/split`, { method: 'PUT', body: JSON.stringify({ parts: [{ category: 'daily.pharm', amount: -15000 }, { category: 'daily.home', amount: -9000 }] }) });
    expect(put.status).toBe(200);
    expect(put.body.transaction.split.map((p: { categoryKey: string; amount: number }) => [p.categoryKey, p.amount])).toEqual([['daily.pharm', -15000], ['daily.home', -9000]]);
    const list = await call('/api/transactions?month=2026-10');
    expect(list.body.items[0].split).toBe(true);
    const del = await call(`/api/transactions/${id}/split`, { method: 'DELETE' });
    expect(del.body.transaction.split).toBeNull();
  });

  it('a split that does not add up is a 400 with the reason; an unknown transaction is a 404', async () => {
    const { call, id } = setup();
    const bad = await call(`/api/transactions/${id}/split`, { method: 'PUT', body: JSON.stringify({ parts: [{ category: 'daily.pharm', amount: -15000 }, { category: 'daily.home', amount: -8000 }] }) });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/add up/);
    const missing = await call('/api/transactions/999999/split', { method: 'PUT', body: JSON.stringify({ parts: [{ category: 'daily.pharm', amount: -1 }, { category: 'daily.home', amount: -1 }] }) });
    expect(missing.status).toBe(404);
  });
});
