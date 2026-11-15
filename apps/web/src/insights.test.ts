import { describe, expect, it } from 'vitest';
import type { Key } from './i18n';
import { absPct, avgReading, axisNum, betaReading, buildChart, crossCheckNote, diffTone, drawdownView, insightsReady, lastYear, linePath, monthTicks, nearestIndex, niceTicks, ptsText, rangeReading, trendReadings, unavailableReason } from './insights';
import type { HoldingInsights, InsightPoint } from './types';

const t = (k: Key, vars?: Record<string, string | number>) => (vars ? `${k}(${Object.entries(vars).map(([a, b]) => `${a}=${b}`).join(',')})` : k);

/** n daily points from 2025-01-01, close = 100 + i, averages missing before index 3 / 5. */
const days = (n: number, start = '2025-01-01'): InsightPoint[] =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date(`${start}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return { d: d.toISOString().slice(0, 10), c: 100 + i, sma50: i >= 3 ? 100 + i - 1 : null, sma200: i >= 5 ? 100 + i - 2 : null };
  });

const box = { width: 200, height: 100, left: 0, right: 0, top: 0, bottom: 0 };

describe('number formatting', () => {
  it('absPct drops the sign', () => {
    expect(absPct(-12.345)).toBe('12.3%');
    expect(absPct(4)).toBe('4.0%');
    expect(absPct(null)).toBe('–');
    expect(absPct(Number.NaN)).toBe('–');
  });
  it('ptsText signs points and keeps zero unsigned', () => {
    expect(ptsText(8.14)).toBe('+8.1');
    expect(ptsText(-3)).toBe('−3.0');
    expect(ptsText(-0.01)).toBe('0.0');
    expect(ptsText(undefined)).toBe('–');
  });
  it('axisNum uses the decimals the step needs', () => {
    expect(axisNum(150, 10)).toBe('150');
    expect(axisNum(1250, 250)).toBe('1,250');
    expect(axisNum(100.5, 0.5)).toBe('100.5');
    expect(axisNum(2.25, 0.25)).toBe('2.25');
  });
});

describe('diffTone', () => {
  it('green when the stock beat SPY, red when not, muted when null or zero', () => {
    expect(diffTone(2.3)).toBe('pos');
    expect(diffTone(-0.4)).toBe('neg');
    expect(diffTone(0.04)).toBe('muted');
    expect(diffTone(null)).toBe('muted');
  });
});

describe('avgReading', () => {
  it('above with sessions', () => expect(avgReading(t, 200, 12.34, 41)).toBe('ins_avg_above(w=200,p=12.3%)ins_for_sessions(n=41)'));
  it('below uses the size of a negative day count', () => expect(avgReading(t, 200, -5, -12)).toBe('ins_avg_below(w=200,p=5.0%)ins_for_sessions(n=12)'));
  it('one session', () => expect(avgReading(t, 200, 1.2, 1)).toBe('ins_avg_above(w=200,p=1.2%)ins_for_session'));
  it('a lower bound says at least', () => expect(avgReading(t, 200, 3, 250, true)).toBe('ins_avg_above(w=200,p=3.0%)ins_for_sessions_min(n=250)'));
  it('zero days: no count', () => expect(avgReading(t, 200, 3, 0)).toBe('ins_avg_above(w=200,p=3.0%)'));
  it('no days (50-day)', () => expect(avgReading(t, 50, -2.5)).toBe('ins_avg_below(w=50,p=2.5%)'));
  it('at the average', () => expect(avgReading(t, 50, 0.02, 3)).toBe('ins_avg_at(w=50)'));
  it('null → nothing', () => expect(avgReading(t, 200, null, 10)).toBeNull());
});

describe('rangeReading', () => {
  it('both parts, sign ignored', () => expect(rangeReading(t, -8.2, 31)).toBe('ins_from_high(p=8.2%) · ins_from_low(p=31.0%)'));
  it('at the high', () => expect(rangeReading(t, 0, 40)).toBe('ins_at_high · ins_from_low(p=40.0%)'));
  it('only the low known', () => expect(rangeReading(t, null, 0)).toBe('ins_at_low'));
  it('nothing known', () => expect(rangeReading(t, null, null)).toBeNull());
});

describe('betaReading', () => {
  it('1.3 = about 1.3x the moves', () => expect(betaReading(t, 1.3)).toBe('ins_beta_times(b=1.30,x=1.3)'));
  it('0.8 = about 0.8x the moves', () => expect(betaReading(t, 0.8)).toBe('ins_beta_times(b=0.80,x=0.8)'));
  it('small positive = unrelated', () => expect(betaReading(t, 0.03)).toBe('ins_beta_unrelated(b=0.03)'));
  it('near 1 = like the market', () => expect(betaReading(t, 1.03)).toBe('ins_beta_same(b=1.03)'));
  it('negative = against the market', () => expect(betaReading(t, -0.4)).toBe('ins_beta_opposite(b=-0.40)'));
  it('about zero = unrelated', () => expect(betaReading(t, 0)).toBe('ins_beta_unrelated(b=0.00)'));
  it('null', () => expect(betaReading(t, null)).toBeNull());
});

describe('crossCheckNote', () => {
  const c = { bankPrice: 100, bankAt: '2026-11-10T07:00:00Z', yahooClose: 103, diffPct: 3, ok: false };
  it('a mismatch carries the date of the compared bar', () => {
    expect(crossCheckNote({ ...c, yahooDate: '2026-11-09' })).toEqual({ kind: 'mismatch', diffPct: 3, yahoo: 103, yahooDate: '2026-11-09', bank: 100, bankAt: '2026-11-10T07:00:00Z' });
    expect(crossCheckNote(c)).toMatchObject({ kind: 'mismatch', yahooDate: null });
  });
  it('an intraday bank price: the muted note', () => expect(crossCheckNote({ ...c, ok: null, note: 'intraday_snapshot' })).toEqual({ kind: 'intraday' }));
  it('nothing when ok or unknown', () => {
    expect(crossCheckNote({ ...c, ok: true })).toBeNull();
    expect(crossCheckNote({ ...c, ok: null })).toBeNull();
  });
});

describe('lastYear', () => {
  it('keeps the last 365 days, drops junk', () => {
    const s = days(500);
    const y = lastYear([...s, { d: 'bad', c: 1, sma50: null, sma200: null }]);
    expect(y[y.length - 1]!.d).toBe(s[499]!.d);
    expect(y.length).toBe(366);
  });
  it('empty', () => expect(lastYear([])).toEqual([]));
});

describe('niceTicks', () => {
  it('round steps covering the range', () => expect(niceTicks(101, 189, 4)).toEqual([100, 125, 150, 175, 200]));
  it('small prices', () => expect(niceTicks(2.13, 2.87, 4)).toEqual([2, 2.2, 2.4, 2.6, 2.8, 3]));
  it('flat range gets padding', () => {
    const ticks = niceTicks(50, 50);
    expect(ticks[0]).toBeLessThan(50);
    expect(ticks[ticks.length - 1]).toBeGreaterThan(50);
  });
});

describe('linePath', () => {
  const x = (i: number) => i * 10;
  const y = (v: number) => v;
  it('a gap starts a new segment', () => expect(linePath([1, 2, null, 4, 5], x, y)).toBe('M0.0,1.0L10.0,2.0M30.0,4.0L40.0,5.0'));
  it('all missing → empty', () => expect(linePath([null, null], x, y)).toBe(''));
});

describe('monthTicks', () => {
  it('month starts after the first point', () => {
    expect(monthTicks(days(70, '2025-01-15'), 10).map((m) => m.d)).toEqual(['2025-02-01', '2025-03-01']);
  });
  it('thins to the max, keeping the latest', () => {
    const m = monthTicks(days(366, '2025-01-01'), 4);
    expect(m.length).toBeLessThanOrEqual(4);
    expect(m[m.length - 1]!.d).toBe('2026-01-01');
  });
});

describe('buildChart', () => {
  it('scales x by index and y over all lines; oldest on the left', () => {
    const s = days(11); // closes 100..110, sma200 from index 5
    const m = buildChart(s, box, 2)!;
    expect(m.x(0)).toBe(0);
    expect(m.x(10)).toBe(200);
    const lo = m.yTicks[0]!;
    const hi = m.yTicks[m.yTicks.length - 1]!;
    expect(lo.y).toBe(100); // lowest tick at the bottom
    expect(hi.y).toBe(0);
    expect(lo.v).toBeLessThanOrEqual(100);
    expect(hi.v).toBeGreaterThanOrEqual(110);
    expect(m.close.startsWith('M0.0,')).toBe(true);
    expect(m.sma200.startsWith(`M${m.x(5).toFixed(1)},`)).toBe(true);
    expect(m.close.match(/M/g)!.length).toBe(1);
  });
  it('too few points → null', () => expect(buildChart(days(1), box)).toBeNull());
});

describe('nearestIndex', () => {
  it('maps a pointer to the nearest point, clamped', () => {
    expect(nearestIndex(0, 11, box)).toBe(0);
    expect(nearestIndex(101, 11, box)).toBe(5);
    expect(nearestIndex(-30, 11, box)).toBe(0);
    expect(nearestIndex(999, 11, box)).toBe(10);
  });
});

/** what the hub sends when it could not build the analytics: three nulls, the rest empty, the bank price kept */
const empty = { m1: null, m3: null, m6: null, y1: null, y3Ann: null };
const unavailable: HoldingInsights = {
  id: 7,
  symbol: 'ABCD',
  name: 'Abcd Inc',
  currency: 'USD',
  asOf: null,
  fetchedAt: '2026-11-11T12:00:00Z',
  source: 'yahoo',
  instrumentType: null,
  crossCheck: { bankPrice: 101.5, bankAt: '2026-11-11T07:00:00Z', yahooClose: null, diffPct: null, ok: null },
  trend: { price: null, sma50: null, sma200: null, vsSma50Pct: null, vsSma200Pct: null, daysAboveSma200: null, high52: null, low52: null, fromHigh52Pct: null, fromLow52Pct: null },
  returns: empty,
  benchmark: null,
  risk: { volatility1y: null, maxDrawdown1y: null, maxDrawdown5y: null, beta1y: null },
  series: [],
  events: { dividends: [], splits: [] },
  company: null,
  filings: [],
  sector: null,
  unavailable: 'no price history for this symbol',
};

const noReasonOf = ({ unavailable: _u, ...rest }: HoldingInsights): HoldingInsights => rest;

describe('an unavailable payload', () => {
  it('is not ready, so only the reason and the position are shown', () => {
    expect(insightsReady(unavailable)).toBe(false);
    expect(insightsReady(undefined)).toBe(false);
    // even without the reason, a missing session date is not drawn
    expect(insightsReady(noReasonOf(unavailable))).toBe(false);
  });
  it('every helper copes with its nulls', () => {
    expect(trendReadings(t, unavailable)).toEqual([]);
    expect(crossCheckNote(unavailable.crossCheck)).toBeNull();
    expect(buildChart(lastYear(unavailable.series), box)).toBeNull();
    expect(betaReading(t, unavailable.risk.beta1y)).toBeNull();
    expect(diffTone(unavailable.returns.y1)).toBe('muted');
  });
  it('a ready payload gives its readings (signed range: high ≤ 0, low ≥ 0; days negative when below)', () => {
    const ready: HoldingInsights = { ...noReasonOf(unavailable), asOf: '2026-11-10', instrumentType: 'EQUITY', trend: { ...unavailable.trend, price: 100, vsSma200Pct: -4.2, daysAboveSma200: -9, vsSma50Pct: 0, fromHigh52Pct: -10, fromLow52Pct: 20 } };
    expect(insightsReady(ready)).toBe(true);
    expect(trendReadings(t, ready)).toEqual(['ins_avg_below(w=200,p=4.2%)ins_for_sessions(n=9)', 'ins_avg_at(w=50)', 'ins_from_high(p=10.0%) · ins_from_low(p=20.0%)']);
  });
});

describe('drawdownView', () => {
  it('about zero = no drop, no dates', () => expect(drawdownView({ pct: -0.04, peakDate: '2026-01-01', troughDate: '2026-01-01' })).toEqual({ kind: 'none' }));
  it('a real drop keeps its dates', () => expect(drawdownView({ pct: -23.4, peakDate: '2026-01-02', troughDate: '2026-04-01' })).toEqual({ kind: 'drop', pct: -23.4, peakDate: '2026-01-02', troughDate: '2026-04-01' }));
  it('null', () => expect(drawdownView(null)).toBeNull());
});

describe('unavailableReason', () => {
  it('a known code is translated', () => expect(unavailableReason(t, { unavailable: 'Busy', unavailableCode: 'busy' })).toBe('ins_unav_busy'));
  it('an unknown code falls back to the English text', () => expect(unavailableReason(t, { unavailable: 'Something new', unavailableCode: 'weird' as never })).toBe('Something new'));
  it('no code: the text; nothing: null', () => {
    expect(unavailableReason(t, { unavailable: 'Off' })).toBe('Off');
    expect(unavailableReason(t, undefined)).toBeNull();
  });
});
