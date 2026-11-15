/**
 * Abuse limits for callers from outside the home network (security research P2-02): a stolen device token or passkey
 * session must not be able to log in to the banks again and again, run up the AI bill, or flood Telegram.
 *
 * - The limits live in settings (`limits.*`), changed from home only; missing or broken values fall back to the
 *   defaults below. Callers at home (the PC, Tailscale, the control token) are never limited.
 * - Outside manual syncs: their start times are kept in the setting `limits.syncOutside` (a small JSON list of epoch
 *   milliseconds, pruned to two days), so a worker restart does not reset the bank-login limit. A sync from home, the
 *   CLI or the schedule is not written there: the limit bounds what an outside caller can add on top of the owner's
 *   own syncs, and a sync at the PC must not lock the phone out for half an hour.
 * - Chat and alert counters are in memory (RateCounter): a restart resets them, which only costs a few extra calls.
 * - Days are calendar days in Asia/Jerusalem.
 */
import { getSetting, setSetting } from '../ai/settings.js';
import type { Db } from '../db/db.js';

export const LIMITS_TZ = 'Asia/Jerusalem';

export interface Limits {
  /** minutes between two outside manual syncs */
  syncCooldownMin: number;
  /** outside manual syncs per calendar day */
  syncDailyCap: number;
  /** the most months an outside sync may fetch (home: up to 24) */
  syncMaxMonthsOutside: number;
  /** chat questions per caller per rolling hour */
  chatPerHour: number;
  /** chat questions per caller per calendar day */
  chatPerDay: number;
  /** test or dispatch alert sends per caller per rolling hour (each endpoint separately) */
  alertsPerHour: number;
}

export const LIMIT_DEFAULTS: Readonly<Limits> = { syncCooldownMin: 30, syncDailyCap: 6, syncMaxMonthsOutside: 3, chatPerHour: 30, chatPerDay: 100, alertsPerHour: 3 };

/** inclusive ranges a value may be set to */
export const LIMIT_RANGES: Readonly<Record<keyof Limits, readonly [number, number]>> = {
  syncCooldownMin: [5, 1440],
  syncDailyCap: [1, 48],
  syncMaxMonthsOutside: [1, 24],
  chatPerHour: [1, 500],
  chatPerDay: [1, 5000],
  alertsPerHour: [1, 60],
};

export const LIMIT_KEYS = Object.keys(LIMIT_DEFAULTS) as (keyof Limits)[];
const settingKey = (k: keyof Limits): string => `limits.${k}`;
export const SYNC_OUTSIDE_SETTING = 'limits.syncOutside';

const inRange = (k: keyof Limits, n: number): boolean => Number.isInteger(n) && n >= LIMIT_RANGES[k][0] && n <= LIMIT_RANGES[k][1];

export function getLimits(db: Db): Limits {
  const out = { ...LIMIT_DEFAULTS };
  for (const k of LIMIT_KEYS) {
    const raw = getSetting(db, settingKey(k));
    if (raw === null) continue;
    const n = Number(raw);
    if (inRange(k, n)) out[k] = n;
  }
  return out;
}

/** Validates every value first, then writes; returns the keys whose value changed. Throws on a value out of range. */
export function setLimits(db: Db, patch: Partial<Limits>): (keyof Limits)[] {
  for (const [k, v] of Object.entries(patch) as [keyof Limits, number | undefined][]) {
    if (!LIMIT_KEYS.includes(k)) throw new Error(`unknown limit: ${k}`);
    if (v === undefined) continue;
    if (!inRange(k, v)) throw new Error(`${k} must be a whole number from ${LIMIT_RANGES[k][0]} to ${LIMIT_RANGES[k][1]}`);
  }
  const before = getLimits(db);
  const changed: (keyof Limits)[] = [];
  for (const k of LIMIT_KEYS) {
    const v = patch[k];
    if (v === undefined || v === before[k]) continue;
    setSetting(db, settingKey(k), String(v));
    changed.push(k);
  }
  return changed;
}

// --- calendar days in Asia/Jerusalem

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: LIMITS_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const partsFmt = new Intl.DateTimeFormat('en-US', { timeZone: LIMITS_TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** "2026-11-11" for the instant, in Asia/Jerusalem */
export function localDay(ms: number): string {
  return dayFmt.format(new Date(ms));
}

/** local wall time minus UTC at the instant, in ms */
function offsetAt(ms: number): number {
  const p = Object.fromEntries(partsFmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value])) as Record<string, string>;
  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return wall - Math.floor(ms / 1000) * 1000;
}

