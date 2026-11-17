/**
 * Yahoo Finance company news, the fallback for a held stock's news panel (stock-decision-aids.md, Part C): used only
 * when Finnhub is not set up, fails, or has no headline of the last 14 days for the stock (foreign listings and OTC
 * ADRs, which Finnhub's free plan does not cover). Fetched only when a news panel is opened; no key.
 *
 * What leaves the machine: the ticker, in the query of a GET to Yahoo's public search endpoint (news only, no fuzzy
 * match) on query1/query2.finance.yahoo.com, with a generic browser User-Agent, no cookies, no redirects. The log
 * carries counts and reason codes only (no symbol).
 *
 *  - fresh for 12 hours in memory and in `market_data_cache` (source 'yahoo', key `news:SYM`); a stale entry (up to
 *    30 days old) is served, with its date, when it cannot be refreshed (failure, rate limit, or too slow);
 *  - a failure is remembered 5 minutes per symbol; a 429 backs every fetch off 4, 8, 16… minutes up to an hour;
 *  - one fetch in flight per symbol; each request times out after 6 s; a panel waits at most 4 s (later answers
 *    come from the cache, or 'busy' when there is none), and the fetch still fills the cache for the next open;
 *  - items whose relatedTickers do not name the symbol are dropped (parseYahooNews in core).
 */
import { type AnalystsUnavailableCode, type Db, type FetchFn, type NewsRow, YAHOO_HOSTS, parseYahooNews, readMarketCache, validSymbol, writeMarketCache, yahooNewsPath, yahooSymbol } from '@finc/core';
import { log as defaultLog } from './logger.js';

export const YAHOO_NEWS_SOURCE = 'yahoo';
export const YAHOO_NEWS_TTL_MS = 12 * 60 * 60 * 1000;
export const YAHOO_NEWS_MAX_STALE_MS = 30 * 24 * 60 * 60 * 1000;
export const YAHOO_NEWS_FAIL_TTL_MS = 5 * 60 * 1000;
export const YAHOO_NEWS_BACKOFF_BASE_MS = 4 * 60 * 1000;
export const YAHOO_NEWS_BACKOFF_MAX_MS = 60 * 60 * 1000;
export const YAHOO_NEWS_TIMEOUT_MS = 6000;
export const YAHOO_NEWS_DEADLINE_MS = 4000;
/** the largest answer read (a search answer with 10 news items is a few kB) */
const MAX_BYTES = 512 * 1024;
const MAX_MEMORY = 128;
/** a generic browser user agent: nothing that names finc or the owner */
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const LATE = Symbol('late');

export type YahooNews = { ok: true; rows: NewsRow[]; fetchedAt: number; stale: boolean } | { ok: false; code: AnalystsUnavailableCode };

type Failure = 'rate_limited' | 'server' | 'network' | 'not_found' | 'bad_answer' | 'too_large';
const CODE: Record<Failure, AnalystsUnavailableCode> = { rate_limited: 'busy', server: 'unreachable', network: 'unreachable', not_found: 'invalid', bad_answer: 'invalid', too_large: 'invalid' };

export interface YahooNewsServiceDeps {
  db: Db;
  fetch?: FetchFn;
  now?: () => number;
  timeoutMs?: number;
  deadlineMs?: number;
  log?: { debug(o: object, m: string): void; info(o: object, m: string): void; warn(o: object, m: string): void };
}

export class YahooNewsService {
  private readonly memory = new Map<string, { rows: NewsRow[]; fetchedAt: number }>();
  private readonly failed = new Map<string, { at: number; code: AnalystsUnavailableCode }>();
  private readonly inflight = new Map<string, Promise<YahooNews>>();
  private failures = 0;
  private backoffUntil = 0;
  private requests = 0;
  private readonly now: () => number;
  private readonly log: NonNullable<YahooNewsServiceDeps['log']>;

  constructor(private readonly deps: YahooNewsServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? defaultLog;
  }

