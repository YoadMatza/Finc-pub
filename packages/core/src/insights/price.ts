/**
 * Price analytics for the stock-insights panel (sections B, C, D of research_notes/proposals/stock-insights.md).
 * Pure functions over daily bars (oldest first); no I/O. Every function returns null when the history is too short
 * for its window, never a number from a shorter one.
 *
 * Conventions:
 *  - a window of N sessions means the last N daily changes, i.e. the last N+1 bars (1 m = 21, 3 m = 63, 6 m = 126,
 *    1 y = 252, 3 y = 756 sessions); moving averages and the 52-week range use the last N bars themselves;
 *  - returns, averages, volatility, drawdown and beta use adjusted closes (splits and dividends included);
 *    the price now, the 52-week high/low and the bank comparison use Yahoo's close (split-adjusted only);
 *  - outputs are percent numbers (12.3 means 12.3%), unrounded here (the panel builder rounds).
 */
import type { DailyBar } from '../prices/history.js';

export const SESSIONS = { m1: 21, m3: 63, m6: 126, y1: 252, y3: 756 } as const;
/** "5 years" is the whole fetched history (range=5y, about 1,257 sessions); shorter than this, it is not 5 years */
export const MIN_5Y_SESSIONS = 1200;
/** beta needs at least this many aligned daily changes (of the 252 wanted) */
export const MIN_BETA_RETURNS = 240;

const pct = (a: number, b: number): number => (a / b - 1) * 100;

/** Mean of the last n values, or null when there are fewer than n. */
export function sma(values: readonly number[], n: number): number | null {
  if (n <= 0 || values.length < n) return null;
  let s = 0;
  for (let i = values.length - n; i < values.length; i++) s += values[i]!;
  return s / n;
}

