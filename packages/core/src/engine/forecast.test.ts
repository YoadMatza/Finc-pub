import { describe, expect, it } from 'vitest';
import { errorBand, forecastMonth, predictVariable } from './forecast.js';
import type { MonthSummary } from './summary.js';

const bucket = (count: number, sum: number) => ({ count, sum });
const summary = (over: Partial<MonthSummary> = {}): MonthSummary =>
  ({
    month: '2026-11',
    view: 'purchase',
    income: bucket(1, 1249700),
    expense: bucket(29, -970000),
    fixed: bucket(5, -740000),
    variable: bucket(24, -230000),
    installments: bucket(4, -320000),
    savings: bucket(0, 0),
    refundsNetted: 0,
    excluded: { settlements: bucket(0, 0), transfers: bucket(0, 0), refunds: bucket(0, 0), other: bucket(0, 0) },
    net: 1249700 - 740000 - 230000 - 320000,
    expectedFixed: [],
    expectedFixedRemaining: -150000 - 45000, // ₪1,500 of bills + the ₪450 pension slot
    expectedIncomeRemaining: 0,
    expectedInstallments: [],
    byAccount: [],
    byCategory: [],
    integrity: { bucketsSum: 0, nonExcludedSum: 0, ok: true, unmatchedSettlementDebits: [], pendingCount: 0 },
    ...over,
  }) as MonthSummary;

describe('forecast', () => {
  it('left to spend is cash in minus committed, savings and variable spent (a short month)', () => {
    const f = forecastMonth({ summary: summary(), today: '2026-11-09', variableHistory: [1310000, 1325400, 1298700], typicalByToday: 412300, spentThisWeek: 98000, expectedSavingsRemaining: -45000 });
    expect(f.income.total).toBe(1249700);
    expect(f.committed.fixedExpected).toBe(150000);
    expect(f.savings.planned).toBe(45000);
    expect(f.committed.total).toBe(740000 + 150000 + 320000);
    expect(f.roomBeforeVariable).toBe(1249700 - (740000 + 150000 + 320000) - 45000); // −₪53
    expect(f.left).toBe(f.roomBeforeVariable - 230000); // −₪2,353
    expect(f.state).toBe('short');
    expect(f.weekly.envelope).toBeNull();
    // blend: w = 9/30, pace = 230000·30/9
    const pace = Math.round((230000 * 30) / 9);
    const predicted = Math.round(0.3 * pace + 0.7 * 1310000);
    expect(f.variable.predicted).toBe(predicted);
    expect(f.projected.end).toBe(f.left - (predicted - 230000));
    expect(f.projected.lo).toBeLessThan(f.projected.end);
    expect(f.projected.hi).toBeGreaterThan(f.projected.end);
    expect(f.projected.lo90).toBeLessThan(f.projected.lo);
  });

  it('a comfortable month has a weekly envelope and no shortfall', () => {
    const f = forecastMonth({ summary: summary({ income: bucket(1, 2500000), variable: bucket(3, -50000) }), today: '2026-11-09', variableHistory: [600000, 650000, 580000], typicalByToday: 150000, spentThisWeek: 20000, expectedSavingsRemaining: -45000 });
    expect(f.left).toBeGreaterThan(0);
    expect(f.state).toBe('comfortable');
    expect(f.weekly.envelope).toBe(Math.round((f.left * 7) / 22));
  });

  it('a past month has no expectations and no band', () => {
    const f = forecastMonth({ summary: summary({ month: '2026-09' }), today: '2026-11-09', variableHistory: [], typicalByToday: null, spentThisWeek: 0, expectedSavingsRemaining: 0 });
    expect(f.isCurrentMonth).toBe(false);
    expect(f.committed.fixedExpected).toBe(0);
    expect(f.projected.lo).toBe(f.projected.end);
    expect(f.variable.remaining).toBe(0);
  });

  it('the blend never predicts below what is already spent and the band interpolates', () => {
    // w·pace equals spent by construction, so the blend is spent + (1−w)·med3 and never below spent
    const pv = predictVariable(900000, 10, 30, [500000]);
    expect(pv.predicted).toBe(Math.round((10 / 30) * 2700000 + (20 / 30) * 500000));
    expect(pv.predicted).toBeGreaterThanOrEqual(900000);
    expect(predictVariable(100000, 0, 30, []).predicted).toBe(100000);
    const b7 = errorBand(7);
    expect(b7.p25).toBeLessThan(0);
    expect(b7.p25).toBeGreaterThan(errorBand(5).p25);
    expect(errorBand(40)).toEqual(errorBand(25));
  });
});
