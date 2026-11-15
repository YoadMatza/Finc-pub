import { describe, expect, it } from 'vitest';
import type { Forecast } from './forecast.js';
import {
  EXPLAIN_KEYS,
  type ExplainItem,
  applySpread,
  defaultIncomeKind,
  effectiveIncomeKinds,
  explainTerms,
  incomeKindOf,
  splitIncome,
  toneOf,
  typicalMonth,
  withoutExtra,
} from './income.js';

// fictional amounts, agorot
const forecast = (p: Partial<Forecast> = {}): Forecast => ({
  day: 10,
  dim: 30,
  daysLeft: 21,
  isCurrentMonth: true,
  early: false,
  income: { actual: 0, expected: 0, total: 0 },
  committed: { fixedActual: 400000, fixedExpected: 20000, installmentsActual: 25000, installmentsExpected: 30000, total: 475000 },
  savings: { actual: 100000, planned: 50000, total: 150000 },
  variableSpent: 52000,
  roomBeforeVariable: 0,
  left: 0,
  variable: { med3: 150000, pace: 156000, w: 1 / 3, predicted: 152000, remaining: 100000, typicalByToday: null },
  projected: { end: 1000000, lo: 900000, hi: 1100000, lo90: 800000, hi90: 1200000 },
  weekly: { envelope: 777000, spentThisWeek: 0, weeksLeft: 3 },
  state: 'comfortable',
  ...p,
});

describe('income kinds', () => {
  it('salary and categories of confirmed income streams are regular; everything else, unknown included, is extra', () => {
    const streams = new Set(['income.home_project']);
    expect(defaultIncomeKind('income.salary', new Set())).toBe('regular');
    expect(defaultIncomeKind('income.home_project', streams)).toBe('regular');
    for (const k of ['income.freelance', 'income.other', 'income.cashback', 'transfers.bit']) expect(defaultIncomeKind(k, streams)).toBe('extra');
    expect(defaultIncomeKind(null, streams)).toBe('extra');
  });

  it('a setting overrides the default per category; invalid values are ignored', () => {
    const kinds = effectiveIncomeKinds(['income.salary', 'income.freelance', 'income.other', 'income.cashback'], new Set(), { 'income.freelance': 'regular', 'income.salary': 'extra', 'income.other': 'sometimes' });
    expect(kinds).toEqual({ 'income.salary': 'extra', 'income.freelance': 'regular', 'income.other': 'extra', 'income.cashback': 'extra' });
  });

  it("a payment's own override wins over its category; a key outside the map falls back to the default", () => {
    const kinds = { 'income.salary': 'regular' as const, 'income.freelance': 'extra' as const };
    expect(incomeKindOf({ categoryKey: 'income.freelance', override: 'regular' }, kinds)).toBe('regular');
    expect(incomeKindOf({ categoryKey: 'income.salary', override: 'extra' }, kinds)).toBe('extra');
    expect(incomeKindOf({ categoryKey: 'income.salary', override: null }, kinds)).toBe('regular');
    expect(incomeKindOf({ categoryKey: 'income.other' }, kinds)).toBe('extra');
    expect(incomeKindOf({ categoryKey: 'income.other' }, kinds, new Set(['income.other']))).toBe('regular');
    expect(incomeKindOf({ categoryKey: null, override: 'bogus' }, kinds)).toBe('extra');
  });
});

