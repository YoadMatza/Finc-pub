/**
 * Finnhub for the stock-insights panel (research_notes/proposals/stock-decision-aids.md, Part B): the analysts'
 * monthly recommendation counts and the earnings calendar of one company. Free plan (60 calls a minute); the key is
 * the owner's, from the vault (`finc vault set finnhub`, field apiKey).
 *
 * What leaves the machine: the ticker (and a date window for the calendar) in the query string, to https://finnhub.io
 * only. The key goes in the X-Finnhub-Token header, never in the URL, and is never logged or returned.
 *
 * Rules (as for Yahoo and SEC): one fixed host (checked on every URL), https, no redirects followed, no cookies, a
 * 10 s timeout, answers capped at 2 MB, symbol validated, every answer validated strictly (the symbol echoed, whole
 * counts ≥ 0, real dates, finite numbers); one bad entry refuses the whole answer.
 */
import type { FetchFn } from '../prices/yahoo.js';
import { readCapped } from './sec.js';

export const FINNHUB_HOST = 'finnhub.io';
export const FINNHUB_TIMEOUT_MS = 10_000;
export const FINNHUB_MAX_BYTES = 2 * 1024 * 1024;
/** the free key's shape (as `finc vault set finnhub` checks it) */
export const FINNHUB_KEY_RE = /^[A-Za-z0-9]{16,64}$/;
/** entries kept from an answer at most (a recommendation list is ~4 years of months; a calendar a handful) */
const MAX_ROWS = 120;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** analysts per company per month: far above any real count; more is a broken answer */
const MAX_COUNT = 1000;

const realDate = (s: unknown): s is string => {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
};

/**
 * The symbol Finnhub knows a US holding by: class shares with a dot (BRK.B; the bank's slash or Yahoo's dash form are
 * turned into it). Anything else that is not a plain US ticker (an exchange suffix such as .TA) answers null: not
 * covered.
 */
export function finnhubSymbol(symbol: string): string | null {
  const s = symbol.trim().toUpperCase();
  if (/^[A-Z]{1,5}[./-][A-Z]$/.test(s)) return s.replace(/[/-]/, '.');
  return /^[A-Z][A-Z0-9]{0,5}$/.test(s) ? s : null;
}

export const profilePath = (sym: string): string => `/api/v1/stock/profile2?symbol=${encodeURIComponent(sym)}`;
export const recommendationPath = (sym: string): string => `/api/v1/stock/recommendation?symbol=${encodeURIComponent(sym)}`;
export const earningsPath = (sym: string, from: string, to: string): string => `/api/v1/calendar/earnings?from=${from}&to=${to}&symbol=${encodeURIComponent(sym)}`;

export type FinnhubFailure = 'no_key' | 'forbidden' | 'rate_limited' | 'server' | 'network' | 'not_found' | 'bad_answer' | 'too_large';
export type FinnhubFetchResult = { ok: true; body: unknown } | { ok: false; reason: FinnhubFailure; status?: number };

/**
 * One GET to Finnhub: `path` (starting /api/v1/) on the fixed host, the key in the X-Finnhub-Token header. 401 (a
 * wrong key) is 'no_key'; 403 is 'forbidden' (Finnhub's answer for a symbol or endpoint the free plan does not cover:
 * says nothing about the key); 429 is 'rate_limited'. Never throws.
 */
