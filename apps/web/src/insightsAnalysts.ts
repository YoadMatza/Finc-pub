/**
 * Stock decision aids, part B (research_notes/proposals/stock-decision-aids.md): the pure parts of the "Analysts"
 * section — the five rating counts as bar segments, the buy and sell shares, the change vs 3 months ago, the month
 * label, the earnings lines and the reasons the section is empty. The rating names are labels of what analysts
 * published; finc's own words never say what to do. Tested in insightsAnalysts.test.ts.
 */
import type { Key } from './i18n';
import { isolateLtr, numericDate, ratioText } from './insightsCompany';
import { ptsText } from './insights';
import { pctText } from './live';
import { dayDots } from './holdingRules';
import type { HoldingInsights, InsightAnalystCounts, InsightAnalysts, InsightAnalystsUnavailableCode, InsightEarnings } from './types';

type T = (key: Key, vars?: Record<string, string | number>) => string;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Strong buy → strong sell, the order of the bar and the legend. */
export const RATING_KEYS = ['strongBuy', 'buy', 'hold', 'sell', 'strongSell'] as const;
export type RatingKey = (typeof RATING_KEYS)[number];

export const RATING_LABEL: Record<RatingKey, Key> = {
  strongBuy: 'ins_an_strong_buy',
  buy: 'ins_an_buy',
  hold: 'ins_an_hold',
  sell: 'ins_an_sell',
  strongSell: 'ins_an_strong_sell',
};

/** One hue (the accent) in five strengths: an ordered scale, not a green/red judgement. */
const SHADE_PCT: Record<RatingKey, number> = { strongBuy: 100, buy: 74, hold: 50, sell: 30, strongSell: 15 };

export function ratingColor(k: RatingKey): string {
  return `color-mix(in srgb, var(--color-accent) ${SHADE_PCT[k]}%, var(--color-surface-2))`;
}

/** Below this many analysts the ratings are not shown (the hub says too_few; checked here as well). */
export const MIN_ANALYSTS = 3;

export interface RatingSegment {
  key: RatingKey;
  count: number;
  /** of the total, 0–1 */
  frac: number;
}

export interface AnalystView {
  period: string;
  segments: RatingSegment[];
  total: number;
  /** strong buy + buy, percent of the total */
  buyPct: number;
  /** sell + strong sell, percent of the total */
  sellPct: number;
  prev: { period: string; buyPct: number } | null;
  /** buy share now minus 3 months ago, points, one decimal; null without a comparable month */
  changePts: number | null;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/** The counts of a month when they are whole numbers ≥ 0 and the period reads as YYYY-MM; else null. */
function readCounts(c: InsightAnalystCounts | null | undefined): { period: string; counts: Record<RatingKey, number>; total: number } | null {
  if (!c || typeof c !== 'object' || typeof c.period !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(c.period)) return null;
  const counts = {} as Record<RatingKey, number>;
  let total = 0;
  for (const k of RATING_KEYS) {
    const v = c[k];
    if (!isNum(v) || v < 0 || !Number.isInteger(v)) return null;
    counts[k] = v;
    total += v;
  }
  return { period: c.period, counts, total };
}

const buyPctOf = (x: { counts: Record<RatingKey, number>; total: number }) => ((x.counts.strongBuy + x.counts.buy) / x.total) * 100;

/**
 * What the section draws: the segments with their share of the total, the buy and sell shares (from the counts, so
 * they always match the bar), and the 3-month comparison. The change is the hub's own number when it sent one (the
 * same number the rules check), else computed from the two months. Null when the counts are unreadable or fewer than
 * MIN_ANALYSTS analysts cover the company.
 */
export function analystView(a: InsightAnalysts | null | undefined): AnalystView | null {
  const now = readCounts(a);
  if (!a || !now || now.total < MIN_ANALYSTS) return null;
  const segments = RATING_KEYS.map((key) => ({ key, count: now.counts[key], frac: now.counts[key] / now.total }));
  const buyPct = buyPctOf(now);
  const sellPct = ((now.counts.sell + now.counts.strongSell) / now.total) * 100;
  const p = readCounts(a.prev3m);
  const prev = p && p.total > 0 && p.period < now.period ? { period: p.period, buyPct: buyPctOf(p) } : null;
  let changePts: number | null = null;
  // computed from the shares as shown (one decimal), so the line subtracts to the change it shows
  if (prev) changePts = isNum(a.buyShareChange3mPts) ? r1(a.buyShareChange3mPts) : r1(r1(buyPct) - r1(prev.buyPct));
  return { period: now.period, segments, total: now.total, buyPct, sellPct, prev, changePts };
}

/**
 * Why ratings the hub did send are not drawn: too few analysts, or counts that fail the checks. Null when they are
 * drawn, or when nothing was sent.
 */
export function analystsIssue(a: InsightAnalysts | null | undefined): 'too_few' | 'invalid' | null {
  if (!a) return null;
  const now = readCounts(a);
  if (!now) return 'invalid';
  return now.total < MIN_ANALYSTS ? 'too_few' : null;
}

/** A share as a whole percent: 68%. */
export function sharePct(v: number): string {
  return `${Math.round(v)}%`;
}

/** 2026-11 → "November 2026" / "נובמבר 2026"; anything else as given. */
export function monthYear(period: string, locale: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) return period;
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)));
}

