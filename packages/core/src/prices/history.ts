/**
 * Daily price history from Yahoo Finance's public chart endpoint, for the stock-insights panel (design note
 * research_notes/proposals/stock-insights.md, step 1). Same rules as live quotes (yahoo.ts): only the ticker symbol
 * leaves the machine, in the URL path; fixed hosts query1/query2.finance.yahoo.com; no cookies, no redirects, a
 * timeout; a generic user agent. Every answer is validated strictly and refused whole when anything is off.
 *
 * Request: v8/finance/chart/<SYM>?interval=1d&range=5y&events=div,split
 *
 * Fields used from chart.result[0]:
 *  - meta.symbol (must equal the symbol asked), meta.instrumentType (EQUITY or ETF, required), meta.currency (must be
 *    the holding's), meta.exchangeTimezoneName (the zone a bar's date is read in; New York when absent),
 *    meta.currentTradingPeriod.regular.end (to drop a session still in progress);
 *  - timestamp[] (unix seconds, one per session), indicators.quote[0].close[] and indicators.adjclose[0].adjclose[];
 *  - events.dividends / events.splits (objects keyed by timestamp: {amount, date} / {numerator, denominator, date}).
 *
 * Conventions (Yahoo's, checked 2026-11-11): `close` is already split-adjusted but not dividend-adjusted (the "raw"
 * close: it matches the bank's price, the 52-week range is read from it); `adjclose` is split- and dividend-adjusted
 * (returns, averages, volatility, drawdown and beta are read from it). A bar with either value null (a halt) is
 * dropped; a value that is present but not a finite positive number refuses the answer, and so does any inconsistency
 * between the two series (consistency(): a missing split adjustment, a one-day move beyond 3x, a bad print). A second
 * row of the same day as the LAST row (the live session) is dropped; a duplicate day elsewhere refuses. Fail closed.
 */
import { US_TZ, localDate, wallTime } from './market.js';
import { type FetchFn, QUOTE_TIMEOUT_MS, YAHOO_HOSTS, validSymbol, yahooSymbol } from './yahoo.js';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
export const HISTORY_TIMEOUT_MS = Math.max(QUOTE_TIMEOUT_MS, 15_000);
/** 5 years is about 1,257 sessions; anything far beyond that is not the answer asked for */
export const HISTORY_MAX_BARS = 2000;
/**
 * The ranges finc asks for: 5 years for the insights panel, 10 years (about 2,515 sessions) for SPY in the position
 * view, whose purchase lots can be older than 5 years (position-view.md §5).
 */
export type HistoryRange = '5y' | '10y';
export const HISTORY_RANGE_MAX_BARS: Record<HistoryRange, number> = { '5y': HISTORY_MAX_BARS, '10y': 4000 };
const MAX_EVENTS = 400;
const TYPES = new Set(['EQUITY', 'ETF']);

export interface DailyBar {
  /** session date, YYYY-MM-DD in the exchange's zone */
  d: string;
  /** Yahoo's close: split-adjusted, not dividend-adjusted */
  close: number;
  /** split- and dividend-adjusted close */
  adj: number;
}

export interface PriceHistory {
  symbol: string;
  currency: string;
  instrumentType: 'EQUITY' | 'ETF';
  exchangeTz: string;
  /** oldest first, strictly increasing dates, completed sessions only */
  bars: DailyBar[];
  dividends: Array<{ d: string; amount: number }>;
  splits: Array<{ d: string; ratio: string }>;
  /** when finc fetched it, ms */
  fetchedAt: number;
}

export type HistoryParse = { ok: true; history: PriceHistory } | { ok: false; why: string };

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const posNum = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
};
const fail = (why: string): HistoryParse => ({ ok: false, why });

/**
 * One chart answer (5 y of daily bars) to a PriceHistory, or the reason it was refused. `symbol` is the symbol asked
 * of Yahoo (yahooSymbol), `expectCurrency` the holding's currency.
 */