  /**
   * A held stock's recent news from Yahoo, within `deadlineMs` (default 4 s): fresh for 12 hours from memory or
   * market_data_cache, else one request; a stale entry is served (stale: true) when it cannot be refreshed. A symbol
   * Yahoo cannot take is 'not_covered'. Never throws.
   */
  async news(symbol: string, deadlineMs?: number): Promise<YahooNews> {
    if (!validSymbol(symbol)) return { ok: false, code: 'not_covered' };
    const sym = yahooSymbol(symbol);
    const k = `news:${sym}`;
    const t = this.now();
    const hit = this.cached(k, sym);
    const serve = (code: AnalystsUnavailableCode): YahooNews => {
      const age = hit ? this.now() - hit.fetchedAt : Number.POSITIVE_INFINITY;
      return hit && age >= 0 && age < YAHOO_NEWS_MAX_STALE_MS ? { ok: true, rows: hit.rows, fetchedAt: hit.fetchedAt, stale: true } : { ok: false, code };
    };
    if (hit && t >= hit.fetchedAt && t - hit.fetchedAt < YAHOO_NEWS_TTL_MS) return { ok: true, rows: hit.rows, fetchedAt: hit.fetchedAt, stale: false };
    const f = this.failed.get(k);
    if (f && t >= f.at && t - f.at < YAHOO_NEWS_FAIL_TTL_MS) return serve(f.code);
    if (t < this.backoffUntil) return serve('busy');
    const running = this.inflight.get(k);
    const fetching = running ?? this.fetchNews(k, sym).finally(() => this.inflight.delete(k));
    if (!running) this.inflight.set(k, fetching);
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<typeof LATE>((res) => {
      timer = setTimeout(() => res(LATE), Math.max(0, deadlineMs ?? this.deps.deadlineMs ?? YAHOO_NEWS_DEADLINE_MS));
      timer.unref?.();
    });
    try {
      const r = await Promise.race([fetching, late]);
      if (r === LATE) return serve('busy');
      return r.ok ? r : serve(r.code);
    } catch {
      return serve('unreachable');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** memory first, then the table (validated again on the way in) */
  private cached(k: string, sym: string): { rows: NewsRow[]; fetchedAt: number } | null {
    const m = this.memory.get(k);
    if (m) return m;
    try {
      const stored = readMarketCache(this.deps.db, YAHOO_NEWS_SOURCE, k);
      const rows = stored ? parseYahooNews(stored.value, sym) : null;
      if (!stored || !rows) return null;
      const e = { rows, fetchedAt: stored.fetchedAt };
      this.remember(k, e);
      return e;
    } catch {
      return null;
    }
  }

  private remember(k: string, e: { rows: NewsRow[]; fetchedAt: number }): void {
    this.memory.delete(k);
    this.memory.set(k, e);
    while (this.memory.size > MAX_MEMORY) {
      const first = this.memory.keys().next().value;
      if (first === undefined) break;
      this.memory.delete(first);
    }
  }

  private async fetchNews(k: string, sym: string): Promise<YahooNews> {
    const r = await this.request(sym);
    if (!r.ok) {
      const code = CODE[r.reason];
      if (r.reason !== 'rate_limited') this.failed.set(k, { at: this.now(), code });
      return { ok: false, code };
    }
    const rows = parseYahooNews(r.body, sym, (check) => this.log.info({ kind: 'news', reason: 'bad_answer', check }, 'yahoo news: answer failed validation'));
    if (!rows) {
      this.failed.set(k, { at: this.now(), code: 'invalid' });
      return { ok: false, code: 'invalid' };
    }
    const e = { rows, fetchedAt: this.now() };
    this.failed.delete(k);
    this.remember(k, e);
    try {
      // stored in Yahoo's own shape (already filtered to the symbol), so it is parsed again on the way in
      writeMarketCache(this.deps.db, YAHOO_NEWS_SOURCE, k, e.fetchedAt, { news: rows.map((x) => ({ title: x.title, publisher: x.source, link: x.url, providerPublishTime: Math.round(x.at / 1000) })) });
    } catch (err) {
      this.log.warn({ kind: 'news', err: err instanceof Error ? err.name : 'error' }, 'yahoo news: cache not stored');
    }
    this.log.debug({ kind: 'news', rows: rows.length }, 'yahoo news: fetched');
    return { ok: true, rows, fetchedAt: e.fetchedAt, stale: false };
  }

  /** query1 first, query2 when query1 fails with a server or network error; a 429 starts or extends the backoff */
  private async request(sym: string): Promise<{ ok: true; body: unknown } | { ok: false; reason: Failure; status?: number }> {
    const doFetch: FetchFn = this.deps.fetch ?? ((u, i) => fetch(u, i));
    let last: { ok: false; reason: Failure; status?: number } = { ok: false, reason: 'network' };
    for (const host of YAHOO_HOSTS) {
      this.requests++;
      let res: Response;
      try {
        res = await doFetch(`https://${host}${yahooNewsPath(sym)}`, { method: 'GET', headers: { 'user-agent': USER_AGENT, accept: 'application/json' }, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(this.deps.timeoutMs ?? YAHOO_NEWS_TIMEOUT_MS) });
      } catch {
        last = { ok: false, reason: 'network' };
        continue;
      }
      if (res.status === 429) {
        last = { ok: false, reason: 'rate_limited', status: 429 };
        break;
      }
      if (res.status >= 500) {
        last = { ok: false, reason: 'server', status: res.status };
        continue;
      }
      if (res.status === 404) {
        last = { ok: false, reason: 'not_found', status: 404 };
        break;
      }
      if (!res.ok) {
        last = { ok: false, reason: 'bad_answer', status: res.status };
        break;
      }
      const length = Number(res.headers.get('content-length') ?? '0');
      let text: string;
      try {
        text = length > MAX_BYTES ? '' : await res.text();
      } catch {
        last = { ok: false, reason: 'network' };
        continue;
      }
      if (length > MAX_BYTES || text.length > MAX_BYTES) {
        last = { ok: false, reason: 'too_large' };
        break;
      }
      let body: unknown;
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        last = { ok: false, reason: 'bad_answer', status: res.status };
        break;
      }
      this.failures = 0;
      this.backoffUntil = 0;
      return { ok: true, body };
    }
    if (last.reason === 'rate_limited') {
      this.failures++;
      const wait = Math.min(YAHOO_NEWS_BACKOFF_BASE_MS * 2 ** (this.failures - 1), YAHOO_NEWS_BACKOFF_MAX_MS);
      this.backoffUntil = this.now() + wait;
      this.log.warn({ failures: this.failures, waitMin: Math.round(wait / 60_000) }, 'yahoo news: rate limited, backing off');
    } else this.log.info({ reason: last.reason, ...(last.status ? { status: last.status } : {}) }, 'yahoo news: request failed');
    return last;
  }

  /** Counts only, for tests and health-like checks. */
  status(): { cached: number; inflight: number; requests: number; failures: number; backoffUntil: number | null } {
    return { cached: this.memory.size, inflight: this.inflight.size, requests: this.requests, failures: this.failures, backoffUntil: this.backoffUntil > this.now() ? this.backoffUntil : null };
  }
}
