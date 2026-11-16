import { type FetchFn, createHoldingRule, ensureAccount, listSecurityEvents, openDb, recordHoldings } from '@finc/core';
import { type FinnhubKey, FinnhubService } from '../finnhub.js';
import { describe, expect, it, vi } from 'vitest';
import { InsightsService } from '../insights.js';
import { SecService } from '../sec.js';
import type { WorkerState } from '../server.js';
import { INSIGHTS_OUTSIDE_PER_HOUR, createApp } from './app.js';

// GET /api/holdings/:id/insights (stock insights, step 1). Fictional symbols, quantities and prices; no network.

const TOKEN = 'f'.repeat(64);
const HOME = { authorization: `Bearer ${TOKEN}` };
const EDGE = { 'x-finc-edge': 'public', 'x-forwarded-for': '198.51.100.41', 'x-forwarded-proto': 'https' };
const T0 = Date.parse('2026-11-11T08:00:00Z'); // 10:00 in Jerusalem
const LATEST = '2026-11-11T04:00:00.000Z'; // stands for the US close of Tuesday 2026-11-10
const OLDER = '2026-11-10T04:00:00.000Z';

/** 300 weekday bars ending on Tuesday 2026-11-10, the last close 55 */
function body(symbol: string): unknown {
  const ts: number[] = [];
  for (let t = Date.parse('2026-11-10T14:30:00Z'); ts.length < 300; t -= 86_400_000) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) ts.unshift(t / 1000);
  }
  const close = ts.map((_, i) => (i === ts.length - 1 ? 55 : 50 + (i % 5)));
  return {
    chart: {
      result: [{ meta: { symbol, instrumentType: symbol === 'SPY' || symbol === 'TSTETF' ? 'ETF' : 'EQUITY', currency: 'USD', exchangeTimezoneName: 'America/New_York' }, timestamp: ts, events: {}, indicators: { quote: [{ close }], adjclose: [{ adjclose: close }] } }],
      error: null,
    },
  };
}

const SEC_CONTACT = 'owner-alias@example.com';
/** fictional SEC answers: TEST1 is CIK 9999001, SIC 3571 (technology: XLK), calendar quarters 2024 to Q3 2026 */
function secBody(url: string): unknown {
  if (url.endsWith('company_tickers.json')) return { '0': { cik_str: 9999001, ticker: 'TEST1', title: 'TEST1 Corp' } };
  if (url.includes('/submissions/')) {
    return { cik: '9999001', name: 'Test One Corp', sic: '3571', sicDescription: 'Electronic Computers', filings: { recent: { accessionNumber: ['0009999001-26-000012', '0009999001-26-000011', '0009999001-24-000001'], filingDate: ['2026-11-02', '2026-10-30', '2024-10-30'], reportDate: ['2026-10-29', '2026-09-30', '2024-09-30'], form: ['8-K', '10-Q', '10-Q'], items: ['2.02,9.01', '', ''] } } };
  }
  const q: Array<[string, string]> = [];
  for (const y of [2024, 2025, 2026]) for (const [a, b] of [['01-01', '03-31'], ['04-01', '06-30'], ['07-01', '09-30'], ['10-01', '12-31']] as const) if (`${y}-${b}` <= '2026-09-30') q.push([`${y}-${a}`, `${y}-${b}`]);
  const accn = (i: number) => `0009999001-26-${String(100 + i).padStart(6, '0')}`;
  const flow = (v: (i: number) => number) => q.map(([start, end], i) => ({ start, end, val: v(i), accn: accn(i), fy: 2026, fp: 'Q1', form: '10-Q', filed: new Date(Date.parse(end) + 28 * 86_400_000).toISOString().slice(0, 10) }));
  const inst = (val: number) => [{ end: '2026-09-30', val, accn: accn(99), fy: 2026, fp: 'Q3', form: '10-Q', filed: '2026-10-30' }];
  return {
    cik: 9999001,
    entityName: 'Test One Corp',
    facts: {
      'us-gaap': {
        Revenues: { units: { USD: flow((i) => (i < 7 ? 100 : 125) * 1e6) } },
        NetIncomeLoss: { units: { USD: flow(() => 10e6) } },
        EarningsPerShareDiluted: { units: { 'USD/shares': flow(() => 0.55) } },
        CashAndCashEquivalentsAtCarryingValue: { units: { USD: inst(70e6) } },
        LongTermDebt: { units: { USD: inst(40e6) } },
        StockholdersEquity: { units: { USD: inst(200e6) } },
      },
      dei: { EntityCommonStockSharesOutstanding: { units: { shares: [{ end: '2025-10-20', val: 80e6, accn: accn(98), form: '10-Q', filed: '2025-10-30' }, { end: '2026-10-20', val: 76e6, accn: accn(99), form: '10-Q', filed: '2026-10-30' }] } } },
    },
  };
}

