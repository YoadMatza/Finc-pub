import { describe, expect, it } from 'vitest';
import { compactMoney, explainCheck, extraTotal, incomeTotals, splitParts, typicalExpense, weeklyLine, withoutExtraText } from './nowCard';
import type { ExplainTerm, IncomeSplit } from './types';

const split: IncomeSplit = {
  regular: { received: 1_623_200, expected: 0 },
  extra: { received: 1_164_000, expected: 0, items: [{ id: 7, name: 'Freelance', amount: 1_164_000, date: '2026-11-09', categoryKey: 'freelance' }] },
  kinds: { salary: 'regular', freelance: 'extra' },
};

describe('splitParts', () => {
  it('shares by size, both positive', () => {
    const p = splitParts(3_000_00, 1_000_00);
    expect(p.regular.pct).toBe(75);
    expect(p.extra.pct).toBe(25);
    expect(p.regular.negative).toBe(false);
  });
  it('a negative regular part (−₪275 | +₪11,640) stays visible and is marked negative', () => {
    const p = splitParts(-27_500, 1_164_000);
    expect(p.regular.negative).toBe(true);
    expect(p.regular.amount).toBe(-27_500);
    expect(p.regular.pct).toBe(3); // 2.3% by size, raised to the minimum
    expect(p.extra.pct).toBe(97);
  });
  it('both negative: sizes by absolute value', () => {
    const p = splitParts(-100_00, -300_00);
    expect(p.regular.pct).toBe(25);
    expect(p.extra.pct).toBe(75);
    expect(p.extra.negative).toBe(true);
  });
  it('no extra: the regular part fills the bar; both zero: empty', () => {
    expect(splitParts(500_00, 0)).toEqual({ regular: { amount: 500_00, pct: 100, negative: false }, extra: { amount: 0, pct: 0, negative: false } });
    expect(splitParts(0, 0).regular.pct).toBe(0);
    expect(splitParts(0, 0).extra.pct).toBe(0);
  });
});

describe('income totals', () => {
  it('received and expected add regular and extra', () => {
    const s: IncomeSplit = { ...split, regular: { received: 100, expected: 40 }, extra: { ...split.extra, received: 10, expected: 5 } };
    expect(incomeTotals(s)).toEqual({ received: 110, expected: 45 });
    expect(extraTotal(s)).toBe(15);
  });
  it('a month with ₪27,872 received, nothing expected', () => {
    expect(incomeTotals(split)).toEqual({ received: 2_787_200, expected: 0 });
  });
});

describe('withoutExtraText', () => {
  it('positive: left ₪X', () => expect(withoutExtraText({ left: 150_000, tone: 'positive' })).toEqual({ key: 'wx_positive', amount: 150_000, signed: false }));
  it('balanced keeps the sign', () => expect(withoutExtraText({ left: -27_500, tone: 'balanced' })).toEqual({ key: 'wx_balanced', amount: -27_500, signed: true }));
  it('short shows the shortfall as a positive amount', () => expect(withoutExtraText({ left: -300_000, tone: 'short' })).toEqual({ key: 'wx_short', amount: 300_000, signed: false }));
});

describe('compactMoney', () => {
  it('under ₪1,000: whole shekels', () => {
    expect(compactMoney(0)).toBe('₪0');
    expect(compactMoney(94_049)).toBe('₪940');
    expect(compactMoney(-27_500)).toBe('−₪275');
  });
  it('thousands with one decimal, .0 dropped', () => {
    expect(compactMoney(3_140_000)).toBe('₪31.4K');
    expect(compactMoney(2_790_000)).toBe('₪27.9K');
    expect(compactMoney(2_800_000)).toBe('₪28K');
    expect(compactMoney(-1_164_000)).toBe('−₪11.6K');
    expect(compactMoney(99_960)).toBe('₪1K'); // ₪999.60 rounds to 1,000
  });
  it('millions', () => {
    expect(compactMoney(123_456_789)).toBe('₪1.2M');
    expect(compactMoney(99_999_000)).toBe('₪1M');
  });
});

