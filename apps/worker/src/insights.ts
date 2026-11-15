/**
 * Price histories for the stock-insights panel (research_notes/proposals/stock-insights.md, step 1): 5 years of
 * daily bars per symbol from Yahoo Finance, fetched only when a panel is opened, kept in memory for 6 hours. SPY (the
 * benchmark) and the company's SPDR sector fund (step 2; the fund named by SEC's SIC code, sec.ts) are fetched the
 * same way. Nothing is stored in the database.
 *
 * What leaves the machine: the holding's ticker symbol (validSymbol) and SPY, in the URL path of a GET to
 * query1/query2.finance.yahoo.com (prices/history.ts). The log carries counts and reason codes only: no symbol,
 * price or amount.
 *
 *  - one fetch in flight per symbol: a second panel open joins it;
 *  - a 429 (rate limited) backs every history fetch off 4, 8, 16… minutes up to an hour (cached histories are still
 *    served); a server or network failure is remembered per symbol for 5 minutes, so repeated opens do not hammer;
 *  - a refused answer (bad_answer, not_found) is remembered per symbol for the same 5 minutes;
 *  - the cache holds at most 64 symbols (the oldest goes first);
 *  - each request times out after 6 s, and a panel open never waits more than 8 s in all: what is not there by then
 *    answers as unreachable (the holding) or no benchmark (SPY), and the fetch still fills the cache for the next open;
 *  - the sector fund waits within the same deadline; a late or stale one leaves the panel without it (no refetch);
 *  - SPY must have the holding's last session: a stale cached SPY is refetched once (per holding session date), and
 *    if it is still behind the panel goes without the benchmark (panel.ts);
 *  - cross-check mismatches are counted once per ticker and session date (the log has counts only).
 */
import { BENCHMARK_SYMBOL, type FetchFn, type HistoryResult, type PriceHistory, fetchHistory } from '@finc/core';
import { log as defaultLog } from './logger.js';

export const HISTORY_TTL_MS = 6 * 60 * 60 * 1000;
export const HISTORY_FAIL_TTL_MS = 5 * 60 * 1000;
export const HISTORY_BACKOFF_BASE_MS = 4 * 60 * 1000;
export const HISTORY_BACKOFF_MAX_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 64;
export const HISTORY_REQUEST_TIMEOUT_MS = 6000;
export const HISTORY_DEADLINE_MS = 8000;
const MAX_SEEN = 1000;

type Failure = Extract<HistoryResult, { ok: false }>;

export interface InsightsServiceDeps {
  fetch?: FetchFn;
  now?: () => number;
  /** per request (default 6 s) */
  timeoutMs?: number;
  /** a whole panel open (default 8 s) */
  deadlineMs?: number;
  log?: { debug(o: object, m: string): void; info(o: object, m: string): void; warn(o: object, m: string): void };
}

export class InsightsService {
  private readonly cache = new Map<string, { at: number; result: HistoryResult }>();
  private readonly inflight = new Map<string, Promise<HistoryResult>>();
  private failures = 0;
  private backoffUntil = 0;
  private checks = 0;
  private mismatches = 0;
  /** ticker|session dates already counted by noteCrossCheck */
  private readonly checked = new Set<string>();
  /** holding session dates SPY was already refetched for */
  private readonly spyForced = new Set<string>();
  private readonly now: () => number;
  private readonly log: NonNullable<InsightsServiceDeps['log']>;

  constructor(private readonly deps: InsightsServiceDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? defaultLog;
  }