export async function finnhubGet(path: string, opts: { apiKey: string | null; fetch?: FetchFn; timeoutMs?: number; maxBytes?: number }): Promise<FinnhubFetchResult> {
  const key = opts.apiKey?.trim() ?? '';
  if (!FINNHUB_KEY_RE.test(key)) return { ok: false, reason: 'no_key' };
  let u: URL;
  try {
    u = new URL(`https://${FINNHUB_HOST}${path}`);
  } catch {
    return { ok: false, reason: 'bad_answer' };
  }
  if (u.protocol !== 'https:' || u.hostname !== FINNHUB_HOST || u.port || u.username || u.password || !u.pathname.startsWith('/api/v1/')) return { ok: false, reason: 'bad_answer' };
  // the key must never ride in the URL (a caller passing token= in the path is refused)
  if ([...u.searchParams.keys()].some((k) => k.toLowerCase() === 'token')) return { ok: false, reason: 'bad_answer' };
  const doFetch = opts.fetch ?? ((x, i) => fetch(x, i));
  let res: Response;
  try {
    res = await doFetch(u.toString(), { method: 'GET', headers: { 'x-finnhub-token': key, accept: 'application/json' }, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(opts.timeoutMs ?? FINNHUB_TIMEOUT_MS) });
  } catch {
    return { ok: false, reason: 'network' };
  }
  if (res.status === 401) return { ok: false, reason: 'no_key', status: 401 };
  if (res.status === 403) return { ok: false, reason: 'forbidden', status: 403 };
  if (res.status === 429) return { ok: false, reason: 'rate_limited', status: 429 };
  if (res.status === 404) return { ok: false, reason: 'not_found', status: 404 };
  if (res.status >= 500) return { ok: false, reason: 'server', status: res.status };
  if (res.status !== 200) return { ok: false, reason: 'bad_answer', status: res.status };
  let text: string | null;
  try {
    text = await readCapped(res, opts.maxBytes ?? FINNHUB_MAX_BYTES);
  } catch {
    return { ok: false, reason: 'network' };
  }
  if (text === null) return { ok: false, reason: 'too_large' };
  try {
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: 'bad_answer', status: res.status };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// the symbol an answer is about, and Finnhub's own identity check (/stock/profile2)

/** a symbol as Finnhub writes one (share classes with a dot, foreign listings with a suffix) */
export const FINNHUB_ECHO_RE = /^[A-Z0-9][A-Z0-9.-]{0,14}$/;

/**
 * The one symbol every entry of an answer carries (upper-case), null when the answer has no entries (or is not a
 * list: the parser refuses it), or 'mixed' when entries disagree, lack a symbol or carry a malformed one. Finnhub
 * sometimes answers for another listing of the company (a share class, a primary listing elsewhere); the caller then
 * checks with profile2 that Finnhub itself maps the asked symbol to it.
 */
export function answerSymbol(body: unknown, kind: 'recommendation' | 'earnings'): string | null | 'mixed' {
  const list = kind === 'recommendation' ? body : body && typeof body === 'object' ? (body as { earningsCalendar?: unknown }).earningsCalendar : null;
  if (!Array.isArray(list)) return null;
  let sym: string | null = null;
  for (const x of list) {
    const s = x && typeof x === 'object' ? (x as { symbol?: unknown }).symbol : undefined;
    if (typeof s !== 'string' || !FINNHUB_ECHO_RE.test(s.toUpperCase())) return 'mixed';
    const u = s.toUpperCase();
    if (sym !== null && u !== sym) return 'mixed';
    sym = u;
  }
  return sym;
}

/**
 * profile2's answer: the ticker Finnhub maps the asked symbol to (upper-case), `ticker: null` for an empty answer
 * (Finnhub does not know it), or null when the shape is wrong.
 */
export function parseProfile(body: unknown): { ticker: string | null } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (Object.keys(body).length === 0) return { ticker: null };
  const t = (body as { ticker?: unknown }).ticker;
  if (t === undefined || t === null || t === '') return { ticker: null };
  return typeof t === 'string' && FINNHUB_ECHO_RE.test(t.toUpperCase()) ? { ticker: t.toUpperCase() } : null;
}

// ---------------------------------------------------------------------------------------------------------------
// /stock/recommendation

export interface RecommendationRow {
  /** YYYY-MM-DD (Finnhub dates each month on its first day) */
  period: string;
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
}

/** How an echoed symbol differs from the one asked for, as a category (never the symbols themselves, for the log). */
function symbolMismatch(echo: unknown, asked: string): string {
  if (typeof echo !== 'string') return 'symbol_missing';
  const a = asked.toUpperCase();
  const e = echo.toUpperCase();
  if (e.replace(/[.\-/]/g, '') === a.replace(/[.\-/]/g, '')) return 'symbol_punctuation';
  if (e.startsWith(a) || a.startsWith(e)) return 'symbol_prefix';
  return 'symbol_other';
}

const count = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_COUNT ? v : null);

/**
 * The recommendation answer (an array of {symbol, period, strongBuy, buy, hold, sell, strongSell}) to rows, newest
 * first, one per period; null when it is not an array or any entry is wrong (another symbol, a bad date, a count that
 * is not a whole number ≥ 0, a period after `today` + 31 days). An empty array is a valid answer (no coverage).
 */
