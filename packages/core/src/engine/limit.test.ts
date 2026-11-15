import { describe, expect, it } from 'vitest';
import { effectiveLimit, limitStatus, targetsCheck } from './limit.js';

// Hand-computed. November 2026 has 30 days and starts on a Sunday; 2026-11-12 is a Thursday (week Sun 8 – Sat 14).
// December 2026 starts on a Tuesday; 2026-12-03 is a Thursday (its week starts Sun 29 Nov → clamped to 1 Dec).
const nov = (today: string, spent: number, spentThisWeek = 0, weekStartDay = 8) => limitStatus({ amount: 600000, spent, month: '2026-11', today, dim: 30, spentThisWeek, weekStartDay });

describe('limitStatus: pace', () => {
  it('even-spread amount by today = round(amount × day ÷ dim)', () => {
    expect(nov('2026-11-12', 240000)!.pace).toEqual({ byToday: 240000, delta: 0, state: 'on' });
  });
  it('±5% of the limit (₪300) is still on pace; one agora past it is ahead / under', () => {
    expect(nov('2026-11-12', 270000)!.pace).toEqual({ byToday: 240000, delta: 30000, state: 'on' });
    expect(nov('2026-11-12', 270001)!.pace).toEqual({ byToday: 240000, delta: 30001, state: 'ahead' });
    expect(nov('2026-11-12', 210000)!.pace).toEqual({ byToday: 240000, delta: -30000, state: 'on' });
    expect(nov('2026-11-12', 209999)!.pace).toEqual({ byToday: 240000, delta: -30001, state: 'under' });
  });
});

describe('limitStatus: week share', () => {
  it('mid-month: (amount − spent before the week) × 7 days ÷ 23 days from the week start to the month end', () => {
    // spent before the week 250,000; left of the limit 350,000; 350,000 × 7 / 23 = 106,521.7 → 106,522
    expect(nov('2026-11-12', 300000, 50000)).toEqual({
      amount: 600000,
      spent: 300000,
      usedPct: 50,
      pace: { byToday: 240000, delta: 60000, state: 'ahead' },
      leftWithin: 300000,
      over: false,
      week: { limit: 106522, spent: 50000 },
    });
  });
  it('a week that starts in the previous month is clamped to the 1st: 5 days of 31', () => {
    const r = limitStatus({ amount: 620000, spent: 40000, month: '2026-12', today: '2026-12-03', dim: 31, spentThisWeek: 40000, weekStartDay: 1 })!;
    // 620,000 × 5 / 31 = 100,000; pace 620,000 × 3 / 31 = 60,000, delta −20,000 within 31,000
    expect(r.week).toEqual({ limit: 100000, spent: 40000 });
    expect(r.pace).toEqual({ byToday: 60000, delta: -20000, state: 'on' });
    expect(r.usedPct).toBe(6.5); // 6.45…
  });
  it('a week cut by the month end: 2 days of 2; over the limit → week share 0', () => {
    const r = nov('2026-11-30', 650000, 10000, 29)!;
    expect(r).toMatchObject({ over: true, leftWithin: -50000, usedPct: 108.3, pace: { byToday: 600000, delta: 50000, state: 'ahead' }, week: { limit: 0, spent: 10000 } });
  });
  it('last week, under the limit: the rest of the limit is the week share', () => {
    // before the week 500,000 → 100,000 left over 2 of 2 days
    expect(nov('2026-11-30', 520000, 20000, 29)!.week).toEqual({ limit: 100000, spent: 20000 });
  });
});

describe('limitStatus: other months', () => {
  it('a past month: pace is the whole limit, no week', () => {
    const r = limitStatus({ amount: 500000, spent: 480000, month: '2026-10', today: '2026-11-12', dim: 31, spentThisWeek: 0, weekStartDay: 8 })!;
    expect(r).toEqual({ amount: 500000, spent: 480000, usedPct: 96, pace: { byToday: 500000, delta: -20000, state: 'on' }, leftWithin: 20000, over: false, week: null });
    expect(limitStatus({ amount: 500000, spent: 400000, month: '2026-10', today: '2026-11-12', dim: 31, spentThisWeek: 0, weekStartDay: 8 })!.pace.state).toBe('under');
  });
  it('a future month: null', () => {
    expect(limitStatus({ amount: 500000, spent: 0, month: '2026-12', today: '2026-11-12', dim: 31, spentThisWeek: 0, weekStartDay: 1 })).toBeNull();
  });
});

describe('effectiveLimit: carry-forward', () => {
  const entries = [
    { month: '2026-12', amount: 700000 },
    { month: '2026-09', amount: 500000 },
    { month: '2026-10', amount: 0 },
  ];
  it('set in Sept, off in Oct, set again in Dec', () => {
    expect(effectiveLimit(entries, '2026-08')).toBeNull();
    expect(effectiveLimit(entries, '2026-09')).toBe(500000);
    expect(effectiveLimit(entries, '2026-10')).toBeNull();
    expect(effectiveLimit(entries, '2026-11')).toBeNull();
    expect(effectiveLimit(entries, '2026-12')).toBe(700000);
    expect(effectiveLimit(entries, '2027-01')).toBe(700000);
  });
  it('null entry = off; no entries = null', () => {
    expect(effectiveLimit([{ month: '2026-09', amount: 500000 }, { month: '2026-10', amount: null }], '2026-11')).toBeNull();
    expect(effectiveLimit([], '2026-11')).toBeNull();
  });
});

describe('targetsCheck', () => {
  it('the variable targets against the limit', () => {
    expect(targetsCheck(600000, 650000)).toEqual({ sum: 650000, exceeds: true });
    expect(targetsCheck(600000, 600000)).toEqual({ sum: 600000, exceeds: false });
    expect(targetsCheck(600000, null)).toBeNull();
    expect(targetsCheck(600000, 0)).toBeNull();
  });
});