  /**
   * The holding's history and SPY's, fetched side by side, within the deadline. SPY null when it failed, is late, or
   * (after one refetch) still lacks the holding's last session. Never throws.
   */
  async histories(symbol: string, currency: string, o: { sector?: Promise<string | null> | null } = {}): Promise<{ history: HistoryResult; spy: PriceHistory | null; sector: PriceHistory | null }> {
    const isSpy = symbol === BENCHMARK_SYMBOL && currency === 'USD';
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<'late'>((res) => {
      timer = setTimeout(() => res('late'), this.deps.deadlineMs ?? HISTORY_DEADLINE_MS);
      timer.unref?.();
    });
    const within = async <T>(p: Promise<T>): Promise<T | 'late'> => Promise.race([p, late]);
    try {
      const hp = this.history(symbol, currency);
      const sp = isSpy ? null : this.history(BENCHMARK_SYMBOL, 'USD');
      // the sector fund (step 2): its symbol comes from SEC (the company's SIC code), its history from Yahoo like SPY's
      const xp = o.sector ? o.sector.then((x) => (x && x !== symbol ? this.history(x, 'USD') : null)).catch(() => null) : null;
      const sectorOf = async (): Promise<PriceHistory | null> => {
        if (!xp) return null;
        const x = await within(xp);
        if (x === 'late') this.log.info({ late: 'sector' }, 'insights: sector fund late, panel without it');
        return x !== 'late' && x?.ok ? x.history : null;
      };
      const h = await within(hp);
      const history: HistoryResult = h === 'late' ? { ok: false, reason: 'network' } : h;
      if (isSpy) return { history, spy: history.ok ? history.history : null, sector: await sectorOf() };
      const s0 = await within(sp!);
      let spy = s0 !== 'late' && s0.ok ? s0.history : null;
      if (history.ok && spy) {
        const asOf = history.history.bars.at(-1)?.d;
        const spyLast = spy.bars.at(-1)?.d;
        if (asOf && spyLast && spyLast < asOf && !this.spyForced.has(asOf)) {
          remember(this.spyForced, asOf);
          const s1 = await within(this.history(BENCHMARK_SYMBOL, 'USD', { force: true }));
          spy = s1 !== 'late' && s1.ok ? s1.history : null;
        }
      }
      if (s0 === 'late') this.log.info({ late: 'benchmark' }, 'insights: benchmark late, panel without it');
      return { history, spy, sector: await sectorOf() };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** One symbol's history: from the cache (unless forced), the fetch in flight, or a new fetch. Never throws. */
  history(symbol: string, currency: string, o: { force?: boolean } = {}): Promise<HistoryResult> {
    const key = `${symbol}|${currency}`;
    const t = this.now();
    const hit = this.cache.get(key);
    if (!o.force && hit && t - hit.at < (hit.result.ok ? HISTORY_TTL_MS : HISTORY_FAIL_TTL_MS) && t >= hit.at) return Promise.resolve(hit.result);
    const running = this.inflight.get(key);
    if (running) return running;
    if (t < this.backoffUntil) return Promise.resolve({ ok: false, reason: 'rate_limited' } satisfies Failure);
    const p = this.fetchOne(symbol, currency, key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async fetchOne(symbol: string, currency: string, key: string): Promise<HistoryResult> {
    const r: HistoryResult = await fetchHistory(symbol, currency, { ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}), now: this.now, timeoutMs: this.deps.timeoutMs ?? HISTORY_REQUEST_TIMEOUT_MS }).catch(() => ({ ok: false, reason: 'network' }) as const);
    if (r.ok) {
      this.failures = 0;
      this.backoffUntil = 0;
      this.put(key, r);
      this.log.debug({ bars: r.history.bars.length }, 'insights: history fetched');
      return r;
    }
    if (r.reason === 'rate_limited') {
      this.failures++;
      const wait = Math.min(HISTORY_BACKOFF_BASE_MS * 2 ** (this.failures - 1), HISTORY_BACKOFF_MAX_MS);
      this.backoffUntil = this.now() + wait;
      this.log.warn({ failures: this.failures, waitMin: Math.round(wait / 60_000) }, 'insights: rate limited, backing off');
      return r;
    }
    if (r.reason !== 'invalid_symbol') this.put(key, r);
    this.log.info({ reason: r.reason, ...(r.why ? { why: r.why } : {}), ...(r.status ? { status: r.status } : {}) }, 'insights: history unavailable');
    return r;
  }

  private put(key: string, result: HistoryResult): void {
    this.cache.delete(key);
    this.cache.set(key, { at: this.now(), result });
    while (this.cache.size > MAX_ENTRIES) {
      const first = this.cache.keys().next().value;
      if (first === undefined) break;
      this.cache.delete(first);
    }
  }

  /** Counts a bank cross-check once per ticker and session date (counts only in the log, never the symbol or prices). */
  noteCrossCheck(symbol: string, sessionDate: string | null, ok: boolean | null): void {
    if (ok === null || !sessionDate) return;
    const key = `${symbol}|${sessionDate}`;
    if (this.checked.has(key)) return;
    remember(this.checked, key);
    this.checks++;
    if (!ok) {
      this.mismatches++;
      this.log.warn({ mismatches: this.mismatches, checks: this.checks }, 'insights: a Yahoo close disagrees with the bank price');
    }
  }

  /** Counts only, for tests and health-like checks. */
  status(): { cached: number; inflight: number; failures: number; backoffUntil: number | null; checks: number; mismatches: number } {
    return { cached: this.cache.size, inflight: this.inflight.size, failures: this.failures, backoffUntil: this.backoffUntil > this.now() ? this.backoffUntil : null, checks: this.checks, mismatches: this.mismatches };
  }
}

function remember(set: Set<string>, key: string): void {
  set.add(key);
  while (set.size > MAX_SEEN) {
    const first = set.values().next().value;
    if (first === undefined) break;
    set.delete(first);
  }
}
