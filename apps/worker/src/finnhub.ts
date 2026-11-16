/**
 * Finnhub for the stock-insights panel (research_notes/proposals/stock-decision-aids.md, Part B, step 3): the analysts'
 * monthly recommendation counts and the earnings calendar of a held stock, fetched only when a panel is built (opened,
 * or by the holding-rules runs through the same panel), cached in memory and in `market_data_cache` so the last known
 * view, with its date, still shows while the vault (and so the key) is locked.
 *
 * What leaves the machine: the ticker (and a date window) to https://finnhub.io; the owner's key in the X-Finnhub-Token
 * header (finnhub.ts in core). The key is read from the vault at each fetch (entry `finnhub`, field `apiKey`, or a
 * field named `finnhub`), never logged, never stored anywhere else; the log carries counts and codes only (no symbol).
 *
 *  - freshness: recommendations 24 h, the earnings calendar 12 h; a stale entry (up to 30 days old) is still served,
 *    with its fetchedAt, when it cannot be refreshed (vault locked, no key, rate limit, failure, or too slow);
 *  - a failure is remembered 5 minutes per symbol and kind (a 403, Finnhub's "not on your plan" for a symbol, is
 *    'not_covered' for that symbol only); a key Finnhub refused (401) is not tried again for an hour unless it
 *    changes; one fetch in flight per URL;
 *  - each section says `stale: true` when it is served past its freshness (it could not be refreshed);
 *  - an answer about another symbol than the one asked (Finnhub may answer for a share class or the company's primary
 *    listing) is accepted only when every entry carries that one symbol AND Finnhub's own profile2 maps the asked
 *    symbol to it (profile cached 30 days, an empty one 1 day); otherwise it is refused as 'not_covered' (check
 *    'symbol_unverified'); the sections then name the symbol Finnhub used (`finnhubSymbol`);
 *  - requests start at least 1.1 s apart (the free plan allows 60 a minute; a panel costs at most 2);
 *  - a 429 backs every Finnhub fetch off 4, 8, 16… minutes up to an hour;
 *  - each request times out after 10 s; a panel waits at most 4 s (FINNHUB_DEADLINE_MS): later answers come from the
 *    cache (or 'busy' when there is none), and the fetch still fills the cache for the next build.
 */
import { createHash } from 'node:crypto';
import {
  type AnalystsSection,
  type AnalystsUnavailableCode,
  type Db,
  type EarningsRow,
  type EarningsSection,
  FINNHUB_KEY_RE,
  FINNHUB_TIMEOUT_MS,
  type FetchFn,
  type FinnhubFailure,
  type RecommendationRow,
  type Vault,
  FINNHUB_ECHO_RE,
  answerSymbol,
  earningsPath,
  finnhubGet,
  finnhubSymbol,
  israelDate,
  NEWS_DAYS,
  type NewsRow,
  newsPath,
  parseCompanyNews,
  parseEarnings,
  parseProfile,
  parseRecommendations,
  profilePath,
  readMarketCache,
  recommendationPath,
  summarizeAnalysts,
  summarizeEarnings,
  writeMarketCache,
} from '@finc/core';
import { log as defaultLog } from './logger.js';

export const FINNHUB_SOURCE = 'finnhub';
export const FINNHUB_TTL_MS = { recommendation: 24 * 60 * 60 * 1000, earnings: 12 * 60 * 60 * 1000 } as const;
export const FINNHUB_MAX_STALE_MS = 30 * 24 * 60 * 60 * 1000;
export const FINNHUB_FAIL_TTL_MS = 5 * 60 * 1000;
export const FINNHUB_BAD_KEY_TTL_MS = 60 * 60 * 1000;
export const FINNHUB_BACKOFF_BASE_MS = 4 * 60 * 1000;
export const FINNHUB_BACKOFF_MAX_MS = 60 * 60 * 1000;
export const FINNHUB_DEADLINE_MS = 4000;
export const FINNHUB_MIN_GAP_MS = 1100;
/** the calendar window asked for: back for the last report, ahead for the next */
export const EARNINGS_BACK_DAYS = 120;
export const EARNINGS_AHEAD_FETCH_DAYS = 120;
const MAX_MEMORY = 128;
/** company news (Part C): fresh for 12 hours, then served stale (with its date) up to FINNHUB_MAX_STALE_MS */
export const FINNHUB_NEWS_TTL_MS = 12 * 60 * 60 * 1000;

