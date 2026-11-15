import { describe, expect, it } from 'vitest';
import type { DailyBar } from '../prices/history.js';
import { annualisedReturn, benchmarkReturns, beta, chartSeries, crossCheck, daysVsSma, daysVsSmaDetail, maxDrawdown, maxDrawdown5y, maxDrawdownOver, periodReturn, returnsOf, sma, smaSeries, trendOf, volatility } from './price.js';

/** n weekday dates from `start` (gaps on weekends only) */
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
const barsOf = (adj: number[], start = '2025-01-01', close?: number[]): DailyBar[] => weekdays(start, adj.length).map((d, i) => ({ d, adj: adj[i]!, close: close ? close[i]! : adj[i]! }));

describe('moving averages', () => {
  it('sma is the mean of the last n values, null when shorter', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toBe(4);
    expect(sma([1, 2, 3, 4, 5], 5)).toBe(3);
    expect(sma([1, 2], 3)).toBeNull();
    expect(sma([1, 2], 0)).toBeNull();
  });
  it('smaSeries is null before n values, then the rolling mean', () => {
    expect(smaSeries([1, 2, 3, 4], 2)).toEqual([null, 1.5, 2.5, 3.5]);
    expect(smaSeries([10, 20, 30], 3)).toEqual([null, null, 20]);
    expect(smaSeries([1, 2], 3)).toEqual([null, null]);
  });
  it('days above/below the average: counted back from the latest, negative below', () => {
    // averages (n=3) at indexes 2..6: 5, 11/3, 8/3, 2, 3; the last two closes (3, 4) are above, index 4 (2) is not
    expect(daysVsSma([5, 5, 5, 1, 2, 3, 4], 3)).toBe(2);
    // averages: 1, 7/3, 10/3, 4, 3; the last two (3, 2) are below, index 4 (4) is above
    expect(daysVsSma([1, 1, 1, 5, 4, 3, 2], 3)).toBe(-2);
    expect(daysVsSma([2, 2, 2], 3)).toBe(0);
    // the count stops where the average starts (a lower bound on a young history)
    expect(daysVsSma([1, 2, 3, 4], 3)).toBe(2);
    expect(daysVsSma([1, 2], 3)).toBeNull();
    // whether the streak reaches back to the first average (then the real streak may be longer)
    expect(daysVsSmaDetail([5, 5, 5, 1, 2, 3, 4], 3)).toEqual({ days: 2, lowerBound: false });
    expect(daysVsSmaDetail([1, 2, 3, 4], 3)).toEqual({ days: 2, lowerBound: true });
    expect(daysVsSmaDetail([2, 2, 2], 3)).toEqual({ days: 0, lowerBound: false });
    expect(daysVsSmaDetail([1, 2], 3)).toEqual({ days: null, lowerBound: false });
    expect(daysVsSma(Array.from({ length: 199 }, (_, i) => i + 1))).toBeNull();
    expect(daysVsSma(Array.from({ length: 200 }, (_, i) => i + 1))).toBe(1);
  });
});

describe('returns', () => {
  it('period return over n sessions needs n+1 bars', () => {
    expect(periodReturn([100, 110, 121], 2)).toBeCloseTo(21, 10);
    expect(periodReturn([100, 110, 121], 1)).toBeCloseTo(10, 10);
    expect(periodReturn([100, 110], 2)).toBeNull();
  });
  it('the 3-year return is annualised over 756 sessions (252 a year)', () => {
    const adj = new Array(757).fill(120);
    adj[0] = 100;
    adj[756] = 133.1; // +33.1% over three years = +10% a year
    expect(annualisedReturn(adj, 756)).toBeCloseTo(10, 10);
    expect(annualisedReturn(adj.slice(1), 756)).toBeNull();
  });
  it('returnsOf reads 21/63/126/252/756 sessions back; short history gives nulls', () => {
    const adj = Array.from({ length: 757 }, (_, i) => 100 + i); // last 856
    const r = returnsOf(adj);
    expect(r.m1).toBeCloseTo((856 / 835 - 1) * 100, 10);
    expect(r.m3).toBeCloseTo((856 / 793 - 1) * 100, 10);
    expect(r.m6).toBeCloseTo((856 / 730 - 1) * 100, 10);
    expect(r.y1).toBeCloseTo((856 / 604 - 1) * 100, 10);
    expect(r.y3Ann).toBeCloseTo((Math.cbrt(856 / 100) - 1) * 100, 10);
    expect(returnsOf(adj.slice(-100))).toEqual({ m1: expect.any(Number), m3: expect.any(Number), m6: null, y1: null, y3Ann: null });
    expect(returnsOf([100])).toEqual({ m1: null, m3: null, m6: null, y1: null, y3Ann: null });
  });
});

