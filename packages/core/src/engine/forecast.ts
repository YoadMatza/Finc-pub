/**
 * Cash-grounded forecast for the current month (design notes are kept privately, outside the repo).
 *
 *   room before variable = income (actual + still expected)
 *                        − committed (fixed actual + fixed still expected + installments actual + remaining)
 *                        − savings (actual + planned)
 *   left to spend        = room before variable − variable spent so far
 *
 * The month-end projection assumes the owner keeps his usual pace: predicted variable total
 * V̂ = w·pace + (1−w)·med3 with w = day/dim (never below what is already spent), and the band
 * comes from the blend's own backtested error quantiles (18 months, seeded here until the engine
 * keeps its own table). Everything is in agorot, positive numbers unless stated.
 */
import type { MonthSummary } from './summary.js';

export interface ForecastInput {
  summary: MonthSummary;
  /** YYYY-MM-DD in the owner's timezone */
  today: string;
  /** refund-netted variable totals of the last complete months, most recent first (positive) */
  variableHistory: number[];
  /** median cumulative variable spend by today's day over recent months (positive), null if unknown */
  typicalByToday: number | null;
  /** variable spent so far in the Sunday–Saturday week containing today (positive) */
  spentThisWeek: number;
  /** signed sums of still-expected slots whose category is in the savings section (negative) */
  expectedSavingsRemaining: number;
  /** error quantiles to draw the band from; finc's own backtest when available, else the seed */
  band?: BandRow[];
}

export type ForecastState = 'comfortable' | 'tight' | 'short';

export interface Forecast {
  day: number;
  dim: number;
  daysLeft: number;
  isCurrentMonth: boolean;
  /** before day 7 percentages are hidden and the wide band is used */
  early: boolean;
  income: { actual: number; expected: number; total: number };
  committed: { fixedActual: number; fixedExpected: number; installmentsActual: number; installmentsExpected: number; total: number };
  savings: { actual: number; planned: number; total: number };
  variableSpent: number;
  roomBeforeVariable: number;
  left: number;
  variable: { med3: number | null; pace: number; w: number; predicted: number; remaining: number; typicalByToday: number | null };
  projected: { end: number; lo: number; hi: number; lo90: number; hi90: number };
  weekly: { envelope: number | null; spentThisWeek: number; weeksLeft: number };
  state: ForecastState;
}

export interface BandRow {
  day: number;
  p10: number;
  p25: number;
  p75: number;
  p90: number;
}

/** Seed error quantiles of the blend (prediction − actual variable total) at backtest days; see proposal §3.5.
 *  Replaced by finc's own backtest (hub/forecast-log.ts) once it has run. */
export const SEED_BAND: BandRow[] = [
  { day: 5, p10: -576900, p25: -212000, p75: 52100, p90: 163700 },
  { day: 10, p10: -345700, p25: -205500, p75: 102000, p90: 172000 },
  { day: 15, p10: -380400, p25: -241900, p75: 128900, p90: 167000 },
  { day: 20, p10: -274500, p25: -125000, p75: 106200, p90: 127600 },
  { day: 25, p10: -182000, p25: -10000, p75: 60100, p90: 89900 },
];

