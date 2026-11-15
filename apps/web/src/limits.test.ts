import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { LIMIT_RANGES, errorText, parseLimit, readLimits, retryAtOf, retryWhen } from './limits';

const limited = (retryAt: unknown) => new ApiError('too many requests', 429, undefined, { error: 'too many requests', retryAt });
// a t() that shows the key and its vars, so the tests see which text was chosen
const t = (key: string, vars?: Record<string, string | number>) => `${key}(${Object.entries(vars ?? {}).map(([k, v]) => `${k}=${v}`).join(',')})`;

describe('retryAtOf (P2-02)', () => {
  it('reads retryAt from a 429', () => {
    expect(retryAtOf(limited('2026-11-11T12:35:00.000Z'))?.toISOString()).toBe('2026-11-11T12:35:00.000Z');
  });
  it('null for other statuses, other errors, and a missing or unreadable retryAt', () => {
    expect(retryAtOf(new ApiError('nope', 403, undefined, { retryAt: '2026-11-11T12:35:00Z' }))).toBeNull();
    expect(retryAtOf(new Error('x'))).toBeNull();
    expect(retryAtOf('x')).toBeNull();
    expect(retryAtOf(limited(undefined))).toBeNull();
    expect(retryAtOf(limited(12345))).toBeNull();
    expect(retryAtOf(limited('soon'))).toBeNull();
    expect(retryAtOf(new ApiError('too many', 429))).toBeNull();
  });
});

describe('retryWhen: Israel time, today vs another day', () => {
  // 2026-11-11 is a Wednesday; Israel is UTC+2 in November
  const now = new Date('2026-11-11T10:00:00Z'); // 12:00 in Israel
  it('later today: the time only', () => {
    expect(retryWhen(new Date('2026-11-11T12:35:00Z'), now, 'en-GB')).toEqual({ kind: 'today', time: '14:35', day: '' });
  });
  it('the Israel day decides, not UTC: 23:30 UTC is already tomorrow in Israel', () => {
    expect(retryWhen(new Date('2026-11-11T23:30:00Z'), now, 'en-GB')).toEqual({ kind: 'tomorrow', time: '01:30', day: '' });
    // 21:59 UTC is 23:59 the same day in Israel
    expect(retryWhen(new Date('2026-11-11T21:59:00Z'), now, 'en-GB').kind).toBe('today');
  });
  it('late at night in UTC terms but already the next day in Israel', () => {
    const lateNow = new Date('2026-11-11T22:30:00Z'); // 00:30 on the 12th in Israel
    expect(retryWhen(new Date('2026-11-12T08:00:00Z'), lateNow, 'en-GB')).toEqual({ kind: 'today', time: '10:00', day: '' });
  });
  it('further out: weekday and date', () => {
    const w = retryWhen(new Date('2026-11-13T07:05:00Z'), now, 'en-GB');
    expect(w.kind).toBe('day');
    expect(w.time).toBe('09:05');
    expect(w.day).toMatch(/Fri/);
    expect(w.day).toMatch(/13/);
  });
  it('a time already past reads as today', () => {
    expect(retryWhen(new Date('2026-11-11T09:00:00Z'), now, 'en-GB')).toEqual({ kind: 'today', time: '11:00', day: '' });
  });
  it('across the month end', () => {
    expect(retryWhen(new Date('2026-12-01T06:00:00Z'), new Date('2026-11-30T10:00:00Z'), 'en-GB').kind).toBe('tomorrow');
  });
});

describe('errorText', () => {
  const now = new Date('2026-11-11T10:00:00Z');
  it('a 429 names the area and when', () => {
    expect(errorText(limited('2026-11-11T12:35:00Z'), 'sync', t as never, 'en-GB', now)).toBe('limit_retry_sync(when=limit_when_today(t=14:35,d=))');
    expect(errorText(limited('2026-11-12T06:00:00Z'), 'chat', t as never, 'en-GB', now)).toBe('limit_retry_chat(when=limit_when_tomorrow(t=08:00,d=))');
    expect(errorText(limited('2026-11-14T06:00:00Z'), 'alerts', t as never, 'en-GB', now)).toMatch(/^limit_retry_alerts\(when=limit_when_day\(t=08:00,d=Sat/);
  });
  it("anything else shows the hub's message", () => {
    expect(errorText(new ApiError('months: at most 3 away from home', 400), 'sync', t as never, 'en-GB', now)).toBe('months: at most 3 away from home');
    expect(errorText(new ApiError('too many requests', 429), 'chat', t as never, 'en-GB', now)).toBe('too many requests');
    expect(errorText('boom', 'chat', t as never, 'en-GB', now)).toBe('boom');
  });
});

describe('readLimits', () => {
  const full = { syncCooldownMin: 30, syncDailyCap: 6, syncMaxMonthsOutside: 3, chatPerHour: 30, chatPerDay: 200, alertsPerHour: 10 };
  it('takes a whole object', () => {
    expect(readLimits(full)).toEqual(full);
    expect(readLimits({ ...full, extra: 1 })).toEqual(full);
  });
  it('null when missing (older hub) or malformed', () => {
    expect(readLimits(undefined)).toBeNull();
    expect(readLimits(null)).toBeNull();
    expect(readLimits({ ...full, chatPerDay: '200' })).toBeNull();
    const { alertsPerHour: _, ...partial } = full;
    expect(readLimits(partial)).toBeNull();
  });
});

describe('parseLimit: the Settings ranges', () => {
  it('the ranges', () => {
    expect(LIMIT_RANGES).toEqual({
      syncCooldownMin: { min: 5, max: 1440 },
      syncDailyCap: { min: 1, max: 48 },
      syncMaxMonthsOutside: { min: 1, max: 24 },
      chatPerHour: { min: 1, max: 500 },
      chatPerDay: { min: 1, max: 5000 },
      alertsPerHour: { min: 1, max: 60 },
    });
  });
  it('whole numbers inside the range, spaces trimmed', () => {
    expect(parseLimit('syncCooldownMin', ' 5 ')).toBe(5);
    expect(parseLimit('syncCooldownMin', '1440')).toBe(1440);
    expect(parseLimit('chatPerDay', '5000')).toBe(5000);
  });
  it('refuses out of range, fractions, signs and text', () => {
    expect(parseLimit('syncCooldownMin', '4')).toBeNull();
    expect(parseLimit('syncCooldownMin', '1441')).toBeNull();
    expect(parseLimit('syncDailyCap', '0')).toBeNull();
    expect(parseLimit('syncMaxMonthsOutside', '25')).toBeNull();
    expect(parseLimit('alertsPerHour', '1.5')).toBeNull();
    expect(parseLimit('chatPerHour', '-3')).toBeNull();
    expect(parseLimit('chatPerHour', '')).toBeNull();
    expect(parseLimit('chatPerHour', 'ten')).toBeNull();
  });
});
