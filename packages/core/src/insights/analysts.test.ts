import { describe, expect, it } from 'vitest';
import { israelDate, summarizeAnalysts, summarizeEarnings } from './analysts.js';
import type { EarningsRow, RecommendationRow } from './finnhub.js';

// Fictional counts and dates.
const AT = '2026-11-11T08:00:00.000Z';
const r = (period: string, strongBuy: number, buy: number, hold: number, sell: number, strongSell: number): RecommendationRow => ({ period, strongBuy, buy, hold, sell, strongSell });
const e = (date: string, epsActual: number | null, epsEstimate: number | null = 1, hour: EarningsRow['hour'] = 'amc'): EarningsRow => ({ date, hour, epsEstimate, epsActual, quarter: 1, year: 2026 });

describe('summarizeAnalysts', () => {
  it('the newest month with counts, total and shares; the month 3 months earlier and the change in points', () => {
    const rows = [r('2026-09-01', 3, 9, 8, 1, 0), r('2026-08-01', 2, 8, 10, 2, 0), r('2026-11-01', 5, 10, 8, 1, 1), r('2026-10-01', 4, 10, 8, 1, 1)];
    const s = summarizeAnalysts(rows, '2026-11-11', AT);
    expect(s).toEqual({
      ok: true,
      analysts: {
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
        fetchedAt: AT,
        stale: false,
        source: 'finnhub',
      },
    });
  });

  it('prev3m: the closest period within ±20 days of 3 calendar months back; none in range → null', () => {
    // mid-month periods: 3 months before 2026-11-15 is 2026-08-15; 2026-08-01 is 14 days off, 2026-09-01 17 days
    const near = summarizeAnalysts([r('2026-11-15', 1, 2, 1, 0, 0), r('2026-09-01', 0, 1, 3, 0, 0), r('2026-08-01', 0, 2, 2, 0, 0)], '2026-11-20', AT);
    expect(near.ok && near.analysts.prev3m?.period).toBe('2026-08');
    // a gap in the list: only 2026-06 and the newest → nothing near 2026-08
    const gap = summarizeAnalysts([r('2026-11-01', 1, 2, 1, 0, 0), r('2026-06-01', 0, 2, 2, 0, 0)], '2026-11-11', AT);
    expect(gap).toMatchObject({ ok: true, analysts: { prev3m: null, buyShareChange3mPts: null } });
    // the month-end clamp: 3 months before 2026-05-31 is 2026-02-28
    const clamp = summarizeAnalysts([r('2026-05-31', 1, 2, 1, 0, 0), r('2026-03-01', 0, 2, 2, 0, 0)], '2026-06-02', AT);
    expect(clamp.ok && clamp.analysts.prev3m?.period).toBe('2026-03');
  });

  it('prev3m with fewer than 3 analysts is left out (the change would mean little)', () => {
    const s = summarizeAnalysts([r('2026-11-01', 1, 2, 1, 0, 0), r('2026-08-01', 0, 1, 1, 0, 0)], '2026-11-11', AT);
    expect(s).toMatchObject({ ok: true, analysts: { total: 4, buyShare: 75, prev3m: null, buyShareChange3mPts: null } });
  });

  it('toward sell: a negative change; shares are rounded to 1 decimal and the change is taken from the shown shares', () => {
    const s = summarizeAnalysts([r('2026-11-01', 0, 1, 1, 1, 0), r('2026-08-01', 1, 1, 1, 0, 0)], '2026-11-11', AT);
    expect(s).toMatchObject({ ok: true, analysts: { buyShare: 33.3, sellShare: 33.3, prev3m: { buyShare: 66.7, sellShare: 0 }, buyShareChange3mPts: -33.4 } });
  });

  it('fewer than 3 analysts: too_few; no rows or a newest month over 100 days old: not_covered', () => {
    expect(summarizeAnalysts([r('2026-11-01', 0, 1, 1, 0, 0), r('2026-08-01', 3, 3, 3, 0, 0)], '2026-11-11', AT)).toEqual({ ok: false, code: 'too_few' });
    expect(summarizeAnalysts([r('2026-11-01', 0, 0, 0, 0, 0)], '2026-11-11', AT)).toEqual({ ok: false, code: 'too_few' });
    expect(summarizeAnalysts([], '2026-11-11', AT)).toEqual({ ok: false, code: 'not_covered' });
    expect(summarizeAnalysts([r('2026-07-01', 3, 3, 3, 0, 0)], '2026-11-11', AT)).toEqual({ ok: false, code: 'not_covered' });
    expect(summarizeAnalysts([r('2026-08-01', 3, 3, 3, 0, 0)], '2026-11-08', AT).ok).toBe(true); // 99 days
  });
});

