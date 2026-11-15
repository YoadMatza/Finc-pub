/**
 * Live prices for the holdings (securities and the dollar balance): a small in-memory cache of Yahoo Finance quotes
 * and the USD/ILS rate, refreshed on a schedule and on demand. Nothing is stored in the database.
 *
 * What leaves the machine: the ticker symbols in the LATEST holding snapshot of each account (only those that pass
 * validSymbol, only foreign-priced securities) and the FX pair ILS=X, in the URL path of a GET to
 * query1/query2.finance.yahoo.com. Never a quantity, a value, an account or a name. The log carries counts and
 * reason codes only: no symbol, price or amount.
 *
 * Schedule:
 *  - US regular session open (09:30–16:00 New York, Mon–Fri, DST from Intl): quotes and the rate every 2 minutes
 *    while someone looked at live data in the last 15 minutes, every 15 minutes otherwise
 *  - otherwise: the rate every 30 minutes; the quotes until they have been fetched once after the close settled
 *    (close + 5 min), then not again until the next session. A wait never runs past the next 09:30 open.
 *  - on demand (an API read, demand()): when the last refresh started over 60 s ago, debounced, one refresh in
 *    flight. Only the holdings view waits (at most a few seconds), and only when the cache is really stale for it
 *    (never fetched, or the session is open and no quote came in 5 minutes); the accounts and net-worth reads never
 *    wait, they kick a refresh in the background and read what the cache has.
 *  - errors: a 429 stops the round at once; a round where every request failed (429, 5xx, network) backs off 4, 8,
 *    16… minutes up to an hour, and on-demand refreshes wait for the backoff too. Nothing here ever throws into the
 *    worker; timers are unref'd and stop() ends everything (shutdown, database-owner conflict).
 */
import { type FetchFn, type PriceCache, type Quote, type QuoteResult, USD_ILS_SYMBOL, fetchQuote, lastUsClose, nextUsOpen, usSessionOpen } from '@finc/core';
import { log as defaultLog } from './logger.js';

export const SESSION_EVERY_MS = 2 * 60 * 1000;
/** in session with nobody looking */
export const SESSION_IDLE_EVERY_MS = 15 * 60 * 1000;
/** someone looked at live data this recently: poll at the session pace */
export const DEMAND_WINDOW_MS = 15 * 60 * 1000;
/** the holdings view waits for a refresh when no quote came in this long during the session */
export const VIEW_STALE_MS = 5 * 60 * 1000;
export const OFF_SESSION_EVERY_MS = 30 * 60 * 1000;
export const DEMAND_MIN_AGE_MS = 60 * 1000;
export const DEMAND_MAX_WAIT_MS = 4000;
export const FIRST_REFRESH_MS = 5000;
/** the closing price settles a few minutes after 16:00 */
export const AFTER_CLOSE_SETTLE_MS = 5 * 60 * 1000;
export const BACKOFF_MAX_MS = 60 * 60 * 1000;
/** a little after the open, so the first answer is a session quote */
const OPEN_SLACK_MS = 5000;

export interface PriceServiceDeps {
  /** what to fetch, read from the latest holding snapshots (holdingSymbols) */
  symbols: () => { quotes: Array<{ symbol: string; currency: string }>; fx: boolean };
  fetch?: FetchFn;
  now?: () => number;
  log?: { debug(o: object, m: string): void; info(o: object, m: string): void; warn(o: object, m: string): void };
}

type Mode = 'scheduled' | 'demand';

export class PriceService {
  private quotes = new Map<string, Quote>();
  private fx: Quote | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> | null = null;
  /** set by stop(): nothing runs again */
  private stopped = false;
  private started = false;
  private lastAttempt = 0;
  private lastDemand = Number.NEGATIVE_INFINITY;
  private nextAt = 0;
  private lastQuoteFetch = 0;
  private lastFxFetch = 0;
  private failures = 0;
  private backoffUntil = 0;
  private readonly now: () => number;
  private readonly log: NonNullable<PriceServiceDeps['log']>;

