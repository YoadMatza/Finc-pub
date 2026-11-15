/**
 * Stock insights (design research_notes/proposals/stock-insights.md §3 B–D): the pure parts of the panel —
 * the neutral reading sentences, green/red tone of a comparison, number formatting, and the SVG chart's
 * scaling and path building. No React here so it is easy to test. Wording describes, never advises.
 */
import type { Key } from './i18n';
import type { HoldingInsights, InsightDrawdown, InsightPoint, InsightReturnKey, InsightUnavailableCode } from './types';

type T = (key: Key, vars?: Record<string, string | number>) => string;

export const INSIGHTS_STALE_MS = 30 * 60_000;

const isNum = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/** 12.3% (no sign) / – for null. */
export function absPct(v: number | null | undefined, digits = 1): string {
  if (!isNum(v)) return '–';
  return `${Math.abs(v).toFixed(digits)}%`;
}

/** +8.1 / −3.0 / 0.0 points; – for null. */
export function ptsText(v: number | null | undefined, digits = 1): string {
  if (!isNum(v)) return '–';
  const abs = Math.abs(v).toFixed(digits);
  if (Number(abs) === 0) return (0).toFixed(digits);
  return `${v > 0 ? '+' : '−'}${abs}`;
}

/** An axis label: as many decimals as the tick step needs (step 5 → 0, 0.5 → 1, 0.25 → 2), no currency. */
export function axisNum(v: number, step: number): string {
  const digits = !(step > 0) || Number.isInteger(Number(step.toFixed(6))) ? 0 : Number(step.toFixed(6)).toString().split('.')[1]!.length;
  return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Green when the stock beat the benchmark, red when it trailed, muted when equal or unknown. */
export function diffTone(v: number | null | undefined): 'pos' | 'neg' | 'muted' {
  if (!isNum(v) || Number(v.toFixed(1)) === 0) return 'muted';
  return v > 0 ? 'pos' : 'neg';
}

/**
 * "12.3% above the 200-day average, for 41 sessions in a row" ("for at least 41 sessions" when the history ran
 * out first). `days` counts trading sessions on the current side (negative = below, as the hub sends it);
 * only its size is used, the side comes from `pct`.
 */
export function avgReading(t: T, window: 50 | 200, pct: number | null | undefined, days?: number | null, lowerBound = false): string | null {
  if (!isNum(pct)) return null;
  const p = absPct(pct);
  if (Number(Math.abs(pct).toFixed(1)) === 0) return t('ins_avg_at', { w: window });
  const base = t(pct > 0 ? 'ins_avg_above' : 'ins_avg_below', { w: window, p });
  if (!isNum(days) || days === 0) return base;
  const n = Math.abs(Math.round(days));
  if (lowerBound) return `${base}${t('ins_for_sessions_min', { n })}`;
  return `${base}${n === 1 ? t('ins_for_session') : t('ins_for_sessions', { n })}`;
}

/** "8.2% below the 52-week high · 31.0% above the 52-week low" (each part only when known). */
export function rangeReading(t: T, fromHighPct: number | null | undefined, fromLowPct: number | null | undefined): string | null {
  const parts: string[] = [];
  if (isNum(fromHighPct)) parts.push(Number(Math.abs(fromHighPct).toFixed(1)) === 0 ? t('ins_at_high') : t('ins_from_high', { p: absPct(fromHighPct) }));
  if (isNum(fromLowPct)) parts.push(Number(Math.abs(fromLowPct).toFixed(1)) === 0 ? t('ins_at_low') : t('ins_from_low', { p: absPct(fromLowPct) }));
  return parts.length ? parts.join(' · ') : null;
}

/** "1.30 = on average about 1.3× the market's daily moves"; near 1 → like the market; near 0 → unrelated; negative → against. */
export function betaReading(t: T, beta: number | null | undefined): string | null {
  if (!isNum(beta)) return null;
  const b = beta.toFixed(2);
  if (beta < -0.05) return t('ins_beta_opposite', { b });
  if (beta < 0.05) return t('ins_beta_unrelated', { b });
  if (Math.abs(beta - 1) < 0.05) return t('ins_beta_same', { b });
  return t('ins_beta_times', { b, x: beta.toFixed(1) });
}

export type CrossCheckView =
  | { kind: 'mismatch'; diffPct: number | null; yahoo: number | null; yahooDate: string | null; bank: number | null; bankAt: string | null }
  | { kind: 'intraday' };

/**
 * The cross-check line: amber when the hub says Yahoo and the bank disagree (with the date of the bar compared),
 * muted when the bank's price was taken during the session and so was not compared, else nothing.
 */
export function crossCheckNote(c: HoldingInsights['crossCheck']): CrossCheckView | null {
  if (c.ok === false) return { kind: 'mismatch', diffPct: c.diffPct, yahoo: c.yahooClose, yahooDate: c.yahooDate ?? null, bank: c.bankPrice, bankAt: c.bankAt };
  if (c.ok === null && c.note === 'intraday_snapshot') return { kind: 'intraday' };
  return null;
}

/** A drawdown that is (about) zero is "no drop in this period", without dates. */
export function drawdownView(dd: InsightDrawdown | null | undefined): { kind: 'none' } | { kind: 'drop'; pct: number; peakDate: string; troughDate: string } | null {
  if (!dd || !isNum(dd.pct)) return null;
  if (Math.abs(dd.pct) < 0.05) return { kind: 'none' };
  return { kind: 'drop', pct: dd.pct, peakDate: dd.peakDate, troughDate: dd.troughDate };
}

const UNAVAILABLE_KEYS: Record<InsightUnavailableCode, Key> = {
  off: 'ins_unav_off',
  not_covered: 'ins_unav_not_covered',
  busy: 'ins_unav_busy',
  unreachable: 'ins_unav_unreachable',
  unknown_symbol: 'ins_unav_unknown_symbol',
  invalid: 'ins_unav_invalid',
};

/** The reason in the app's language for a known code; otherwise the hub's English text (or nothing). */
export function unavailableReason(t: T, d: Pick<HoldingInsights, 'unavailable' | 'unavailableCode'> | undefined): string | null {
  const code = d?.unavailableCode;
  if (code && Object.prototype.hasOwnProperty.call(UNAVAILABLE_KEYS, code)) return t(UNAVAILABLE_KEYS[code]);
  return d?.unavailable || null;
}

export const RETURN_KEYS: InsightReturnKey[] = ['m1', 'm3', 'm6', 'y1', 'y3Ann'];

/** The last 365 calendar days of the series (ends at the last point); points in date order. */
export function lastYear(series: InsightPoint[]): InsightPoint[] {
  const s = series.filter((p) => isNum(p.c) && /^\d{4}-\d{2}-\d{2}/.test(p.d));
  if (s.length === 0) return [];
  const last = Date.parse(`${s[s.length - 1]!.d.slice(0, 10)}T00:00:00Z`);
  const from = last - 365 * 86_400_000;
  return s.filter((p) => Date.parse(`${p.d.slice(0, 10)}T00:00:00Z`) >= from);
}

/** Round, readable axis steps (1, 2, 2.5, 5 × 10^k) covering [min, max] with about `count` ticks. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!isNum(min) || !isNum(max)) return [];
  if (min === max) {
    const pad = Math.abs(min) * 0.05 || 1;
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = start; v <= end + step / 1e6; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

export interface ChartBox {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface ChartModel {
  close: string;
  sma50: string;
  sma200: string;
  yTicks: Array<{ v: number; y: number }>;
  /** the first point of a month, thinned to fit */
  xTicks: Array<{ i: number; d: string; x: number }>;
  x: (i: number) => number;
  y: (v: number) => number;
  n: number;
}

