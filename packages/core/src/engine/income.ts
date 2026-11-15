/**
 * The Now screen's "what does the month rest on" (proposal research_notes/proposals/now-screen-and-limit.md §1–2):
 *
 *  - income kinds: regular (salary, recurring income) vs extra (freelance, gifts, cashback, unknown);
 *  - the month's income split into regular/extra × received/expected;
 *  - "without the extra": the forecast's left to spend on the regular income alone, with a tone;
 *  - the typical month (medians of the last complete months);
 *  - the large-extra rule: when extra income is more than 20% of the month's income, the weekly envelope and the
 *    month-end projection are computed on the regular part (the headline `left` never changes);
 *  - the explain terms, which sum exactly to the forecast's `left`.
 *
 * Pure functions only; hub/now.ts reads the database. All amounts in agorot.
 */
import { type Forecast, type ForecastState, median } from './forecast.js';

export type IncomeKind = 'regular' | 'extra';
export const INCOME_KINDS: readonly IncomeKind[] = ['regular', 'extra'];
export const SALARY_KEY = 'income.salary';
/** extra income above this share of the month's income moves the weekly envelope to the regular part */
export const LARGE_EXTRA_SHARE = 0.2;
/** "without the extra" within ±5% of the regular income reads as balanced */
export const BALANCED_SHARE = 0.05;
/** explain items per term; the rest is counted in `more` */
export const EXPLAIN_CAP = 50;
/** the typical month needs at least this many complete months with data, out of TYPICAL_WINDOW */
export const TYPICAL_MIN_MONTHS = 3;
export const TYPICAL_WINDOW = 6;

export function isIncomeKind(v: unknown): v is IncomeKind {
  return v === 'regular' || v === 'extra';
}

/** The default kind of an income category: salary and any category of a confirmed recurring income stream are regular. */
export function defaultIncomeKind(categoryKey: string | null, streamCategoryKeys: ReadonlySet<string>): IncomeKind {
  if (categoryKey === null) return 'extra';
  return categoryKey === SALARY_KEY || streamCategoryKeys.has(categoryKey) ? 'regular' : 'extra';
}

/**
 * The effective kind for each key: the owner's setting (income.kind.<key>) when valid, else the default.
 * `overrides` maps category key → stored value (anything but regular/extra is ignored).
 */
export function effectiveIncomeKinds(keys: Iterable<string>, streamCategoryKeys: ReadonlySet<string>, overrides: Readonly<Record<string, string | null | undefined>>): Record<string, IncomeKind> {
  const out: Record<string, IncomeKind> = {};
  for (const k of keys) {
    const o = overrides[k];
    out[k] = isIncomeKind(o) ? o : defaultIncomeKind(k, streamCategoryKeys);
  }
  return out;
}

/**
 * One payment's kind, first match wins:
 *  1. its own override (transaction.income_kind_override);
 *  2. the owner's explicit setting for its category (`explicitKeys`: keys with an income.kind.<key> setting);
 *  3. regular when it belongs to a confirmed recurring income stream (`stream`), whatever its category;
 *  4. its category's effective kind, else the default (unknown → extra).
 */
export function incomeKindOf(
  row: { categoryKey: string | null; override?: string | null; stream?: boolean },
  kinds: Readonly<Record<string, IncomeKind>>,
  streamCategoryKeys: ReadonlySet<string> = new Set(),
  explicitKeys: ReadonlySet<string> = new Set(),
): IncomeKind {
  if (isIncomeKind(row.override)) return row.override;
  if (row.categoryKey !== null && explicitKeys.has(row.categoryKey) && kinds[row.categoryKey]) return kinds[row.categoryKey]!;
  if (row.stream) return 'regular';
  if (row.categoryKey !== null && kinds[row.categoryKey]) return kinds[row.categoryKey]!;
  return defaultIncomeKind(row.categoryKey, streamCategoryKeys);
}

/** What incomeKindOf needs besides the row. */
export interface KindContext {
  kinds: Record<string, IncomeKind>;
  streamCategoryKeys?: ReadonlySet<string>;
  explicitKeys?: ReadonlySet<string>;
}

export interface ReceivedIncome {
  id: number;
  name: string;
  /** signed as the month counts it (refunds netted); normally positive */
  amount: number;
  date: string;
  categoryKey: string | null;
  override: IncomeKind | null;
  /** belongs to a confirmed recurring income stream */
  stream?: boolean;
  /** its category is in the income section (only those count toward the large-extra rule); default true */
  incomeCategory?: boolean;
}

export interface ExpectedIncome {
  name: string;
  amount: number;
  date: string;
  categoryKey: string | null;
  streamId: number | null;
  /** default true */
  incomeCategory?: boolean;
}

