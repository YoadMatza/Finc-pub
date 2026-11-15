import { type PriceCache, type Quote, ensureAccount, openDb, recordBalance, recordHoldings } from '@finc/core';
import { describe, expect, it, vi } from 'vitest';
import type { WorkerState } from '../server.js';
import { createApp } from './app.js';

const TOKEN = 'c'.repeat(64);
const NOW = Date.parse('2026-11-11T18:00:00Z'); // Wednesday 13:00 New York, session open
const q = (symbol: string, price: number, prevClose: number, currency = 'USD'): Quote => ({ symbol, price, prevClose, currency, marketTime: NOW - 60_000, marketState: null, exchangeTz: 'America/New_York', fetchedAt: NOW - 30_000 });

function setup(prices?: WorkerState['prices']) {
  const db = openDb(':memory:');
  const sec = ensureAccount(db, { institutionId: 'beinleumi', institutionKind: 'bank', institutionDisplayName: 'FIBI', source: 'scraper:beinleumi', externalId: 'b-securities', type: 'securities' }).accountId;
  const fx = ensureAccount(db, { institutionId: 'beinleumi', institutionKind: 'bank', institutionDisplayName: 'FIBI', source: 'scraper:beinleumi', externalId: 'b-fx', type: 'foreign_currency' }).accountId;
  const takenAt = '2026-11-11T04:00:00.000Z';
  const base = { name: 'x', dailyChangePct: 0.5, fromCostPct: null };
  // fictional: 10 TEST1 bought at $50, bank priced at $55 at 3.6; $100 cash
  recordHoldings(db, { accountId: sec, runId: null, source: 't', takenAt, rows: [{ ...base, kind: 'security', symbol: 'TEST1', quantity: 10, price: 55, currency: 'USD', valueIls: 198_000, valueOrig: 550, costPrice: 50 }] });
  recordHoldings(db, { accountId: fx, runId: null, source: 't', takenAt, rows: [{ ...base, kind: 'currency', symbol: 'USD', quantity: 100, price: 3.6, currency: 'USD', valueIls: 36_000, valueOrig: 100, costPrice: null, dailyChangePct: null }] });
  recordBalance(db, { accountId: sec, runId: null, balanceMinor: 198_000, takenAt, source: 't' });
  recordBalance(db, { accountId: fx, runId: null, balanceMinor: 36_000, takenAt, source: 't' });
  const state: WorkerState = { db, vault: null, scheduler: { config: { times: [], jitterMinutes: 0, timezone: 'UTC', monthsBack: 3 }, isRunning: false, nextRun: () => null } as never, startedAt: NOW, ...(prices ? { prices } : {}) };
  const { app } = createApp(state, { controlToken: TOKEN, webDist: '/nonexistent', now: () => NOW });
  const get = async (path: string, auth = true) => {
    const res = await app.request(path, { headers: auth ? { authorization: `Bearer ${TOKEN}` } : {} });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
  };
  return { sec, fx, get };
}

describe('live prices in the API', () => {
  const cache: PriceCache = { quotes: new Map([['TEST1', q('TEST1', 60, 58)]]), fx: q('ILS=X', 3.7, 3.65, 'ILS') };

  it('GET /api/accounts/:id/holdings keeps its fields and adds live with the agreed shape', async () => {
    const demand = vi.fn(async (_o: { wait: boolean }) => undefined);
    const { sec, get } = setup({ cache: () => cache, demand });
    const r = await get(`/api/accounts/${sec}/holdings`);
    expect(r.status).toBe(200);
    expect(demand).toHaveBeenCalledWith({ wait: true });
    await get('/api/accounts');
    await get('/api/networth');
    expect(demand.mock.calls.slice(1)).toEqual([[{ wait: false }], [{ wait: false }]]); // the others never wait
    expect(r.body).toMatchObject({ accountId: sec, totalIls: 198_000, takenAt: '2026-11-11T04:00:00.000Z' });
    expect(r.body.positions).toHaveLength(1);
    expect(r.body.live).toEqual({
      asOf: new Date(NOW - 60_000).toISOString(),
      marketState: 'open',
      fx: { pair: 'USD/ILS', rate: 3.7, at: new Date(NOW - 60_000).toISOString() },
      rows: [{ id: r.body.positions[0].id, symbol: 'TEST1', source: 'live', price: 60, prevClose: 58, currency: 'USD', valueOrig: 600, valueIls: 222_000, gainOrig: 100, gainPct: 20, dayChangeOrig: 20, dayChangePct: 3.45 }],
      totalIls: 222_000,
      gainIls: 37_000,
      gainPct: 20,
      dayChangeIls: 7_400,
      dayChangePct: 3.45,
      dayChangeIncludesFx: false,
      gainBasis: 'usd_at_today_rate',
    });
    expect(typeof r.body.positions[0].id).toBe('number');
  });

  it('accounts and net worth add liveValueIls/liveAsOf on the securities and FX entries; totals unchanged', async () => {
    const withLive = setup({ cache: () => cache, demand: async () => undefined });
    const without = setup();
    const a = (await withLive.get('/api/accounts')).body.accounts as Array<Record<string, unknown>>;
    expect(a.find((x) => x.id === withLive.sec)).toMatchObject({ balance: { amount: 198_000 }, liveValueIls: 222_000, liveAsOf: new Date(NOW - 60_000).toISOString(), liveState: 'live' });
    expect(a.find((x) => x.id === withLive.fx)).toMatchObject({ balance: { amount: 36_000 }, liveValueIls: 37_000 });
    const nwLive = (await withLive.get('/api/networth')).body;
    const nwBank = (await without.get('/api/networth')).body;
    expect(nwLive.total).toBe(nwBank.total);
    expect(nwLive.assets).toBe(234_000);
    const line = (nwLive.lines as Array<Record<string, unknown>>).find((l) => l.accountId === withLive.sec);
    expect(line).toMatchObject({ value: 198_000, liveValueIls: 222_000 });
    expect((nwBank.lines as Array<Record<string, unknown>>).some((l) => 'liveValueIls' in l)).toBe(false);
  });

  it('without the price service every row is the bank one, marked unavailable', async () => {
    const { sec, get } = setup();
    const live = (await get(`/api/accounts/${sec}/holdings`)).body.live;
    expect(live).toMatchObject({ asOf: null, marketState: 'unavailable', fx: null, totalIls: 198_000, gainIls: 18_000, dayChangeIls: null });
    expect(live.rows[0]).toMatchObject({ source: 'bank', price: 55, valueIls: 198_000, dayChangePct: 0.5 });
  });

  it('needs a signed-in caller like the other routes', async () => {
    const { sec, get } = setup({ cache: () => cache, demand: async () => undefined });
    expect((await get(`/api/accounts/${sec}/holdings`, false)).status).toBe(401);
  });
});