describe('volatility', () => {
  it('a constant series has none', () => {
    expect(volatility(new Array(253).fill(42))).toBe(0);
  });
  it('sample stdev of daily log returns, times sqrt(252), percent', () => {
    // ln(1.1) and ln(0.9): sd = |ln(1.1/0.9)| / sqrt(2) = 0.1418971; x 15.8745 = 225.2523%
    expect(volatility([100, 110, 99], 2)).toBeCloseTo(225.2522969955067, 8);
    // alternating 100/110 over 252 changes: mean 0, sd = ln(1.1) * sqrt(252/251) -> 151.6013%
    const alt = Array.from({ length: 253 }, (_, i) => (i % 2 ? 110 : 100));
    expect(volatility(alt)).toBeCloseTo(151.60131516785262, 8);
  });
  it('uses only the last 252 changes and needs 253 bars', () => {
    const calm = new Array(253).fill(50);
    expect(volatility([1, 1000, ...calm])).toBe(0);
    expect(volatility(calm.slice(1))).toBeNull();
  });
});

describe('max drawdown', () => {
  it('the deepest fall from a running high, with its peak and trough dates', () => {
    const b = barsOf([100, 120, 90, 130, 65, 70]);
    expect(maxDrawdown(b)).toEqual({ pct: -50, peakDate: b[3]!.d, troughDate: b[4]!.d });
    // 120 -> 90 alone is -25%
    expect(maxDrawdown(b.slice(0, 3))).toEqual({ pct: -25, peakDate: b[1]!.d, troughDate: b[2]!.d });
  });
  it('none on a rising series: 0, both dates the first bar', () => {
    const b = barsOf([1, 2, 3]);
    expect(maxDrawdown(b)).toEqual({ pct: 0, peakDate: b[0]!.d, troughDate: b[0]!.d });
    expect(maxDrawdown([])).toBeNull();
  });
  it('1 y window = last 253 bars; 5 y = the whole history, null under 1200 sessions', () => {
    const adj = [100, 10, ...new Array(253).fill(100)]; // the crash is outside the last 253 bars
    const b = barsOf(adj);
    expect(maxDrawdownOver(b, 252)).toEqual({ pct: 0, peakDate: b[2]!.d, troughDate: b[2]!.d });
    expect(maxDrawdownOver(b.slice(-252), 252)).toBeNull();
    expect(maxDrawdown5y(b)).toBeNull();
    const long = barsOf([200, 50, ...new Array(1198).fill(100)]);
    expect(maxDrawdown5y(long)).toEqual({ pct: -75, peakDate: long[0]!.d, troughDate: long[1]!.d });
  });
  it('reads adjusted closes: a dividend drop in the raw close is not a drawdown', () => {
    const b = barsOf([100, 100, 100], '2025-01-01', [102, 102, 100]);
    expect(maxDrawdown(b)!.pct).toBe(0);
  });
});

describe('beta', () => {
  it('cov/var of daily returns, hand-computed: 5/19', () => {
    // market +1%, -2%, +3%; stock +2%, -1%, 0%: cov = (1/3000)/2, var = (0.0038/3)/2 -> 1/3.8
    const m = barsOf([100, 101, 98.98, 101.9494]);
    const s = barsOf([100, 102, 100.98, 100.98]);
    expect(beta(s, m, 252, 2)).toBeCloseTo(5 / 19, 10);
  });
  it('a stock moving twice the market has beta 2; dates are intersected first', () => {
    const n = 300;
    const rm = Array.from({ length: n }, (_, i) => [0.01, -0.005, 0.002, -0.012, 0.007][i % 5]!);
    const mAdj = [100];
    const sAdj = [50];
    for (const r of rm) {
      mAdj.push(mAdj[mAdj.length - 1]! * (1 + r));
      sAdj.push(sAdj[sAdj.length - 1]! * (1 + 2 * r));
    }
    const m = barsOf(mAdj);
    const s = barsOf(sAdj);
    expect(beta(s, m)).toBeCloseTo(2, 10);
    // extra dates on either side (not shared) are ignored, whatever their values
    const sExtra = [...s, { d: '2099-01-01', adj: 1, close: 1 }].sort((a, b) => a.d.localeCompare(b.d));
    const mExtra = [...m.slice(0, 10), { d: '2024-12-31', adj: 9999, close: 9999 }, ...m.slice(10)].sort((a, b) => a.d.localeCompare(b.d));
    expect(beta(sExtra, mExtra)).toBeCloseTo(2, 10);
  });
  it('null with too few aligned changes or a flat benchmark', () => {
    const s = barsOf(Array.from({ length: 260 }, (_, i) => 100 + (i % 3)));
    const flat = barsOf(new Array(260).fill(100));
    expect(beta(s, flat)).toBeNull();
    // misaligned: the benchmark trades on other days entirely
    const other = barsOf(Array.from({ length: 260 }, (_, i) => 100 + (i % 2)), '2030-01-01');
    expect(beta(s, other)).toBeNull();
    // 239 aligned changes are not enough
    expect(beta(s.slice(-240), barsOf(Array.from({ length: 260 }, (_, i) => 100 + (i % 4))))).toBeNull();
  });
});

