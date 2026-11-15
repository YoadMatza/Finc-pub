/**
 * The monthly spending limit (research_notes/proposals/now-screen-and-limit.md §3–4, build step 2). The arithmetic is
 * in engine/limit.ts; this file reads the database and the settings:
 *
 *   spend.limit.<YYYY-MM>   agorot as a string, "0" = off   the limit from that month on (carried forward)
 *
 * Setting a limit applies from the given month (the current month or later) on: entries for later months are removed,
 * earlier months keep the limit they had.
 */
import { setSetting } from '../ai/settings.js';
import type { Db } from '../db/db.js';
import { daysInMonth } from '../engine/cashflow.js';
import { type LimitStatus, effectiveLimit, limitStatus, targetsCheck } from '../engine/limit.js';
import { type View, classifyMonthRows } from '../engine/summary.js';
import { currentMonth as thisMonth } from '../riseup/client.js';
import { groupTargets } from './targets.js';

export const SPEND_LIMIT_PREFIX = 'spend.limit.';
/** ₪1,000,000 in agorot */
export const SPEND_LIMIT_MAX = 100_000_000;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The hub's limit card: the engine's status plus the category-targets check. */
export interface HubLimit extends LimitStatus {
  /** the sum of the variable groups' targets (Categories screen) against the limit; null when none is set */
  targets: { sum: number; exceeds: boolean } | null;
}

export class LimitError extends Error {}

/** Every spend.limit.<YYYY-MM> entry (amount null = off). */
export function spendLimitEntries(db: Db): Array<{ month: string; amount: number | null }> {
  const rows = db.$client.prepare(`select key, value from setting where substr(key, 1, ?) = ?`).all(SPEND_LIMIT_PREFIX.length, SPEND_LIMIT_PREFIX) as Array<{ key: string; value: string }>;
  const out: Array<{ month: string; amount: number | null }> = [];
  for (const r of rows) {
    const month = r.key.slice(SPEND_LIMIT_PREFIX.length);
    if (!MONTH_RE.test(month)) continue;
    const n = Number(r.value);
    out.push({ month, amount: Number.isFinite(n) && n > 0 ? Math.round(n) : null });
  }
  return out;
}

/** The limit that applies to `month` (carried forward from the latest entry at or before it), or null. */
export function getSpendLimit(db: Db, month: string): number | null {
  return effectiveLimit(spendLimitEntries(db), month);
}

/** Throws LimitError unless `month` is YYYY-MM, not before `currentMonth`, and `amount` is null or 1..SPEND_LIMIT_MAX agorot. */
export function checkSpendLimit(month: string, amount: number | null, currentMonth: string = thisMonth()): void {
  if (!MONTH_RE.test(month)) throw new LimitError('month must be YYYY-MM');
  if (month < currentMonth) throw new LimitError('a limit can be set from the current month on; earlier months keep the limit they had');
  if (amount !== null && (!Number.isInteger(amount) || amount <= 0 || amount > SPEND_LIMIT_MAX)) throw new LimitError(`the limit must be a whole number of agorot between 1 and ${SPEND_LIMIT_MAX}`);
}

/**
 * Set the limit from `month` on (null = off). Checked before anything is written; entries for later months are
 * removed so the new value applies to them too.
 */
export function setSpendLimit(db: Db, month: string, amount: number | null, currentMonth: string = thisMonth()): void {
  checkSpendLimit(month, amount, currentMonth);
  for (const e of spendLimitEntries(db)) if (e.month > month) setSetting(db, `${SPEND_LIMIT_PREFIX}${e.month}`, null);
  setSetting(db, `${SPEND_LIMIT_PREFIX}${month}`, String(amount ?? 0));
}

/** The sum of the effective targets of the groups made of tracked variable categories; null when none has a target. */
export function variableTargetsSum(db: Db): number | null {
  // Only day-to-day money counts. A group whose categories are all variable may use its group target; a mixed group
  // (car: insurance is fixed, fuel and parking are variable) counts only its tracked variable categories' targets.
  const cats = db.$client.prepare(`select group_key g, section, track, monthly_target t from category where group_key is not null`).all() as Array<{ g: string; section: string; track: number; t: number | null }>;
  const byGroup = new Map<string, typeof cats>();
  for (const c of cats) byGroup.set(c.g, [...(byGroup.get(c.g) ?? []), c]);
  const explicit = groupTargets(db);
  let sum = 0;
  let any = false;
  for (const [g, list] of byGroup) {
    const variable = list.filter((c) => c.section === 'variable' && c.track === 1);
    if (!variable.length) continue;
    const allVariable = list.every((c) => c.section === 'variable');
    const groupTarget = explicit.get(g);
    if (allVariable && groupTarget !== undefined) {
      sum += groupTarget;
      any = true;
      continue;
    }
    for (const c of variable) {
      if (c.t === null) continue;
      sum += c.t;
      any = true;
    }
  }
  return any ? sum : null;
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * The limit card for `month`, or null (no limit, or a month after today's). `spent` is the month's refund-netted
 * variable spend (forecast.variableSpent); this week's spend is counted the same way (variable rows, refunds netted),
 * from the week's Sunday or the 1st of the month, whichever is later, through today.
 */
export function spendLimitStatus(db: Db, ctx: { month: string; view: View; today: string; spent: number }): HubLimit | null {
  const { month, view, today, spent } = ctx;
  if (month > today.slice(0, 7)) return null;
  const amount = getSpendLimit(db, month);
  if (amount === null) return null;
  const [y, m] = month.split('-').map(Number) as [number, number];
  const dim = daysInMonth(y, m);
  const current = month === today.slice(0, 7);
  const sunday = addDays(today, -new Date(`${today}T00:00:00Z`).getUTCDay());
  const from = sunday < `${month}-01` ? `${month}-01` : sunday;
  const weekStartDay = current ? Number(from.slice(8, 10)) : 1;
  const spentThisWeek = current
    ? 0 -
      classifyMonthRows(db, month, view)
        .filter((r) => r.bucket === 'variable' && r.t.txnDate >= from && r.t.txnDate <= today)
        .reduce((a, r) => a + r.amount, 0)
    : 0;
  const status = limitStatus({ amount, spent, month, today, dim, spentThisWeek, weekStartDay });
  if (!status) return null;
  return { ...status, targets: targetsCheck(amount, variableTargetsSum(db)) };
}