export type FinnhubNews = { ok: true; rows: NewsRow[]; fetchedAt: number; stale: boolean } | { ok: false; code: AnalystsUnavailableCode };

export const FINNHUB_PROFILE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const FINNHUB_PROFILE_EMPTY_TTL_MS = 24 * 60 * 60 * 1000;

type Kind = 'recommendation' | 'earnings';
type Rows = { recommendation: RecommendationRow[]; earnings: EarningsRow[] };
/** `fsym`: the symbol Finnhub answered for (the asked one, or an alias verified with profile2) */
type Entry<K extends Kind> = { fetchedAt: number; fsym: string; rows: Rows[K] };
type Profile = { at: number; ticker: string | null };
type Got<K extends Kind> = { entry: Entry<K> | null; code: AnalystsUnavailableCode | null };

export type FinnhubKey = { ok: true; key: string } | { ok: false; code: 'vault_locked' | 'no_key' };

/** The key from the vault: entry `finnhub`, field `apiKey` (or a field named `finnhub`). Never throws. */
export function finnhubKeyFromVault(vault: Pick<Vault, 'locked' | 'get'> | null): FinnhubKey {
  if (!vault || vault.locked) return { ok: false, code: 'vault_locked' };
  try {
    const f = vault.get('finnhub')?.fields;
    const k = (f?.apiKey ?? f?.finnhub ?? '').trim();
    return FINNHUB_KEY_RE.test(k) ? { ok: true, key: k } : { ok: false, code: 'no_key' };
  } catch {
    return { ok: false, code: 'vault_locked' };
  }
}

export interface FinnhubLookup {
  analysts: AnalystsSection | null;
  /** set when analysts is null */
  code: AnalystsUnavailableCode | null;
  earnings: EarningsSection | null;
}

export interface FinnhubServiceDeps {
  db: Db;
  /** read at each fetch (the vault locks and unlocks while the worker runs) */
  key: () => FinnhubKey;
  fetch?: FetchFn;
  now?: () => number;
  timeoutMs?: number;
  deadlineMs?: number;
  minGapMs?: number;
  log?: { debug(o: object, m: string): void; info(o: object, m: string): void; warn(o: object, m: string): void };
}

const CODE: Record<FinnhubFailure, AnalystsUnavailableCode> = { no_key: 'no_key', forbidden: 'not_covered', rate_limited: 'busy', server: 'unreachable', network: 'unreachable', not_found: 'invalid', bad_answer: 'invalid', too_large: 'invalid' };
const LATE = Symbol('late');
const hashKey = (k: string): string => createHash('sha256').update(k).digest('hex');

export class FinnhubService {
  private readonly memory = new Map<string, Entry<Kind>>();
  private readonly failed = new Map<string, { at: number; code: AnalystsUnavailableCode }>();
  private readonly inflight = new Map<string, Promise<Got<Kind>>>();
  private readonly profiles = new Map<string, Profile>();
  private readonly newsMemory = new Map<string, { rows: NewsRow[]; fetchedAt: number }>();
  private readonly profileInflight = new Map<string, Promise<{ ok: true; ticker: string | null } | { ok: false; code: AnalystsUnavailableCode }>>();
  private badKey: { hash: string; at: number } | null = null;
  private failures = 0;
  private backoffUntil = 0;
  private nextSlot = 0;
  private requests = 0;
  private readonly now: () => number;
  private readonly log: NonNullable<FinnhubServiceDeps['log']>;

  constructor(private readonly deps: FinnhubServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? defaultLog;
  }

