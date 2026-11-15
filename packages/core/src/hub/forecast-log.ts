/**
 * The forecast's own bookkeeping (proposal §4.5):
 *  - logForecast: write what the Now screen says today, one row per day.
 *  - backtestBand: replay the blend on finished months as of day 5/10/15/20/25 and store the error
 *    quantiles in the settings, so the band on Now comes from finc's measured misses, not a seed.
 *  - forecastAccuracy: judge logged forecasts against finished months (band coverage, error).
 *  - refreshForecast: all of the above, run after every sync.
 */
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { getSetting, setSetting } from '../ai/settings.js';
import type { Db } from '../db/db.js';
import { forecastLog } from '../db/schema.js';
import { type BandRow, SEED_BAND, daysInMonthOf, median, predictVariable } from '../engine/forecast.js';
import { monthSummary } from '../engine/summary.js';
import { VARIABLE_ROW_SQL } from '../engine/paidback.js';
import { hubOverview, todayLocal } from './overview.js';

export const BAND_SETTING = 'forecast.band';
const BACKTEST_DAYS = [5, 10, 15, 20, 25];

export function storedBand(db: Db): BandRow[] | null {
  const raw = getSetting(db, BAND_SETTING);
  if (!raw) return null;
  try {
    const rows = JSON.parse(raw) as { rows?: BandRow[] };
    return Array.isArray(rows.rows) && rows.rows.length >= 2 ? rows.rows : null;
  } catch {
    return null;
  }
}

/** Record today's forecast for the current month (replaces an earlier row of the same day). */
export function logForecast(db: Db, today = todayLocal()): void {
  const h = hubOverview(db);
  const f = h.forecast;
  if (!f.isCurrentMonth) return;
  db.delete(forecastLog).where(eq(forecastLog.date, today)).run();
  db.insert(forecastLog)
    .values({
      month: h.month,
      date: today,
      day: f.day,
      leftToSpend: f.left,
      roomBeforeVariable: f.roomBeforeVariable,
      variableSpent: f.variableSpent,
      predictedVariable: f.variable.predicted,
      // the accuracy check compares against the month's real end (all income), so log the projection on all income
      // even when the Now screen shows it without a large extra (engine/income.ts applySpread)
      projectedEnd: (h.spread.projectedAll ?? f.projected).end,
      bandLo: (h.spread.projectedAll ?? f.projected).lo,
      bandHi: (h.spread.projectedAll ?? f.projected).hi,
      createdAt: new Date().toISOString(),
    })
    .run();
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return Math.round(sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo));
}

function completeMonthsBefore(db: Db, month: string, n: number): string[] {
  const rows = db.$client.prepare(`select distinct cashflow_month m from "transaction" where cashflow_month < ? order by m desc limit ?`).all(month, n) as Array<{ m: string }>;
  return rows.map((r) => r.m);
}

/**
 * For each finished month with at least three months of history before it, predict the variable total
 * as of each backtest day the way the Now screen would, and collect prediction − actual. Returns the
 * quantile table and the number of months used; stores the table when it rests on 12+ months.
 */
export function backtestBand(db: Db, opts: { months?: number; today?: string } = {}): { rows: BandRow[]; monthsUsed: number; stored: boolean } {
  const today = opts.today ?? todayLocal();
  const currentMonth = today.slice(0, 7);
  const targets = completeMonthsBefore(db, currentMonth, opts.months ?? 18);
  const totals = new Map<string, number>();
  const netted = (m: string): number => {
    let v = totals.get(m);
    if (v === undefined) {
      v = -monthSummary(db, m).variable.sum;
      totals.set(m, v);
    }
    return v;
  };
  const spentByDay = db.$client.prepare(
    `select coalesce(sum(t.amount_ils),0) v from "transaction" t
     where t.cashflow_month = ? and t.status = 'completed' and t.excluded = 0 and ${VARIABLE_ROW_SQL} and t.installment_plan_id is null
       and (t.recurring_stream_id is null or not exists (select 1 from recurring_stream rs where rs.id = t.recurring_stream_id and rs.state = 'confirmed'))
       and t.txn_date <= ?`,
  );
  const errors = new Map<number, number[]>();
  let monthsUsed = 0;
  for (const m of targets) {
    const history = completeMonthsBefore(db, m, 3).map(netted);
    if (history.length < 3) continue;
    const actual = netted(m);
    const dim = daysInMonthOf(m);
    monthsUsed++;
    for (const d of BACKTEST_DAYS) {
      const spent = -(spentByDay.get(m, `${m}-${String(Math.min(d, dim)).padStart(2, '0')}`) as { v: number }).v;
      const pv = predictVariable(spent, d, dim, history);
      errors.set(d, [...(errors.get(d) ?? []), pv.predicted - actual]);
    }
  }
  const rows: BandRow[] = BACKTEST_DAYS.map((d) => {
    const e = [...(errors.get(d) ?? [])].sort((a, b) => a - b);
    return { day: d, p10: quantile(e, 0.1), p25: quantile(e, 0.25), p75: quantile(e, 0.75), p90: quantile(e, 0.9) };
  });
  const stored = monthsUsed >= 12;
  if (stored) setSetting(db, BAND_SETTING, JSON.stringify({ rows, monthsUsed, computedAt: today }));
  return { rows, monthsUsed, stored };
}