describe('splitIncome', () => {
  const kinds = { 'income.salary': 'regular' as const, 'income.freelance': 'extra' as const, 'income.other': 'regular' as const };
  const received = [
    { id: 1, name: 'Employer Ltd', amount: 1500000, date: '2026-11-01', categoryKey: 'income.salary', override: null },
    { id: 2, name: 'Client A', amount: 1164000, date: '2026-11-09', categoryKey: 'income.freelance', override: null },
    { id: 3, name: 'Card cashback', amount: 5000, date: '2026-11-04', categoryKey: 'income.cashback', override: null },
    { id: 4, name: 'Client B', amount: 300000, date: '2026-11-06', categoryKey: 'income.freelance', override: 'regular' as const },
    { id: 5, name: 'Unknown', amount: 12000, date: '2026-11-07', categoryKey: null, override: null, incomeCategory: false },
  ];
  const expected = [
    { name: 'Rent from flat', amount: 300000, date: '2026-11-28', categoryKey: 'income.other', streamId: 7 },
    { name: 'Retainer', amount: 100000, date: '2026-11-20', categoryKey: 'income.freelance', streamId: 8 },
  ];

  it('splits regular/extra × received/expected and lists the extra items, largest first', () => {
    // income.freelance explicitly set to extra: its stream slot (Retainer) stays extra
    const s = splitIncome(received, expected, { kinds, explicitKeys: new Set(['income.freelance']) });
    expect(s.regular).toEqual({ received: 1800000, expected: 300000 });
    expect(s.extra.received).toBe(1181000);
    expect(s.extra.expected).toBe(100000);
    // the uncategorised 12,000 stays extra but does not count toward the large-extra rule
    expect(s.extra.counted).toBe(1181000 + 100000 - 12000);
    expect(s.extra.items).toEqual([
      { id: 2, name: 'Client A', amount: 1164000, date: '2026-11-09', categoryKey: 'income.freelance', status: 'received', incomeCategory: true },
      { id: null, name: 'Retainer', amount: 100000, date: '2026-11-20', categoryKey: 'income.freelance', status: 'expected', incomeCategory: true },
      { id: 5, name: 'Unknown', amount: 12000, date: '2026-11-07', categoryKey: null, status: 'received', incomeCategory: false },
      { id: 3, name: 'Card cashback', amount: 5000, date: '2026-11-04', categoryKey: 'income.cashback', status: 'received', incomeCategory: true },
    ]);
    expect(s.kinds).toBe(kinds);
    // nothing lost: the four parts add up to all income
    expect(s.regular.received + s.extra.received).toBe(received.reduce((a, r) => a + r.amount, 0));
    expect(s.regular.expected + s.extra.expected).toBe(400000);
  });

  it('confirmed income streams are regular unless the category is explicitly extra or the payment is overridden', () => {
    const s = splitIncome(
      [
        { id: 1, name: 'Tenant', amount: 300000, date: '2026-11-03', categoryKey: null, override: null, stream: true, incomeCategory: false },
        { id: 2, name: 'Tenant 2', amount: 200000, date: '2026-11-04', categoryKey: 'income.freelance', override: 'extra', stream: true },
      ],
      [{ name: 'Retainer', amount: 100000, date: '2026-11-20', categoryKey: 'income.freelance', streamId: 8 }],
      { kinds },
    );
    expect(s.regular).toEqual({ received: 300000, expected: 100000 });
    expect(s.extra.received).toBe(200000);
    expect(incomeKindOf({ categoryKey: 'income.freelance', stream: true }, kinds, new Set(), new Set(['income.freelance']))).toBe('extra');
    expect(incomeKindOf({ categoryKey: 'income.freelance', stream: true }, kinds)).toBe('regular');
  });

  it('an empty month splits to zeros', () => {
    expect(splitIncome([], [], { kinds: {} })).toEqual({ regular: { received: 0, expected: 0 }, extra: { received: 0, expected: 0, counted: 0, items: [] }, kinds: {} });
  });
});