describe('explainCheck', () => {
  const terms: ExplainTerm[] = [
    { key: 'income_regular_received', amount: 1_623_200, items: [] },
    { key: 'income_extra_received', amount: 1_164_000, items: [] },
    { key: 'fixed_paid', amount: -1_000_000, items: [] },
    { key: 'savings_actual', amount: -400_000, items: [] },
    { key: 'variable_spent', amount: -249_300, items: [] },
  ];
  it('adds the terms and matches the headline', () => {
    const c = explainCheck(terms, 1_137_900);
    expect(c.total).toBe(1_137_900);
    expect(c.ok).toBe(true);
    expect(c.diff).toBe(0);
  });
  it('matches in whole shekels as shown', () => expect(explainCheck(terms, 1_137_920).ok).toBe(true));
  it('flags a mismatch with the difference', () => {
    const c = explainCheck(terms, 1_147_900);
    expect(c.ok).toBe(false);
    expect(c.diff).toBe(-10_000);
  });
  it('no terms: total 0', () => expect(explainCheck([], 0)).toEqual({ total: 0, ok: true, diff: 0 }));
});

describe('typicalExpense', () => {
  it('fixed + variable as a positive amount, whichever sign the hub sends', () => {
    expect(typicalExpense({ fixed: -1_500_000, variable: -1_290_000 })).toBe(2_790_000);
    expect(typicalExpense({ fixed: 1_500_000, variable: 1_290_000 })).toBe(2_790_000);
  });
});

describe('compactMoney near zero', () => {
  it('amounts that round to ₪0 have no minus', () => {
    expect(compactMoney(-40)).toBe('₪0');
    expect(compactMoney(-49)).toBe('₪0');
    expect(compactMoney(-50)).toBe('−₪1');
  });
});

describe('weeklyLine', () => {
  const f = {
    state: 'comfortable' as const,
    income: { actual: 2_787_200, expected: 0, total: 2_787_200 },
    committed: { fixedActual: 0, fixedExpected: 0, installmentsActual: 0, installmentsExpected: 0, total: 1_000_000 },
    savings: { actual: 400_000, planned: 0, total: 400_000 },
    variableSpent: 249_300,
    variable: { med3: null, pace: 0, w: 0, predicted: 0, remaining: 500_000, typicalByToday: null },
    weekly: { envelope: 490_000, spentThisWeek: 5_300, weeksLeft: 3 },
  };
  const spread = { extraExcluded: true, reason: 'large_extra' as const, weeklyAll: 490_000, projectedAll: null };
  it('no spread rule: the forecast envelope as before', () => {
    expect(weeklyLine(f)).toEqual({ key: 'this_week_of', a: 5_300, b: 490_000, n: 3 });
    expect(weeklyLine({ ...f, state: 'tight' })).toEqual({ key: 'tight_line', r: 500_000, b: 490_000 });
  });
  it('extra kept out: the regular weekly figure and the regular state', () => {
    expect(weeklyLine(f, { ...spread, weeklyRegular: 120_000, stateRegular: 'comfortable' })).toEqual({ key: 'this_week_of', a: 5_300, b: 120_000, n: 3 });
    expect(weeklyLine(f, { ...spread, weeklyRegular: 30_000, stateRegular: 'tight' })).toEqual({ key: 'tight_line', r: 500_000, b: 30_000 });
  });
  it('no weekly room on regular income: says so, with the figure including the extra; never "of ₪0"', () => {
    expect(weeklyLine(f, { ...spread, weeklyRegular: null, stateRegular: 'short' })).toEqual({ key: 'weekly_no_room_regular', w: 490_000 });
    expect(weeklyLine(f, { ...spread, weeklyRegular: 0, stateRegular: 'tight' })).toEqual({ key: 'weekly_no_room_regular', w: 490_000 });
    expect(weeklyLine(f, { ...spread, weeklyAll: null, weeklyRegular: null })).toEqual({ key: 'weekly_no_room_regular_only' });
  });
  it('a hub without weeklyRegular: the old line', () => {
    expect(weeklyLine(f, spread)).toEqual({ key: 'this_week_of', a: 5_300, b: 490_000, n: 3 });
  });
  it('overall short keeps the formula', () => {
    expect(weeklyLine({ ...f, state: 'short' }, { ...spread, weeklyRegular: null })).toEqual({ key: 'hero_formula', i: 2_787_200, c: 1_400_000, v: 249_300 });
  });
});