const FH_KEY = 'TESTKEY000fictional0000';
/** fictional Finnhub answers: 25 analysts in November 2026, 22 in August; earnings on the 16th */
function finnhubBody(url: string): unknown {
  const sym = new URL(url).searchParams.get('symbol')!;
  if (url.includes('/stock/recommendation')) {
    return [
      { symbol: sym, period: '2026-11-01', strongBuy: 5, buy: 10, hold: 8, sell: 1, strongSell: 1 },
      { symbol: sym, period: '2026-08-01', strongBuy: 2, buy: 8, hold: 10, sell: 2, strongSell: 0 },
    ];
  }
  return {
    earningsCalendar: [
      { symbol: sym, date: '2026-11-16', hour: 'amc', epsEstimate: 1.1, epsActual: null, quarter: 4, year: 2026 },
      { symbol: sym, date: '2026-08-04', hour: 'bmo', epsEstimate: 1, epsActual: 1.25, quarter: 3, year: 2026 },
    ],
  };
}

type Answer = (url: string) => Response | Promise<Response> | undefined;
function setup(o: { insights?: boolean; status?: number; sec?: { answer?: Answer; deadlineMs?: number }; finnhub?: { answer?: Answer; key?: () => FinnhubKey; deadlineMs?: number } } = {}) {
  const db = openDb(':memory:');
  const sec = ensureAccount(db, { institutionId: 'beinleumi', institutionKind: 'bank', institutionDisplayName: 'FIBI', source: 'scraper:beinleumi', externalId: 'b-securities', type: 'securities' }).accountId;
  const fx = ensureAccount(db, { institutionId: 'beinleumi', institutionKind: 'bank', institutionDisplayName: 'FIBI', source: 'scraper:beinleumi', externalId: 'b-fx', type: 'foreign_currency' }).accountId;
  const base = { dailyChangePct: 0.5, fromCostPct: 10 };
  const sRow = (symbol: string, price: number, currency = 'USD') => ({ ...base, kind: 'security' as const, symbol, name: `${symbol} Corp`, quantity: 12, price, currency, valueIls: 237_600, valueOrig: 12 * price, costPrice: 50 });
  recordHoldings(db, { accountId: sec, runId: null, source: 't', takenAt: OLDER, rows: [sRow('TEST1', 54)] });
  recordHoldings(db, { accountId: sec, runId: null, source: 't', takenAt: LATEST, rows: [sRow('TEST1', 55), sRow('TSTIL', 1234, 'ILS'), sRow('TSTETF', 55), sRow('TSTEU', 55, 'EUR')] });
  recordHoldings(db, { accountId: fx, runId: null, source: 't', takenAt: LATEST, rows: [{ ...base, kind: 'currency', symbol: 'USD', name: 'Dollar', quantity: 100, price: 3.6, currency: 'USD', valueIls: 36_000, valueOrig: 100, costPrice: null }] });
  const ids = db.$client.prepare('select id, symbol, taken_at t from holding_snapshot order by id').all() as Array<{ id: number; symbol: string; t: string }>;
  const id = (symbol: string, t = LATEST) => ids.find((r) => r.symbol === symbol && r.t === t)!.id;
  const f = vi.fn<FetchFn>(async (url) => {
    if (o.status) return new Response('', { status: o.status });
    const sym = decodeURIComponent(url.split('/chart/')[1]!.split('?')[0]!);
    return new Response(JSON.stringify(body(sym)), { status: 200 });
  });
  const clock = { t: T0 };
  const quiet = { debug() {}, info() {}, warn() {} };
  const sf = vi.fn<FetchFn>(async (url) => (await o.sec?.answer?.(url)) ?? new Response(JSON.stringify(secBody(url)), { status: 200 }));
  const hf = vi.fn<FetchFn>(async (url) => (await o.finnhub?.answer?.(url)) ?? new Response(JSON.stringify(finnhubBody(url)), { status: 200 }));
  const fhState = o.finnhub ? { finnhub: new FinnhubService({ db, key: o.finnhub.key ?? (() => ({ ok: true, key: FH_KEY })), fetch: hf, now: () => clock.t, minGapMs: 0, deadlineMs: o.finnhub.deadlineMs ?? 2000, log: quiet }) } : {};
  const secState = o.sec ? { sec: new SecService({ contact: SEC_CONTACT, fetch: sf, now: () => clock.t, minGapMs: 0, deadlineMs: o.sec.deadlineMs ?? 2000, log: quiet }) } : {};
  const state: WorkerState = { db, vault: null, scheduler: { config: { times: [], jitterMinutes: 0, timezone: 'UTC', monthsBack: 3 }, isRunning: false, nextRun: () => null } as never, startedAt: T0, ...(o.insights === false ? {} : { insights: new InsightsService({ fetch: f, now: () => clock.t, log: quiet }), ...secState, ...fhState, panelDeadlines: { secMs: o.sec?.deadlineMs ?? 2000, finnhubMs: o.finnhub?.deadlineMs ?? 2000 } }) };
  const { app } = createApp(state, { controlToken: TOKEN, webDist: '/nonexistent', now: () => clock.t });
  const get = async (path: string, headers: Record<string, string> = HOME) => {
    const res = await app.request(path, { headers });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
  };
  const post = async (path: string, headers: Record<string, string>, b: unknown) => {
    const res = await app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(b) });
    return (await res.json()) as Record<string, any>;
  };
  const pair = async (name: string): Promise<Record<string, string>> => {
    const code = (await post('/api/devices/pairings', HOME, { name })).code as string;
    const r = await post('/api/devices/pair', EDGE, { code });
    return { ...EDGE, authorization: `Bearer ${r.token as string}` };
  };
  return { db, f, sf, hf, clock, id, get, pair };
}