export interface ExtraItem {
  /** the transaction; null for an extra income that is still expected */
  id: number | null;
  name: string;
  amount: number;
  date: string;
  categoryKey: string | null;
  status: 'received' | 'expected';
  /** false for a positive row outside the income categories (a card credit, an uncategorised transfer in): it stays
   *  extra but does not count toward the large-extra rule */
  incomeCategory: boolean;
}

export interface IncomeSplit {
  regular: { received: number; expected: number };
  /** counted: the part of received + expected in income-section categories; the 20% rule uses it */
  extra: { received: number; expected: number; counted: number; items: ExtraItem[] };
  kinds: Record<string, IncomeKind>;
}

/** This month's income into regular/extra × received/expected. Extra items: largest first. */
export function splitIncome(received: ReceivedIncome[], expected: ExpectedIncome[], ctx: KindContext): IncomeSplit {
  const { kinds, streamCategoryKeys = new Set<string>(), explicitKeys = new Set<string>() } = ctx;
  const out: IncomeSplit = { regular: { received: 0, expected: 0 }, extra: { received: 0, expected: 0, counted: 0, items: [] }, kinds };
  for (const r of received) {
    if (incomeKindOf(r, kinds, streamCategoryKeys, explicitKeys) === 'regular') out.regular.received += r.amount;
    else {
      const incomeCategory = r.incomeCategory ?? true;
      out.extra.received += r.amount;
      if (incomeCategory) out.extra.counted += r.amount;
      out.extra.items.push({ id: r.id, name: r.name, amount: r.amount, date: r.date, categoryKey: r.categoryKey, status: 'received', incomeCategory });
    }
  }
  // expected slots belong to confirmed income streams: regular unless an explicit category setting says extra
  for (const e of expected) {
    if (incomeKindOf({ categoryKey: e.categoryKey, stream: e.streamId !== null }, kinds, streamCategoryKeys, explicitKeys) === 'regular') out.regular.expected += e.amount;
    else {
      const incomeCategory = e.incomeCategory ?? true;
      out.extra.expected += e.amount;
      if (incomeCategory) out.extra.counted += e.amount;
      out.extra.items.push({ id: null, name: e.name, amount: e.amount, date: e.date, categoryKey: e.categoryKey, status: 'expected', incomeCategory });
    }
  }
  out.extra.items.sort((a, b) => b.amount - a.amount || a.date.localeCompare(b.date));
  return out;
}

export type WithoutExtraTone = 'positive' | 'balanced' | 'short';

/**
 * Left to spend on the regular income alone: regular (received + expected) − committed − savings − variable spent,
 * the same terms as forecast.left. Tone: positive above +5% of the regular income, short below −5%, else balanced.
 */
export function withoutExtra(split: IncomeSplit, f: Pick<Forecast, 'committed' | 'savings' | 'variableSpent'>): { left: number; tone: WithoutExtraTone } {
  const regular = split.regular.received + split.regular.expected;
  const left = regular - f.committed.total - f.savings.total - f.variableSpent;
  return { left, tone: toneOf(left, regular) };
}

export function toneOf(left: number, regularIncome: number): WithoutExtraTone {
  const band = Math.abs(regularIncome) * BALANCED_SHARE;
  return left > band ? 'positive' : left < -band ? 'short' : 'balanced';
}

export interface MonthTotals {
  /** all income counted (refund-netted), positive */
  income: number;
  /** of it, regular by the same kinds */
  regularIncome: number;
  /** fixed + instalments, positive */
  fixed: number;
  /** refund-netted variable spend, positive */
  variable: number;
}

export interface TypicalMonth extends MonthTotals {
  months: number;
}

/** Medians over the complete months that have data (null entries = no data); null with fewer than three. */
export function typicalMonth(months: Array<MonthTotals | null>): TypicalMonth | null {
  const xs = months.filter((m): m is MonthTotals => m !== null).slice(0, TYPICAL_WINDOW);
  if (xs.length < TYPICAL_MIN_MONTHS) return null;
  const med = (f: (m: MonthTotals) => number) => median(xs.map(f))!;
  return { months: xs.length, income: med((m) => m.income), regularIncome: med((m) => m.regularIncome), fixed: med((m) => m.fixed), variable: med((m) => m.variable) };
}

export interface Spread {
  /** true when the weekly envelope and the projection were computed without the extra income */
  extraExcluded: boolean;
  /** the owner chose to spread the extra this month (spend.spreadExtra.<YYYY-MM> = true), so the card can offer the undo */
  extraIncluded: boolean;
  /** 'large_extra' whenever the extra is more than 20% of the month's income (also when spreading was chosen) */
  reason: 'large_extra' | null;
  /** the envelope and projection on all income, when they were replaced */
  weeklyAll: number | null;
  projectedAll: { end: number; lo: number; hi: number } | null;
  /** with a large extra (reason set): the forecast state and the weekly envelope on the regular part alone
   *  (weeklyRegular null when the regular part leaves nothing); null otherwise. forecast.state stays on all income. */
  stateRegular: ForecastState | null;
  weeklyRegular: number | null;
}