export function parseHistory(body: unknown, symbol: string, expectCurrency: string, fetchedAt: number, range: HistoryRange = '5y'): HistoryParse {
  const result = (body as { chart?: { result?: unknown } } | null)?.chart?.result;
  if (!Array.isArray(result) || result.length === 0) return fail('shape');
  const r = result[0] as {
    meta?: Record<string, unknown>;
    timestamp?: unknown;
    indicators?: { quote?: Array<{ close?: unknown }>; adjclose?: Array<{ adjclose?: unknown }> };
    events?: { dividends?: unknown; splits?: unknown };
  } | null;
  const meta = r?.meta;
  if (!meta || typeof meta !== 'object') return fail('shape');
  if (typeof meta.symbol !== 'string' || meta.symbol.toUpperCase() !== symbol.toUpperCase()) return fail('symbol');
  if (typeof meta.instrumentType !== 'string' || !TYPES.has(meta.instrumentType)) return fail('type');
  if (typeof meta.currency !== 'string' || meta.currency !== expectCurrency) return fail('currency');
  const tz = typeof meta.exchangeTimezoneName === 'string' && meta.exchangeTimezoneName.length <= 64 ? meta.exchangeTimezoneName : US_TZ;
  try {
    localDate(0, tz);
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    return fail('timezone');
  }
  const ts = r?.timestamp;
  const closes = r?.indicators?.quote?.[0]?.close;
  const adjs = r?.indicators?.adjclose?.[0]?.adjclose;
  if (!Array.isArray(ts) || !Array.isArray(closes) || !Array.isArray(adjs)) return fail('shape');
  if (ts.length !== closes.length || ts.length !== adjs.length) return fail('shape');
  if (ts.length === 0 || ts.length > HISTORY_RANGE_MAX_BARS[range]) return fail('length');

  const bars: DailyBar[] = [];
  let prevT = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < ts.length; i++) {
    const t = num(ts[i]);
    if (t === null || t <= 0) return fail('value');
    if (t <= prevT) return fail('order');
    prevT = t;
    if (t * 1000 > fetchedAt + 60 * 60 * 1000) return fail('future');
    const c = closes[i];
    const a = adjs[i];
    if (c === null || a === null) continue; // a halted session, or one side missing: the bar is dropped
    const close = posNum(c);
    const adj = posNum(a);
    if (close === null || adj === null) return fail('value');
    const d = localDate(t * 1000, tz);
    if (bars.length && bars[bars.length - 1]!.d === d) {
      // Yahoo sometimes appends the live session as a second row of the same day: keep the earlier row
      if (i === ts.length - 1) continue;
      return fail('duplicate');
    }
    if (bars.length && bars[bars.length - 1]!.d > d) return fail('order');
    bars.push({ d, close, adj });
  }
  if (!bars.length) return fail('length');
  // a session still in progress (its close is the live price): drop it, the panel speaks of completed sessions
  const last = bars[bars.length - 1]!;
  if (inProgress(last.d, meta, tz, fetchedAt)) bars.pop();
  if (!bars.length) return fail('length');

  const firstD = bars[0]!.d;
  const dividends: PriceHistory['dividends'] = [];
  for (const e of events(r?.events?.dividends)) {
    const amount = posNum(e.v.amount);
    const t = posNum(e.v.date) ?? e.t;
    if (amount === null || t === null) return fail('dividend');
    dividends.push({ d: localDate(t * 1000, tz), amount });
  }
  const splits: PriceHistory['splits'] = [];
  const splitFactors: Array<{ d: string; f: number }> = [];
  for (const e of events(r?.events?.splits)) {
    const n = posNum(e.v.numerator);
    const dd = posNum(e.v.denominator);
    const t = posNum(e.v.date) ?? e.t;
    if (n === null || dd === null || t === null) return fail('split');
    const d = localDate(t * 1000, tz);
    splits.push({ d, ratio: `${trimNum(n)}:${trimNum(dd)}` });
    splitFactors.push({ d, f: n / dd });
  }
  const bad = consistency(bars, dividends, splitFactors);
  if (bad) return fail(bad);
  if (dividends.length > MAX_EVENTS || splits.length > MAX_EVENTS) return fail('events');
  const inRange = <T extends { d: string }>(xs: T[]): T[] => xs.filter((x) => x.d >= firstD && x.d <= bars[bars.length - 1]!.d).sort((a, b) => a.d.localeCompare(b.d));
  return {
    ok: true,
    history: { symbol, currency: meta.currency, instrumentType: meta.instrumentType as 'EQUITY' | 'ETF', exchangeTz: tz, bars, dividends: inRange(dividends), splits: inRange(splits), fetchedAt },
  };
}

/** a one-day move beyond this (either way) is refused: a missing adjustment or a bad print, never a real session */
const MAX_DAY_LOG_MOVE = Math.log(3);
/** a bar this far (either way) from both neighbours, which agree with each other, is a bad print */
const BAD_PRINT_LOG = Math.log(1.5);
/** close/adj may not fall below this (adj is the close less later dividends, so the ratio is at least 1) */
const MIN_CLOSE_ADJ_RATIO = 0.98;
/** close/adj may change from one bar to the next only on a dividend date; rounding noise below this is ignored */
const RATIO_STEP_TOL = 0.01;

/**
 * Cross-checks the two series (review H1, H2); the reason code, or null when consistent:
 *  - close/adj ≥ 0.98 on every bar, and it steps (by more than 1%) only between bars with a dividend going ex;
 *  - on a split's date, neither series moved by the split's factor (the move is closer to the factor than to none);
 *  - no one-day move beyond 3× either way in either series;
 *  - no single bar more than 50% away from both neighbours that agree with each other (a bad print).
 */