describe('GET /api/holdings/:id/insights', () => {
  it('needs a signed-in caller', async () => {
    const env = setup();
    expect((await env.get(`/api/holdings/${env.id('TEST1')}/insights`, {})).status).toBe(401);
    expect(env.f).not.toHaveBeenCalled();
  });

  it('answers with the agreed shape for a row of the latest snapshot; only symbols reach Yahoo', async () => {
    const env = setup();
    const r = await env.get(`/api/holdings/${env.id('TEST1')}/insights`);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['analysts', 'analystsUnavailableCode', 'asOf', 'benchmark', 'company', 'companyUnavailableCode', 'crossCheck', 'currency', 'earnings', 'events', 'fetchedAt', 'filings', 'id', 'instrumentType', 'name', 'returns', 'risk', 'rules', 'sector', 'series', 'signals', 'source', 'symbol', 'trend']);
    expect(r.body).toMatchObject({ company: null, companyUnavailableCode: 'off', filings: [], sector: null }); // no SEC contact
    expect(r.body).toMatchObject({ analysts: null, analystsUnavailableCode: 'off', earnings: null }); // no Finnhub service
    expect(r.body).toMatchObject({ id: env.id('TEST1'), symbol: 'TEST1', name: 'TEST1 Corp', currency: 'USD', asOf: '2026-11-10', fetchedAt: new Date(T0).toISOString(), source: 'yahoo', instrumentType: 'EQUITY' });
    expect(r.body.crossCheck).toEqual({ bankPrice: 55, bankAt: LATEST, yahooClose: 55, yahooDate: '2026-11-10', diffPct: 0, ok: true, note: null });
    expect(r.body.trend.price).toBe(55);
    expect(r.body.series).toHaveLength(252);
    expect(r.body.benchmark.symbol).toBe('SPY');
    expect(typeof r.body.risk.beta1y).toBe('number');
    expect(r.body.returns).toMatchObject({ m1: expect.any(Number), y1: expect.any(Number), y3Ann: null });
    expect(JSON.stringify(r.body)).not.toMatch(/quantity|valueIls|valueOrig|costPrice|237600|\b660\b/);
    const urls = env.f.mock.calls.map(([u]) => u).sort();
    expect(urls).toEqual(['https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=5y&events=div%2Csplit', 'https://query1.finance.yahoo.com/v8/finance/chart/TEST1?interval=1d&range=5y&events=div%2Csplit']);
    // a second open is served from memory
    await env.get(`/api/holdings/${env.id('TEST1')}/insights`);
    expect(env.f).toHaveBeenCalledTimes(2);
  });

  it('404 for a row of an older snapshot, a currency row, an unknown or malformed id', async () => {
    const env = setup();
    for (const p of [env.id('TEST1', OLDER), env.id('USD'), 99_999, 'abc', '1.5', '-1']) {
      const r = await env.get(`/api/holdings/${p}/insights`);
      expect(r.status).toBe(404);
    }
    expect(env.f).not.toHaveBeenCalled();
  });

  it('unavailable (200, with the reason) when the source cannot answer, the holding is not covered or insights are off', async () => {
    const busy = setup({ status: 429 });
    const a = await busy.get(`/api/holdings/${busy.id('TEST1')}/insights`);
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ unavailableCode: 'busy', unavailable: 'the price source is busy; try again later', asOf: null, series: [], benchmark: null, crossCheck: { bankPrice: 55, yahooClose: null, ok: null } });
    const env = setup();
    const b = await env.get(`/api/holdings/${env.id('TSTIL')}/insights`);
    expect(b.body).toMatchObject({ unavailableCode: 'not_covered', unavailable: 'this holding is not covered by the price source', company: null, companyUnavailableCode: 'not_covered' });
    expect(env.f).not.toHaveBeenCalled(); // a shekel-priced security never goes to Yahoo
    const off = setup({ insights: false });
    expect((await off.get(`/api/holdings/${off.id('TEST1')}/insights`)).body).toMatchObject({ unavailableCode: 'off', unavailable: 'stock insights are off' });
  });

  it(`outside callers: ${INSIGHTS_OUTSIDE_PER_HOUR} an hour per device; home is not limited`, async () => {
    const env = setup();
    const phone = await env.pair('Phone Test');
    const path = `/api/holdings/${env.id('TEST1')}/insights`;
    for (let i = 0; i < INSIGHTS_OUTSIDE_PER_HOUR; i++) expect((await env.get(path, phone)).status).toBe(200);
    const r = await env.get(path, phone);
    expect(r.status).toBe(429);
    expect(r.body).toEqual({ error: expect.any(String), retryAt: new Date(T0 + 3_600_000).toISOString() });
    expect(listSecurityEvents(env.db, { kind: 'insights.limited' }).events.length).toBeGreaterThan(0);
    const tablet = await env.pair('Tablet Test');
    expect((await env.get(path, tablet)).status).toBe(200); // per device
    for (let i = 0; i < 5; i++) expect((await env.get(path)).status).toBe(200);
    env.clock.t += 3_600_000;
    expect((await env.get(path, phone)).status).toBe(200);
  });
});

