import { describe, expect, it } from 'vitest';
import type { Key } from './i18n';
import { dayMonth, settlementNote } from './settlement';

const t = (k: Key, vars?: Record<string, string | number>) => (vars ? `${k}(${Object.entries(vars).map(([a, b]) => `${a}=${b}`).join(',')})` : k);

describe('settlement labels', () => {
  it('day and month without leading zeros', () => {
    expect(dayMonth('2026-11-07')).toBe('7.11');
    expect(dayMonth('2026-01-10')).toBe('10.1');
  });
  it('one card row: names it and points to it', () => {
    expect(settlementNote({ settles: { count: 1, account: 'Max', first: { txnId: 7, description: 'GOOGLE FICTIFLIX', date: '2026-11-07', amount: -2990 } } }, t)).toEqual({ text: 'settles_one(account=Max,name=GOOGLE FICTIFLIX,d=7.11)', targetId: 7 });
  });
  it('a monthly bill: a count, no single target', () => {
    expect(settlementNote({ settles: { count: 23, account: 'Max' } }, t)).toEqual({ text: 'settles_many(account=Max,n=23)', targetId: null });
  });
  it('a card row paid by an immediate charge points back to the payment', () => {
    expect(settlementNote({ settledBy: { txnId: 3, date: '2026-11-10', account: 'Bank', count: 1 } }, t)).toEqual({ text: 'settled_by(d=10.11)', targetId: 3 });
    expect(settlementNote({ settledBy: { txnId: 3, date: '2026-11-10', account: 'Bank', count: 3 } }, t)?.targetId).toBe(3);
  });
  it('a card row paid by a monthly bill has no line', () => {
    expect(settlementNote({ settledBy: { txnId: 3, date: '2026-11-02', account: 'Bank', count: 4 } }, t)).toBeNull();
    expect(settlementNote({ settledBy: { txnId: 3, date: '2026-11-02', account: 'Bank', count: 40 } }, t)).toBeNull();
  });
  it('nothing linked: no line', () => {
    expect(settlementNote({}, t)).toBeNull();
    expect(settlementNote({ settles: { count: 0, account: 'Max' } }, t)).toBeNull();
  });
  it('the three strings exist in both languages', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('./i18n.tsx', import.meta.url), 'utf8');
    for (const k of ['settles_one', 'settles_many', 'settled_by']) expect(src.split(`  ${k}:`).length - 1, k).toBe(2);
  });
});
