/**
 * SEC EDGAR for the stock-insights panel (research_notes/proposals/stock-insights.md, step 2): the company's numbers
 * (section E), its recent filings (section F) and its SIC code (for the sector benchmark), fetched only when a panel
 * is opened and kept in memory. Nothing is stored in the database.
 *
 * What leaves the machine: SEC's ticker list is downloaded whole (the holding's ticker never leaves), then the
 * company's CIK goes to data.sec.gov in the URL path, with the User-Agent SEC requires: "finc personal finance app
 * <contact>", the contact read from FINC_SEC_CONTACT (empty or not an e-mail address: SEC is not contacted and the
 * company sections answer 'off'). The contact is never logged; the log carries counts and reason codes only (no
 * symbol, CIK or figure).
 *
 *  - caches: the ticker list 24 h, a company's submissions 12 h, its facts 24 h (trimmed to the concepts used, at
 *    most 32 companies, the oldest going first); a failure is remembered 5 minutes so repeated opens do not hammer;
 *  - one fetch in flight per URL; requests start at least 120 ms apart (SEC allows 10 a second; a panel open costs at
 *    most 3, usually 0–2);
 *  - a 429 or 403 (SEC's answer to too many requests) backs every SEC fetch off 4, 8, 16… minutes up to an hour;
 *  - each request times out after 10 s; a panel open waits at most 8 s for SEC: later answers 'busy' and the fetch
 *    still fills the cache for the next open;
 *  - the company figures survive a submissions failure (no filings, no SIC then); a facts failure fails the sections;
 *  - answers are capped at 32 MB (submissions, facts) and 8 MB (ticker list); only the newest 2,000 filings are read.
 */
import {
  type CompanyFacts,
  type FetchFn,
  SEC_MAX_BYTES,
  SEC_TICKERS_URL,
  SEC_TIMEOUT_MS,
  type SecFetchResult,
  type SecSubmissions,
  type TickerEntry,
  companyFactsUrl,
  lookupTicker,
  parseSubmissions,
  parseTickerMap,
  secContact,
  secGet,
  submissionsUrl,
  trimCompanyFacts,
} from '@finc/core';
import { log as defaultLog } from './logger.js';

export const SEC_TICKERS_TTL_MS = 24 * 60 * 60 * 1000;
export const SEC_SUBMISSIONS_TTL_MS = 12 * 60 * 60 * 1000;
export const SEC_FACTS_TTL_MS = 24 * 60 * 60 * 1000;
export const SEC_FAIL_TTL_MS = 5 * 60 * 1000;
export const SEC_BACKOFF_BASE_MS = 4 * 60 * 1000;
export const SEC_BACKOFF_MAX_MS = 60 * 60 * 1000;
export const SEC_DEADLINE_MS = 8000;
export const SEC_MIN_GAP_MS = 120;
const MAX_COMPANIES = 32;

export type CompanyCode = 'off' | 'not_covered' | 'busy' | 'unreachable' | 'invalid';
/** `submissions` null: they failed but the facts did not (section E is shown without filings or SIC) */
export type CompanyResult = { ok: true; cik: string; title: string; submissions: SecSubmissions | null; facts: CompanyFacts | null } | { ok: false; code: CompanyCode };

type Failure = Extract<SecFetchResult, { ok: false }>['reason'];
type Loaded<T> = { ok: true; value: T } | { ok: false; reason: Failure };

/** FINC_SEC_CONTACT, validated (null when empty or not an e-mail address). */
export const secContactFromEnv = (env: NodeJS.ProcessEnv = process.env): string | null => secContact(env.FINC_SEC_CONTACT);

export interface SecServiceDeps {
  contact: string | null;
  fetch?: FetchFn;
  now?: () => number;
  timeoutMs?: number;
  deadlineMs?: number;
  minGapMs?: number;
  log?: { debug(o: object, m: string): void; info(o: object, m: string): void; warn(o: object, m: string): void };
}

