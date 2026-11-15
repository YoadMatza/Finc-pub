import { describe, expect, it } from 'vitest';
import type { DailyBar, PriceHistory } from '../prices/history.js';
import { bankSessionDate, buildInsights, intradaySnapshot, unavailableInsights, withAnalysts, withCompany } from './panel.js';
import type { AnalystsSection, EarningsSection } from './analysts.js';
import { buildCompany } from './company.js';
import { returnsOf } from './price.js';

// fictional symbols and prices throughout
const NOW = Date.parse('2026-11-11T12:00:00Z');

function weekdays(start: string, n: number): string[] {
  const out: string[] = [];
  let t = Date.parse(`${start}T00:00:00Z`);
  while (out.length < n) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(new Date(t).toISOString().slice(0, 10));
    t += 86_400_000;
  }
  return out;
}

const RM = [0.01, -0.005, 0.002, -0.012, 0.007, 0.003, -0.004];
function pair(n = 1300): { stock: DailyBar[]; spy: DailyBar[] } {
  const dates = weekdays('2021-11-15', n);
  let s = 100;
  let m = 400;
  const stock: DailyBar[] = [];
  const spy: DailyBar[] = [];
  dates.forEach((d, i) => {
    if (i > 0) {
      const r = RM[i % RM.length]!;
      s *= 1 + 2 * r;
      m *= 1 + r;
    }
    stock.push({ d, close: s, adj: s });
    spy.push({ d, close: m, adj: m });
  });
  return { stock, spy };
}
const hist = (symbol: string, bars: DailyBar[], extra: Partial<PriceHistory> = {}): PriceHistory => ({ symbol, currency: 'USD', instrumentType: 'EQUITY', exchangeTz: 'America/New_York', bars, dividends: [], splits: [], fetchedAt: NOW, ...extra });

describe('the session a bank snapshot stands for', () => {
  it('the morning sync in Israel carries the previous US close; weekends go back to Friday', () => {
    expect(bankSessionDate(Date.parse('2026-11-11T04:00:00Z'))).toBe('2026-11-10'); // Wednesday 06:00 Israel
    expect(bankSessionDate(Date.parse('2026-11-16T04:00:00Z'))).toBe('2026-11-13'); // Monday morning -> Friday
    expect(bankSessionDate(Date.parse('2026-11-15T07:00:00Z'))).toBe('2026-11-13'); // Sunday
    expect(bankSessionDate(Date.parse('2026-11-14T07:00:00Z'))).toBe('2026-11-13'); // Saturday
    expect(bankSessionDate(Date.parse('2026-11-02T04:00:00Z'))).toBe('2026-10-30'); // the Monday after the US switch
  });
  it('the close is 16:00 New York in both EDT (20:00Z) and EST (21:00Z)', () => {
    expect(bankSessionDate(Date.parse('2026-07-15T20:30:00Z'))).toBe('2026-07-15'); // EDT: closed at 20:00Z
    expect(bankSessionDate(Date.parse('2026-07-15T19:59:00Z'))).toBe('2026-07-14');
    expect(bankSessionDate(Date.parse('2026-11-11T20:30:00Z'))).toBe('2026-11-10'); // EST: not closed until 21:00Z
    expect(bankSessionDate(Date.parse('2026-11-11T21:00:00Z'))).toBe('2026-11-11');
    // spring: US clocks moved on 2026-03-08
    expect(bankSessionDate(Date.parse('2026-03-06T20:30:00Z'))).toBe('2026-03-05');
    expect(bankSessionDate(Date.parse('2026-03-09T20:30:00Z'))).toBe('2026-03-09');
    // Israel's clocks moved on 2026-10-25, New York's a week later: still the previous US close in the morning
    expect(bankSessionDate(Date.parse('2026-10-28T05:00:00Z'))).toBe('2026-10-27');
  });
});

describe('intraday snapshots', () => {
  it('09:30–16:05 New York on weekdays, in both EDT and EST', () => {
    expect(intradaySnapshot(Date.parse('2026-11-11T16:00:00Z'))).toBe(true); // 18:00 Israel, 11:00 New York
    expect(intradaySnapshot(Date.parse('2026-11-11T14:29:00Z'))).toBe(false); // 09:29 EST
    expect(intradaySnapshot(Date.parse('2026-11-11T14:30:00Z'))).toBe(true);
    expect(intradaySnapshot(Date.parse('2026-11-11T21:04:00Z'))).toBe(true); // 16:04, not settled
    expect(intradaySnapshot(Date.parse('2026-11-11T21:05:00Z'))).toBe(false);
    expect(intradaySnapshot(Date.parse('2026-07-15T13:30:00Z'))).toBe(true); // 09:30 EDT
    expect(intradaySnapshot(Date.parse('2026-07-15T20:05:00Z'))).toBe(false); // 16:05 EDT
    expect(intradaySnapshot(Date.parse('2026-11-14T16:00:00Z'))).toBe(false); // Saturday
    expect(intradaySnapshot(Date.parse('2026-11-11T04:00:00Z'))).toBe(false); // the morning sync
  });
});

