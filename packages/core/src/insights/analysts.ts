/**
 * The panel's "Analysts" section from Finnhub's validated rows (finnhub.ts): the published ratings of the analysts who
 * cover the company (third-party, attributed, never finc's view) and the next / last earnings report
 * (stock-decision-aids.md, Part B). Pure: dates come in, nothing is fetched.
 *
 *  - analysts: the newest month's counts; `prev3m` the month about 3 months earlier (the period closest to 3 calendar
 *    months back, within ±20 days, with at least 3 analysts); shares are percent of the month's total, 1 decimal;
 *    the 3-month change is in points, from the shown (rounded) shares. Hidden ('too_few') under 3 analysts; a newest
 *    month older than 100 days, or no rows, is 'not_covered' (no current coverage);
 *  - earnings: `next` the earliest report dated today or later (Israel date) within 120 days that has no actual yet;
 *    `last` the latest report dated today or earlier with an actual EPS (null when the calendar has no past report: the
 *    free plan may return only about a month of history); surprise = (actual − estimate) / |estimate| × 100,
 *    1 decimal, null without an estimate or when |estimate| < 0.05 (a near-zero base makes the percentage meaningless);
 *  - `stale` (both sections): served from the cache past its freshness because it could not be refreshed (vault
 *    locked, no key, rate limit, failure, too slow); the app shows "not refreshed since fetchedAt".
 */
import { localDate } from '../prices/market.js';
import type { EarningsHour, EarningsRow, RecommendationRow } from './finnhub.js';

export const ANALYSTS_TZ = 'Asia/Jerusalem';
export const ANALYSTS_MIN_TOTAL = 3;
export const ANALYSTS_MAX_AGE_DAYS = 100;
export const PREV_3M_TOLERANCE_DAYS = 20;
export const EARNINGS_AHEAD_DAYS = 120;
/** |EPS estimate| below this: no surprise percentage */
export const SURPRISE_MIN_ESTIMATE = 0.05;
const DAY = 86_400_000;

/** why the analysts' view is missing (the app translates the code) */
export type AnalystsUnavailableCode = 'off' | 'no_key' | 'vault_locked' | 'not_covered' | 'busy' | 'unreachable' | 'invalid' | 'too_few';

export interface AnalystsMonth {
  /** YYYY-MM */
  period: string;
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
  total: number;
  /** (strong buy + buy) / total, percent, 1 decimal */
  buyShare: number;
  /** (sell + strong sell) / total, percent, 1 decimal */
  sellShare: number;
}

export interface AnalystsSection extends AnalystsMonth {
  prev3m: AnalystsMonth | null;
  /** buyShare − prev3m.buyShare, points, 1 decimal; null without prev3m */
  buyShareChange3mPts: number | null;
  /** ISO time Finnhub answered */
  fetchedAt: string;
  /** served from the cache past its freshness (could not be refreshed) */
  stale: boolean;
  /** the symbol Finnhub answered for, only when it differs from the one asked (verified with profile2) */
  finnhubSymbol?: string;
  source: 'finnhub';
}

export interface EarningsSection {
  next: { date: string; hour: EarningsHour | null; epsEstimate: number | null } | null;
  last: { date: string; epsActual: number; epsEstimate: number | null; surprisePct: number | null } | null;
  /** ISO time Finnhub answered */
  fetchedAt: string;
  /** served from the cache past its freshness (could not be refreshed) */
  stale: boolean;
  /** the symbol Finnhub answered for, only when it differs from the one asked (verified with profile2) */
  finnhubSymbol?: string;
}

const round1 = (v: number): number => {
  const x = Math.round(v * 10) / 10;
  return Object.is(x, -0) ? 0 : x;
};
const ms = (d: string): number => Date.parse(`${d}T00:00:00Z`);

/** Today's date in Israel (YYYY-MM-DD). */
export const israelDate = (t: number): string => localDate(t, ANALYSTS_TZ);

