/**
 * Pure helpers for the "left to spend" card (now-screen-and-limit.md §2, step 1): the regular | extra split bar,
 * the without-extra wording, a compact ₪ format and the check that the "how is this calculated" terms add up to
 * the headline. Money arrives in agorot, signed; nothing here rounds the data, only what is shown.
 */
import type { ExplainTerm, Forecast, IncomeSplit, SpreadInfo, WithoutExtra } from './types';

/**
 * The sentence under the headline (current month, not past months): which i18n key and which amounts (agorot;
 * `n` is a count). When a large extra is kept out of the weekly amount (`spread.extraExcluded`), it uses the
 * regular figures: `stateRegular` and `weeklyRegular`; with no weekly room on regular income it says so and gives
 * the figure with the extra, never "of ₪0". The overall 'short' formula stays as it is (it is about the headline).
 */
export type WeeklyLine =
  | { key: 'hero_formula'; i: number; c: number; v: number }
  | { key: 'tight_line'; r: number; b: number }
  | { key: 'this_week_of'; a: number; b: number; n: number }
  | { key: 'weekly_no_room_regular'; w: number }
  | { key: 'weekly_no_room_regular_only' };

export function weeklyLine(f: Pick<Forecast, 'state' | 'income' | 'committed' | 'savings' | 'variableSpent' | 'variable' | 'weekly'>, spread?: SpreadInfo): WeeklyLine {
  if (f.state === 'short') return { key: 'hero_formula', i: f.income.total, c: f.committed.total + f.savings.total, v: f.variableSpent };
  // a hub that sends `spread` without `weeklyRegular` predates it: its own envelope is used as before
  if (spread?.extraExcluded && spread.weeklyRegular !== undefined) {
    const weekly = spread.weeklyRegular;
    if (weekly === null || weekly <= 0 || spread.stateRegular === 'short') {
      return spread.weeklyAll !== null && spread.weeklyAll > 0 ? { key: 'weekly_no_room_regular', w: spread.weeklyAll } : { key: 'weekly_no_room_regular_only' };
    }
    if ((spread.stateRegular ?? f.state) === 'tight') return { key: 'tight_line', r: f.variable.remaining, b: weekly };
    return { key: 'this_week_of', a: f.weekly.spentThisWeek, b: weekly, n: f.weekly.weeksLeft };
  }
  if (f.state === 'tight') return { key: 'tight_line', r: f.variable.remaining, b: f.weekly.envelope ?? 0 };
  return { key: 'this_week_of', a: f.weekly.spentThisWeek, b: f.weekly.envelope ?? 0, n: f.weekly.weeksLeft };
}

export interface SplitPart {
  /** agorot, signed */
  amount: number;
  /** share of the bar, 0..100; a non-zero part never gets less than MIN_PART so it stays visible */
  pct: number;
  negative: boolean;
}

const MIN_PART = 3;

/**
 * The two parts of `left`: regular = what the month leaves without the extra income (can be negative), extra = the
 * extra income received + expected. The bar shows sizes (absolute values); a negative part is drawn as a shortfall.
 * Both zero: both 0%.
 */
export function splitParts(regular: number, extra: number): { regular: SplitPart; extra: SplitPart } {
  const ar = Math.abs(regular);
  const ae = Math.abs(extra);
  const total = ar + ae;
  if (total === 0) return { regular: { amount: regular, pct: 0, negative: false }, extra: { amount: extra, pct: 0, negative: false } };
  let pr = (ar / total) * 100;
  let pe = (ae / total) * 100;
  if (ar > 0 && pr < MIN_PART) {
    pr = MIN_PART;
    pe = 100 - MIN_PART;
  } else if (ae > 0 && pe < MIN_PART) {
    pe = MIN_PART;
    pr = 100 - MIN_PART;
  }
  return { regular: { amount: regular, pct: pr, negative: regular < 0 }, extra: { amount: extra, pct: pe, negative: extra < 0 } };
}

/** extra income received + expected this month (agorot) */
export function extraTotal(s: IncomeSplit): number {
  return s.extra.received + s.extra.expected;
}

/** all income received so far, and all still expected (regular + extra) */
export function incomeTotals(s: IncomeSplit): { received: number; expected: number } {
  return { received: s.regular.received + s.extra.received, expected: s.regular.expected + s.extra.expected };
}

/** The i18n key and amount for "without the extra income": left ₪X / about break-even (₪X, signed) / short by ₪X. */
export function withoutExtraText(w: WithoutExtra): { key: 'wx_positive' | 'wx_balanced' | 'wx_short'; amount: number; signed: boolean } {
  if (w.tone === 'short') return { key: 'wx_short', amount: Math.abs(w.left), signed: false };
  if (w.tone === 'balanced') return { key: 'wx_balanced', amount: w.left, signed: true };
  return { key: 'wx_positive', amount: w.left, signed: false };
}

/**
 * ₪31.4K, ₪940, ₪1.2M, −₪27.9K. Under ₪1,000 whole shekels; thousands and millions with one decimal, dropped when
 * it is .0 (₪28K). Rounds half away from zero on the shown digit.
 */
export function compactMoney(minor: number): string {
  const sign = minor < 0 ? '−' : '';
  const shekels = Math.abs(minor) / 100;
  const one = (v: number) => {
    const r = Math.round(v * 10) / 10;
    return Number.isInteger(r) ? String(r) : r.toFixed(1);
  };
  if (shekels < 1000) {
    const r = Math.round(shekels);
    if (r === 0) return '₪0'; // no "−₪0"
    if (r < 1000) return `${sign}₪${r}`;
  }
  if (shekels < 999_950) return `${sign}₪${one(shekels / 1000)}K`;
  return `${sign}₪${one(shekels / 1_000_000)}M`;
}

/**
 * The terms' sum and whether it matches the headline as shown (whole shekels): the sheet's "= ₪11,379 ✓".
 * `diff` is total − headline in agorot.
 */
export function explainCheck(terms: ExplainTerm[], headline: number): { total: number; ok: boolean; diff: number } {
  const total = terms.reduce((s, x) => s + x.amount, 0);
  return { total, ok: Math.round(total / 100) === Math.round(headline / 100), diff: total - headline };
}

/** the typical month's spending (fixed + day-to-day) as a positive amount, whatever sign the hub sends */
export function typicalExpense(t: { fixed: number; variable: number }): number {
  return Math.abs(t.fixed + t.variable);
}