describe('buildInsights', () => {
  const { stock, spy } = pair();
  const last = stock.at(-1)!;
  const nextMorning = new Date(Date.parse(`${last.d}T00:00:00Z`) + 86_400_000 + 4 * 3_600_000).toISOString();
  const row = { id: 7, symbol: 'TEST1', name: 'Test One Inc', currency: 'USD', price: last.close * 1.01, takenAt: nextMorning };

  it('the agreed shape, nothing about quantities or amounts', () => {
    const out = buildInsights(row, hist('TEST1', stock, { dividends: [{ d: '2020-01-02', amount: 0.5 }, { d: stock[1000]!.d, amount: 0.25 }], splits: [{ d: stock[500]!.d, ratio: '2:1' }] }), hist('SPY', spy, { instrumentType: 'ETF' }), NOW);
    expect(Object.keys(out).sort()).toEqual(['analysts', 'analystsUnavailableCode', 'asOf', 'benchmark', 'company', 'companyUnavailableCode', 'crossCheck', 'currency', 'earnings', 'events', 'fetchedAt', 'filings', 'id', 'instrumentType', 'name', 'returns', 'risk', 'sector', 'series', 'source', 'symbol', 'trend'].sort());
    expect(out).toMatchObject({ analysts: null, analystsUnavailableCode: 'off', earnings: null });
    expect(out).toMatchObject({ id: 7, symbol: 'TEST1', name: 'Test One Inc', currency: 'USD', asOf: last.d, fetchedAt: new Date(NOW).toISOString(), source: 'yahoo', instrumentType: 'EQUITY' });
    expect(Object.keys(out.trend).sort()).toEqual(['daysAboveSma200', 'daysAboveSma200IsLowerBound', 'fromHigh52Pct', 'fromLow52Pct', 'high52', 'low52', 'price', 'sma200', 'sma50', 'vsSma200Pct', 'vsSma50Pct']);
    expect(Object.keys(out.returns).sort()).toEqual(['m1', 'm3', 'm6', 'y1', 'y3Ann']);
    expect(Object.keys(out.risk).sort()).toEqual(['beta1y', 'maxDrawdown1y', 'maxDrawdown5y', 'volatility1y']);
    expect(out.series).toHaveLength(252);
    expect(Object.keys(out.series[0]!).sort()).toEqual(['c', 'd', 'sma200', 'sma50']);
    expect(out.series.at(-1)!.d).toBe(last.d);
    expect(out.events).toEqual({ dividends: [{ d: stock[1000]!.d, amount: 0.25 }], splits: [{ d: stock[500]!.d, ratio: '2:1' }] }); // the 2020 dividend is over 5 years old
    expect(JSON.stringify(out)).not.toMatch(/quantity|valueIls|valueOrig|cost|gain/i);
  });

  it('rounded figures: percents to 2 decimals, prices to 4, beta to 3; benchmark differences in points', () => {
    const out = buildInsights(row, hist('TEST1', stock), hist('SPY', spy), NOW);
    const r2 = (x: number) => Math.round(x * 100) / 100;
    const sr = returnsOf(stock.map((b) => b.adj));
    const mr = returnsOf(spy.map((b) => b.adj));
    expect(out.returns).toEqual({ m1: r2(sr.m1!), m3: r2(sr.m3!), m6: r2(sr.m6!), y1: r2(sr.y1!), y3Ann: r2(sr.y3Ann!) });
    expect(out.benchmark!.symbol).toBe('SPY');
    expect(out.benchmark!.returns.y1).toBe(r2(mr.y1!));
    const r1 = (x: number) => Math.round(x * 10) / 10;
    expect(out.benchmark!.diffPts.y1).toBe(r1(r1(sr.y1!) - r1(mr.y1!))); // from the 1-decimal values the app shows
    expect(out.risk.beta1y).toBe(2); // the stock moves twice the benchmark every day
    expect(out.risk.maxDrawdown5y).not.toBeNull();
    expect(out.trend.price).toBe(Math.round(last.close * 1e4) / 1e4);
    for (const v of [out.trend.vsSma50Pct, out.risk.volatility1y, out.trend.fromHigh52Pct]) expect(Number.isInteger(v! * 100) || Math.abs(v! * 100 - Math.round(v! * 100)) < 1e-6).toBe(true);
    expect(out.crossCheck).toEqual({ bankPrice: Math.round(last.close * 1.01 * 1e4) / 1e4, bankAt: nextMorning, yahooClose: Math.round(last.close * 1e4) / 1e4, yahooDate: last.d, diffPct: 1, ok: true, note: null });
  });

  it('the benchmark is cut at the holding’s last session', () => {
    const later = [...spy, { d: '2030-01-02', close: 1, adj: 1 }];
    const a = buildInsights(row, hist('TEST1', stock), hist('SPY', spy), NOW);
    const b = buildInsights(row, hist('TEST1', stock), hist('SPY', later), NOW);
    expect(b.benchmark).toEqual(a.benchmark);
    expect(b.risk.beta1y).toBe(a.risk.beta1y);
  });

  it('no SPY: benchmark and beta null, the rest stays', () => {
    const out = buildInsights(row, hist('TEST1', stock), null, NOW);
    expect(out.benchmark).toBeNull();
    expect(out.risk.beta1y).toBeNull();
    expect(out.returns.y1).not.toBeNull();
  });

  it('a short history: long windows are null, never computed from fewer sessions', () => {
    const short = stock.slice(-100);
    const out = buildInsights(row, hist('TEST1', short), hist('SPY', spy), NOW);
    expect(out.returns).toMatchObject({ m1: expect.any(Number), m3: expect.any(Number), m6: null, y1: null, y3Ann: null });
    expect(out.benchmark!.diffPts).toMatchObject({ m6: null, y1: null, y3Ann: null });
    expect(out.trend).toMatchObject({ sma200: null, daysAboveSma200: null, high52: null, low52: null });
    expect(out.risk).toEqual({ volatility1y: null, maxDrawdown1y: null, maxDrawdown5y: null, beta1y: null });
    expect(out.series).toHaveLength(100);
  });

  it('a bank price over 2% away is flagged', () => {
    const out = buildInsights({ ...row, price: last.close * 1.03 }, hist('TEST1', stock), null, NOW);
    expect(out.crossCheck).toMatchObject({ diffPct: 3, ok: false });
  });

  it('the unavailable answer: the bank price, empty sections, the reason', () => {
    const u = unavailableInsights(row, 'busy', NOW);
    expect(u).toMatchObject({ id: 7, symbol: 'TEST1', asOf: null, instrumentType: null, benchmark: null, series: [], events: { dividends: [], splits: [] }, unavailable: 'the price source is busy; try again later', unavailableCode: 'busy' });
    expect(u.crossCheck).toEqual({ bankPrice: Math.round(last.close * 1.01 * 1e4) / 1e4, bankAt: nextMorning, yahooClose: null, yahooDate: null, diffPct: null, ok: null, note: null });
    expect(buildInsights(row, hist('TEST1', []), null, NOW)).toMatchObject({ unavailableCode: 'invalid', unavailable: 'the price history failed validation' });
  });

  it('a snapshot taken during the US session (18:00 in Israel) is not compared', () => {
    const at = `${last.d}T16:00:00.000Z`; // 18:00 Israel, 11:00 New York in winter
    const out = buildInsights({ ...row, takenAt: at }, hist('TEST1', stock), null, NOW);
    expect(out.crossCheck).toEqual({ bankPrice: Math.round(last.close * 1.01 * 1e4) / 1e4, bankAt: at, yahooClose: null, yahooDate: null, diffPct: null, ok: null, note: 'intraday_snapshot' });
  });

  it('a stale SPY (no session on the holding’s last one) gives no benchmark and no beta', () => {
    const out = buildInsights(row, hist('TEST1', stock), hist('SPY', spy.slice(0, -1)), NOW);
    expect(out.benchmark).toBeNull();
    expect(out.risk.beta1y).toBeNull();
    expect(out.returns.y1).not.toBeNull();
  });
});