  constructor(private readonly deps: PriceServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? defaultLog;
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.schedule(FIRST_REFRESH_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** A snapshot of the cache for the live view. */
  cache(): PriceCache {
    return { quotes: new Map(this.quotes), fx: this.fx };
  }

  /** For tests and /health-like checks: counts only. */
  status(): { quotes: number; fx: boolean; failures: number; backoffUntil: number | null; running: boolean } {
    return { quotes: this.quotes.size, fx: !!this.fx, failures: this.failures, backoffUntil: this.backoffUntil > this.now() ? this.backoffUntil : null, running: this.started && !this.stopped };
  }

  /** Is the cache too old to show without waiting for a refresh? Never fetched, or in session with no quote in 5 min. */
  staleForView(now: number = this.now()): boolean {
    if (this.lastQuoteFetch === 0 && this.lastFxFetch === 0) return true;
    return usSessionOpen(now) && now - this.lastQuoteFetch > VIEW_STALE_MS;
  }

  /**
   * An API read of live data. Records the interest (session polling speeds up to every 2 minutes), kicks a
   * debounced refresh, and with `wait` (the holdings view only) waits for it when the cache is stale for the view.
   * Never throws.
   */
  async demand(opts: { wait: boolean }): Promise<void> {
    if (this.stopped) return;
    const now = this.now();
    this.lastDemand = now;
    // an idle in-session wait (15 min) shrinks back to the session pace
    if (this.started && this.timer && usSessionOpen(now) && this.nextAt - now > SESSION_EVERY_MS) this.schedule(Math.max(SESSION_EVERY_MS, this.backoffUntil - now));
    if (opts.wait && this.staleForView(now)) return this.refreshIfStale();
    void this.refreshIfStale(0);
  }

  /**
   * Refreshes when the last attempt is over 60 s old (not during a backoff), waiting at most `maxWaitMs`. Never
   * throws.
   */
  async refreshIfStale(maxWaitMs = DEMAND_MAX_WAIT_MS): Promise<void> {
    if (this.stopped) return;
    const now = this.now();
    if (!this.inflight && (now - this.lastAttempt < DEMAND_MIN_AGE_MS || now < this.backoffUntil)) return;
    const p = this.refresh('demand');
    if (maxWaitMs <= 0) return;
    let t: NodeJS.Timeout | undefined;
    const cap = new Promise<void>((r) => {
      t = setTimeout(r, maxWaitMs);
      t.unref?.();
    });
    await Promise.race([p, cap]);
    if (t) clearTimeout(t);
  }

  /** One refresh round; joins the one in flight. Never rejects. */
  refresh(mode: Mode): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this.round(mode)
      .catch((e: unknown) => {
        this.log.warn({ err: e instanceof Error ? e.name : 'error' }, 'prices: refresh failed');
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.nextAt = this.now() + Math.max(0, ms);
    this.timer = setTimeout(() => void this.tick(), Math.max(0, ms));
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    this.timer = null;
    if (this.stopped) return;
    await this.refresh('scheduled');
    this.schedule(this.nextDelay(this.now()));
  }

  /** How long until the next scheduled round. */
  nextDelay(now: number): number {
    const watched = now - this.lastDemand <= DEMAND_WINDOW_MS;
    let d = usSessionOpen(now) ? (watched ? SESSION_EVERY_MS : SESSION_IDLE_EVERY_MS) : Math.min(OFF_SESSION_EVERY_MS, nextUsOpen(now) - now + OPEN_SLACK_MS);
    if (this.backoffUntil > now) d = Math.max(d, this.backoffUntil - now);
    return d;
  }

  private async round(mode: Mode): Promise<void> {
    if (this.stopped) return;
    const now = this.now();
    if (mode === 'demand' && now < this.backoffUntil) return;
    this.lastAttempt = now;
    let want: ReturnType<PriceServiceDeps['symbols']>;
    try {
      want = this.deps.symbols();
    } catch {
      return; // the database is closing (shutdown, conflict): nothing to do
    }
    // forget what is no longer held
    const held = new Set(want.quotes.map((q) => q.symbol));
    for (const s of [...this.quotes.keys()]) if (!held.has(s)) this.quotes.delete(s);
    if (!want.fx) this.fx = null;

    const open = usSessionOpen(now);
    const quotesDue = want.quotes.length > 0 && (open ? mode === 'scheduled' || now - this.lastQuoteFetch >= DEMAND_MIN_AGE_MS : this.lastQuoteFetch < lastUsClose(now) + AFTER_CLOSE_SETTLE_MS);
    const fxDue = want.fx && (mode === 'scheduled' || now - this.lastFxFetch >= DEMAND_MIN_AGE_MS);
    const jobs: Array<{ symbol: string; currency: string; fx: boolean }> = [];
    if (fxDue) jobs.push({ symbol: USD_ILS_SYMBOL, currency: 'ILS', fx: true });
    if (quotesDue) for (const q of want.quotes) jobs.push({ ...q, fx: false });
    if (!jobs.length) return;

    let ok = 0;
    let failed = 0;
    let quoteOk = 0;
    let limited = false;
    const reasons: Record<string, number> = {};
    for (const j of jobs) {
      if (this.stopped) return;
      const r: QuoteResult = await fetchQuote(j.symbol, j.currency, { ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}), now: this.now }).catch(() => ({ ok: false, reason: 'network' }) as const);
      if (r.ok) {
        ok++;
        if (j.fx) {
          this.fx = r.quote;
          this.lastFxFetch = now;
        } else {
          this.quotes.set(j.symbol, r.quote);
          quoteOk++;
        }
        continue;
      }
      failed++;
      reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
      if (r.reason === 'rate_limited') {
        limited = true;
        break;
      }
    }
    if (quoteOk > 0) this.lastQuoteFetch = now;
    if (limited || (ok === 0 && failed > 0 && Object.keys(reasons).some((k) => k === 'server' || k === 'network'))) {
      this.failures++;
      const wait = Math.min(SESSION_EVERY_MS * 2 ** this.failures, BACKOFF_MAX_MS);
      this.backoffUntil = this.now() + wait;
      this.log.warn({ failures: this.failures, waitMin: Math.round(wait / 60_000), reasons }, 'prices: backing off');
      return;
    }
    this.failures = 0;
    this.backoffUntil = 0;
    if (failed) this.log.info({ ok, failed, reasons }, 'prices: some quotes unavailable');
    else this.log.debug({ ok }, 'prices: refreshed');
  }
}

/** FINC_LIVE_PRICES=off turns the price service off (the live view then shows the bank's numbers). */
export const livePricesEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env.FINC_LIVE_PRICES ?? '').trim());
