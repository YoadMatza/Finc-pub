/**
 * The monthly spending limit (proposal research_notes/proposals/now-screen-and-limit.md §3, build step 2):
 *
 *  - what it limits: the month's variable ("day-to-day") spending, refund-netted — the same number as
 *    forecast.variableSpent. Fixed bills, instalments and savings are not part of it;
 *  - pace: actual against the even-spread amount by today (amount × day ÷ days in month); within ±5% of the limit
 *    reads as "on pace";
 *  - this week's share: what is left of the limit, spread over the days from the week's start to the month's end,
 *    times the days of this Sunday–Saturday week inside the month;
 *  - carry-forward: a limit set for a month applies to every later month until another entry; 0 / null = off;
 *  - the category targets check: the sum of the variable groups' targets against the limit.
 *
 * Pure functions only; hub/limit.ts reads the database. All amounts in agorot.
 */

/** |spent − pace| within this share of the limit reads as "on pace" */
export const LIMIT_ON_PACE_SHARE = 0.05;

export type LimitPaceState = 'on' | 'ahead' | 'under';

export interface LimitStatus {
  amount: number;
  /** variable spent this month, refund-netted (forecast.variableSpent) */
  spent: number;
  /** spent ÷ amount × 100, one decimal */
  usedPct: number;
  /** byToday: the even-spread amount by today (the whole limit for a past month); delta: spent − byToday */
  pace: { byToday: number; delta: number; state: LimitPaceState };
  /** amount − spent; negative = over the limit */
  leftWithin: number;
  over: boolean;
  /** this Sunday–Saturday week (days inside the month only); null for a past month */
  week: { limit: number; spent: number } | null;
}

export interface LimitInput {
  amount: number;
  spent: number;
  month: string;
  today: string;
  dim: number;
  /** variable spent in the Sunday–Saturday week containing today, counting only days inside this month */
  spentThisWeek: number;
  /** the day of the month the current week starts (its Sunday, clamped to 1) */
  weekStartDay: number;
}

/** The limit card for `month`; null for a month after today's. */
export function limitStatus(input: LimitInput): LimitStatus | null {
  const { amount, spent, month, today, dim } = input;
  const thisMonth = today.slice(0, 7);
  if (month > thisMonth) return null;
  const past = month < thisMonth;
  const day = past ? dim : Number(today.slice(8, 10));
  const byToday = past ? amount : Math.round((amount * day) / dim);
  const delta = spent - byToday;
  const state: LimitPaceState = Math.abs(delta) <= amount * LIMIT_ON_PACE_SHARE ? 'on' : delta > 0 ? 'ahead' : 'under';
  let week: LimitStatus['week'] = null;
  if (!past) {
    const start = Math.max(1, Math.min(input.weekStartDay, day));
    const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = Sunday
    const end = Math.min(dim, day + (6 - dow));
    const weekDays = end - start + 1;
    const daysFromWeekStart = dim - start + 1;
    const spentBeforeWeek = spent - input.spentThisWeek;
    week = { limit: Math.max(0, Math.round(((amount - spentBeforeWeek) * weekDays) / daysFromWeekStart)), spent: input.spentThisWeek };
  }
  return {
    amount,
    spent,
    usedPct: amount > 0 ? Math.round((spent / amount) * 1000) / 10 : 0,
    pace: { byToday, delta, state },
    leftWithin: amount - spent,
    over: spent > amount,
    week,
  };
}

/**
 * The limit that applies to `month`: the latest entry at or before it (entries are per month, carried forward);
 * an entry of 0 or null means "off"; no entry → null.
 */
export function effectiveLimit(entries: ReadonlyArray<{ month: string; amount: number | null }>, month: string): number | null {
  let best: { month: string; amount: number | null } | null = null;
  for (const e of entries) if (e.month <= month && (best === null || e.month > best.month)) best = e;
  if (!best || best.amount === null || !(best.amount > 0)) return null;
  return best.amount;
}

/** The variable categories' targets against the limit; null when no target is set. */
export function targetsCheck(limit: number, variableTargetsSum: number | null): { sum: number; exceeds: boolean } | null {
  if (variableTargetsSum === null || !(variableTargetsSum > 0)) return null;
  return { sum: variableTargetsSum, exceeds: variableTargetsSum > limit };
}