/** A share with one decimal: 68.8%. */
export function sharePct1(v: number): string {
  return `${r1(v).toFixed(1)}%`;
}

/**
 * "Buy share 3 months ago: 60.0% → now 68.8% (+8.8 points)", both shares with one decimal so they subtract to the
 * change shown; null without a comparable month.
 */
export function changeText(t: T, v: AnalystView): string | null {
  if (!v.prev || v.changePts === null) return null;
  return t('ins_an_change', { a: isolateLtr(sharePct1(v.prev.buyPct)), b: isolateLtr(sharePct1(v.buyPct)), d: isolateLtr(ptsText(v.changePts)) });
}

const UNAVAILABLE_KEYS: Record<InsightAnalystsUnavailableCode, Key> = {
  off: 'ins_an_unav_off',
  no_key: 'ins_an_unav_no_key',
  vault_locked: 'ins_an_unav_vault_locked',
  not_covered: 'ins_an_unav_not_covered',
  busy: 'ins_an_unav_busy',
  unreachable: 'ins_an_unav_unreachable',
  invalid: 'ins_an_unav_invalid',
  too_few: 'ins_an_unav_too_few',
};

/** The muted one-liner when there are no ratings for a known reason; null otherwise. */
export function analystsUnavailableReason(t: T, code: string | null | undefined): string | null {
  if (!code || !Object.prototype.hasOwnProperty.call(UNAVAILABLE_KEYS, code)) return null;
  return t(UNAVAILABLE_KEYS[code as InsightAnalystsUnavailableCode]);
}

const HOUR_KEYS: Record<string, Key> = { bmo: 'ins_earn_bmo', amc: 'ins_earn_amc', dmh: 'ins_earn_dmh' };

const DAY_MS = 86_400_000;

/** Whole days from `today` to `date` (both YYYY-MM-DD); null when either is unreadable. */
export function daysUntil(date: string, today: string): number | null {
  const a = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  const b = /^(\d{4})-(\d{2})-(\d{2})/.exec(today);
  if (!a || !b) return null;
  const ta = Date.UTC(Number(a[1]), Number(a[2]) - 1, Number(a[3]));
  const tb = Date.UTC(Number(b[1]), Number(b[2]) - 1, Number(b[3]));
  return Math.round((ta - tb) / DAY_MS);
}

/**
 * "Next earnings report: 29.1.2027, before the market opens · in 79 days". The time of day only when Finnhub gave
 * one; the countdown only for a date today or later. Null without a next report.
 */
