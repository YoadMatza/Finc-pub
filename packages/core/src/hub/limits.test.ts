import { describe, expect, it } from 'vitest';
import { getSetting, setSetting } from '../ai/settings.js';
import { openDb } from '../db/db.js';
import { LIMIT_DEFAULTS, RateCounter, checkOutsideSync, getLimits, localDay, nextLocalMidnight, recordOutsideSync, setLimits } from './limits.js';

// security research P2-02

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('limits settings', () => {
  it('defaults, overrides, and broken stored values fall back', () => {
    const db = openDb(':memory:');
    expect(getLimits(db)).toEqual(LIMIT_DEFAULTS);
    expect(setLimits(db, { chatPerDay: 200, chatPerHour: 30 })).toEqual(['chatPerDay']);
    expect(getLimits(db).chatPerDay).toBe(200);
    setSetting(db, 'limits.syncDailyCap', 'lots');
    setSetting(db, 'limits.alertsPerHour', '0');
    expect(getLimits(db)).toMatchObject({ syncDailyCap: 6, alertsPerHour: 3 });
  });

  it('a value out of range is refused and nothing in the patch is written', () => {
    const db = openDb(':memory:');
    expect(() => setLimits(db, { chatPerHour: 10, syncCooldownMin: 4 })).toThrow(/syncCooldownMin/);
    expect(() => setLimits(db, { chatPerDay: 5001 })).toThrow();
    expect(() => setLimits(db, { syncMaxMonthsOutside: 2.5 })).toThrow();
    expect(getLimits(db)).toEqual(LIMIT_DEFAULTS);
  });
});

describe('calendar days in Asia/Jerusalem', () => {
  it('the day turns at local midnight, winter and summer', () => {
    expect(localDay(Date.parse('2026-11-11T21:59:59Z'))).toBe('2026-11-11');
    expect(localDay(Date.parse('2026-11-11T22:00:00Z'))).toBe('2026-11-12');
    expect(nextLocalMidnight(Date.parse('2026-11-11T08:00:00Z'))).toBe(Date.parse('2026-11-11T22:00:00Z'));
    expect(nextLocalMidnight(Date.parse('2026-07-01T10:00:00Z'))).toBe(Date.parse('2026-07-01T21:00:00Z'));
    // 23:30 local on the night the clocks go back (Israel, last Sunday of October 2026): midnight is still in summer time
    expect(nextLocalMidnight(Date.parse('2026-10-24T20:30:00Z'))).toBe(Date.parse('2026-10-24T21:00:00Z'));
    // the day after the change: winter time
    expect(nextLocalMidnight(Date.parse('2026-10-25T12:00:00Z'))).toBe(Date.parse('2026-10-25T22:00:00Z'));
  });
});

describe('outside syncs', () => {
  const T0 = Date.parse('2026-11-11T08:00:00Z');

  it('cooldown boundary, months, daily cap; the list is persisted and pruned', () => {
    const db = openDb(':memory:');
    expect(checkOutsideSync(db, T0, undefined)).toEqual({ ok: true });
    expect(checkOutsideSync(db, T0, 4)).toEqual({ ok: false, reason: 'months', max: 3 });
    recordOutsideSync(db, T0);
    expect(checkOutsideSync(db, T0 + 30 * MIN - 1, 3)).toEqual({ ok: false, reason: 'cooldown', retryAt: T0 + 30 * MIN });
    expect(checkOutsideSync(db, T0 + 30 * MIN, 3)).toEqual({ ok: true });
    for (let i = 1; i < 6; i++) recordOutsideSync(db, T0 + i * HOUR);
    const late = Date.parse('2026-11-11T21:59:00Z');
    expect(checkOutsideSync(db, late, undefined)).toEqual({ ok: false, reason: 'daily_cap', retryAt: Date.parse('2026-11-11T22:00:00Z') });
    expect(checkOutsideSync(db, Date.parse('2026-11-11T22:00:00Z'), undefined)).toEqual({ ok: true });
    // two days later the old starts are pruned on the next write
    recordOutsideSync(db, T0 + 54 * HOUR);
    expect(JSON.parse(getSetting(db, 'limits.syncOutside')!)).toEqual([T0 + 54 * HOUR]);
  });

  it('starts up to a day in the future survive a backwards clock correction; absurd ones are dropped (review)', () => {
    const db = openDb(':memory:');
    recordOutsideSync(db, T0);
    // the clock goes back two hours: the start is now "in the future" and still counts
    const back = T0 - 2 * HOUR;
    expect(checkOutsideSync(db, back, undefined)).toEqual({ ok: false, reason: 'cooldown', retryAt: T0 + 30 * MIN });
    recordOutsideSync(db, back + 3 * HOUR);
    expect(JSON.parse(getSetting(db, 'limits.syncOutside')!)).toEqual([T0, back + 3 * HOUR]);
    // a start a year ahead is nonsense
    setSetting(db, 'limits.syncOutside', JSON.stringify([T0 + 365 * 24 * HOUR]));
    expect(checkOutsideSync(db, T0, undefined)).toEqual({ ok: true });
  });

  it('a broken stored list is treated as empty', () => {
    const db = openDb(':memory:');
    setSetting(db, 'limits.syncOutside', '{oops');
    expect(checkOutsideSync(db, T0, undefined)).toEqual({ ok: true });
  });
});

describe('RateCounter', () => {
  const T0 = Date.parse('2026-11-11T08:00:00Z');

  it('rolling hour per key, retry when the oldest leaves the window', () => {
    const r = new RateCounter();
    expect(r.take('a', T0, 2)).toBeNull();
    expect(r.take('a', T0 + 10 * MIN, 2)).toBeNull();
    expect(r.take('a', T0 + 20 * MIN, 2)).toBe(T0 + HOUR);
    expect(r.take('b', T0 + 20 * MIN, 2)).toBeNull();
    expect(r.take('a', T0 + HOUR, 2)).toBeNull();
  });

  it('calendar-day cap until local midnight', () => {
    const r = new RateCounter();
    for (let i = 0; i < 3; i++) expect(r.take('a', T0 + i * 2 * HOUR, 10, 3)).toBeNull();
    const midnight = Date.parse('2026-11-11T22:00:00Z');
    expect(r.take('a', midnight - 1, 10, 3)).toBe(midnight);
    expect(r.take('a', midnight, 10, 3)).toBeNull();
  });
});
