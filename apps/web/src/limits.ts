/**
 * Security finding P2-02: the hub caps manual syncs, chat questions and alert tests/sends from away from home. A capped
 * request answers 429 with {error, retryAt (ISO)}; GET /api/settings carries the caps as `limits` (absent on an older
 * hub). Pure helpers for the UI; tested in limits.test.ts.
 */
import { ApiError } from './api';
import type { Key } from './i18n';

export interface Limits {
  syncCooldownMin: number;
  syncDailyCap: number;
  syncMaxMonthsOutside: number;
  chatPerHour: number;
  chatPerDay: number;
  alertsPerHour: number;
}

export type LimitKey = keyof Limits;

/** What the Settings form accepts for each cap (whole numbers, inclusive). */
export const LIMIT_RANGES: Record<LimitKey, { min: number; max: number }> = {
  syncCooldownMin: { min: 5, max: 1440 },
  syncDailyCap: { min: 1, max: 48 },
  syncMaxMonthsOutside: { min: 1, max: 24 },
  chatPerHour: { min: 1, max: 500 },
  chatPerDay: { min: 1, max: 5000 },
  alertsPerHour: { min: 1, max: 60 },
};

export const LIMIT_KEYS = Object.keys(LIMIT_RANGES) as LimitKey[];

/** The `limits` object from /api/settings, or null when the hub does not send it (older hub) or it is malformed. */
export function readLimits(v: unknown): Limits | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const out = {} as Limits;
  for (const k of LIMIT_KEYS) {
    const n = o[k];
    if (typeof n !== 'number' || !Number.isFinite(n)) return null;
    out[k] = n;
  }
  return out;
}

/** A typed cap as a whole number inside its range, or null. */
export function parseLimit(key: LimitKey, input: string): number | null {
  const s = input.trim();
  if (!/^\d{1,5}$/.test(s)) return null;
  const n = Number(s);
  const r = LIMIT_RANGES[key];
  return n >= r.min && n <= r.max ? n : null;
}

/** When a 429 says the action works again; null for any other error or a 429 without a readable retryAt. */
export function retryAtOf(e: unknown): Date | null {
  if (!(e instanceof ApiError) || e.status !== 429) return null;
  const raw = e.data.retryAt;
  if (typeof raw !== 'string') return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const TZ = 'Asia/Jerusalem';

const ymd = (d: Date): string => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

function nextDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export interface RetryWhen {
  kind: 'today' | 'tomorrow' | 'day';
  /** HH:MM, 24-hour, Israel time */
  time: string;
  /** weekday and day/month in Israel time, e.g. "Fri 13/11" ("" for today and tomorrow) */
  day: string;
}

/** When `at` is, in Israel time, relative to `now`: today, tomorrow or another day. A time already past reads as today. */
export function retryWhen(at: Date, now: Date, locale: string): RetryWhen {
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  const a = ymd(at);
  const today = ymd(now);
  if (a <= today) return { kind: 'today', time, day: '' };
  if (a === nextDay(today)) return { kind: 'tomorrow', time, day: '' };
  const day = new Intl.DateTimeFormat(locale, { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'numeric' }).format(at);
  return { kind: 'day', time, day };
}

export type LimitArea = 'sync' | 'chat' | 'alerts' | 'rules';
type T = (key: Key, vars?: Record<string, string | number>) => string;

const AREA_KEY: Record<LimitArea, Key> = { sync: 'limit_retry_sync', chat: 'limit_retry_chat', alerts: 'limit_retry_alerts', rules: 'limit_retry_rules' };
const WHEN_KEY: Record<RetryWhen['kind'], Key> = { today: 'limit_when_today', tomorrow: 'limit_when_tomorrow', day: 'limit_when_day' };

/**
 * The line to show for a failed request: a 429 with a retryAt reads "You can sync again at 14:35" (or tomorrow / on a
 * day); anything else shows the hub's own message.
 */
export function errorText(e: unknown, area: LimitArea, t: T, locale: string, now: Date = new Date()): string {
  const at = retryAtOf(e);
  if (at) {
    const w = retryWhen(at, now, locale);
    return t(AREA_KEY[area], { when: t(WHEN_KEY[w.kind], { t: w.time, d: w.day }) });
  }
  return e instanceof Error ? e.message : String(e);
}
