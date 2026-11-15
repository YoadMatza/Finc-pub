import { describe, expect, it } from 'vitest';
import type { HubLimit } from '../hub/limit.js';
import { limitAlerts, weekSunday } from './limit.js';

/** A limit card as the hub sends it; pace.byToday / delta as engine/limit.ts computes them (amount × day ÷ dim). */
function card(amount: number, spent: number, byToday: number): HubLimit {
  return {
    amount,
    spent,
    usedPct: Math.round((spent / amount) * 1000) / 10,
    pace: { byToday, delta: spent - byToday, state: 'on' },
    leftWithin: amount - spent,
    over: spent > amount,
    week: { limit: 0, spent: 0 },
    targets: null,
  } as HubLimit;
}
/** the text without the LRI/PDI marks that keep amounts left-to-right in Hebrew */
const plain = (s: string) => s.replace(/[⁦⁩]/g, '');
const ctx = { month: '2026-11', today: '2026-11-12', lang: 'en' as const };

describe('weekSunday', () => {
  it('returns the Sunday of the week', () => {
    expect(weekSunday('2026-11-12')).toBe('2026-11-08'); // Thursday
    expect(weekSunday('2026-11-08')).toBe('2026-11-08'); // Sunday itself
    expect(weekSunday('2026-11-14')).toBe('2026-11-08'); // Saturday
    expect(weekSunday('2026-11-01')).toBe('2026-11-01'); // a Sunday, the 1st
    expect(weekSunday('2026-12-02')).toBe('2026-11-29'); // a week that started last month
  });
});

describe('limitAlerts', () => {
  it('nothing without a limit, for another month, or on pace', () => {
    expect(limitAlerts(null, ctx)).toEqual([]);
    expect(limitAlerts(card(600000, 590000, 600000), { ...ctx, month: '2026-10' })).toEqual([]);
    // ₪6,000 limit, day 12 of 30: even spread ₪2,400; spent ₪2,493 → ₪93 ahead, inside both thresholds
    expect(limitAlerts(card(600000, 249300, 240000), ctx)).toEqual([]);
  });

  it('100% once a month, with the amount over', () => {
    const [a, ...rest] = limitAlerts(card(600000, 650000, 240000), ctx);
    expect(rest).toEqual([]);
    expect(a!.key).toBe('spend_limit:100:2026-11');
    expect(plain(a!.text)).toContain('₪6,500');
    expect(plain(a!.text)).toContain('₪500 over it');
    // exactly at the limit: reached, nothing over
    const [b] = limitAlerts(card(600000, 600000, 240000), ctx);
    expect(b!.key).toBe('spend_limit:100:2026-11');
    expect(plain(b!.text)).not.toContain('over it');
  });

  it('80% (inclusive) below 100%, with what is left', () => {
    const [a] = limitAlerts(card(600000, 480000, 400000), ctx);
    expect(a!.key).toBe('spend_limit:80:2026-11');
    expect(plain(a!.text)).toContain('₪1,200 left');
    expect(limitAlerts(card(600000, 479999, 479999), ctx)).toEqual([]);
  });

  it('ahead of pace: more than 20% above the even spread and more than 5% of the limit, keyed by the week', () => {
    // byToday 2,400: 20% = 480, 5% of 6,000 = 300 → needs delta > 480
    expect(limitAlerts(card(600000, 288000, 240000), ctx)).toEqual([]); // delta 480, not more
    const [a] = limitAlerts(card(600000, 288100, 240000), ctx);
    expect(a!.key).toBe('spend_limit:pace:2026-11-08');
    expect(plain(a!.text)).toContain('₪481 ahead of pace');
    // day 2: byToday 400, spent 700 = 75% above pace but only ₪300 = 5% of the limit → quiet
    expect(limitAlerts(card(600000, 70000, 40000), { ...ctx, today: '2026-11-02' })).toEqual([]);
  });

  it('Hebrew text keeps amounts isolated', () => {
    const [a] = limitAlerts(card(600000, 650000, 240000), { ...ctx, lang: 'he' });
    expect(a!.text).toContain('⁦6,500 ₪⁩');
    expect(a!.text).toContain('מעליה');
  });
});