describe('trend', () => {
  it('price, averages, the 52-week range from raw closes', () => {
    const adj = Array.from({ length: 260 }, (_, i) => 100 + i); // 100..359
    const close = adj.map((a, i) => (i === 100 ? 900 : a)); // a raw spike inside the last 252 bars
    const t = trendOf(barsOf(adj, '2025-01-01', close))!;
    expect(t.price).toBe(359);
    expect(t.sma50).toBeCloseTo(334.5, 10); // mean of 310..359
    expect(t.sma200).toBeCloseTo(259.5, 10); // mean of 160..359
    expect(t.vsSma50Pct).toBeCloseTo((359 / 334.5 - 1) * 100, 10);
    expect(t.vsSma200Pct).toBeCloseTo((359 / 259.5 - 1) * 100, 10);
    expect(t.daysAboveSma200).toBe(61); // every bar since the average starts (index 199)
    expect(t.daysAboveSma200IsLowerBound).toBe(true);
    expect(t.high52).toBe(900);
    expect(t.low52).toBe(108); // the last 252 bars start at index 8
    expect(t.fromHigh52Pct).toBeCloseTo((359 / 900 - 1) * 100, 10);
    expect(t.fromLow52Pct).toBeCloseTo((359 / 108 - 1) * 100, 10);
  });
  it('short history: what needs more bars is null', () => {
    const t = trendOf(barsOf(new Array(60).fill(10)))!;
    expect(t).toEqual({ price: 10, sma50: 10, sma200: null, vsSma50Pct: 0, vsSma200Pct: null, daysAboveSma200: null, daysAboveSma200IsLowerBound: false, high52: null, low52: null, fromHigh52Pct: null, fromLow52Pct: null });
    expect(trendOf([])).toBeNull();
  });
  it('averages shown in the day’s own prices: adjusted mean x close/adj', () => {
    // a 2% dividend went ex on the last day: adjusted closes are 98 before (in today's terms), the raw close 100 before
    const adj = [...new Array(49).fill(98), 98];
    const close = [...new Array(49).fill(100), 98];
    const b = barsOf(adj, '2025-01-01', close);
    expect(trendOf(b)!.sma50).toBeCloseTo(98, 10);
    const s = chartSeries(b);
    expect(s).toHaveLength(50);
    expect(s[49]).toEqual({ d: b[49]!.d, c: 98, sma50: 98, sma200: null });
    expect(s[0]).toEqual({ d: b[0]!.d, c: 100, sma50: null, sma200: null });
  });
  it('a split inside the window does not move anything when the closes are split-adjusted (Yahoo’s)', () => {
    // 4:1 split half-way; Yahoo restates earlier closes, so the series is continuous
    const adj = Array.from({ length: 300 }, () => 25);
    const r = returnsOf(adj);
    expect(r.m6).toBe(0);
    expect(volatility(adj)).toBe(0);
    expect(maxDrawdownOver(barsOf(adj), 252)!.pct).toBe(0);
  });
  it('the chart has the last 252 sessions', () => {
    const b = barsOf(Array.from({ length: 300 }, (_, i) => 1 + i));
    const s = chartSeries(b);
    expect(s).toHaveLength(252);
    expect(s[0]!.d).toBe(b[48]!.d);
    expect(s[251]!.sma200).toBeCloseTo(sma(b.map((x) => x.adj), 200)!, 10);
  });
});

