import { describe, expect, it } from 'vitest';
import { telegramLockdownKey, PANIC_SHOW_FAILED_MS, PANIC_SHOW_MS, PANIC_WORD, panicOutcome, panicWordOk, parseIdleDays, revokedLabel, unusedDays } from './devicePolicy';

describe('panicWordOk (lock everything, P1-09)', () => {
  it('the word is LOCK, as the worker expects', () => {
    expect(PANIC_WORD).toBe('LOCK');
  });
  it('accepts the word with any case and surrounding spaces', () => {
    expect(panicWordOk('LOCK')).toBe(true);
    expect(panicWordOk(' lock ')).toBe(true);
    expect(panicWordOk('Lock')).toBe(true);
  });
  it('refuses anything else', () => {
    expect(panicWordOk('')).toBe(false);
    expect(panicWordOk('LOC')).toBe(false);
    expect(panicWordOk('LOCKS')).toBe(false);
    expect(panicWordOk('L O C K')).toBe(false);
    expect(panicWordOk('נעל')).toBe(false);
  });
});

describe('parseIdleDays', () => {
  it('whole days 0..365', () => {
    expect(parseIdleDays('0')).toBe(0);
    expect(parseIdleDays(' 30 ')).toBe(30);
    expect(parseIdleDays('365')).toBe(365);
  });
  it('null for anything out of range or not a whole number', () => {
    for (const s of ['', '366', '-1', '1.5', 'abc', '1e2', '1000', ' ']) expect(parseIdleDays(s)).toBeNull();
  });
});

const base = {
  createdAt: '2026-09-01T10:00:00.000Z',
  lastSeenAt: '2026-10-01T10:00:00.000Z' as string | null,
  revokedAt: null as string | null,
};

describe('unusedDays', () => {
  it('days from the last use to the removal', () => {
    expect(unusedDays({ ...base, revokedAt: '2026-10-31T11:00:00.000Z' })).toBe(30);
  });
  it('from the pairing when the device was never used', () => {
    expect(
      unusedDays({
        ...base,
        lastSeenAt: null,
        revokedAt: '2026-09-15T10:00:00.000Z',
      }),
    ).toBe(14);
  });
  it('null for an active device or unreadable dates; never negative', () => {
    expect(unusedDays(base)).toBeNull();
    expect(unusedDays({ ...base, revokedAt: 'garbage' })).toBeNull();
    expect(unusedDays({ ...base, revokedAt: '2026-09-30T10:00:00.000Z' })).toBe(0);
  });
});

describe('revokedLabel', () => {
  const gone = { ...base, revokedAt: '2026-10-31T11:00:00.000Z' };
  it('null for an active device', () => {
    expect(revokedLabel({ ...base, revokedReason: null })).toBeNull();
  });
  it('one label per reason', () => {
    expect(revokedLabel({ ...gone, revokedReason: 'expired' })).toEqual({
      key: 'dev_reason_expired',
      days: 30,
    });
    expect(revokedLabel({ ...gone, revokedReason: 'removed' })).toEqual({
      key: 'dev_reason_removed',
    });
    expect(revokedLabel({ ...gone, revokedReason: 'panic' })).toEqual({
      key: 'dev_reason_panic',
    });
  });
  it('an expiry with unreadable dates still says expired', () => {
    expect(revokedLabel({ ...gone, revokedAt: 'x', revokedReason: 'expired' })).toEqual({ key: 'dev_reason_expired_plain' });
  });
  it('a removal without a recorded reason (older worker) reads as removed', () => {
    expect(revokedLabel({ ...gone, revokedReason: null })).toEqual({
      key: 'dev_reason_removed',
    });
    expect(revokedLabel(gone)).toEqual({ key: 'dev_reason_removed' });
  });
});

describe('panicOutcome (reads ok, not the HTTP status)', () => {
  const full = { ok: true, devices: 2, sessions: 3, passkeys: 1, vaultLocked: true, alerted: true };
  it('a full success', () => {
    expect(panicOutcome(full)).toEqual({ failed: false, errors: [], devices: 2, sessions: 3, passkeys: 1, vaultLocked: true, showMs: PANIC_SHOW_MS });
  });
  it('ok:false is a partial failure: counts kept, errors listed, shown longer', () => {
    const o = panicOutcome({ ...full, ok: false, vaultLocked: false, errors: ['vault lock failed', ''] });
    expect(o).toMatchObject({ failed: true, errors: ['vault lock failed'], devices: 2, sessions: 3, passkeys: 1, vaultLocked: false, showMs: PANIC_SHOW_FAILED_MS });
    expect(PANIC_SHOW_FAILED_MS).toBeGreaterThan(PANIC_SHOW_MS);
  });
  it('a missing ok or missing counts never read as success', () => {
    expect(panicOutcome({})).toEqual({ failed: true, errors: [], devices: 0, sessions: 0, passkeys: 0, vaultLocked: false, showMs: PANIC_SHOW_FAILED_MS });
  });
});

describe('telegramLockdownKey', () => {
  it('offers /lockdown only when the worker says it works', () => {
    expect(telegramLockdownKey({ lockdownTelegram: true })).toBe('lockdown_telegram');
    expect(telegramLockdownKey({ lockdownTelegram: false })).toBe('lockdown_telegram_off');
  });
  it('missing (older worker, no settings yet) reads as off', () => {
    expect(telegramLockdownKey({})).toBe('lockdown_telegram_off');
    expect(telegramLockdownKey(undefined)).toBe('lockdown_telegram_off');
  });
});