export interface ForecastAccuracy {
  /** finished months that had at least one logged forecast */
  monthsEvaluated: number;
  /** of those, how many ended inside the p25–p75 band shown around day 10 (or the earliest log after it) */
  insideBand: number;
  /** mean absolute error of the projected month end at that log, agorot */
  maeEnd: number | null;
  /** mean absolute error of the predicted variable total, agorot */
  maeVariable: number | null;
}

/** Judge the logged forecasts of finished months against what actually happened. */
export function forecastAccuracy(db: Db, today = todayLocal()): ForecastAccuracy {
  const currentMonth = today.slice(0, 7);
  const months = db.select({ month: forecastLog.month }).from(forecastLog).where(lt(forecastLog.month, currentMonth)).groupBy(forecastLog.month).all();
  let inside = 0;
  const endErrors: number[] = [];
  const varErrors: number[] = [];
  for (const { month } of months) {
    const logs = db.select().from(forecastLog).where(and(eq(forecastLog.month, month), sql`${forecastLog.day} >= 10`)).orderBy(forecastLog.day).all();
    const pick = logs[0] ?? db.select().from(forecastLog).where(eq(forecastLog.month, month)).orderBy(sql`${forecastLog.day} desc`).all()[0];
    if (!pick) continue;
    const s = monthSummary(db, month);
    const actualEnd = s.net;
    const actualVariable = -s.variable.sum;
    if (actualEnd >= pick.bandLo && actualEnd <= pick.bandHi) inside++;
    endErrors.push(Math.abs(pick.projectedEnd - actualEnd));
    varErrors.push(Math.abs(pick.predictedVariable - actualVariable));
  }
  const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  return { monthsEvaluated: months.length, insideBand: inside, maeEnd: mean(endErrors), maeVariable: mean(varErrors) };
}

export interface ForecastChange {
  /** date of the earlier snapshot compared against (usually yesterday) */
  since: string;
  /** left to spend then and now, agorot; delta = now − before */
  before: number;
  now: number;
  delta: number;
  /** this month's transactions recorded since that snapshot, largest first (top 3), and their total */
  arrived: Array<{ name: string; amount: number; date: string }>;
  arrivedCount: number;
  arrivedSum: number;
}

/**
 * What moved the Now number since the last daily snapshot: the difference in "left to spend" and the
 * transactions that arrived in between. Null until a second day has been logged.
 */
export function forecastChange(db: Db, opts: { overview?: ReturnType<typeof hubOverview>; today?: string } = {}): ForecastChange | null {
  const today = opts.today ?? todayLocal();
  const h = opts.overview ?? hubOverview(db);
  const f = h.forecast;
  if (!f.isCurrentMonth) return null;
  const prev = db
    .select()
    .from(forecastLog)
    .where(and(eq(forecastLog.month, h.month), lt(forecastLog.date, today)))
    .orderBy(desc(forecastLog.date))
    .limit(1)
    .get();
  if (!prev) return null;
  const rows = db.$client
    .prepare(
      `select t.amount_ils amount, t.txn_date date, coalesce(m.name, t.description_norm) name
       from "transaction" t left join merchant m on m.id = t.merchant_id
       where t.cashflow_month = ? and t.created_at >= ? and t.status <> 'voided' and t.excluded = 0
         and coalesce(t.kind, '') not in ('settlement', 'transfer')
       order by abs(t.amount_ils) desc`,
    )
    .all(h.month, prev.createdAt) as Array<{ amount: number; date: string; name: string }>;
  return {
    since: prev.date,
    before: prev.leftToSpend,
    now: f.left,
    delta: f.left - prev.leftToSpend,
    arrived: rows.slice(0, 3),
    arrivedCount: rows.length,
    arrivedSum: rows.reduce((a, r) => a + r.amount, 0),
  };
}

/** After every sync: refresh the band from finc's own history and log today's forecast. */
export function refreshForecast(db: Db, today = todayLocal()): { band: ReturnType<typeof backtestBand>; logged: boolean } {
  const band = backtestBand(db, { today });
  logForecast(db, today);
  return { band, logged: true };
}

export { SEED_BAND, median };