/** The instant the next calendar day starts in Asia/Jerusalem (local midnight after `ms`). */
export function nextLocalMidnight(ms: number): number {
  const [y, m, d] = localDay(ms).split('-').map(Number) as [number, number, number];
  const wallMidnight = Date.UTC(y, m - 1, d + 1);
  let t = wallMidnight - offsetAt(ms);
  t = wallMidnight - offsetAt(t); // once more, in case a DST change lies in between
  return t;
}

// --- outside manual syncs (persisted)

const KEEP_MS = 48 * 3_600_000;
/**
 * Starts up to a day in the future are kept (review): after the clock is corrected backwards they still count, so a
 * clock fix cannot reset the bank-login limit. Anything further ahead is nonsense and dropped.
 */
const FUTURE_MS = 24 * 3_600_000;

export function outsideSyncStarts(db: Db, nowMs: number): number[] {
  try {
    const v = JSON.parse(getSetting(db, SYNC_OUTSIDE_SETTING) ?? '[]') as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x) && nowMs - x < KEEP_MS && x <= nowMs + FUTURE_MS).sort((a, b) => a - b);
  } catch {
    return [];
  }
}

export function recordOutsideSync(db: Db, nowMs: number): void {
  const list = [...outsideSyncStarts(db, nowMs), nowMs].sort((a, b) => a - b).slice(-200);
  setSetting(db, SYNC_OUTSIDE_SETTING, JSON.stringify(list));
}

export type SyncCheck = { ok: true } | { ok: false; reason: 'months'; max: number } | { ok: false; reason: 'cooldown' | 'daily_cap'; retryAt: number };

/** May an outside caller start a manual sync of `months` months now? Pure check; recordOutsideSync once it starts. */
export function checkOutsideSync(db: Db, nowMs: number, months: number | undefined, limits: Limits = getLimits(db)): SyncCheck {
  if (months !== undefined && months > limits.syncMaxMonthsOutside) return { ok: false, reason: 'months', max: limits.syncMaxMonthsOutside };
  const starts = outsideSyncStarts(db, nowMs);
  const last = starts.at(-1);
  const cooldownUntil = last !== undefined && limits.syncCooldownMin > 0 ? last + limits.syncCooldownMin * 60_000 : 0;
  const today = localDay(nowMs);
  const todayCount = starts.filter((t) => localDay(t) === today).length;
  if (todayCount >= limits.syncDailyCap) return { ok: false, reason: 'daily_cap', retryAt: Math.max(nextLocalMidnight(nowMs), cooldownUntil) };
  if (cooldownUntil > nowMs) return { ok: false, reason: 'cooldown', retryAt: cooldownUntil };
  return { ok: true };
}

// --- in-memory per-actor counters (chat, alerts)

/**
 * Per-key counter with a rolling hour and an optional calendar-day cap. take() checks and counts in one synchronous
 * step (like Attempts.take), so parallel requests cannot all pass. Old entries are pruned; the map is bounded.
 */
export class RateCounter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly maxKeys = 2000) {}

  /** null when allowed (and counted), else the instant it will be allowed again */
  take(key: string, nowMs: number, perHour: number, perDay?: number): number | null {
    const keep = perDay === undefined ? 3_600_000 : 26 * 3_600_000; // a calendar day is at most 25 hours
    const arr = (this.hits.get(key) ?? []).filter((t) => nowMs - t < keep && t <= nowMs);
    const hour = arr.filter((t) => nowMs - t < 3_600_000);
    let retry: number | null = null;
    if (hour.length >= perHour) retry = hour[hour.length - perHour]! + 3_600_000;
    if (perDay !== undefined) {
      const today = localDay(nowMs);
      if (arr.filter((t) => localDay(t) === today).length >= perDay) retry = Math.max(retry ?? 0, nextLocalMidnight(nowMs));
    }
    if (retry !== null) {
      this.hits.set(key, arr);
      return retry;
    }
    arr.push(nowMs);
    this.hits.set(key, arr);
    if (this.hits.size > this.maxKeys) {
      const first = this.hits.keys().next().value;
      if (first !== undefined) this.hits.delete(first);
    }
    return null;
  }
}