  /**
   * The analysts' section and the earnings dates of a holding's symbol, within `deadlineMs` (default 4 s). A symbol
   * Finnhub cannot know (not a plain US ticker) is 'not_covered'. Never throws.
   */
  async lookup(symbol: string, deadlineMs?: number): Promise<FinnhubLookup> {
    const sym = finnhubSymbol(symbol);
    if (!sym) return { analysts: null, code: 'not_covered', earnings: null };
    const deadline = Math.max(0, deadlineMs ?? this.deps.deadlineMs ?? FINNHUB_DEADLINE_MS);
    try {
      const [rec, earn] = await Promise.all([this.within('recommendation', sym, deadline), this.within('earnings', sym, deadline)]);
      const t = this.now();
      const today = israelDate(t);
      const stale = (kind: Kind, at: number): boolean => !(t >= at && t - at < FINNHUB_TTL_MS[kind]);
      let analysts: AnalystsSection | null = null;
      let code: AnalystsUnavailableCode | null = rec.code ?? 'invalid';
      if (rec.entry) {
        const s = summarizeAnalysts(rec.entry.rows, today, new Date(rec.entry.fetchedAt).toISOString(), stale('recommendation', rec.entry.fetchedAt));
        analysts = s.ok ? { ...s.analysts, ...(rec.entry.fsym !== sym ? { finnhubSymbol: rec.entry.fsym } : {}) } : null;
        code = s.ok ? null : s.code;
      }
      const earnings = earn.entry ? { ...summarizeEarnings(earn.entry.rows, today, new Date(earn.entry.fetchedAt).toISOString(), stale('earnings', earn.entry.fetchedAt)), ...(earn.entry.fsym !== sym ? { finnhubSymbol: earn.entry.fsym } : {}) } : null;
      // every build while the vault is locked would say so: debug only (failures themselves are logged at info)
      if (code && code !== 'too_few' && code !== 'not_covered') this.log.debug({ code, earnings: earnings ? 'shown' : (earn.code ?? 'none') }, 'finnhub: analysts unavailable');
      return { analysts, code, earnings };
    } catch (e) {
      this.log.warn({ err: e instanceof Error ? e.name : 'error' }, 'finnhub: lookup failed');
      return { analysts: null, code: 'unreachable', earnings: null };
    }
  }