const CODE: Record<Failure, CompanyCode> = { off: 'off', rate_limited: 'busy', server: 'unreachable', network: 'unreachable', not_found: 'invalid', bad_answer: 'invalid', too_large: 'invalid' };

export class SecService {
  private tickers: { at: number; value: Loaded<Map<string, TickerEntry>> } | null = null;
  private readonly submissions = new Map<string, { at: number; value: Loaded<SecSubmissions> }>();
  private readonly facts = new Map<string, { at: number; value: Loaded<CompanyFacts | null> }>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private failures = 0;
  private backoffUntil = 0;
  private nextSlot = 0;
  private requests = 0;
  private readonly contact: string | null;
  private readonly now: () => number;
  private readonly log: NonNullable<SecServiceDeps['log']>;

  constructor(private readonly deps: SecServiceDeps) {
    this.contact = secContact(deps.contact);
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? defaultLog;
  }

  /** false without a valid contact: SEC is never contacted then */
  enabled(): boolean {
    return this.contact !== null;
  }

  /**
   * The company of a holding's symbol: submissions and trimmed facts, within the deadline (`deadlineMs`, default the
   * service's: what is left of the panel's time). Never throws.
   */
  async company(symbol: string, deadlineMs?: number): Promise<CompanyResult> {
    if (!this.contact) return { ok: false, code: 'off' };
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<CompanyResult>((res) => {
      timer = setTimeout(() => res({ ok: false, code: 'busy' }), Math.max(0, deadlineMs ?? this.deps.deadlineMs ?? SEC_DEADLINE_MS));
      timer.unref?.();
    });
    try {
      const r = await Promise.race([this.load(symbol).catch((): CompanyResult => ({ ok: false, code: 'unreachable' })), late]);
      if (!r.ok && r.code === 'busy') this.log.info({ code: r.code }, 'sec: company sections unavailable');
      return r;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async load(symbol: string): Promise<CompanyResult> {
    const map = await this.tickerMap();
    if (!map.ok) return this.fail(map.reason);
    const entry = lookupTicker(map.value, symbol);
    if (!entry) return { ok: false, code: 'not_covered' };
    const [sub, facts] = await Promise.all([this.submissionsOf(entry.cik), this.factsOf(entry.cik)]);
    if (!facts.ok) return this.fail(facts.reason);
    if (!sub.ok) this.log.info({ reason: sub.reason }, 'sec: submissions unavailable, company figures without filings');
    return { ok: true, cik: entry.cik, title: entry.title, submissions: sub.ok ? sub.value : null, facts: facts.value };
  }

  private fail(reason: Failure): CompanyResult {
    const code = CODE[reason];
    this.log.info({ reason, code }, 'sec: company sections unavailable');
    return { ok: false, code };
  }

  private tickerMap(): Promise<Loaded<Map<string, TickerEntry>>> {
    const t = this.now();
    const hit = this.tickers;
    if (hit && fresh(hit, t, SEC_TICKERS_TTL_MS)) return Promise.resolve(hit.value);
    return this.once(SEC_TICKERS_URL, async () => {
      const r = await this.get(SEC_TICKERS_URL, SEC_MAX_BYTES.tickers);
      const value: Loaded<Map<string, TickerEntry>> = r.ok ? ((m) => (m ? { ok: true as const, value: m } : { ok: false as const, reason: 'bad_answer' as const }))(parseTickerMap(r.value)) : r;
      if (remembered(value)) this.tickers = { at: this.now(), value };
      if (value.ok) this.log.debug({ tickers: value.value.size }, 'sec: ticker list fetched');
      return value;
    });
  }

  private submissionsOf(cik: string): Promise<Loaded<SecSubmissions>> {
    const url = submissionsUrl(cik);
    const hit = this.submissions.get(cik);
    if (hit && fresh(hit, this.now(), SEC_SUBMISSIONS_TTL_MS)) return Promise.resolve(hit.value);
    return this.once(url, async () => {
      const r = await this.get(url, SEC_MAX_BYTES.submissions);
      const value: Loaded<SecSubmissions> = r.ok ? ((s) => (s ? { ok: true as const, value: s } : { ok: false as const, reason: 'bad_answer' as const }))(parseSubmissions(r.value, cik)) : r;
      if (remembered(value)) put(this.submissions, cik, { at: this.now(), value });
      return value;
    });
  }

  /** a company without XBRL facts (404) is fine: facts null */
  private factsOf(cik: string): Promise<Loaded<CompanyFacts | null>> {
    const url = companyFactsUrl(cik);
    const hit = this.facts.get(cik);
    if (hit && fresh(hit, this.now(), SEC_FACTS_TTL_MS)) return Promise.resolve(hit.value);
    return this.once(url, async () => {
      const r = await this.get(url, SEC_MAX_BYTES.facts);
      let value: Loaded<CompanyFacts | null>;
      if (r.ok) {
        const t = trimCompanyFacts(r.value, cik);
        value = t ? { ok: true, value: t } : { ok: false, reason: 'bad_answer' };
      } else value = r.reason === 'not_found' ? { ok: true, value: null } : r;
      if (remembered(value)) put(this.facts, cik, { at: this.now(), value });
      return value;
    });
  }

  /** one promise per key while it runs */
  private once<T>(key: string, run: () => Promise<T>): Promise<T> {
    const running = this.inflight.get(key) as Promise<T> | undefined;
    if (running) return running;
    const p = run().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  /** one SEC request: backoff, spacing, then secGet; a rate limit starts or extends the backoff */
  private async get(url: string, maxBytes: number): Promise<Loaded<unknown>> {
    if (this.now() < this.backoffUntil) return { ok: false, reason: 'rate_limited' };
    const gap = this.deps.minGapMs ?? SEC_MIN_GAP_MS;
    const t = performance.now();
    const start = Math.max(t, this.nextSlot);
    this.nextSlot = start + gap;
    if (start > t) await new Promise((res) => setTimeout(res, start - t));
    this.requests++;
    const r = await secGet(url, { contact: this.contact, ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}), timeoutMs: this.deps.timeoutMs ?? SEC_TIMEOUT_MS, maxBytes });
    if (r.ok) {
      this.failures = 0;
      this.backoffUntil = 0;
      return { ok: true, value: r.body };
    }
    if (r.reason === 'rate_limited') {
      this.failures++;
      const wait = Math.min(SEC_BACKOFF_BASE_MS * 2 ** (this.failures - 1), SEC_BACKOFF_MAX_MS);
      this.backoffUntil = this.now() + wait;
      this.log.warn({ failures: this.failures, waitMin: Math.round(wait / 60_000) }, 'sec: rate limited, backing off');
    } else this.log.info({ reason: r.reason, ...(r.status ? { status: r.status } : {}) }, 'sec: request failed');
    return { ok: false, reason: r.reason };
  }

  /** Counts only, for tests and health-like checks. */
  status(): { enabled: boolean; companies: number; facts: number; inflight: number; requests: number; failures: number; backoffUntil: number | null } {
    return { enabled: this.enabled(), companies: this.submissions.size, facts: this.facts.size, inflight: this.inflight.size, requests: this.requests, failures: this.failures, backoffUntil: this.backoffUntil > this.now() ? this.backoffUntil : null };
  }
}

/** a successful entry is fresh for its TTL, a failed one for 5 minutes (a clock moved back counts as stale) */
function fresh(e: { at: number; value: { ok: boolean } }, t: number, ttl: number): boolean {
  return t >= e.at && t - e.at < (e.value.ok ? ttl : SEC_FAIL_TTL_MS);
}

/** rate limits are not cached (the backoff covers them), nor is 'off' */
function remembered(v: { ok: boolean; reason?: Failure }): boolean {
  return v.ok || (v.reason !== 'rate_limited' && v.reason !== 'off');
}

function put<T>(m: Map<string, T>, key: string, v: T): void {
  m.delete(key);
  m.set(key, v);
  while (m.size > MAX_COMPANIES) {
    const first = m.keys().next().value;
    if (first === undefined) break;
    m.delete(first);
  }
}
