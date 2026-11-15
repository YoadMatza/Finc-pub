import { describe, expect, it } from 'vitest';
import { limitLines, parseShekels } from './limitCard';
import type { SpendLimit } from './types';

// the plan's example (§3): ₪2,493 of ₪6,000 on the 12th of a 30-day month; even spread by today ₪2,400
const base: SpendLimit = {
  amount: 600_000,
  spent: 249_300,
  usedPct: 41.55,
  pace: { byToday: 240_000, delta: 9_300, state: 'on' },
  leftWithin: 350_700,
  over: false,
  week: { limit: 117_000, spent: 5_300 },
  targets: { sum: 550_000, exceeds: false },
};

describe('limitLines', () => {
  it('the plan example: headline, left within, this week, fill and marker', () => {
    const r = limitLines(base);
    expect(r.headline).toEqual({ spent: 249_300, amount: 600_000 });
    expect(r.pace).toEqual({ key: 'limit_pace_on' });
    expect(r.left).toEqual({ key: 'limit_left_within', x: 350_700 });
    expect(r.over).toBe(false);
    expect(r.week).toEqual({ spent: 5_300, limit: 117_000 });
    expect(r.fillPct).toBeCloseTo(41.55, 10); // 2,493 / 6,000
    expect(r.markerPct).toBe(40); // 2,400 / 6,000
    expect(r.tone).toBe('neutral');
    expect(r.targetsOver).toBeNull();
  });
  it('ahead of pace: the amount ahead, warm', () => {
    const r = limitLines({ ...base, spent: 300_000, leftWithin: 300_000, pace: { byToday: 240_000, delta: 60_000, state: 'ahead' } });
    expect(r.pace).toEqual({ key: 'limit_pace_ahead', x: 60_000 });
    expect(r.tone).toBe('warm');
    expect(r.fillPct).toBe(50);
  });
  it('under pace: the amount under as a positive number, neutral', () => {
    const r = limitLines({ ...base, spent: 180_000, leftWithin: 420_000, pace: { byToday: 240_000, delta: -60_000, state: 'under' } });
    expect(r.pace).toEqual({ key: 'limit_pace_under', x: 60_000 });
    expect(r.tone).toBe('neutral');
    expect(r.fillPct).toBe(30);
  });
  it('over the limit: "over by", fill clamped to 100, warm', () => {
    const r = limitLines({ ...base, spent: 650_000, usedPct: 108.3, leftWithin: -50_000, over: true, pace: { byToday: 400_000, delta: 250_000, state: 'ahead' } });
    expect(r.left).toEqual({ key: 'limit_over_by', x: 50_000 });
    expect(r.over).toBe(true);
    expect(r.fillPct).toBe(100);
    expect(r.markerPct).toBeCloseTo(66.667, 2);
    expect(r.tone).toBe('warm');
  });
  it('a negative leftWithin counts as over even if the flag says otherwise', () => {
    const r = limitLines({ ...base, leftWithin: -100, over: false });
    expect(r.left).toEqual({ key: 'limit_over_by', x: 100 });
    expect(r.tone).toBe('warm');
  });
  it('exactly at the limit: nothing left, not over', () => {
    const r = limitLines({ ...base, spent: 600_000, leftWithin: 0, over: false });
    expect(r.left).toEqual({ key: 'limit_left_within', x: 0 });
    expect(r.fillPct).toBe(100);
  });
  it('past month: week null, the marker at the end of the month is 100', () => {
    const r = limitLines({ ...base, week: null, pace: { byToday: 600_000, delta: -350_700, state: 'under' } });
    expect(r.week).toBeNull();
    expect(r.markerPct).toBe(100);
  });
  it('category targets over the limit: their sum; at or under: null', () => {
    expect(limitLines({ ...base, targets: { sum: 720_000, exceeds: true } }).targetsOver).toBe(720_000);
    expect(limitLines({ ...base, targets: { sum: 600_000, exceeds: false } }).targetsOver).toBeNull();
    expect(limitLines({ ...base, targets: null }).targetsOver).toBeNull();
  });
  it('a zero amount does not divide by zero; nothing spent: empty bar', () => {
    const r = limitLines({ ...base, amount: 0 });
    expect(r.fillPct).toBe(0);
    expect(r.markerPct).toBe(0);
    expect(limitLines({ ...base, spent: 0, leftWithin: 600_000 }).fillPct).toBe(0);
  });
});

describe('parseShekels', () => {
  it('whole shekels, separators and the ₪ sign', () => {
    expect(parseShekels('6000')).toBe(600_000);
    expect(parseShekels(' 6,000 ')).toBe(600_000);
    expect(parseShekels('₪6,000')).toBe(600_000);
    expect(parseShekels('1,250,000')).toBe(125_000_000);
  });
  it('up to two decimals', () => {
    expect(parseShekels('6000.5')).toBe(600_050);
    expect(parseShekels('0.01')).toBe(1);
    expect(parseShekels('19.99')).toBe(1_999);
  });
  it('not a positive amount: null', () => {
    for (const v of ['', '0', '0.00', '-100', 'abc', '6.123', '1e5', '6,00', '.5', '5.']) expect(parseShekels(v)).toBeNull();
  });
});
