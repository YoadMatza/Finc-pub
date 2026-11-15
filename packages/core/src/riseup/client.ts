/**
 * Minimal client for RiseUp's external API (Bearer PAT). Verified against riseup-oss/mcp
 * docs on 2026-11-08: 60 req/min, 1000 req/day, one cashflow month per transactions call.
 * The token is held in a closure and never appears in errors or logs.
 */
import type { RiseupTransaction } from '../ingest/riseup-convert.js';

export const RISEUP_API_BASE = 'https://input.riseup.co.il';
export const PAT_PREFIX = 'riseup_pat_';

export interface RiseupBalance {
  source: string;
  accountNickname: string | null;
  accountNumberHash: string | null;
  balance: number;
  lastUpdated: string;
  overdraftLimit: number | null;
  availableOverdraft: number | null;
  overdraftLimitUpdatedAt: string | null;
}

export interface RiseupBalanceHistoryAccount {
  source: string;
  accountNickname: string | null;
  accountNumberHash: string | null;
  minBalance: number;
  maxBalance: number;
  avgBalance: number;
  balances: Array<{ date: string; balance: number }>;
}

export class RiseupApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly tokenRef: string | null,
  ) {
    super(message);
    this.name = 'RiseupApiError';
  }
}

export interface RiseupClientOptions {
  apiBase?: string;
  fetchImpl?: typeof fetch;
  /** Calls per minute we allow ourselves (server limit is 60). */
  perMinute?: number;
  maxRetries429?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class RiseupClient {
  private readonly headers: Record<string, string>;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly perMinute: number;
  private readonly maxRetries429: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly stamps: number[] = [];
  calls = 0;

  constructor(token: string, opts: RiseupClientOptions = {}) {
    if (!token.startsWith(PAT_PREFIX)) throw new Error(`RiseUp token must start with ${PAT_PREFIX}`);
    this.headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    this.base = (opts.apiBase ?? RISEUP_API_BASE).replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.perMinute = opts.perMinute ?? 50;
    this.maxRetries429 = opts.maxRetries429 ?? 3;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async pace(): Promise<void> {
    const now = Date.now();
    while (this.stamps.length && now - this.stamps[0]! > 60_000) this.stamps.shift();
    if (this.stamps.length >= this.perMinute) {
      const wait = 60_000 - (now - this.stamps[0]!) + 50;
      await this.sleep(wait);
    }
    this.stamps.push(Date.now());
  }

  async get<T>(path: string): Promise<{ data: T; tokenRef: string | null }> {
    for (let attempt = 0; ; attempt++) {
      await this.pace();
      this.calls++;
      const res = await this.fetchImpl(`${this.base}${path}`, { headers: this.headers });
      const tokenRef = res.headers.get('x-riseup-token-ref');
      if (res.status === 429 && attempt < this.maxRetries429) {
        const retry = Number(res.headers.get('retry-after') ?? '60');
        await this.sleep(Math.min(Math.max(retry, 1), 120) * 1000);
        continue;
      }
      if (res.status === 401) throw new RiseupApiError('RiseUp token rejected (401): expired or revoked. Create a new one at Settings → חיבור לכלים חיצוניים', 401, tokenRef);
      if (res.status === 403) throw new RiseupApiError('RiseUp token lacks a required scope (403). Needs budget:read and balances:read', 403, tokenRef);
      if (res.status === 404) throw new RiseupApiError(`not found: ${path}`, 404, tokenRef);
      const text = await res.text().catch(() => '');
      if (!res.ok) throw new RiseupApiError(`RiseUp API ${res.status} on ${path}: ${text.slice(0, 200)}`, res.status, tokenRef);
      // Seen 2026-11-08: a 200 with an empty body at the edge of the history. Treat as "nothing here".
      if (text.trim() === '') return { data: null as T, tokenRef };
      try {
        return { data: JSON.parse(text) as T, tokenRef };
      } catch {
        throw new RiseupApiError(`RiseUp API returned non-JSON on ${path}: ${text.slice(0, 120)}`, res.status, tokenRef);
      }
    }
  }

  async transactions(cashflowMonth: string): Promise<RiseupTransaction[]> {
    assertMonth(cashflowMonth);
    const { data } = await this.get<{ transactions: RiseupTransaction[] } | null>(`/api/external/transactions?cashflowMonth=${cashflowMonth}`);
    return data?.transactions ?? [];
  }

  /** Budget for a month. Returns null when the month is before the account's earliest record (404). */
  async budget(month: string): Promise<unknown | null> {
    assertMonth(month);
    try {
      const { data } = await this.get<unknown>(`/api/external/budget/${month}`);
      return data;
    } catch (e) {
      if (e instanceof RiseupApiError && e.status === 404) return null;
      throw e;
    }
  }

  async currentBalances(): Promise<RiseupBalance[]> {
    const { data } = await this.get<{ balances: RiseupBalance[] } | null>('/api/external/balances/current');
    return data?.balances ?? [];
  }

  async balanceHistory(daysBack = 90): Promise<RiseupBalanceHistoryAccount[]> {
    const { data } = await this.get<{ accounts: RiseupBalanceHistoryAccount[] } | null>(`/api/external/balances/history?daysBack=${Math.min(Math.max(daysBack, 1), 90)}`);
    return data?.accounts ?? [];
  }
}

function assertMonth(m: string): void {
  if (!/^\d{4}-\d{2}$/.test(m)) throw new Error(`month must be YYYY-MM, got "${m}"`);
}

export function prevMonth(m: string): string {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, mo - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function currentMonth(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit' }).format(now).slice(0, 7);
}
