import { type CostLotRow, type FetchFn, ensureAccount, openDb, recordCostLots, recordHoldings, recordTaxYear } from '@finc/core';
import { describe, expect, it, vi } from 'vitest';
import { InsightsService } from '../insights.js';
import type { WorkerState } from '../server.js';
import { createApp } from './app.js';

// GET /api/holdings/:id/position (position view, step 2). Fictional papers, quantities, prices and amounts; no network.

const TOKEN = 'f'.repeat(64);
const HOME = { authorization: `Bearer ${TOKEN}` };
const T0 = Date.parse('2026-11-11T08:00:00Z');
const LATEST = '2026-11-11T04:00:00.000Z';

/** 300 weekday bars ending on Tuesday 2026-11-10 */
function body(symbol: string): unknown {
  const ts: number[] = [];
  for (let t = Date.parse('2026-11-10T14:30:00Z'); ts.length < 300; t -= 86_400_000) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) ts.unshift(t / 1000);
  }
  const close = ts.map((_, i) => (i === ts.length - 1 ? 55 : 50 + (i % 5)));
  return { chart: { result: [{ meta: { symbol, instrumentType: symbol === 'SPY' ? 'ETF' : 'EQUITY', currency: 'USD', exchangeTimezoneName: 'America/New_York' }, timestamp: ts, events: {}, indicators: { quote: [{ close }], adjclose: [{ adjclose: close }] } }], error: null } };
}

const lot = (o: Partial<CostLotRow> = {}): CostLotRow => ({ paperId: '1111111', name: 'TEST ONE', action: 'buy', actionText: 'קניה בבורסה', quantity: 12, costPrice: 50, costPriceIls: 180, currency: 'USD', tradeDate: '2026-01-05', avgPrice: null, lastPrice: 55, changePct: 10, ...o });

function setup(o: { lots?: CostLotRow[] } = {}) {
  const db = openDb(':memory:');
  const acc = ensureAccount(db, { institutionId: 'beinleumi', institutionKind: 'bank', institutionDisplayName: 'FIBI', source: 'scraper:beinleumi', externalId: 'b-securities', type: 'securities' }).accountId;
  const fx = ensureAccount(db, { institutionId: 'beinleumi', institutionKind: 'bank', institutionDisplayName: 'FIBI', source: 'scraper:beinleumi', externalId: 'b-fx', type: 'foreign_currency' }).accountId;
  const base = { dailyChangePct: 0.5, fromCostPct: 10, costPrice: 50 };
  // 12 × $55 × 3.6 = ₪2,376
  recordHoldings(db, { accountId: acc, runId: null, source: 't', takenAt: LATEST, rows: [{ ...base, kind: 'security', symbol: 'TEST1', name: 'TEST1 Corp', quantity: 12, price: 55, currency: 'USD', valueIls: 237_600, valueOrig: 660 }] });
  recordHoldings(db, { accountId: fx, runId: null, source: 't', takenAt: LATEST, rows: [{ ...base, kind: 'currency', symbol: 'USD', name: 'Dollar', quantity: 100, price: 3.6, currency: 'USD', valueIls: 36_000, valueOrig: 100, costPrice: null }] });
  if (o.lots?.length) recordCostLots(db, { accountId: acc, runId: null, lots: o.lots });
  recordTaxYear(db, { accountId: acc, summary: { year: 2026, lossesIls: -5000, gains: [{ ratePct: 25, amountIls: 0 }], taxWithheld: [], interestDividendIls: null, interestDividendTaxIls: null } });
  const ids = db.$client.prepare('select id, symbol from holding_snapshot order by id').all() as Array<{ id: number; symbol: string }>;
  const id = (symbol: string) => ids.find((r) => r.symbol === symbol)!.id;
  const f = vi.fn<FetchFn>(async (url) => new Response(JSON.stringify(body(decodeURIComponent(url.split('/chart/')[1]!.split('?')[0]!))), { status: 200 }));
  const quiet = { debug() {}, info() {}, warn() {} };
  const state: WorkerState = { db, vault: null, scheduler: { config: { times: [], jitterMinutes: 0, timezone: 'UTC', monthsBack: 3 }, isRunning: false, nextRun: () => null } as never, startedAt: T0, insights: new InsightsService({ fetch: f, now: () => T0, log: quiet }) };
  const { app } = createApp(state, { controlToken: TOKEN, webDist: '/nonexistent', now: () => T0 });
  const get = async (path: string, headers: Record<string, string> = HOME) => {
    const res = await app.request(path, { headers });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
  };
  return { f, id, get };
}

describe('GET /api/holdings/:id/position', () => {
  it('needs a signed-in caller', async () => {
    const env = setup({ lots: [lot()] });
    expect((await env.get(`/api/holdings/${env.id('TEST1')}/position`, {})).status).toBe(401);
  });

  it('answers with the owner result from the matched lots; only SPY reaches Yahoo', async () => {
    const env = setup({ lots: [lot()] });
    const r = await env.get(`/api/holdings/${env.id('TEST1')}/position`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ available: true, priceSource: 'bank', currency: 'USD', quantity: 12, price: 55, rate: 3.6 });
    // cost 12 × 180 = ₪2,160; gain 2,376 − 2,160 = ₪216 = 10%; the paper $60 × 3.6 = ₪216, the dollar 0
    expect(r.body.result).toMatchObject({ costIls: 216_000, valueIls: 237_600, gainIls: 21_600, gainPct: 10, gainOrig: 60 });
    expect(r.body.dollarPart).toEqual({ stockIls: 21_600, fxIls: 0, rateAtBuy: 3.6, rateNow: 3.6 });
    expect(r.body.perYear).toMatchObject({ pct: null, missing: 'under_a_year' });
    expect(r.body.benchmark).toMatchObject({ symbol: 'SPY', asOf: '2026-11-10' });
    expect(r.body.ifSold).toMatchObject({ taxIls: 5400, proceedsIls: 232_200 });
    expect(r.body.weight.ofPortfolioPct).toBe(100);
    expect(r.body.taxYear).toMatchObject({ year: 2026, lossesIls: -5000 });
    expect(env.f.mock.calls.map(([u]) => u)).toEqual(['https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=5y&events=div%2Csplit']);
  });

  it('says why when no lots were read or none fit the holding', async () => {
    const none = setup();
    expect((await none.get(`/api/holdings/${none.id('TEST1')}/position`)).body).toMatchObject({ available: false, code: 'no_lots', taxYear: { year: 2026 } });
    const other = setup({ lots: [lot({ quantity: 7 })] });
    expect((await other.get(`/api/holdings/${other.id('TEST1')}/position`)).body).toMatchObject({ available: false, code: 'not_matched' });
    expect(other.f).not.toHaveBeenCalled();
  });

  it('404 for a currency row or an unknown id', async () => {
    const env = setup({ lots: [lot()] });
    expect((await env.get(`/api/holdings/${env.id('USD')}/position`)).status).toBe(404);
    expect((await env.get('/api/holdings/99999/position')).status).toBe(404);
  });
});