  /** one kind within the deadline; late: the cached entry (if any) or 'busy' */
  private async within<K extends Kind>(kind: K, sym: string, ms: number): Promise<Got<K>> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<typeof LATE>((res) => {
      timer = setTimeout(() => res(LATE), ms);
      timer.unref?.();
    });
    try {
      const r = await Promise.race([this.get(kind, sym), late]);
      return r === LATE ? this.serve(this.cached(kind, sym), 'busy') : r;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private key(kind: Kind, sym: string): string {
    return `${kind}:${sym}`;
  }

  /** memory first, then the table (validated again on the way in) */
  private cached<K extends Kind>(kind: K, sym: string): Entry<K> | null {
    const k = this.key(kind, sym);
    const m = this.memory.get(k) as Entry<K> | undefined;
    if (m) return m;
    let stored: ReturnType<typeof readMarketCache> = null;
    try {
      stored = readMarketCache(this.deps.db, FINNHUB_SOURCE, k);
    } catch {
      return null;
    }
    if (!stored) return null;
    // { symbol, rows } (an older entry is the bare rows, for the asked symbol)
    const v = stored.value as { symbol?: unknown; rows?: unknown } | unknown[];
    const fsym = Array.isArray(v) ? sym : typeof v?.symbol === 'string' && FINNHUB_ECHO_RE.test(v.symbol) ? v.symbol : null;
    const list = Array.isArray(v) ? v : v?.rows;
    if (!fsym || !Array.isArray(list)) return null;
    const withSym = (list as unknown[]).map((x) => (x && typeof x === 'object' ? { ...(x as object), symbol: fsym } : x));
    const rows = kind === 'recommendation' ? parseRecommendations(withSym, fsym, israelDate(stored.fetchedAt)) : parseEarnings({ earningsCalendar: withSym }, fsym);
    if (!rows) return null;
    const e = { fetchedAt: stored.fetchedAt, fsym, rows } as Entry<K>;
    this.remember(k, e);
    return e;
  }

  private remember(k: string, e: Entry<Kind>): void {
    this.memory.delete(k);
    this.memory.set(k, e);
    while (this.memory.size > MAX_MEMORY) {
      const first = this.memory.keys().next().value;
      if (first === undefined) break;
      this.memory.delete(first);
    }
  }

  /** a stale entry when it is not too old, else the code */
  private serve<K extends Kind>(hit: Entry<K> | null, code: AnalystsUnavailableCode): Got<K> {
    const age = hit ? this.now() - hit.fetchedAt : Number.POSITIVE_INFINITY;
    return hit && age >= 0 && age < FINNHUB_MAX_STALE_MS ? { entry: hit, code: null } : { entry: null, code };
  }

  private async get<K extends Kind>(kind: K, sym: string): Promise<Got<K>> {
    const k = this.key(kind, sym);
    const hit = this.cached(kind, sym);
    const t = this.now();
    if (hit && t >= hit.fetchedAt && t - hit.fetchedAt < FINNHUB_TTL_MS[kind]) return { entry: hit, code: null };
    const key = this.deps.key();
    if (!key.ok) return this.serve(hit, key.code);
    if (this.badKey && this.badKey.hash === hashKey(key.key) && t - this.badKey.at < FINNHUB_BAD_KEY_TTL_MS) return this.serve(hit, 'no_key');
    const f = this.failed.get(k);
    if (f && t >= f.at && t - f.at < FINNHUB_FAIL_TTL_MS) return this.serve(hit, f.code);
    if (t < this.backoffUntil) return this.serve(hit, 'busy');
    const running = this.inflight.get(k) as Promise<Got<K>> | undefined;
    const p = running ?? this.fetchKind(kind, sym, key.key).finally(() => this.inflight.delete(k));
    if (!running) this.inflight.set(k, p);
    const r = await p;
    return r.entry ? r : this.serve(hit, r.code ?? 'invalid');
  }

  private async fetchKind<K extends Kind>(kind: K, sym: string, apiKey: string): Promise<Got<K>> {
    const k = this.key(kind, sym);
    const today = israelDate(this.now());
    const day = (n: number): string => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
    const path = kind === 'recommendation' ? recommendationPath(sym) : earningsPath(sym, day(-EARNINGS_BACK_DAYS), day(EARNINGS_AHEAD_FETCH_DAYS));
    const r = await this.request(path, apiKey);
    if (!r.ok) {
      const code = CODE[r.reason];
      if (r.reason !== 'rate_limited' && r.reason !== 'no_key') this.failed.set(k, { at: this.now(), code });
      return { entry: null, code };
    }
    // the symbol the answer is about: the asked one, or another listing Finnhub itself maps it to (profile2)
    const echo = answerSymbol(r.body, kind);
    if (echo === 'mixed') {
      this.failed.set(k, { at: this.now(), code: 'invalid' });
      this.log.info({ kind, reason: 'bad_answer', check: 'symbol_mixed' }, 'finnhub: answer failed validation');
      return { entry: null, code: 'invalid' };
    }
    let fsym = sym;
    if (echo !== null && echo !== sym) {
      const p = await this.profileTicker(sym, apiKey);
      if (!p.ok) {
        if (p.code !== 'busy' && p.code !== 'no_key') this.failed.set(k, { at: this.now(), code: p.code });
        return { entry: null, code: p.code };
      }
      if (p.ticker !== echo) {
        this.failed.set(k, { at: this.now(), code: 'not_covered' });
        this.log.info({ kind, check: 'symbol_unverified' }, 'finnhub: answer is about another symbol; not used');
        return { entry: null, code: 'not_covered' };
      }
      fsym = echo;
      this.log.debug({ kind, check: 'symbol_alias' }, 'finnhub: answer for another listing, verified');
    }
    let check = 'unknown';
    const onFail = (c: string): void => {
      check = c;
    };
    const rows = kind === 'recommendation' ? parseRecommendations(r.body, fsym, today, onFail) : parseEarnings(r.body, fsym, onFail);
    if (!rows) {
      this.failed.set(k, { at: this.now(), code: 'invalid' });
      this.log.info({ kind, reason: 'bad_answer', check }, 'finnhub: answer failed validation');
      return { entry: null, code: 'invalid' };
    }
    const e = { fetchedAt: this.now(), fsym, rows } as Entry<K>;
    this.failed.delete(k);
    this.remember(k, e);
    try {
      writeMarketCache(this.deps.db, FINNHUB_SOURCE, k, e.fetchedAt, { symbol: fsym, rows });
    } catch (err) {
      this.log.warn({ kind, err: err instanceof Error ? err.name : 'error' }, 'finnhub: cache not stored');
    }
    this.log.debug({ kind, rows: rows.length }, 'finnhub: fetched');
    return { entry: e, code: null };
  }

  /**
   * The ticker Finnhub's profile2 maps `sym` to (null when it does not know it): memory, then market_data_cache
   * (`profile:SYM`; 30 days, an empty answer 1 day), then one request (joined while in flight).
   */
  private async profileTicker(sym: string, apiKey: string): Promise<{ ok: true; ticker: string | null } | { ok: false; code: AnalystsUnavailableCode }> {
    const k = `profile:${sym}`;
    const fresh = (p: Profile): boolean => {
      const age = this.now() - p.at;
      return age >= 0 && age < (p.ticker ? FINNHUB_PROFILE_TTL_MS : FINNHUB_PROFILE_EMPTY_TTL_MS);
    };
    let hit = this.profiles.get(sym);
    if (!hit) {
      try {
        const stored = readMarketCache(this.deps.db, FINNHUB_SOURCE, k);
        const t = (stored?.value as { ticker?: unknown } | null)?.ticker;
        if (stored && (t === null || (typeof t === 'string' && FINNHUB_ECHO_RE.test(t)))) hit = { at: stored.fetchedAt, ticker: t };
      } catch {
        hit = undefined;
      }
    }
    if (hit && fresh(hit)) {
      this.profiles.set(sym, hit);
      return { ok: true, ticker: hit.ticker };
    }
    const running = this.profileInflight.get(sym);
    if (running) return running;
    const p = (async (): Promise<{ ok: true; ticker: string | null } | { ok: false; code: AnalystsUnavailableCode }> => {
      const r = await this.request(profilePath(sym), apiKey);
      if (!r.ok) return { ok: false, code: CODE[r.reason] };
      const prof = parseProfile(r.body);
      if (!prof) {
        this.log.info({ kind: 'profile', reason: 'bad_answer' }, 'finnhub: answer failed validation');
        return { ok: false, code: 'invalid' };
      }
      const entry: Profile = { at: this.now(), ticker: prof.ticker };
      this.profiles.set(sym, entry);
      if (this.profiles.size > MAX_MEMORY) this.profiles.delete(this.profiles.keys().next().value!);
      try {
        writeMarketCache(this.deps.db, FINNHUB_SOURCE, k, entry.at, { ticker: entry.ticker });
      } catch (err) {
        this.log.warn({ kind: 'profile', err: err instanceof Error ? err.name : 'error' }, 'finnhub: cache not stored');
      }
      return { ok: true, ticker: prof.ticker };
    })().finally(() => this.profileInflight.delete(sym));
    this.profileInflight.set(sym, p);
    return p;
  }

  /** one Finnhub request: spacing, then finnhubGet; a 429 starts or extends the backoff, a 401/403 marks the key */
  private async request(path: string, apiKey: string): Promise<Awaited<ReturnType<typeof finnhubGet>>> {
    const gap = this.deps.minGapMs ?? FINNHUB_MIN_GAP_MS;
    const t = performance.now();
    const start = Math.max(t, this.nextSlot);
    this.nextSlot = start + gap;
    if (start > t) await new Promise((res) => setTimeout(res, start - t));
    if (this.now() < this.backoffUntil) return { ok: false, reason: 'rate_limited' };
    this.requests++;
    const r = await finnhubGet(path, { apiKey, ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}), timeoutMs: this.deps.timeoutMs ?? FINNHUB_TIMEOUT_MS });
    if (r.ok) {
      this.failures = 0;
      this.backoffUntil = 0;
      return r;
    }
    if (r.reason === 'rate_limited') {
      this.failures++;
      const wait = Math.min(FINNHUB_BACKOFF_BASE_MS * 2 ** (this.failures - 1), FINNHUB_BACKOFF_MAX_MS);
      this.backoffUntil = this.now() + wait;
      this.log.warn({ failures: this.failures, waitMin: Math.round(wait / 60_000) }, 'finnhub: rate limited, backing off');
    } else if (r.reason === 'no_key') {
      this.badKey = { hash: hashKey(apiKey), at: this.now() };
      this.log.warn({ status: r.status ?? null }, 'finnhub: the key was refused (finc vault set finnhub)');
    } else if (r.reason === 'forbidden') {
      this.log.debug({ status: 403 }, 'finnhub: symbol not on the plan');
    } else this.log.info({ reason: r.reason, ...(r.status ? { status: r.status } : {}) }, 'finnhub: request failed');
    return r;
  }

  /**
   * A held stock's company news of the last NEWS_DAYS days (Part C), within `deadlineMs`: fresh for 12 hours in memory
   * and market_data_cache (`news:SYM`), else one request; a stale entry is served (stale: true) when it cannot be
   * refreshed. What leaves the machine: the ticker and the date window, as for the other kinds. Never throws.
   */
  async news(symbol: string, deadlineMs?: number): Promise<FinnhubNews> {
    const sym = finnhubSymbol(symbol);
    if (!sym) return { ok: false, code: 'not_covered' };
    const k = `news:${sym}`;
    const t = this.now();
    const fromCache = (): { rows: NewsRow[]; fetchedAt: number } | null => {
      const m = this.newsMemory.get(k);
      if (m) return m;
      try {
        const stored = readMarketCache(this.deps.db, FINNHUB_SOURCE, k);
        const rows = stored ? parseCompanyNews((stored.value as { items?: unknown } | null)?.items) : null;
        if (!stored || !rows) return null;
        const e = { rows, fetchedAt: stored.fetchedAt };
        this.newsMemory.set(k, e);
        return e;
      } catch {
        return null;
      }
    };
    const hit = fromCache();
    const serve = (code: AnalystsUnavailableCode): FinnhubNews => (hit && t - hit.fetchedAt >= 0 && t - hit.fetchedAt < FINNHUB_MAX_STALE_MS ? { ok: true, rows: hit.rows, fetchedAt: hit.fetchedAt, stale: true } : { ok: false, code });
    if (hit && t >= hit.fetchedAt && t - hit.fetchedAt < FINNHUB_NEWS_TTL_MS) return { ok: true, rows: hit.rows, fetchedAt: hit.fetchedAt, stale: false };
    const key = this.deps.key();
    if (!key.ok) return serve(key.code);
    if (this.badKey && this.badKey.hash === hashKey(key.key) && t - this.badKey.at < FINNHUB_BAD_KEY_TTL_MS) return serve('no_key');
    const f = this.failed.get(k);
    if (f && t >= f.at && t - f.at < FINNHUB_FAIL_TTL_MS) return serve(f.code);
    if (t < this.backoffUntil) return serve('busy');
    const today = israelDate(t);
    const from = new Date(Date.parse(`${today}T00:00:00Z`) - NEWS_DAYS * 86_400_000).toISOString().slice(0, 10);
    const fetching = (async (): Promise<FinnhubNews> => {
      const r = await this.request(newsPath(sym, from, today), key.key);
      if (!r.ok) {
        const code = CODE[r.reason];
        if (r.reason !== 'rate_limited' && r.reason !== 'no_key') this.failed.set(k, { at: this.now(), code });
        return serve(code);
      }
      const rows = parseCompanyNews(r.body, (check) => this.log.info({ kind: 'news', reason: 'bad_answer', check }, 'finnhub: answer failed validation'));
      if (!rows) {
        this.failed.set(k, { at: this.now(), code: 'invalid' });
        return serve('invalid');
      }
      const e = { rows, fetchedAt: this.now() };
      this.failed.delete(k);
      this.newsMemory.set(k, e);
      if (this.newsMemory.size > MAX_MEMORY) this.newsMemory.delete(this.newsMemory.keys().next().value!);
      try {
        writeMarketCache(this.deps.db, FINNHUB_SOURCE, k, e.fetchedAt, { items: rows.map((x) => ({ headline: x.title, source: x.source, url: x.url, datetime: Math.round(x.at / 1000), summary: x.summary ?? '' })) });
      } catch (err) {
        this.log.warn({ kind: 'news', err: err instanceof Error ? err.name : 'error' }, 'finnhub: cache not stored');
      }
      this.log.debug({ kind: 'news', rows: rows.length }, 'finnhub: fetched');
      return { ok: true, rows, fetchedAt: e.fetchedAt, stale: false };
    })();
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<typeof LATE>((res) => {
      timer = setTimeout(() => res(LATE), Math.max(0, deadlineMs ?? this.deps.deadlineMs ?? FINNHUB_DEADLINE_MS));
      timer.unref?.();
    });
    try {
      const r = await Promise.race([fetching, late]);
      return r === LATE ? serve('busy') : r;
    } catch {
      return serve('unreachable');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Counts only, for tests and health-like checks. */
  status(): { cached: number; inflight: number; requests: number; failures: number; backoffUntil: number | null; keyRefused: boolean } {
    return { cached: this.memory.size, inflight: this.inflight.size, requests: this.requests, failures: this.failures, backoffUntil: this.backoffUntil > this.now() ? this.backoffUntil : null, keyRefused: !!this.badKey && this.now() - this.badKey.at < FINNHUB_BAD_KEY_TTL_MS };
  }
}
