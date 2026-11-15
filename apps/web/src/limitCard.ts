/**
 * Pure helpers for the monthly spending limit card (now-screen-and-limit.md §3, step 2): which lines the card shows
 * and with which amounts, the bar fill and the pace marker, and parsing the amount typed in shekels. Money arrives
 * in agorot; nothing here rounds the data, only what is shown. Wording stays descriptive ("₪X ahead of pace").
 */
import type { SpendLimit } from './types';

export type PaceLine = { key: 'limit_pace_on' } | { key: 'limit_pace_ahead' | 'limit_pace_under'; x: number };
export type LeftLine = { key: 'limit_left_within'; x: number } | { key: 'limit_over_by'; x: number };

export interface LimitLines {
  /** "Day-to-day spending: ₪{spent} of ₪{amount}" */
  headline: { spent: number; amount: number };
  pace: PaceLine;
  left: LeftLine;
  /** true when spending is past the limit */
  over: boolean;
  /** "this week: ₪{spent} of ₪{limit}"; null for a past month */
  week: { spent: number; limit: number } | null;
  /** bar fill, 0..100 */
  fillPct: number;
  /** where spending would be today if spread evenly, 0..100 of the bar */
  markerPct: number;
  /** ahead of pace or over the limit read warm; on / under pace neutral */
  tone: 'warm' | 'neutral';
  /** the category targets' sum when it is more than the limit; null otherwise */
  targetsOver: number | null;
}

const clamp = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0);

export function limitLines(l: SpendLimit): LimitLines {
  const over = l.over || l.leftWithin < 0;
  const pace: PaceLine = l.pace.state === 'on' ? { key: 'limit_pace_on' } : { key: l.pace.state === 'ahead' ? 'limit_pace_ahead' : 'limit_pace_under', x: Math.abs(l.pace.delta) };
  const left: LeftLine = over ? { key: 'limit_over_by', x: Math.abs(l.leftWithin) } : { key: 'limit_left_within', x: l.leftWithin };
  return {
    headline: { spent: l.spent, amount: l.amount },
    pace,
    left,
    over,
    week: l.week ? { spent: l.week.spent, limit: l.week.limit } : null,
    fillPct: l.amount > 0 ? clamp((l.spent / l.amount) * 100) : 0,
    markerPct: l.amount > 0 ? clamp((l.pace.byToday / l.amount) * 100) : 0,
    tone: over || l.pace.state === 'ahead' ? 'warm' : 'neutral',
    targetsOver: l.targets && l.targets.exceeds ? l.targets.sum : null,
  };
}

/**
 * An amount typed in shekels ("6000", "6,000", "₪6,000.50") as agorot; null when it is not a positive number.
 * Thousands separators and the ₪ sign are allowed; more than two decimals are not.
 */
export function parseShekels(input: string): number | null {
  const s = input.trim().replace(/[₪\s]/g, '').replace(/,(?=\d{3}(\D|$))/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const agorot = Math.round(Number(s) * 100);
  return agorot > 0 && Number.isSafeInteger(agorot) ? agorot : null;
}