function consistency(bars: readonly DailyBar[], dividends: ReadonlyArray<{ d: string }>, splits: ReadonlyArray<{ d: string; f: number }>): string | null {
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    const q = b.close / b.adj;
    if (q < MIN_CLOSE_ADJ_RATIO) return 'adjustment';
    if (i === 0) continue;
    const p = bars[i - 1]!;
    const between = <T extends { d: string }>(xs: readonly T[]): T[] => xs.filter((x) => x.d > p.d && x.d <= b.d);
    const qp = p.close / p.adj;
    if (Math.abs(Math.log(q / qp)) > RATIO_STEP_TOL && between(dividends).length === 0) return 'adjustment';
    if (i + 1 < bars.length) {
      const n = bars[i + 1]!;
      for (const [x0, x1, x2] of [[p.close, b.close, n.close], [p.adj, b.adj, n.adj]] as const) {
        const up = Math.log(x1 / x0);
        const down = Math.log(x1 / x2);
        if (Math.abs(up) > BAD_PRINT_LOG && Math.abs(down) > BAD_PRINT_LOG && Math.sign(up) === Math.sign(down) && Math.abs(Math.log(x2 / x0)) < BAD_PRINT_LOG) return 'bad_print';
      }
    }
    const split = between(splits).reduce((a, x) => a * x.f, 1);
    for (const [x0, x1] of [[p.close, b.close], [p.adj, b.adj]] as const) {
      const r = Math.log(x1 / x0);
      if (Math.abs(Math.log(split)) > 0.05 && Math.abs(r + Math.log(split)) < Math.abs(r)) return 'split_unadjusted';
      if (Math.abs(r) > MAX_DAY_LOG_MOVE) return split !== 1 ? 'split_unadjusted' : 'jump';
    }
  }
  return null;
}

const trimNum = (n: number): string => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1e6) / 1e6));

function events(o: unknown): Array<{ t: number | null; v: Record<string, unknown> }> {
  if (o === undefined || o === null) return [];
  if (typeof o !== 'object' || Array.isArray(o)) return [{ t: null, v: {} }]; // refused by the caller
  return Object.entries(o as Record<string, unknown>).map(([k, v]) => ({ t: posNum(Number(k)), v: v && typeof v === 'object' ? (v as Record<string, unknown>) : {} }));
}

/** Is the session dated `d` still open (or not settled) at `fetchedAt`? */
function inProgress(d: string, meta: Record<string, unknown>, tz: string, fetchedAt: number): boolean {
  if (d !== localDate(fetchedAt, tz)) return false;
  const end = posNum((meta.currentTradingPeriod as { regular?: { end?: unknown } } | undefined)?.regular?.end);
  if (end !== null && localDate(end * 1000, tz) === d) return fetchedAt < end * 1000 + 5 * 60 * 1000;
  // no trading period in the answer: a US session closes at 16:00, settled five minutes later
  const w = wallTime(fetchedAt, tz);
  return w.hour * 60 + w.minute < 16 * 60 + 5;
}

export type HistoryResult = { ok: true; history: PriceHistory } | { ok: false; reason: 'invalid_symbol' | 'rate_limited' | 'server' | 'network' | 'not_found' | 'bad_answer'; status?: number; why?: string };

/** Fetches 5 years of daily bars: query1 first, query2 when query1 fails with a server or network error. Never throws. */
export async function fetchHistory(symbol: string, expectCurrency: string, opts: { fetch?: FetchFn; now?: () => number; timeoutMs?: number; range?: HistoryRange } = {}): Promise<HistoryResult> {
  const range = opts.range ?? '5y';
  if (!validSymbol(symbol)) return { ok: false, reason: 'invalid_symbol' };
  if (!/^[A-Z]{3}$/.test(expectCurrency)) return { ok: false, reason: 'bad_answer', why: 'currency' };
  const doFetch = opts.fetch ?? ((u, i) => fetch(u, i));
  const now = opts.now ?? Date.now;
  const asked = yahooSymbol(symbol);
  let last: HistoryResult = { ok: false, reason: 'network' };
  for (const host of YAHOO_HOSTS) {
    const url = `https://${host}/v8/finance/chart/${encodeURIComponent(asked)}?interval=1d&range=${range}&events=div%2Csplit`;
    let res: Response;
    try {
      res = await doFetch(url, { method: 'GET', headers: { 'user-agent': USER_AGENT, accept: 'application/json' }, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(opts.timeoutMs ?? HISTORY_TIMEOUT_MS) });
    } catch {
      last = { ok: false, reason: 'network' };
      continue;
    }
    if (res.status === 429) return { ok: false, reason: 'rate_limited', status: 429 };
    if (res.status === 404) return { ok: false, reason: 'not_found', status: 404 };
    if (res.status >= 500) {
      last = { ok: false, reason: 'server', status: res.status };
      continue;
    }
    if (!res.ok) return { ok: false, reason: 'bad_answer', status: res.status };
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, reason: 'bad_answer', status: res.status, why: 'json' };
    }
    const p = parseHistory(body, asked, expectCurrency, now(), range);
    return p.ok ? { ok: true, history: { ...p.history, symbol } } : { ok: false, reason: 'bad_answer', status: res.status, why: p.why };
  }
  return last;
}
