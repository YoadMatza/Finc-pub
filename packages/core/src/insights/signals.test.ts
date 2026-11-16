import { describe, expect, it } from 'vitest';
import type { CompanyFigure } from './company.js';
import { type HoldingInsights, unavailableInsights } from './panel.js';
import { signalsBoard } from './signals.js';

// stock decision aids Part E: deterministic readings, agreement, never a score

const fig = (value: number): CompanyFigure => ({ value, unit: '%', periodEnd: '2026-09-30', basis: 'ttm', form: '10-Q', filed: '2026-10-30', accn: 'x' });

function panel(over: Partial<HoldingInsights> = {}): HoldingInsights {
  const base = unavailableInsights({ id: 1, symbol: 'DEMO', name: 'Demo Corp', currency: 'USD', price: 100, takenAt: '2026-11-16T05:00:00Z' }, 'off', Date.parse('2026-11-16T05:00:00Z'));
  const series = Array.from({ length: 60 }, (_, i) => ({ d: `2026-0${1 + Math.floor(i / 28)}-${String(1 + (i % 28)).padStart(2, '0')}`, c: 100, sma50: 95, sma200: 80 + i * 0.2 }));
  const { unavailable: _u, unavailableCode: _c, ...rest } = base;
  return {
    ...rest,
    instrumentType: 'EQUITY',
    asOf: '2026-11-13',
    trend: { ...base.trend, price: 100, vsSma50Pct: 5, vsSma200Pct: 12 },
    series,
    benchmark: { symbol: 'SPY', returns: { m1: 1, m3: 2, m6: 4, y1: 10, y3Ann: 8 }, diffPts: { m1: 1, m3: 3, m6: 8, y1: 12, y3Ann: 2 } },
    company: { name: 'Demo Corp', cik: '0000000001', sic: null, sicDescription: null, currency: 'USD', figures: { revenueTtm: null, revenueYoYPct: fig(9), netIncomeTtm: null, netIncomeYoYPct: null, netMarginPct: fig(21), netMarginPct1yAgo: fig(20), netMarginPct3yAgo: null, epsTtm: null, pe: null, cash: null, totalDebt: null, financeLeases: null, debtToEquity: null, sharesOutstanding: null, sharesChange1yPct: null }, notes: [] },
    analysts: { period: '2026-11', strongBuy: 6, buy: 8, hold: 5, sell: 1, strongSell: 0, total: 20, buyShare: 70, sellShare: 5, prev3m: null, buyShareChange3mPts: null, fetchedAt: '2026-11-16T05:00:00Z', stale: false, source: 'finnhub' },
    ...over,
  };
}
const readings = (b: ReturnType<typeof signalsBoard>) => Object.fromEntries(b.signals.map((s) => [s.key, s.reading]));

describe('signals board', () => {
  it('reads each source by its rule and says the readings agree', () => {
    const b = signalsBoard(panel(), [{ state: 'applies' }, { state: 'clear' }, { state: 'unknown' }]);
    expect(readings(b)).toEqual({ trend: 'up', market: 'ahead', company: 'growing', analysts: 'positive', news: 'unavailable' });
    expect(b.agreement).toBe('agree');
    expect(b.rules).toEqual({ apply: 1, checked: 2, total: 3 });
    expect(b.signals.find((s) => s.key === 'news')?.why).toBe('not_built');
  });

  it('names the sides when the readings disagree', () => {
    const p = panel({ benchmark: { symbol: 'SPY', returns: { m1: 0, m3: 0, m6: 0, y1: 0, y3Ann: 0 }, diffPts: { m1: 0, m3: 0, m6: -9, y1: -15, y3Ann: 0 } } });
    const b = signalsBoard(p);
    expect(readings(b).market).toBe('behind');
    expect(b.agreement).toBe('disagree');
    expect(b.unfavourable).toEqual(['market']);
    expect(b.favourable).toEqual(['trend', 'company', 'analysts']);
  });

  it('mixed and in-line readings are neutral; a falling 200-day average is not "up"', () => {
    const base = panel();
    const p = panel({
      series: base.series.map((x, i) => ({ ...x, sma200: 100 - i * 0.2 })),
      benchmark: { symbol: 'SPY', returns: base.benchmark!.returns, diffPts: { m1: 0, m3: 0, m6: 8, y1: 2, y3Ann: 0 } },
      analysts: { ...base.analysts!, buyShare: 40, sellShare: 10 },
    });
    expect(readings(signalsBoard(p))).toMatchObject({ trend: 'mixed', market: 'in_line', analysts: 'mixed' });
  });

  it('missing data is "unavailable", never a guess; an ETF has no company or analysts reading', () => {
    const p = panel({ trend: { ...panel().trend, vsSma50Pct: null }, analysts: null, company: null });
    expect(readings(signalsBoard(p))).toMatchObject({ trend: 'unavailable', analysts: 'unavailable', company: 'unavailable' });
    const etf = signalsBoard(panel({ instrumentType: 'ETF' }));
    expect(etf.signals.filter((s) => s.why === 'etf').map((s) => s.key)).toEqual(['company', 'analysts']);
    // with one directional reading left there is nothing to agree about
    expect(signalsBoard(panel({ trend: { ...panel().trend, vsSma50Pct: null }, analysts: null, company: null, benchmark: null })).agreement).toBe('none');
  });

  it('an unavailable panel reads unavailable everywhere', () => {
    const b = signalsBoard(unavailableInsights({ id: 1, symbol: 'X', name: 'X', currency: 'USD', price: null, takenAt: '2026-11-16T05:00:00Z' }, 'unreachable', Date.now()));
    expect(b.signals.every((s) => s.reading === 'unavailable')).toBe(true);
    expect(b.agreement).toBe('none');
  });
});