describe('step 2: sector benchmark and company sections', () => {
  const { stock, spy } = pair();
  const last = stock.at(-1)!;
  const row = { id: 7, symbol: 'TEST1', name: 'Test One Inc', currency: 'USD', price: last.close, takenAt: new Date(NOW).toISOString() };
  const fund = { symbol: 'XLK', name: 'Technology Select Sector SPDR Fund' };

  it('the sector fund over the same windows as SPY, with points of difference', () => {
    const out = buildInsights(row, hist('TEST1', stock), hist('SPY', spy), NOW, { fund, history: hist('XLK', spy, { instrumentType: 'ETF' }) });
    expect(out.sector).toEqual({ symbol: 'XLK', name: fund.name, returns: out.benchmark!.returns, diffPts: out.benchmark!.diffPts });
    expect(out.company).toBeNull();
    expect(out.companyUnavailableCode).toBe('off');
    expect(out.filings).toEqual([]);
  });

  it('no sector when the fund is stale, missing, or the holding is an ETF', () => {
    expect(buildInsights(row, hist('TEST1', stock), hist('SPY', spy), NOW, { fund, history: hist('XLK', spy.slice(0, -1)) }).sector).toBeNull();
    expect(buildInsights(row, hist('TEST1', stock), hist('SPY', spy), NOW, { fund, history: null }).sector).toBeNull();
    expect(buildInsights(row, hist('TEST1', stock, { instrumentType: 'ETF' }), hist('SPY', spy), NOW, { fund, history: hist('XLK', spy) }).sector).toBeNull();
  });

  it('withCompany: the section and filings, or the code (then no sector either); an ETF is never covered', () => {
    const base = buildInsights(row, hist('TEST1', stock), hist('SPY', spy), NOW, { fund, history: hist('XLK', spy) });
    const company = buildCompany({ cik: '0009999001', name: 'Test One Inc', sic: '3571', sicDescription: 'Electronic Computers' }, null, { price: 10, currency: 'USD' });
    const filing = { form: '8-K', filed: '2026-11-01', reportDate: '2026-10-30', title: 'Current report', items: ['2.02 Results of operations'], url: 'https://www.sec.gov/Archives/edgar/data/9999001/000999900126000001/' };
    const ok = withCompany(base, { company, filings: [filing] });
    expect(ok.company).toEqual(company);
    expect(ok.filings).toEqual([filing]);
    expect('companyUnavailableCode' in ok).toBe(false);
    expect(ok.sector?.symbol).toBe('XLK');
    for (const code of ['off', 'not_covered', 'busy', 'unreachable', 'invalid'] as const) {
      const x = withCompany(base, { code });
      expect(x).toMatchObject({ company: null, companyUnavailableCode: code, filings: [], sector: null });
    }
    const etf = withCompany(buildInsights(row, hist('TEST1', stock, { instrumentType: 'ETF' }), hist('SPY', spy), NOW), { company, filings: [filing] });
    expect(etf).toMatchObject({ company: null, companyUnavailableCode: 'not_covered', filings: [] });
    expect(unavailableInsights(row, 'busy', NOW)).toMatchObject({ company: null, companyUnavailableCode: 'off', filings: [], sector: null });
  });

  it('withAnalysts: the section and earnings, or the code (earnings may still show); an ETF never has them', () => {
    const base = buildInsights(row, hist('TEST1', stock), hist('SPY', spy), NOW);
    const m = { strongBuy: 5, buy: 10, hold: 8, sell: 1, strongSell: 1, total: 25, buyShare: 60, sellShare: 8 };
    const analysts: AnalystsSection = { period: '2026-11', ...m, prev3m: null, buyShareChange3mPts: null, fetchedAt: '2026-11-11T08:00:00.000Z', source: 'finnhub' };
    const earnings: EarningsSection = { next: { date: '2026-11-20', hour: 'amc', epsEstimate: 1.1 }, last: null, fetchedAt: '2026-11-11T08:00:00.000Z' };
    const ok = withAnalysts(base, { analysts, code: null, earnings });
    expect(ok).toMatchObject({ analysts, earnings });
    expect('analystsUnavailableCode' in ok).toBe(false);
    const few = withAnalysts(base, { analysts: null, code: 'too_few', earnings });
    expect(few).toMatchObject({ analysts: null, analystsUnavailableCode: 'too_few', earnings });
    expect(withAnalysts(base, { analysts: null, code: 'vault_locked', earnings: null })).toMatchObject({ analysts: null, analystsUnavailableCode: 'vault_locked', earnings: null });
    const etf = withAnalysts(buildInsights(row, hist('TEST1', stock, { instrumentType: 'ETF' }), hist('SPY', spy), NOW), { analysts, code: null, earnings });
    expect(etf).toMatchObject({ analysts: null, analystsUnavailableCode: 'not_covered', earnings: null });
    // the company step keeps them
    expect(withCompany(ok, { code: 'busy' })).toMatchObject({ analysts, earnings });
  });
});