export function parseRecommendations(body: unknown, symbol: string, today: string, onFail?: (check: string) => void): RecommendationRow[] | null {
  const fail = (check: string): null => (onFail?.(check), null);
  if (!Array.isArray(body)) return fail('shape');
  const latestOk = new Date(Date.parse(`${today}T00:00:00Z`) + 31 * 86_400_000).toISOString().slice(0, 10);
  const seen = new Set<string>();
  const out: RecommendationRow[] = [];
  for (const x of body.slice(0, MAX_ROWS * 4)) {
    if (!x || typeof x !== 'object') return fail('shape');
    const e = x as Record<string, unknown>;
    if (typeof e.symbol !== 'string' || e.symbol.toUpperCase() !== symbol.toUpperCase()) return fail(symbolMismatch(e.symbol, symbol));
    if (!realDate(e.period) || e.period > latestOk) return fail('period');
    const c = [count(e.strongBuy), count(e.buy), count(e.hold), count(e.sell), count(e.strongSell)];
    if (c.some((v) => v === null)) return fail('count');
    if (seen.has(e.period)) continue;
    seen.add(e.period);
    out.push({ period: e.period, strongBuy: c[0]!, buy: c[1]!, hold: c[2]!, sell: c[3]!, strongSell: c[4]! });
  }
  out.sort((a, b) => (a.period < b.period ? 1 : a.period > b.period ? -1 : 0));
  return out.slice(0, MAX_ROWS);
}

// ---------------------------------------------------------------------------------------------------------------
// /calendar/earnings

export type EarningsHour = 'bmo' | 'amc' | 'dmh';

export interface EarningsRow {
  date: string;
  /** before market open, after market close, during market hours; null when Finnhub does not say */
  hour: EarningsHour | null;
  epsEstimate: number | null;
  epsActual: number | null;
  quarter: number | null;
  year: number | null;
}

const num = (v: unknown): number | null | undefined => (v === null || v === undefined ? null : typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * The calendar answer ({earningsCalendar: [{date, hour, epsEstimate, epsActual, quarter, year, symbol}]}) to rows,
 * oldest first, one per date; null when the shape is wrong or any entry is (another symbol, a bad date or hour, a
 * number that is not finite, a quarter outside 1–4). Missing estimates and actuals are null.
 */
export function parseEarnings(body: unknown, symbol: string, onFail?: (check: string) => void): EarningsRow[] | null {
  const fail = (check: string): null => (onFail?.(check), null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('shape');
  const cal = (body as { earningsCalendar?: unknown }).earningsCalendar;
  if (!Array.isArray(cal)) return fail('shape');
  const byDate = new Map<string, EarningsRow>();
  for (const x of cal.slice(0, MAX_ROWS)) {
    if (!x || typeof x !== 'object') return fail('shape');
    const e = x as Record<string, unknown>;
    if (typeof e.symbol !== 'string' || e.symbol.toUpperCase() !== symbol.toUpperCase()) return fail(symbolMismatch(e.symbol, symbol));
    if (!realDate(e.date)) return fail('date');
    const hour = e.hour === '' || e.hour === null || e.hour === undefined ? null : e.hour === 'bmo' || e.hour === 'amc' || e.hour === 'dmh' ? e.hour : undefined;
    if (hour === undefined) return fail('hour');
    const est = num(e.epsEstimate);
    const act = num(e.epsActual);
    if (est === undefined || act === undefined) return fail('eps');
    const quarter = e.quarter === null || e.quarter === undefined ? null : typeof e.quarter === 'number' && Number.isInteger(e.quarter) && e.quarter >= 1 && e.quarter <= 4 ? e.quarter : undefined;
    const year = e.year === null || e.year === undefined ? null : typeof e.year === 'number' && Number.isInteger(e.year) && e.year >= 1990 && e.year <= 2200 ? e.year : undefined;
    if (quarter === undefined || year === undefined) return fail(quarter === undefined ? 'quarter' : 'year');
    if (!byDate.has(e.date)) byDate.set(e.date, { date: e.date, hour, epsEstimate: est, epsActual: act, quarter, year });
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