export function nextEarningsText(t: T, e: InsightEarnings | null | undefined, today: string | null): string | null {
  const n = e?.next;
  if (!n || typeof n.date !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(n.date)) return null;
  const d = numericDate(n.date);
  const hk = n.hour ? HOUR_KEYS[n.hour] : undefined;
  let s = hk ? t('ins_earn_next_at', { d, w: t(hk) }) : t('ins_earn_next', { d });
  const days = today ? daysUntil(n.date, today) : null;
  if (days !== null && days >= 0) s += ` · ${days === 0 ? t('ins_earn_today') : days === 1 ? t('ins_earn_tomorrow') : t('ins_earn_in_days', { n: days })}`;
  return s;
}

/** An EPS figure: two decimals, a real minus, kept left-to-right. */
function eps(v: number): string {
  return isolateLtr(ratioText(v, 2));
}

/**
 * "Last report (30.10.2026): EPS 1.64 vs 1.60 expected (+2.5%)". The expectation and the surprise are left out when
 * Finnhub has none. Null without a last report.
 */
export function lastEarningsText(t: T, e: InsightEarnings | null | undefined): string | null {
  const l = e?.last;
  if (!l || typeof l.date !== 'string' || !isNum(l.epsActual)) return null;
  let s = t('ins_earn_last', { d: numericDate(l.date), a: eps(l.epsActual) });
  if (isNum(l.epsEstimate)) {
    s += ` ${t('ins_earn_vs', { e: eps(l.epsEstimate) })}`;
    if (isNum(l.surprisePct)) s += ` (${isolateLtr(pctText(l.surprisePct, 1))})`;
  }
  return s;
}

export interface AnalystsParts {
  view: AnalystView | null;
  /** the muted reason when there are no ratings to draw */
  why: string | null;
  next: string | null;
  last: string | null;
  /** "Analysts: Finnhub, 11.11" (+ "· not refreshed since 11.11" when stale), only when ratings are drawn */
  analystsSource: string | null;
  /** "Earnings: Finnhub, 11.11" (+ the same stale note), only when an earnings line is shown */
  earningsSource: string | null;
}

/**
 * Everything the Analysts section shows, from the payload alone: it does not depend on the price data, so it is
 * built for a payload whose Yahoo part is unavailable too. Null when there is nothing to show (an older hub).
 */
export function analystsParts(t: T, d: Pick<HoldingInsights, 'analysts' | 'analystsUnavailableCode' | 'earnings'> | null | undefined, today: string | null): AnalystsParts | null {
  if (!d) return null;
  const view = analystView(d.analysts);
  const why = view ? null : analystsUnavailableReason(t, d.analystsUnavailableCode ?? analystsIssue(d.analysts));
  const next = nextEarningsText(t, d.earnings, today);
  const last = lastEarningsText(t, d.earnings);
  if (!view && !why && !next && !last) return null;
  const analystsSource = view ? finnhubSource(t, 'ins_an_source_analysts', d.analysts) : null;
  const earningsSource = next || last ? finnhubSource(t, 'ins_an_source_earnings', d.earnings) : null;
  return { view, why, next, last, analystsSource, earningsSource };
}

/**
 * One part's own source line: "Analysts: Finnhub, 11.11", and "· not refreshed since 11.11" when the hub marks it
 * stale (a cached copy it could not refresh). Each part keeps its own date; null without a readable fetch time.
 */
export function finnhubSource(t: T, key: 'ins_an_source_analysts' | 'ins_an_source_earnings', part: { fetchedAt?: string | null; stale?: boolean } | null | undefined): string | null {
  const day = typeof part?.fetchedAt === 'string' && !Number.isNaN(Date.parse(part.fetchedAt)) ? dayDots(part.fetchedAt) : null;
  if (!day) return null;
  const s = t(key, { d: day });
  return part?.stale === true ? `${s} · ${t('ins_an_stale', { d: day })}` : s;
}