describe('GET /api/holdings/:id/insights: company sections from SEC (step 2)', () => {
  const FIGS = ['cash', 'debtToEquity', 'epsTtm', 'financeLeases', 'netIncomeTtm', 'netIncomeYoYPct', 'netMarginPct', 'netMarginPct1yAgo', 'netMarginPct3yAgo', 'pe', 'revenueTtm', 'revenueYoYPct', 'sharesChange1yPct', 'sharesOutstanding', 'totalDebt'];

  it('the agreed contract: company, filings and the sector fund; only the CIK reaches SEC', async () => {
    const env = setup({ sec: {} });
    const r = await env.get(`/api/holdings/${env.id('TEST1')}/insights`);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['analysts', 'analystsUnavailableCode', 'asOf', 'benchmark', 'company', 'crossCheck', 'currency', 'earnings', 'events', 'fetchedAt', 'filings', 'id', 'instrumentType', 'name', 'returns', 'risk', 'rules', 'sector', 'series', 'signals', 'source', 'symbol', 'trend']);
    const c = r.body.company;
    expect(Object.keys(c).sort()).toEqual(['cik', 'currency', 'figures', 'name', 'notes', 'sic', 'sicDescription']);
    expect(c).toMatchObject({ name: 'Test One Corp', cik: '0009999001', sic: '3571', sicDescription: 'Electronic Computers', currency: 'USD' });
    expect(Object.keys(c.figures).sort()).toEqual(FIGS);
    for (const k of FIGS.filter((x) => x !== 'netMarginPct3yAgo' && x !== 'financeLeases')) expect(Object.keys(c.figures[k]).sort()).toEqual(['accn', 'basis', 'filed', 'form', 'periodEnd', 'unit', 'value']);
    expect(c.figures.revenueTtm).toEqual({ value: 500e6, unit: 'USD', periodEnd: '2026-09-30', basis: 'ttm', form: '10-Q', filed: '2026-10-28', accn: '0009999001-26-000110' });
    expect(c.figures.revenueYoYPct.value).toBe(25); // 500 vs 400 million
    expect(c.figures.epsTtm.value).toBe(2.2);
    expect(c.figures.pe).toMatchObject({ value: 25, unit: 'x', basis: 'derived' }); // 55 / 2.2
    expect(c.figures.totalDebt).toMatchObject({ value: 40e6, basis: 'instant' });
    expect(c.figures.debtToEquity.value).toBe(0.2);
    expect(c.figures.sharesChange1yPct.value).toBe(-5);
    expect(c.figures.netMarginPct3yAgo).toBeNull();
    expect(c.notes).toContainEqual(expect.objectContaining({ code: 'no_prior_period', figure: 'netMarginPct3yAgo' }));
    for (const n of c.notes) expect(Object.keys(n).sort()).toEqual(['code', 'figure', 'text']);
    expect(r.body.filings).toEqual([
      { form: '8-K', filed: '2026-11-02', reportDate: '2026-10-29', title: 'Current report', items: ['2.02 Results of operations', '9.01 Financial statements and exhibits'], url: 'https://www.sec.gov/Archives/edgar/data/9999001/000999900126000012/' },
      { form: '10-Q', filed: '2026-10-30', reportDate: '2026-09-30', title: 'Quarterly report', items: [], url: 'https://www.sec.gov/Archives/edgar/data/9999001/000999900126000011/' },
    ]);
    expect(r.body.sector).toMatchObject({ symbol: 'XLK', name: 'Technology Select Sector SPDR Fund' });
    expect(Object.keys(r.body.sector.returns).sort()).toEqual(['m1', 'm3', 'm6', 'y1', 'y3Ann']);
    expect(Object.keys(r.body.sector.diffPts).sort()).toEqual(['m1', 'm3', 'm6', 'y1', 'y3Ann']);
    const secUrls = env.sf.mock.calls.map(([u]) => u);
    expect(secUrls.sort()).toEqual(['https://data.sec.gov/api/xbrl/companyfacts/CIK0009999001.json', 'https://data.sec.gov/submissions/CIK0009999001.json', 'https://www.sec.gov/files/company_tickers.json']);
    expect(env.f.mock.calls.map(([u]) => u)).toContain('https://query1.finance.yahoo.com/v8/finance/chart/XLK?interval=1d&range=5y&events=div%2Csplit');
    expect(JSON.stringify(r.body)).not.toMatch(/example\.com|quantity|valueIls|costPrice/);
    // a second open is served from memory
    await env.get(`/api/holdings/${env.id('TEST1')}/insights`);
    expect(env.sf).toHaveBeenCalledTimes(3);
  });

  it('unavailable codes: not_covered, busy (rate limit or slow), unreachable, invalid, off; price sections unaffected', async () => {
    const code = async (answer: (url: string) => Response | Promise<Response> | undefined, deadlineMs?: number) => {
      const env = setup({ sec: { answer, ...(deadlineMs ? { deadlineMs } : {}) } });
      const r = await env.get(`/api/holdings/${env.id('TEST1')}/insights`);
      expect(r.status).toBe(200);
      expect(r.body.trend.price).toBe(55);
      expect(r.body.benchmark.symbol).toBe('SPY');
      expect(r.body).toMatchObject({ company: null, filings: [], sector: null });
      return r.body.companyUnavailableCode;
    };
    expect(await code((u) => (u.endsWith('company_tickers.json') ? new Response(JSON.stringify({ '0': { cik_str: 9999002, ticker: 'OTHER', title: 'Other' } }), { status: 200 }) : undefined))).toBe('not_covered');
    expect(await code(() => new Response('', { status: 429 }))).toBe('busy');
    expect(await code(() => new Response('', { status: 503 }))).toBe('unreachable');
    expect(await code((u) => (u.includes('companyfacts') ? new Response('{"cik":1}', { status: 200 }) : undefined))).toBe('invalid');
    expect(await code((u) => (u.includes('companyfacts') ? new Promise<Response>(() => {}) : undefined), 50)).toBe('busy');
    const off = setup();
    expect((await off.get(`/api/holdings/${off.id('TEST1')}/insights`)).body).toMatchObject({ company: null, companyUnavailableCode: 'off' });
    expect(off.sf).not.toHaveBeenCalled();
  });

  it('the figures survive a submissions failure: no filings, no sector, a note', async () => {
    const env = setup({ sec: { answer: (u) => (u.includes('/submissions/') ? new Response('', { status: 503 }) : undefined) } });
    const r = await env.get(`/api/holdings/${env.id('TEST1')}/insights`);
    expect(r.body).toMatchObject({ company: { name: 'TEST1 Corp', cik: '0009999001', sic: null }, filings: [], sector: null });
    expect(r.body.company.figures.revenueTtm.value).toBe(500e6);
    expect(r.body.company.notes).toContainEqual(expect.objectContaining({ code: 'filings_unavailable', figure: null }));
    expect('companyUnavailableCode' in r.body).toBe(false);
  });

  it('a fund (ETF) is never looked up at SEC', async () => {
    const env = setup({ sec: {} });
    const r = await env.get(`/api/holdings/${env.id('TSTETF')}/insights`);
    expect(r.body).toMatchObject({ instrumentType: 'ETF', company: null, companyUnavailableCode: 'not_covered', filings: [], sector: null });
    expect(env.sf).not.toHaveBeenCalled();
  });

  it('company sections even when the price history is unavailable (no P/E then)', async () => {
    const env = setup({ status: 503, sec: {} });
    const r = await env.get(`/api/holdings/${env.id('TEST1')}/insights`);
    expect(r.body).toMatchObject({ unavailableCode: 'unreachable', sector: null, company: { name: 'Test One Corp' } });
    expect(r.body.company.figures.pe).toBeNull();
    expect(r.body.company.figures.revenueTtm.value).toBe(500e6);
    expect(r.body.filings).toHaveLength(2);
  });
});