describe('withoutExtra', () => {
  const split = (regular: number, extra = 0) => ({ regular: { received: regular, expected: 0 }, extra: { received: extra, expected: 0, counted: extra, items: [] }, kinds: {} });

  it('regular income minus the same committed, savings and variable terms as forecast.left', () => {
    // 1,800,000 − 475,000 − 150,000 − 52,000
    expect(withoutExtra(split(1800000, 2000000), forecast())).toEqual({ left: 1123000, tone: 'positive' });
  });

  it('tones: positive above +5% of regular income, balanced within ±5% (edges included), short below −5%', () => {
    expect(toneOf(50001, 1000000)).toBe('positive');
    expect(toneOf(50000, 1000000)).toBe('balanced');
    expect(toneOf(0, 1000000)).toBe('balanced');
    expect(toneOf(-50000, 1000000)).toBe('balanced');
    expect(toneOf(-50001, 1000000)).toBe('short');
    // no regular income: any surplus is positive, any gap is short
    expect(toneOf(1, 0)).toBe('positive');
    expect(toneOf(0, 0)).toBe('balanced');
    expect(toneOf(-1, 0)).toBe('short');
  });

  it('the ₪-275 month of the proposal reads as balanced on a ~₪16K regular income', () => {
    // regular 1,600,000; terms total 1,627,500 → left −27,500 (−1.7%)
    const f = forecast({ committed: { fixedActual: 900000, fixedExpected: 0, installmentsActual: 100000, installmentsExpected: 0, total: 1000000 }, savings: { actual: 300000, planned: 0, total: 300000 }, variableSpent: 327500 });
    expect(withoutExtra(split(1600000, 1164000), f)).toEqual({ left: -27500, tone: 'balanced' });
  });
});

describe('typicalMonth', () => {
  const m = (income: number, regularIncome: number, fixed: number, variable: number) => ({ income, regularIncome, fixed, variable });

  it('medians over the months with data', () => {
    const t = typicalMonth([m(3000000, 1500000, 800000, 500000), null, m(1600000, 1500000, 900000, 700000), m(1700000, 1600000, 850000, 2000000), null, m(1500000, 1500000, 820000, 600000)]);
    // four months: even count → mean of the middle two, rounded
    expect(t).toEqual({ months: 4, income: 1650000, regularIncome: 1500000, fixed: 835000, variable: 650000 });
  });

  it('one unusual month does not move the median', () => {
    const t = typicalMonth([m(1500000, 1500000, 800000, 600000), m(1500000, 1500000, 800000, 9000000), m(1500000, 1500000, 800000, 650000)]);
    expect(t).toEqual({ months: 3, income: 1500000, regularIncome: 1500000, fixed: 800000, variable: 650000 });
  });

  it('needs at least three months with data', () => {
    expect(typicalMonth([m(1, 1, 1, 1), m(2, 2, 2, 2), null, null, null, null])).toBeNull();
    expect(typicalMonth([])).toBeNull();
    expect(typicalMonth([m(1, 1, 1, 1), m(2, 2, 2, 2), m(4, 4, 4, 4)])).toEqual({ months: 3, income: 2, regularIncome: 2, fixed: 2, variable: 2 });
  });

  it('uses at most six months', () => {
    const xs = [1, 2, 3, 4, 5, 6, 100, 100].map((v) => m(v, v, v, v));
    expect(typicalMonth(xs)?.months).toBe(6);
    expect(typicalMonth(xs)?.income).toBe(4); // median of 1..6 = 3.5 → 4
  });
});