function month(r: RecommendationRow): AnalystsMonth {
  const total = r.strongBuy + r.buy + r.hold + r.sell + r.strongSell;
  return {
    period: r.period.slice(0, 7),
    strongBuy: r.strongBuy,
    buy: r.buy,
    hold: r.hold,
    sell: r.sell,
    strongSell: r.strongSell,
    total,
    buyShare: total > 0 ? round1(((r.strongBuy + r.buy) / total) * 100) : 0,
    sellShare: total > 0 ? round1(((r.sell + r.strongSell) / total) * 100) : 0,
  };
}

/** `d` moved back `n` calendar months (the day clamped to the month's length). */
function monthsBack(d: string, n: number): string {
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7)) - 1 - n;
  const day = Number(d.slice(8, 10));
  const first = new Date(Date.UTC(y, m, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, last))).toISOString().slice(0, 10);
}

/** The analysts' section from the rows (any order), or the code saying why it is hidden. */
export function summarizeAnalysts(rows: readonly RecommendationRow[], today: string, fetchedAt: string, stale = false): { ok: true; analysts: AnalystsSection } | { ok: false; code: 'not_covered' | 'too_few' } {
  if (!rows.length) return { ok: false, code: 'not_covered' };
  const sorted = [...rows].sort((a, b) => (a.period < b.period ? 1 : a.period > b.period ? -1 : 0));
  const latest = sorted[0]!;
  if (ms(today) - ms(latest.period) > ANALYSTS_MAX_AGE_DAYS * DAY) return { ok: false, code: 'not_covered' };
  const cur = month(latest);
  if (cur.total < ANALYSTS_MIN_TOTAL) return { ok: false, code: 'too_few' };
  const target = ms(monthsBack(latest.period, 3));
  let best: RecommendationRow | null = null;
  for (const r of sorted.slice(1)) {
    const off = Math.abs(ms(r.period) - target);
    if (off > PREV_3M_TOLERANCE_DAYS * DAY) continue;
    if (!best || off < Math.abs(ms(best.period) - target)) best = r;
  }
  const prev = best ? month(best) : null;
  const prev3m = prev && prev.total >= ANALYSTS_MIN_TOTAL ? prev : null;
  return { ok: true, analysts: { ...cur, prev3m, buyShareChange3mPts: prev3m ? round1(cur.buyShare - prev3m.buyShare) : null, fetchedAt, stale, source: 'finnhub' } };
}

/** The next and last earnings reports from the calendar rows, as of `today` (Israel date). */
export function summarizeEarnings(rows: readonly EarningsRow[], today: string, fetchedAt: string, stale = false): EarningsSection {
  const until = new Date(ms(today) + EARNINGS_AHEAD_DAYS * DAY).toISOString().slice(0, 10);
  let next: EarningsRow | null = null;
  let last: EarningsRow | null = null;
  for (const r of rows) {
    if (r.epsActual === null && r.date >= today && r.date <= until && (!next || r.date < next.date)) next = r;
    if (r.epsActual !== null && r.date <= today && (!last || r.date > last.date)) last = r;
  }
  const surprise = (a: number, e: number | null): number | null => (e === null || Math.abs(e) < SURPRISE_MIN_ESTIMATE ? null : round1(((a - e) / Math.abs(e)) * 100));
  return {
    next: next ? { date: next.date, hour: next.hour, epsEstimate: next.epsEstimate } : null,
    last: last && last.epsActual !== null ? { date: last.date, epsActual: last.epsActual, epsEstimate: last.epsEstimate, surprisePct: surprise(last.epsActual, last.epsEstimate) } : null,
    fetchedAt,
    stale,
  };
}

/** Whole days from `today` to `date` (both YYYY-MM-DD); negative when it has passed. */
export const daysUntilDate = (today: string, date: string): number => Math.round((ms(date) - ms(today)) / DAY);
