/**
 * Security research P1-09: paired devices expire after a stretch without use, and "lock everything" (panic) removes
 * every paired phone and browser session and locks the vault. Pure helpers for the Settings UI; tested in
 * devicePolicy.test.ts.
 */
import type { Device, PanicResult, Settings } from './types';

/** The word the user types to confirm "lock everything"; the worker expects exactly this in the body. */
export const PANIC_WORD = 'LOCK';

/** Whether the typed confirmation matches: surrounding spaces and letter case do not matter. */
export function panicWordOk(input: string): boolean {
  return input.trim().toUpperCase() === PANIC_WORD;
}

export const IDLE_DAYS_MAX = 365;

/** The idle-expiry field as a number of days (0 = never), or null when it is not a whole number in 0..365. */
export function parseIdleDays(input: string): number | null {
  const s = input.trim();
  if (!/^\d{1,3}$/.test(s)) return null;
  const n = Number(s);
  return n <= IDLE_DAYS_MAX ? n : null;
}

const DAY_MS = 86_400_000;

/** Whole days a device went unused before it was removed: from its last use (or its pairing) to the removal. */
export function unusedDays(d: Pick<Device, 'createdAt' | 'lastSeenAt' | 'revokedAt'>): number | null {
  if (!d.revokedAt) return null;
  const end = Date.parse(d.revokedAt);
  const start = Date.parse(d.lastSeenAt ?? d.createdAt);
  if (Number.isNaN(end) || Number.isNaN(start)) return null;
  return Math.max(0, Math.floor((end - start) / DAY_MS));
}

export type RevokedLabel = { key: 'dev_reason_expired'; days: number } | { key: 'dev_reason_expired_plain' } | { key: 'dev_reason_removed' } | { key: 'dev_reason_panic' };

/**
 * Why a removed device was removed, as an i18n key (and the unused days for an expiry). null for an active device.
 * A removed device without a reason (removed before the worker recorded reasons) reads as "removed".
 */
export function revokedLabel(d: Pick<Device, 'createdAt' | 'lastSeenAt' | 'revokedAt' | 'revokedReason'>): RevokedLabel | null {
  if (!d.revokedAt) return null;
  if (d.revokedReason === 'panic') return { key: 'dev_reason_panic' };
  if (d.revokedReason === 'expired') {
    const days = unusedDays(d);
    return days === null ? { key: 'dev_reason_expired_plain' } : { key: 'dev_reason_expired', days };
  }
  return { key: 'dev_reason_removed' };
}

/** How long the outcome stays on screen before the app re-checks its own (now ended) access. */
export const PANIC_SHOW_MS = 3_000;
/** A partial failure stays longer: the owner has to read what failed and finish from the PC. */
export const PANIC_SHOW_FAILED_MS = 12_000;

/**
 * Reads POST /api/panic by its `ok` field, never the HTTP status (a partial failure still answers 200). Counts missing
 * from the answer read as 0.
 */
export function panicOutcome(r: Partial<PanicResult>): { failed: boolean; errors: string[]; devices: number; sessions: number; passkeys: number; vaultLocked: boolean; showMs: number } {
  const failed = r.ok !== true;
  const errors = Array.isArray(r.errors) ? r.errors.filter((e) => typeof e === 'string' && e.trim() !== '') : [];
  return {
    failed,
    errors,
    devices: r.devices ?? 0,
    sessions: r.sessions ?? 0,
    passkeys: r.passkeys ?? 0,
    vaultLocked: r.vaultLocked === true,
    showMs: failed ? PANIC_SHOW_FAILED_MS : PANIC_SHOW_MS,
  };
}

/** The Telegram line on the lockdown card: /lockdown only when the worker says the alarm bot can take it (missing = no). */
export function telegramLockdownKey(s: Pick<Settings, 'lockdownTelegram'> | undefined): 'lockdown_telegram' | 'lockdown_telegram_off' {
  return s?.lockdownTelegram === true ? 'lockdown_telegram' : 'lockdown_telegram_off';
}