describe('applySpread (the large-extra rule)', () => {
  const split = (regular: number, extraReceived: number, extraExpected = 0) => ({ regular: { received: regular, expected: 0 }, extra: { received: extraReceived, expected: extraExpected, counted: extraReceived + extraExpected, items: [] }, kinds: {} });

  it('extra above 20% of the month: envelope and projection on the regular part, old values kept, left unchanged', () => {
    const f = forecast({ left: 2292000 });
    const r = applySpread(f, split(1800000, 1169000), 1123000, false);
    expect(r.spread).toEqual({ extraExcluded: true, extraIncluded: false, reason: 'large_extra', weeklyAll: 777000, projectedAll: { end: 1000000, lo: 900000, hi: 1100000 }, stateRegular: 'comfortable', weeklyRegular: 374333 });
    expect(r.forecast.left).toBe(2292000);
    expect(r.forecast.weekly.envelope).toBe(Math.round((1123000 * 7) / 21));
    // end = withoutExtra.left − variable still to come; the band keeps its offsets
    expect(r.forecast.projected).toEqual({ end: 1023000, lo: 923000, hi: 1123000, lo90: 823000, hi90: 1223000 });
    expect(r.forecast.state).toBe(f.state);
  });

  it('counts expected extra too, and is strict at exactly 20%', () => {
    expect(applySpread(forecast(), split(800000, 100000, 100000), 0, false).spread.extraExcluded).toBe(false); // 200k of 1M = 20%
    expect(applySpread(forecast(), split(799999, 100000, 100001), 0, false).spread.extraExcluded).toBe(true);
  });

  it('no envelope when the regular part leaves nothing', () => {
    const r = applySpread(forecast(), split(500000, 2000000), -27500, false);
    expect(r.forecast.weekly.envelope).toBeNull();
    expect(r.spread.weeklyAll).toBe(777000);
    // the state on the regular part says short even though forecast.state (all income) does not
    expect(r.spread).toMatchObject({ stateRegular: 'short', weeklyRegular: null });
    expect(r.forecast.state).toBe('comfortable');
    // tight: positive but below the variable still to come (100,000)
    expect(applySpread(forecast(), split(500000, 2000000), 60000, false).spread).toMatchObject({ stateRegular: 'tight', weeklyRegular: 20000 });
  });

  it('only extra in income categories triggers the rule', () => {
    const s = { regular: { received: 1000000, expected: 0 }, extra: { received: 600000, expected: 0, counted: 200000, items: [] }, kinds: {} };
    // 600,000 extra of 1,600,000 (37.5%), but only 200,000 (12.5%) in income categories
    expect(applySpread(forecast(), s, 0, false).spread.reason).toBeNull();
    expect(applySpread(forecast(), { ...s, extra: { ...s.extra, counted: 400000 } }, 0, false).spread.reason).toBe('large_extra');
  });

  it('spreadExtra for the month keeps everything on all income but still names the reason', () => {
    const f = forecast();
    const r = applySpread(f, split(1800000, 1169000), 1123000, true);
    expect(r.forecast).toBe(f);
    expect(r.spread).toEqual({ extraExcluded: false, extraIncluded: true, reason: 'large_extra', weeklyAll: null, projectedAll: null, stateRegular: 'comfortable', weeklyRegular: 374333 });
  });

  it('a small extra, no income or a finished month: unchanged', () => {
    const f = forecast();
    expect(applySpread(f, split(1800000, 300000), 0, false)).toEqual({ forecast: f, spread: { extraExcluded: false, extraIncluded: false, reason: null, weeklyAll: null, projectedAll: null, stateRegular: null, weeklyRegular: null } });
    expect(applySpread(f, split(0, 0), 0, false).spread.reason).toBeNull();
    const past = forecast({ isCurrentMonth: false });
    expect(applySpread(past, split(1800000, 1169000), 0, false).forecast).toBe(past);
  });
});

describe('explainTerms', () => {
  const item = (amount: number, i = 0): ExplainItem => ({ id: i, name: `row ${i}`, amount, date: `2026-11-${String((i % 28) + 1).padStart(2, '0')}`, status: 'paid' });

  it('all eleven terms in order; amount = sum of every item; largest first', () => {
    const t = explainTerms({ variable_spent: [item(-100, 1), item(-5000, 2), item(300, 3)], income_regular_received: [item(1000, 4)] });
    expect(t.map((x) => x.key)).toEqual([...EXPLAIN_KEYS]);
    const v = t.find((x) => x.key === 'variable_spent')!;
    expect(v.amount).toBe(-4800);
    expect(v.items.map((i) => i.amount)).toEqual([-5000, 300, -100]);
    expect(v.more).toBeUndefined();
    expect(t.find((x) => x.key === 'fixed_expected')).toEqual({ key: 'fixed_expected', amount: 0, items: [] });
  });

  it('caps the list at 50 and counts the rest, keeping their amounts in the term', () => {
    const many = Array.from({ length: 73 }, (_, i) => item(-(i + 1), i));
    const v = explainTerms({ variable_spent: many }).find((x) => x.key === 'variable_spent')!;
    expect(v.items).toHaveLength(50);
    expect(v.more).toBe(23);
    expect(v.amount).toBe(-((73 * 74) / 2));
    expect(v.items[0]!.amount).toBe(-73);
  });
});