/** The n-day moving average at every index (null for the first n−1). */
export function smaSeries(values: readonly number[], n: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (n <= 0) return out;
  let s = 0;
  for (let i = 0; i < values.length; i++) {
    s += values[i]!;
    if (i >= n) s -= values[i - n]!;
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

/**
 * Sessions in a row, counted back from the latest, on which the adjusted close was above (positive count) or below
 * (negative count) its 200-day average. 0 when the latest close equals it; null without a 200-day average. The count
 * stops where the average starts, so on a young history it is a lower bound.
 */
export function daysVsSma(adj: readonly number[], n = 200): number | null {
  return daysVsSmaDetail(adj, n).days;
}

/** daysVsSma with whether the streak reaches back to where the average starts (so the true streak may be longer). */
export function daysVsSmaDetail(adj: readonly number[], n = 200): { days: number | null; lowerBound: boolean } {
  const avg = smaSeries(adj, n);
  const last = adj.length - 1;
  if (last < 0 || avg[last] === null) return { days: null, lowerBound: false };
  const side = Math.sign(adj[last]! - avg[last]!);
  if (side === 0) return { days: 0, lowerBound: false };
  let k = 0;
  let i = last;
  for (; i >= 0 && avg[i] !== null && Math.sign(adj[i]! - avg[i]!) === side; i--) k++;
  return { days: side * k, lowerBound: i < 0 || avg[i] === null };
}

/** Total return over the last n sessions, percent; null when there are fewer than n+1 bars. */
export function periodReturn(adj: readonly number[], n: number): number | null {
  if (n <= 0 || adj.length < n + 1) return null;
  return pct(adj[adj.length - 1]!, adj[adj.length - 1 - n]!);
}

/** Annualised return over the last n sessions (252 a year), percent. */
export function annualisedReturn(adj: readonly number[], n: number): number | null {
  if (n <= 0 || adj.length < n + 1) return null;
  const growth = adj[adj.length - 1]! / adj[adj.length - 1 - n]!;
  return (growth ** (SESSIONS.y1 / n) - 1) * 100;
}

export interface Returns {
  m1: number | null;
  m3: number | null;
  m6: number | null;
  y1: number | null;
  y3Ann: number | null;
}

export function returnsOf(adj: readonly number[]): Returns {
  return { m1: periodReturn(adj, SESSIONS.m1), m3: periodReturn(adj, SESSIONS.m3), m6: periodReturn(adj, SESSIONS.m6), y1: periodReturn(adj, SESSIONS.y1), y3Ann: annualisedReturn(adj, SESSIONS.y3) };
}

/**
 * Annualised volatility, percent: the sample standard deviation (n−1) of the last n daily log returns ln(a_i/a_{i−1}),
 * times √252. Null when there are fewer than n+1 bars. A constant series is 0.
 */
export function volatility(adj: readonly number[], n: number = SESSIONS.y1): number | null {
  if (n < 2 || adj.length < n + 1) return null;
  const r: number[] = [];
  for (let i = adj.length - n; i < adj.length; i++) r.push(Math.log(adj[i]! / adj[i - 1]!));
  const mean = r.reduce((a, x) => a + x, 0) / r.length;
  const v = r.reduce((a, x) => a + (x - mean) ** 2, 0) / (r.length - 1);
  return Math.sqrt(v) * Math.sqrt(SESSIONS.y1) * 100;
}

export interface Drawdown {
  /** the deepest fall from a running high, percent (≤ 0) */
  pct: number;
  peakDate: string;
  troughDate: string;
}

/**
 * The deepest fall from a running high over the given bars (adjusted closes). With no fall at all, pct is 0 and both
 * dates are the first bar's.
 */
export function maxDrawdown(bars: readonly DailyBar[]): Drawdown | null {
  if (!bars.length) return null;
  let peak = bars[0]!;
  let best: Drawdown = { pct: 0, peakDate: peak.d, troughDate: peak.d };
  for (const b of bars) {
    if (b.adj > peak.adj) peak = b;
    const dd = pct(b.adj, peak.adj);
    if (dd < best.pct) best = { pct: dd, peakDate: peak.d, troughDate: b.d };
  }
  return best;
}

/** Max drawdown over the last n sessions (n+1 bars); null when the history is shorter. */
export function maxDrawdownOver(bars: readonly DailyBar[], n: number): Drawdown | null {
  if (bars.length < n + 1) return null;
  return maxDrawdown(bars.slice(bars.length - n - 1));
}

/** Max drawdown over the whole fetched history (5 y), null when it has fewer than MIN_5Y_SESSIONS sessions. */
export function maxDrawdown5y(bars: readonly DailyBar[]): Drawdown | null {
  return bars.length < MIN_5Y_SESSIONS ? null : maxDrawdown(bars);
}

/**
 * Beta against a benchmark: cov(r_s, r_m) / var(r_m) of simple daily returns over the last `n` changes between
 * dates both series have (dates intersected first, so a session missing on one side spans two on the other). Null
 * with fewer than MIN_BETA_RETURNS aligned changes, or a benchmark that never moved.
 */
export function beta(stock: readonly DailyBar[], bench: readonly DailyBar[], n: number = SESSIONS.y1, minReturns = MIN_BETA_RETURNS): number | null {
  const m = new Map(bench.map((b) => [b.d, b.adj]));
  const pairs: Array<[number, number]> = [];
  for (const b of stock) {
    const x = m.get(b.d);
    if (x !== undefined) pairs.push([b.adj, x]);
  }
  const aligned = pairs.slice(Math.max(0, pairs.length - n - 1));
  const rs: number[] = [];
  const rm: number[] = [];
  for (let i = 1; i < aligned.length; i++) {
    rs.push(aligned[i]![0] / aligned[i - 1]![0] - 1);
    rm.push(aligned[i]![1] / aligned[i - 1]![1] - 1);
  }
  if (rs.length < Math.max(2, minReturns)) return null;
  const ms = rs.reduce((a, x) => a + x, 0) / rs.length;
  const mm = rm.reduce((a, x) => a + x, 0) / rm.length;
  let cov = 0;
  let varM = 0;
  for (let i = 0; i < rs.length; i++) {
    cov += (rs[i]! - ms) * (rm[i]! - mm);
    varM += (rm[i]! - mm) ** 2;
  }
  if (varM <= 1e-18) return null;
  return cov / varM;
}

export interface Trend {
  /** the latest close (Yahoo's close, split-adjusted only) */
  price: number;
  sma50: number | null;
  sma200: number | null;
  vsSma50Pct: number | null;
  vsSma200Pct: number | null;
  daysAboveSma200: number | null;
  /** the streak reaches back to the first 200-day average: the real streak may be longer */
  daysAboveSma200IsLowerBound: boolean;
  high52: number | null;
  low52: number | null;
  fromHigh52Pct: number | null;
  fromLow52Pct: number | null;
}

/**
 * The adjusted value `v` of bar i in that day's own (close) prices: adjusted closes are in today's terms, so a moving
 * average of them is turned back into the day's price by close_i / adj_i (1 on the latest bar when no dividend went
 * ex since). Used for the averages drawn over the chart's closes and for the averages shown next to the price.
 */
const toClose = (v: number | null, b: DailyBar): number | null => (v === null ? null : (v * b.close) / b.adj);

export function trendOf(bars: readonly DailyBar[]): Trend | null {
  if (!bars.length) return null;
  const adj = bars.map((b) => b.adj);
  const last = bars[bars.length - 1]!;
  const a50 = sma(adj, 50);
  const a200 = sma(adj, 200);
  const streak = daysVsSmaDetail(adj, 200);
  let high52: number | null = null;
  let low52: number | null = null;
  if (bars.length >= SESSIONS.y1) {
    const w = bars.slice(bars.length - SESSIONS.y1).map((b) => b.close);
    high52 = Math.max(...w);
    low52 = Math.min(...w);
  }
  return {
    price: last.close,
    sma50: toClose(a50, last),
    sma200: toClose(a200, last),
    vsSma50Pct: a50 === null ? null : pct(last.adj, a50),
    vsSma200Pct: a200 === null ? null : pct(last.adj, a200),
    daysAboveSma200: streak.days,
    daysAboveSma200IsLowerBound: streak.lowerBound,
    high52,
    low52,
    fromHigh52Pct: high52 === null ? null : pct(last.close, high52),
    fromLow52Pct: low52 === null ? null : pct(last.close, low52),
  };
}

/** The last n bars with the 50- and 200-day averages in each day's own prices (for the chart). */
export function chartSeries(bars: readonly DailyBar[], n: number = SESSIONS.y1): Array<{ d: string; c: number; sma50: number | null; sma200: number | null }> {
  const adj = bars.map((b) => b.adj);
  const s50 = smaSeries(adj, 50);
  const s200 = smaSeries(adj, 200);
  const from = Math.max(0, bars.length - n);
  const out: Array<{ d: string; c: number; sma50: number | null; sma200: number | null }> = [];
  for (let i = from; i < bars.length; i++) {
    const b = bars[i]!;
    out.push({ d: b.d, c: b.close, sma50: toClose(s50[i]!, b), sma200: toClose(s200[i]!, b) });
  }
  return out;
}

export interface CrossCheck {
  bankPrice: number | null;
  bankAt: string | null;
  yahooClose: number | null;
  /** the session of the Yahoo close compared with */
  yahooDate: string | null;
  /** (bank / Yahoo − 1) × 100, rounded to 2 decimals */
  diffPct: number | null;
  /** |diffPct| ≤ 2 on the rounded value; null when there is nothing to compare */
  ok: boolean | null;
  /** why nothing was compared although there is a bank price: the snapshot was taken during the US session */
  note: 'intraday_snapshot' | null;
}

export const CROSS_CHECK_MAX_PCT = 2;
/** a Yahoo close older than this many calendar days before the expected session is no match */
const CROSS_CHECK_MAX_GAP_DAYS = 6;

/**
 * The bank's price at its sync against Yahoo's close of the session the bank's price stands for: the last US session
 * that had closed (16:00 New York, DST from Intl, weekends skipped) when the snapshot was taken — FIBI's morning sync
 * (Israel time) carries the previous US session's close. A holiday has no bar, so the latest bar on or before that
 * date is used (at most 6 days earlier). A snapshot taken during the session (`intraday`) may carry an intraday price,
 * so it is not compared (note 'intraday_snapshot').
 */
export function crossCheck(bankPrice: number | null, takenAt: string | null, bars: readonly DailyBar[], o: { expectedSession: (t: number) => string; intraday?: (t: number) => boolean }): CrossCheck {
  const t = takenAt ? Date.parse(takenAt) : Number.NaN;
  const none = (note: CrossCheck['note'] = null): CrossCheck => ({ bankPrice: bankPrice !== null && bankPrice > 0 ? bankPrice : null, bankAt: takenAt, yahooClose: null, yahooDate: null, diffPct: null, ok: null, note });
  if (bankPrice === null || !(bankPrice > 0) || !Number.isFinite(t)) return none();
  if (o.intraday?.(t)) return none('intraday_snapshot');
  const want = o.expectedSession(t);
  let bar: DailyBar | null = null;
  for (let i = bars.length - 1; i >= 0; i--) {
    if (bars[i]!.d <= want) {
      bar = bars[i]!;
      break;
    }
  }
  if (!bar || (Date.parse(want) - Date.parse(bar.d)) / 86_400_000 > CROSS_CHECK_MAX_GAP_DAYS) return none();
  const raw = pct(bankPrice, bar.close);
  const diffPct = Math.round(raw * 100) / 100 || 0;
  return { bankPrice, bankAt: takenAt, yahooClose: bar.close, yahooDate: bar.d, diffPct, ok: Math.abs(diffPct) <= CROSS_CHECK_MAX_PCT, note: null };
}

/**
 * The benchmark's returns over the SAME dates as the holding's windows (review M1): for each window the holding's
 * start and end session dates are taken, and the benchmark's adjusted closes on those dates compared (the end date
 * must be a benchmark session; for the start, the latest benchmark session on or before it, at most 6 days earlier).
 * Null when the holding's window is too short or the benchmark has no bar on the end date. 3 y is annualised with the
 * holding's session count (252/756).
 */
export function benchmarkReturns(stock: readonly DailyBar[], bench: readonly DailyBar[]): Returns {
  const out: Returns = { m1: null, m3: null, m6: null, y1: null, y3Ann: null };
  if (!stock.length || !bench.length) return out;
  const byDate = new Map(bench.map((b) => [b.d, b.adj]));
  const end = byDate.get(stock[stock.length - 1]!.d);
  if (end === undefined) return out;
  const onOrBefore = (d: string): number | null => {
    for (let i = bench.length - 1; i >= 0; i--) {
      const b = bench[i]!;
      if (b.d <= d) return (Date.parse(d) - Date.parse(b.d)) / 86_400_000 > CROSS_CHECK_MAX_GAP_DAYS ? null : b.adj;
    }
    return null;
  };
  const growth = (n: number): number | null => {
    if (stock.length < n + 1) return null;
    const start = onOrBefore(stock[stock.length - 1 - n]!.d);
    return start === null ? null : end / start;
  };
  const g = (n: number): number | null => {
    const x = growth(n);
    return x === null ? null : (x - 1) * 100;
  };
  out.m1 = g(SESSIONS.m1);
  out.m3 = g(SESSIONS.m3);
  out.m6 = g(SESSIONS.m6);
  out.y1 = g(SESSIONS.y1);
  const y3 = growth(SESSIONS.y3);
  out.y3Ann = y3 === null ? null : (y3 ** (SESSIONS.y1 / SESSIONS.y3) - 1) * 100;
  return out;
}