/**
 * An SVG path through the points that have a value; a missing value breaks the line (a new M after the gap),
 * so a 200-day average that starts mid-year does not draw a line from zero.
 */
export function linePath(values: Array<number | null>, x: (i: number) => number, y: (v: number) => number): string {
  let d = '';
  let pen = false;
  values.forEach((v, i) => {
    if (!isNum(v)) {
      pen = false;
      return;
    }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

/** Month starts in the series, keeping at most `max` evenly spread ones (never the very first point's partial month edge). */
export function monthTicks(series: InsightPoint[], max = 4): Array<{ i: number; d: string }> {
  const starts: Array<{ i: number; d: string }> = [];
  for (let i = 1; i < series.length; i++) if (series[i]!.d.slice(0, 7) !== series[i - 1]!.d.slice(0, 7)) starts.push({ i, d: series[i]!.d });
  if (starts.length <= max) return starts;
  const every = Math.ceil(starts.length / max);
  // count from the end so the latest month boundary is always labelled
  return starts.filter((_, k) => (starts.length - 1 - k) % every === 0);
}

/** Scales and paths for the price chart: x = index (trading days, left = oldest), y = price over all three lines. */
export function buildChart(series: InsightPoint[], box: ChartBox, tickCount = 4): ChartModel | null {
  const n = series.length;
  if (n < 2) return null;
  const vals: number[] = [];
  for (const p of series) for (const v of [p.c, p.sma50, p.sma200]) if (isNum(v)) vals.push(v);
  const ticks = niceTicks(Math.min(...vals), Math.max(...vals), tickCount);
  const lo = ticks[0]!;
  const hi = ticks[ticks.length - 1]!;
  const plotW = box.width - box.left - box.right;
  const plotH = box.height - box.top - box.bottom;
  const x = (i: number) => box.left + (i / (n - 1)) * plotW;
  const y = (v: number) => box.top + (hi === lo ? plotH / 2 : (1 - (v - lo) / (hi - lo)) * plotH);
  return {
    close: linePath(series.map((p) => p.c), x, y),
    sma50: linePath(series.map((p) => p.sma50), x, y),
    sma200: linePath(series.map((p) => p.sma200), x, y),
    yTicks: ticks.map((v) => ({ v, y: y(v) })),
    xTicks: monthTicks(series).map((m) => ({ ...m, x: x(m.i) })),
    x,
    y,
    n,
  };
}

/** The series index nearest to a pointer at `px` (viewBox units), clamped to the data. */
export function nearestIndex(px: number, n: number, box: ChartBox): number {
  if (n < 2) return 0;
  const plotW = box.width - box.left - box.right;
  const i = Math.round(((px - box.left) / plotW) * (n - 1));
  return Math.max(0, Math.min(n - 1, i));
}

/**
 * The payload can be drawn as analytics: no `unavailable` reason and a last-session date. When the hub sets
 * `unavailable`, asOf / instrumentType / trend.price are null and the rest is empty: show the reason and the
 * position only. Every section checks this first.
 */
export function insightsReady(d: HoldingInsights | undefined): d is HoldingInsights & { asOf: string } {
  return !!d && !d.unavailable && typeof d.asOf === 'string' && d.asOf.length > 0;
}

/** The trend readings (200-day, 50-day, 52-week range) that have data; none for an unavailable payload. */
export function trendReadings(t: T, d: HoldingInsights | undefined): string[] {
  if (!insightsReady(d) || !d.trend) return [];
  const tr = d.trend;
  return [avgReading(t, 200, tr.vsSma200Pct, tr.daysAboveSma200, tr.daysAboveSma200IsLowerBound === true), avgReading(t, 50, tr.vsSma50Pct), rangeReading(t, tr.fromHigh52Pct, tr.fromLow52Pct)].filter((s): s is string => !!s);
}
