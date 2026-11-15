import { describe, expect, it } from 'vitest';
import { lastUsClose, localDate, nextUsOpen, usSessionOpen } from './market.js';

const t = (iso: string): number => Date.parse(iso);

describe('US market hours', () => {
  it('opens 09:30 and closes 16:00 New York in winter (EST, UTC-5)', () => {
    expect(usSessionOpen(t('2026-11-11T14:29:59Z'))).toBe(false);
    expect(usSessionOpen(t('2026-11-11T14:30:00Z'))).toBe(true);
    expect(usSessionOpen(t('2026-11-11T20:59:59Z'))).toBe(true);
    expect(usSessionOpen(t('2026-11-11T21:00:00Z'))).toBe(false);
  });

  it('follows daylight saving in summer (EDT, UTC-4)', () => {
    expect(usSessionOpen(t('2026-07-15T13:29:00Z'))).toBe(false);
    expect(usSessionOpen(t('2026-07-15T13:30:00Z'))).toBe(true);
    expect(usSessionOpen(t('2026-07-15T19:59:00Z'))).toBe(true);
    expect(usSessionOpen(t('2026-07-15T20:00:00Z'))).toBe(false);
  });

  it('is right on both sides of the March switch (Friday EST, Monday EDT)', () => {
    expect(usSessionOpen(t('2026-03-06T14:00:00Z'))).toBe(false); // 09:00 EST
    expect(usSessionOpen(t('2026-03-06T14:30:00Z'))).toBe(true);
    expect(usSessionOpen(t('2026-03-09T13:30:00Z'))).toBe(true); // 09:30 EDT
    expect(usSessionOpen(t('2026-03-09T13:29:00Z'))).toBe(false);
    expect(nextUsOpen(t('2026-03-06T22:00:00Z'))).toBe(t('2026-03-09T13:30:00Z'));
    expect(lastUsClose(t('2026-03-09T12:00:00Z'))).toBe(t('2026-03-06T21:00:00Z'));
  });

  it('is shut on weekends', () => {
    expect(usSessionOpen(t('2026-11-14T16:00:00Z'))).toBe(false); // Saturday 11:00
    expect(usSessionOpen(t('2026-03-08T15:00:00Z'))).toBe(false); // Sunday, the switch day
    expect(lastUsClose(t('2026-11-14T16:00:00Z'))).toBe(t('2026-11-13T21:00:00Z'));
    expect(nextUsOpen(t('2026-11-14T16:00:00Z'))).toBe(t('2026-11-16T14:30:00Z'));
  });

  it('last close and next open around a session', () => {
    expect(lastUsClose(t('2026-07-15T20:00:00Z'))).toBe(t('2026-07-15T20:00:00Z'));
    expect(lastUsClose(t('2026-07-15T19:00:00Z'))).toBe(t('2026-07-14T20:00:00Z'));
    expect(nextUsOpen(t('2026-11-11T14:29:00Z'))).toBe(t('2026-11-11T14:30:00Z'));
    expect(nextUsOpen(t('2026-11-11T14:30:00Z'))).toBe(t('2026-11-12T14:30:00Z'));
  });

  it('local dates per exchange zone, unknown zones fall back to New York', () => {
    expect(localDate(t('2026-11-11T03:00:00Z'))).toBe('2026-11-10');
    expect(localDate(t('2026-11-11T03:00:00Z'), 'Europe/London')).toBe('2026-11-11');
    expect(localDate(t('2026-11-11T03:00:00Z'), 'Not/AZone')).toBe('2026-11-10');
  });
});