/**
 * The large-extra rule. When the month's extra income (received + expected) is more than 20% of its income and the
 * owner did not choose to spread it this month, the weekly envelope and the month-end projection are recomputed on
 * `withoutExtraLeft` (the band keeps its offsets); the old values move to weeklyAll / projectedAll. The headline
 * `left`, the state and everything else stay. Only for the current month (a finished month's end is a fact).
 */
export function applySpread(f: Forecast, split: IncomeSplit, withoutExtraLeft: number, spreadExtra: boolean): { forecast: Forecast; spread: Spread } {
  // only extra in income-section categories triggers the rule; the share is of all the month's income
  const total = split.regular.received + split.regular.expected + split.extra.received + split.extra.expected;
  const large = f.isCurrentMonth && total > 0 && split.extra.counted > LARGE_EXTRA_SHARE * total;
  if (!large) return { forecast: f, spread: { extraExcluded: false, extraIncluded: spreadExtra, reason: null, weeklyAll: null, projectedAll: null, stateRegular: null, weeklyRegular: null } };
  const envelope = withoutExtraLeft > 0 ? Math.round((withoutExtraLeft * 7) / f.daysLeft) : null;
  const stateRegular = stateOf(withoutExtraLeft, f.variable.remaining);
  if (spreadExtra) return { forecast: f, spread: { extraExcluded: false, extraIncluded: true, reason: 'large_extra', weeklyAll: null, projectedAll: null, stateRegular, weeklyRegular: envelope } };
  const end = withoutExtraLeft - f.variable.remaining;
  const shift = end - f.projected.end;
  return {
    forecast: {
      ...f,
      projected: { end, lo: f.projected.lo + shift, hi: f.projected.hi + shift, lo90: f.projected.lo90 + shift, hi90: f.projected.hi90 + shift },
      weekly: { ...f.weekly, envelope },
    },
    spread: { extraExcluded: true, extraIncluded: false, reason: 'large_extra', weeklyAll: f.weekly.envelope, projectedAll: { end: f.projected.end, lo: f.projected.lo, hi: f.projected.hi }, stateRegular, weeklyRegular: envelope },
  };
}

/** The forecast's state rule (engine/forecast.ts) applied to another `left`. */
export function stateOf(left: number, remaining: number): ForecastState {
  return left <= 0 ? 'short' : left < remaining ? 'tight' : 'comfortable';
}

export type ExplainKey =
  | 'income_regular_received'
  | 'income_regular_expected'
  | 'income_extra_received'
  | 'income_extra_expected'
  | 'fixed_paid'
  | 'fixed_expected'
  | 'installments_paid'
  | 'installments_expected'
  | 'savings_actual'
  | 'savings_planned'
  | 'variable_spent';

export const EXPLAIN_KEYS: readonly ExplainKey[] = [
  'income_regular_received',
  'income_regular_expected',
  'income_extra_received',
  'income_extra_expected',
  'fixed_paid',
  'fixed_expected',
  'installments_paid',
  'installments_expected',
  'savings_actual',
  'savings_planned',
  'variable_spent',
];

export interface ExplainItem {
  id: number | null;
  name: string;
  /** signed as it enters `left`: income positive, money out negative (a refund-netted row may differ) */
  amount: number;
  date: string | null;
  status: 'received' | 'expected' | 'paid';
}

export interface ExplainTerm {
  key: ExplainKey;
  /** signed as it enters `left`: the eleven terms sum exactly to forecast.left */
  amount: number;
  /** largest first (by absolute amount), at most EXPLAIN_CAP */
  items: ExplainItem[];
  /** items left out of the list (their amounts are still in `amount`) */
  more?: number;
}

/** Terms from their items (amount = the sum of every item, listed or not), in EXPLAIN_KEYS order. */
export function explainTerms(items: Partial<Record<ExplainKey, ExplainItem[]>>, cap = EXPLAIN_CAP): ExplainTerm[] {
  return EXPLAIN_KEYS.map((key) => {
    const all = [...(items[key] ?? [])].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount) || (a.date ?? '').localeCompare(b.date ?? ''));
    const term: ExplainTerm = { key, amount: all.reduce((a, i) => a + i.amount, 0), items: all.slice(0, cap) };
    if (all.length > cap) term.more = all.length - cap;
    return term;
  });
}