describe('summarizeEarnings', () => {
  const rows = [e('2026-04-28', 0.9, 1), e('2026-07-28', 1.32, 1.2), e('2026-10-27', 0.8, -0.5, 'bmo'), e('2027-01-26', null, 1.4, null), e('2027-04-27', null, 1.5)];

  it('next: the earliest without an actual, today or later within 120 days; last: the latest with an actual; the surprise', () => {
    expect(summarizeEarnings(rows, '2026-11-11', AT)).toEqual({
      next: { date: '2027-01-26', hour: null, epsEstimate: 1.4 },
      // (0.8 − (−0.5)) / 0.5 × 100
      last: { date: '2026-10-27', epsActual: 0.8, epsEstimate: -0.5, surprisePct: 260 },
      fetchedAt: AT,
      stale: false,
    });
    expect(summarizeEarnings(rows, '2026-11-11', AT, true).stale).toBe(true);
    expect(summarizeAnalysts([r('2026-11-01', 3, 3, 3, 0, 0)], '2026-11-11', AT, true)).toMatchObject({ ok: true, analysts: { stale: true } });
  });

  it('a report today: next until its actual is in, then last; beyond 120 days there is no next', () => {
    expect(summarizeEarnings([e('2026-11-11', null)], '2026-11-11', AT).next?.date).toBe('2026-11-11');
    expect(summarizeEarnings([e('2026-11-11', 1.1, 1)], '2026-11-11', AT)).toMatchObject({ next: null, last: { date: '2026-11-11', surprisePct: 10 } });
    expect(summarizeEarnings([e('2027-03-12', null)], '2026-11-11', AT).next).toBeNull(); // 121 days
    expect(summarizeEarnings([e('2027-03-11', null)], '2026-11-11', AT).next?.date).toBe('2027-03-11'); // 120 days
    // a past date still without an actual is neither
    expect(summarizeEarnings([e('2026-11-01', null)], '2026-11-11', AT)).toEqual({ next: null, last: null, fetchedAt: AT, stale: false });
    // only future reports (the free plan may return little history): last is simply null
    expect(summarizeEarnings([e('2026-12-01', null)], '2026-11-11', AT)).toMatchObject({ next: { date: '2026-12-01' }, last: null });
    expect(summarizeEarnings([], '2026-11-11', AT)).toEqual({ next: null, last: null, fetchedAt: AT, stale: false });
  });

  it('no surprise without an estimate or when |estimate| < 0.05; 1 decimal', () => {
    expect(summarizeEarnings([e('2026-10-27', 0.1, 0.04)], '2026-11-11', AT).last?.surprisePct).toBeNull();
    expect(summarizeEarnings([e('2026-10-27', 0.1, -0.049)], '2026-11-11', AT).last?.surprisePct).toBeNull();
    expect(summarizeEarnings([e('2026-10-27', 0.1, 0.05)], '2026-11-11', AT).last?.surprisePct).toBe(100);
    expect(summarizeEarnings([e('2026-10-27', 1.2, null)], '2026-11-11', AT).last).toEqual({ date: '2026-10-27', epsActual: 1.2, epsEstimate: null, surprisePct: null });
    expect(summarizeEarnings([e('2026-10-27', 1.2, 0)], '2026-11-11', AT).last?.surprisePct).toBeNull();
    expect(summarizeEarnings([e('2026-10-27', 1, 3)], '2026-11-11', AT).last?.surprisePct).toBe(-66.7);
  });

  it('today is the Israel date: 23:30Z on the 10th is already the 11th in Jerusalem', () => {
    expect(israelDate(Date.parse('2026-11-10T22:30:00Z'))).toBe('2026-11-11');
    expect(israelDate(Date.parse('2026-11-10T21:59:00Z'))).toBe('2026-11-10');
    const t = israelDate(Date.parse('2026-11-10T22:30:00Z'));
    expect(summarizeEarnings([e('2026-11-10', null), e('2026-11-11', null)], t, AT).next?.date).toBe('2026-11-11');
  });
});