export function errorBand(day: number, table: BandRow[] = SEED_BAND): { p10: number; p25: number; p75: number; p90: number } {
  const BAND = table.length >= 2 ? [...table].sort((a, b) => a.day - b.day) : SEED_BAND;
  const d = Math.max(BAND[0]!.day, Math.min(BAND[BAND.length - 1]!.day, day));
  let lo = BAND[0]!;
  let hi = BAND[BAND.length - 1]!;
  for (let i = 0; i < BAND.length - 1; i++) {
    if (d >= BAND[i]!.day && d <= BAND[i + 1]!.day) {
      lo = BAND[i]!;
      hi = BAND[i + 1]!;
      break;
    }
  }
  const f = hi.day === lo.day ? 0 : (d - lo.day) / (hi.day - lo.day);
  const mix = (a: number, b: number) => Math.round(a + (b - a) * f);
  return { p10: mix(lo.p10, hi.p10), p25: mix(lo.p25, hi.p25), p75: mix(lo.p75, hi.p75), p90: mix(lo.p90, hi.p90) };
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

/** V̂ = w·pace + (1−w)·med3, never below what is already spent. */
export function predictVariable(spent: number, day: number, dim: number, history: number[]): { med3: number | null; pace: number; w: number; predicted: number } {
  const med3 = median(history.slice(0, 3));
  const w = Math.min(1, Math.max(0, day / dim));
  const pace = day > 0 ? Math.round((spent * dim) / day) : spent;
  const blend = med3 === null ? pace : Math.round(w * pace + (1 - w) * med3);
  return { med3, pace, w, predicted: Math.max(spent, blend) };
}

export function daysInMonthOf(month: string): number {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function forecastMonth(input: ForecastInput): Forecast {
  const s = input.summary;
  const dim = daysInMonthOf(s.month);
  const isCurrentMonth = input.today.slice(0, 7) === s.month;
  const day = isCurrentMonth ? Number(input.today.slice(8, 10)) : input.today.slice(0, 7) > s.month ? dim : 1;
  const daysLeft = isCurrentMonth ? Math.max(1, dim - day + 1) : 0;

  const incomeActual = s.income.sum;
  const incomeExpected = isCurrentMonth ? s.expectedIncomeRemaining : 0;
  const fixedActual = -s.fixed.sum;
  const fixedExpected = isCurrentMonth ? -(s.expectedFixedRemaining - input.expectedSavingsRemaining) : 0;
  const installmentsActual = -s.installments.sum;
  const installmentsExpected = isCurrentMonth ? -s.expectedInstallments.reduce((a, e) => a + e.amount, 0) : 0;
  const savingsActual = -s.savings.sum;
  const savingsPlanned = isCurrentMonth ? -input.expectedSavingsRemaining : 0;
  const variableSpent = -s.variable.sum;

  const income = { actual: incomeActual, expected: incomeExpected, total: incomeActual + incomeExpected };
  const committed = { fixedActual, fixedExpected, installmentsActual, installmentsExpected, total: fixedActual + fixedExpected + installmentsActual + installmentsExpected };
  const savings = { actual: savingsActual, planned: savingsPlanned, total: savingsActual + savingsPlanned };
  const roomBeforeVariable = income.total - committed.total - savings.total;
  const left = roomBeforeVariable - variableSpent;

  const pv = predictVariable(variableSpent, day, dim, input.variableHistory);
  const remaining = isCurrentMonth ? Math.max(0, pv.predicted - variableSpent) : 0;
  const end = left - remaining;
  const band = errorBand(day, input.band ?? SEED_BAND);
  const projected = isCurrentMonth ? { end, lo: end + band.p25, hi: end + band.p75, lo90: end + band.p10, hi90: end + band.p90 } : { end, lo: end, hi: end, lo90: end, hi90: end };

  const weeksLeft = isCurrentMonth ? Math.max(1, Math.ceil(daysLeft / 7)) : 0;
  const envelope = isCurrentMonth && left > 0 ? Math.round((left * 7) / daysLeft) : null;

  const state: ForecastState = left <= 0 ? 'short' : left < remaining ? 'tight' : 'comfortable';
  return {
    day,
    dim,
    daysLeft,
    isCurrentMonth,
    early: isCurrentMonth && day < 7,
    income,
    committed,
    savings,
    variableSpent,
    roomBeforeVariable,
    left,
    variable: { med3: pv.med3, pace: pv.pace, w: pv.w, predicted: pv.predicted, remaining, typicalByToday: input.typicalByToday },
    projected,
    weekly: { envelope, spentThisWeek: input.spentThisWeek, weeksLeft },
    state,
  };
}
