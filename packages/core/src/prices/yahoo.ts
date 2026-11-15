/**
 * Quotes from Yahoo Finance's public chart endpoint (no key, no cookies). Only a ticker symbol (or the FX pair symbol)
 * leaves the machine, in the URL path; never a quantity, a value or an account. Every answer is validated strictly:
 * anything unexpected (a missing or non-positive price, a currency other than the holding's, another symbol, a time
 * in the future) makes the quote unavailable, and the live view falls back to the bank's own numbers.
 *
 * Fields used from chart.result[0].meta: symbol (required, must match), instrumentType (EQUITY/ETF, or CURRENCY for
 * the rate, when present), currency, regularMarketPrice, regularMarketTime (unix seconds),
 * exchangeTimezoneName, marketState (rarely present on this endpoint), previousClose (only on some answers). The
 * previous close otherwise comes from the daily bars (timestamp + indicators.quote[0].close): the last close before
 * the bar of regularMarketTime's day. chartPreviousClose is NOT a day-over-day close with range=5d (it is the close
 * before the five-day window), so it is used only when the range is a single day.
 */
import { localDate } from './market.js';

export const YAHOO_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'] as const;
/** US dollars to shekels (price is shekels per dollar) */
export const USD_ILS_SYMBOL = 'ILS=X';
export const QUOTE_TIMEOUT_MS = 10_000;
const SYMBOL_RE = /^[A-Z0-9^][A-Z0-9.=^-]{0,14}$/;
/** a generic browser user agent: nothing that names finc or the owner */
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export function validSymbol(s: unknown): s is string {
  return typeof s === 'string' && SYMBOL_RE.test(s);
}

/**
 * The symbol Yahoo knows a holding by: US class shares written with a dot (BRK.B) are BRK-B there. Exchange suffixes
 * (TEVA.TA, two letters or more) stay as they are.
 */
export function yahooSymbol(symbol: string): string {
  return /^[A-Z]{1,5}\.[A-Z]$/.test(symbol) ? symbol.replace('.', '-') : symbol;
}

/** Instrument types accepted when Yahoo names one (an absent type is accepted). */
const SECURITY_TYPES = new Set(['EQUITY', 'ETF']);
const FX_TYPES = new Set(['CURRENCY']);

export interface Quote {
  symbol: string;
  price: number;
  prevClose: number | null;
  currency: string;
  /** regularMarketTime, ms */
  marketTime: number;
  /** Yahoo's marketState (REGULAR, CLOSED, PRE, POST…) when the answer carries one */
  marketState: string | null;
  exchangeTz: string | null;
  /** when finc fetched it, ms */
  fetchedAt: number;
}

const pos = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/**
 * One chart answer to a Quote, or null when anything needed is missing or wrong. `expectCurrency` is the holding's
 * currency (or ILS for the dollar rate); a different currency (ILA agorot for a Tel Aviv listing, say) is refused.
 */
export function parseChart(body: unknown, symbol: string, expectCurrency: string, fetchedAt: number, range = '5d', kind: 'security' | 'fx' = symbol.endsWith('=X') ? 'fx' : 'security'): Quote | null {
  const result = (body as { chart?: { result?: unknown } } | null)?.chart?.result;
  if (!Array.isArray(result) || result.length === 0) return null;
  const r = result[0] as { meta?: Record<string, unknown>; timestamp?: unknown; indicators?: { quote?: Array<{ close?: unknown }> } } | null;
  const meta = r?.meta;
  if (!meta || typeof meta !== 'object') return null;
  // the answer must name the symbol asked for (a missing or different one is a broken or redirected answer)
  if (typeof meta.symbol !== 'string' || meta.symbol.toUpperCase() !== symbol.toUpperCase()) return null;
  if (typeof meta.instrumentType === 'string' && !(kind === 'fx' ? FX_TYPES : SECURITY_TYPES).has(meta.instrumentType)) return null;
  const currency = typeof meta.currency === 'string' ? meta.currency : null;
  if (!currency || currency !== expectCurrency) return null;
  const price = pos(meta.regularMarketPrice);
  const timeS = pos(meta.regularMarketTime);
  if (price === null || timeS === null) return null;
  const marketTime = timeS * 1000;
  if (marketTime > fetchedAt + 60 * 60 * 1000) return null; // a quote from the future is a broken answer
  const exchangeTz = typeof meta.exchangeTimezoneName === 'string' && meta.exchangeTimezoneName.length <= 64 ? meta.exchangeTimezoneName : null;
  const marketState = typeof meta.marketState === 'string' && meta.marketState.length <= 16 ? meta.marketState : null;
  let prevClose = pos(meta.previousClose) ?? barsPrevClose(r?.timestamp, r?.indicators?.quote?.[0]?.close, marketTime, exchangeTz);
  if (prevClose === null && range === '1d') prevClose = pos(meta.chartPreviousClose);
  return { symbol, price, prevClose, currency, marketTime, marketState, exchangeTz, fetchedAt };
}

/** The close of the last daily bar before regularMarketTime's trading day. */
function barsPrevClose(ts: unknown, closes: unknown, marketTime: number, tz: string | null): number | null {
  if (!Array.isArray(ts) || !Array.isArray(closes) || ts.length !== closes.length || ts.length === 0) return null;
  const zone = tz ?? 'America/New_York';
  const today = localDate(marketTime, zone);
  for (let i = ts.length - 1; i >= 0; i--) {
    const t = pos(ts[i]);
    const c = pos(closes[i]);
    if (t === null || c === null) continue;
    if (localDate(t * 1000, zone) < today) return c;
  }
  return null;
}

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export type QuoteResult = { ok: true; quote: Quote } | { ok: false; reason: 'invalid_symbol' | 'rate_limited' | 'server' | 'network' | 'not_found' | 'bad_answer'; status?: number };

/**
 * Fetches one quote: query1 first, query2 when query1 fails with a server or network error. Never throws.
 */
export async function fetchQuote(symbol: string, expectCurrency: string, opts: { fetch?: FetchFn; now?: () => number; timeoutMs?: number } = {}): Promise<QuoteResult> {
  if (!validSymbol(symbol)) return { ok: false, reason: 'invalid_symbol' };
  const doFetch = opts.fetch ?? ((u, i) => fetch(u, i));
  const now = opts.now ?? Date.now;
  const asked = yahooSymbol(symbol);
  let last: QuoteResult = { ok: false, reason: 'network' };
  for (const host of YAHOO_HOSTS) {
    const url = `https://${host}/v8/finance/chart/${encodeURIComponent(asked)}?interval=1d&range=5d`;
    let res: Response;
    try {
      res = await doFetch(url, { method: 'GET', headers: { 'user-agent': USER_AGENT, accept: 'application/json' }, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(opts.timeoutMs ?? QUOTE_TIMEOUT_MS) });
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
      return { ok: false, reason: 'bad_answer', status: res.status };
    }
    const quote = parseChart(body, asked, expectCurrency, now());
    // cached under the holding's own symbol
    return quote ? { ok: true, quote: { ...quote, symbol } } : { ok: false, reason: 'bad_answer', status: res.status };
  }
  return last;
}