describe('cross-check with the bank', () => {
  const b = (d: string, close: number): DailyBar => ({ d, close, adj: close });
  const bars = [b('2026-11-05', 99), b('2026-11-06', 100), b('2026-11-09', 101), b('2026-11-10', 102)];
  const session = (d: string, intraday = false) => ({ expectedSession: () => d, intraday: () => intraday });
  const AT = '2026-11-11T04:00:00Z';
  it('compares with the expected session’s close and names it; more than 2% apart is not ok', () => {
    expect(crossCheck(102, AT, bars, session('2026-11-10'))).toEqual({ bankPrice: 102, bankAt: AT, yahooClose: 102, yahooDate: '2026-11-10', diffPct: 0, ok: true, note: null });
    expect(crossCheck(104.04, 'x', bars, session('2026-11-10')).ok).toBeNull(); // no time, nothing to compare
    expect(crossCheck(104.04, AT, bars, session('2026-11-10'))).toMatchObject({ diffPct: 2, ok: true }); // exactly 2% is ok
    expect(crossCheck(105, AT, bars, session('2026-11-10'))).toMatchObject({ diffPct: 2.94, ok: false });
    expect(crossCheck(97, AT, bars, session('2026-11-10'))).toMatchObject({ diffPct: -4.9, ok: false });
  });
  it('rounds the difference to 2 decimals and decides on the rounded value', () => {
    const c = [b('2026-11-10', 100)];
    expect(crossCheck(102.004, AT, c, session('2026-11-10'))).toMatchObject({ diffPct: 2, ok: true }); // 2.004 -> 2.00
    expect(crossCheck(102.006, AT, c, session('2026-11-10'))).toMatchObject({ diffPct: 2.01, ok: false });
    expect(crossCheck(97.996, AT, c, session('2026-11-10'))).toMatchObject({ diffPct: -2, ok: true });
  });
  it('a snapshot taken during the US session is not compared', () => {
    expect(crossCheck(102, AT, bars, session('2026-11-10', true))).toEqual({ bankPrice: 102, bankAt: AT, yahooClose: null, yahooDate: null, diffPct: null, ok: null, note: 'intraday_snapshot' });
  });
  it('a holiday uses the latest bar before it; a stale history is no match', () => {
    expect(crossCheck(100, '2026-11-08T04:00:00Z', bars, session('2026-11-07'))).toMatchObject({ yahooClose: 100, yahooDate: '2026-11-06' });
    expect(crossCheck(100, '2026-11-20T04:00:00Z', bars, session('2026-11-19'))).toMatchObject({ yahooClose: null, ok: null, note: null });
    expect(crossCheck(100, '2026-11-01T04:00:00Z', bars, session('2026-11-01'))).toMatchObject({ yahooClose: null, ok: null });
  });
  it('no bank price: nothing to compare', () => {
    expect(crossCheck(null, AT, bars, session('2026-11-10'))).toMatchObject({ bankPrice: null, yahooClose: null, diffPct: null, ok: null });
    expect(crossCheck(0, AT, bars, session('2026-11-10'))).toMatchObject({ bankPrice: null, ok: null });
  });
});

describe('benchmark returns over the holding’s dates', () => {
  it('uses the holding’s window start and end dates, not the benchmark’s session count', () => {
    const stock = barsOf(Array.from({ length: 30 }, (_, i) => 100 + i));
    // the benchmark lacks two sessions inside the 1-month window: a count of 21 sessions would start earlier
    const benchAll = barsOf(Array.from({ length: 30 }, (_, i) => 200 + 2 * i));
    const bench = benchAll.filter((_, i) => i !== 15 && i !== 20);
    const r = benchmarkReturns(stock, bench);
    // window: stock[8] .. stock[29] -> bench 216 .. 258
    expect(r.m1).toBeCloseTo((258 / 216 - 1) * 100, 10);
    expect(r.m3).toBeNull();
  });
  it('the start falls back to the latest benchmark session before it; no bar on the end date gives nulls', () => {
    const stock = barsOf(Array.from({ length: 22 }, (_, i) => 10 + i));
    const bench = barsOf(Array.from({ length: 22 }, (_, i) => 50 + i)).filter((_, i) => i !== 0);
    // stock window starts at index 0, which the benchmark lacks, and nothing earlier exists
    expect(benchmarkReturns(stock, bench).m1).toBeNull();
    const bench2 = barsOf(Array.from({ length: 23 }, (_, i) => 50 + i), '2024-12-31').filter((x) => x.d !== stock[0]!.d);
    expect(benchmarkReturns(stock, bench2).m1).toBeCloseTo((72 / 50 - 1) * 100, 10);
    expect(benchmarkReturns(stock, bench.slice(0, -1))).toEqual({ m1: null, m3: null, m6: null, y1: null, y3Ann: null });
  });
});