describe('GET /api/holdings/:id/insights: analysts and earnings from Finnhub (decision aids, Part B)', () => {
  const path = (env: ReturnType<typeof setup>, sym = 'TEST1') => `/api/holdings/${env.id(sym)}/insights`;

  it('the agreed contract; only the ticker reaches Finnhub, the key only in the header', async () => {
    const env = setup({ finnhub: {} });
    const r = await env.get(path(env));
    expect(r.status).toBe(200);
    expect(Object.keys(r.body)).not.toContain('analystsUnavailableCode');
    expect(r.body.analysts).toEqual({
      period: '2026-11',
      strongBuy: 5,
      buy: 10,
      hold: 8,
      sell: 1,
      strongSell: 1,
      total: 25,
      buyShare: 60,
      sellShare: 8,
      prev3m: { period: '2026-08', strongBuy: 2, buy: 8, hold: 10, sell: 2, strongSell: 0, total: 22, buyShare: 45.5, sellShare: 9.1 },
      buyShareChange3mPts: 14.5,
      fetchedAt: new Date(T0).toISOString(),
      stale: false,
      source: 'finnhub',
    });
    expect(r.body.earnings).toEqual({
      next: { date: '2026-11-16', hour: 'amc', epsEstimate: 1.1 },
      last: { date: '2026-08-04', epsActual: 1.25, epsEstimate: 1, surprisePct: 25 },
      fetchedAt: new Date(T0).toISOString(),
      stale: false,
    });
    const urls = env.hf.mock.calls.map((c) => c[0]).sort();
    expect(urls).toEqual(['https://finnhub.io/api/v1/calendar/earnings?from=2026-07-14&to=2027-03-11&symbol=TEST1', 'https://finnhub.io/api/v1/stock/recommendation?symbol=TEST1']);
    for (const [url, init] of env.hf.mock.calls) {
      expect(url).not.toContain(FH_KEY);
      expect((init.headers as Record<string, string>)['x-finnhub-token']).toBe(FH_KEY);
    }
    expect(JSON.stringify(r.body)).not.toContain(FH_KEY);
  });

  it('an ETF and a holding not priced in dollars are not covered and never reach Finnhub', async () => {
    const env = setup({ finnhub: {}, sec: {} });
    expect((await env.get(path(env, 'TSTETF'))).body).toMatchObject({ instrumentType: 'ETF', analysts: null, analystsUnavailableCode: 'not_covered', earnings: null });
    expect((await env.get(path(env, 'TSTIL'))).body).toMatchObject({ analysts: null, analystsUnavailableCode: 'not_covered', earnings: null });
    const eur = await env.get(path(env, 'TSTEU'));
    expect(eur.body).toMatchObject({ analysts: null, analystsUnavailableCode: 'not_covered', earnings: null, company: null, companyUnavailableCode: 'not_covered' });
    expect(env.hf).not.toHaveBeenCalled();
    expect(env.sf).not.toHaveBeenCalled();
  });

  it('codes: vault_locked / no_key without a cache, no_key for a refused key, busy, unreachable, invalid, too_few, not_covered; price sections unaffected', async () => {
    const code = async (fh: NonNullable<Parameters<typeof setup>[0]>['finnhub']) => {
      const env = setup({ finnhub: fh });
      const r = await env.get(path(env));
      expect(r.status).toBe(200);
      expect(r.body.trend.price).toBe(55);
      expect(r.body.analysts).toBeNull();
      return r.body.analystsUnavailableCode;
    };
    const rec = (body: string) => (u: string) => (u.includes('recommendation') ? new Response(body, { status: 200 }) : undefined);
    expect(await code({ key: () => ({ ok: false, code: 'vault_locked' }) })).toBe('vault_locked');
    expect(await code({ key: () => ({ ok: false, code: 'no_key' }) })).toBe('no_key');
    expect(await code({ answer: () => new Response('', { status: 401 }) })).toBe('no_key');
    expect(await code({ answer: () => new Response('', { status: 403 }) })).toBe('not_covered'); // not on the plan: this symbol only
    expect(await code({ answer: () => new Response('', { status: 429 }) })).toBe('busy');
    expect(await code({ answer: () => new Response('', { status: 502 }) })).toBe('unreachable');
    // another symbol that profile2 does not confirm: not_covered; entries disagreeing on the symbol: invalid
    expect(await code({ answer: (u) => (u.includes('profile2') ? new Response('{}', { status: 200 }) : rec('[{"symbol":"OTHER","period":"2026-11-01","strongBuy":1,"buy":1,"hold":1,"sell":0,"strongSell":0}]')(u)) })).toBe('not_covered');
    expect(await code({ answer: rec('[{"symbol":"TEST1","period":"2026-11-01","strongBuy":1,"buy":1,"hold":1,"sell":0,"strongSell":0},{"symbol":"OTHER","period":"2026-10-01","strongBuy":1,"buy":1,"hold":1,"sell":0,"strongSell":0}]') })).toBe('invalid');
    expect(await code({ answer: () => new Promise<Response>(() => {}), deadlineMs: 50 })).toBe('busy');
    expect(await code({ answer: rec('[{"symbol":"TEST1","period":"2026-11-01","strongBuy":1,"buy":1,"hold":0,"sell":0,"strongSell":0}]') })).toBe('too_few');
    expect(await code({ answer: rec('[]') })).toBe('not_covered');
  });

  it('earnings still show when the analysts are hidden', async () => {
    const env = setup({ finnhub: { answer: (u) => (u.includes('recommendation') ? new Response('[]', { status: 200 }) : undefined) } });
    const r = await env.get(path(env));
    expect(r.body).toMatchObject({ analysts: null, analystsUnavailableCode: 'not_covered', earnings: { next: { date: '2026-11-16' } } });
  });

  it('the vault locks: the cached view (with its fetchedAt) still shows; nothing is fetched', async () => {
    let key: FinnhubKey = { ok: true, key: FH_KEY };
    const env = setup({ finnhub: { key: () => key } });
    await env.get(path(env));
    expect(env.hf).toHaveBeenCalledTimes(2);
    key = { ok: false, code: 'vault_locked' };
    env.clock.t += 3 * 24 * 3_600_000; // stale
    const r = await env.get(path(env));
    expect(r.body.analysts).toMatchObject({ total: 25, fetchedAt: new Date(T0).toISOString(), stale: true });
    expect(r.body.earnings).toMatchObject({ fetchedAt: new Date(T0).toISOString(), next: { date: '2026-11-16' }, stale: true });
    expect(env.hf).toHaveBeenCalledTimes(2);
  });

  it('the owner\u2019s Part B rules are evaluated against the panel: earnings within N days, analysts toward buy or sell', async () => {
    const env = setup({ finnhub: {} });
    createHoldingRule(env.db, { template: 'earnings_within_days', params: { n: 7 } });
    createHoldingRule(env.db, { template: 'analysts_toward_buy_pts', params: { pts: 10 } });
    createHoldingRule(env.db, { template: 'analysts_toward_sell_pts', params: { pts: 10 } });
    const r = await env.get(path(env));
    const fin = { kind: 'finnhub', date: '2026-11-11', time: null, form: null };
    expect(r.body.rules.map((x: Record<string, unknown>) => [x.template, x.state, x.value, x.source])).toEqual([
      ['earnings_within_days', 'applies', 5, fin],
      ['analysts_toward_buy_pts', 'applies', 14.5, fin],
      ['analysts_toward_sell_pts', 'clear', -14.5, fin],
    ]);
    // no Finnhub (locked, nothing cached): unknown, never clear
    const locked = setup({ finnhub: { key: () => ({ ok: false, code: 'vault_locked' }) } });
    createHoldingRule(locked.db, { template: 'earnings_within_days', params: { n: 7 } });
    expect((await locked.get(path(locked))).body.rules).toMatchObject([{ template: 'earnings_within_days', state: 'unknown', value: null }]);
  });
});

describe('GET /api/holdings/:id/insights: Finnhub answering for another listing', () => {
  it('a verified alias: the sections carry finnhubSymbol; the holding keeps its own symbol', async () => {
    // fictional: Finnhub answers TEST1 with the rows of TEST1.X and profile2 maps TEST1 to TEST1.X
    const env = setup({ finnhub: { answer: (u) => (u.includes('profile2') ? new Response(JSON.stringify({ ticker: 'TEST1.X', name: 'Test One' }), { status: 200 }) : new Response(JSON.stringify(finnhubBody(u.replace('symbol=TEST1', 'symbol=TEST1.X'))), { status: 200 })) } });
    const r = await env.get(`/api/holdings/${env.id('TEST1')}/insights`);
    expect(r.body.symbol).toBe('TEST1');
    expect(r.body.analysts).toMatchObject({ total: 25, finnhubSymbol: 'TEST1.X' });
    expect(r.body.earnings).toMatchObject({ next: { date: '2026-11-16' }, finnhubSymbol: 'TEST1.X' });
  });
});
