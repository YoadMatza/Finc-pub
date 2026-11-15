import { describe, expect, it } from 'vitest';
import { amountSignal, assign, combine, dateSignal, zoneOf } from './match.js';

describe('match engine', () => {
  it('combines weighted signals and maps to zones', () => {
    const s = combine([
      { signal: 'merchant', score: 1, weight: 1.5, note: '' },
      { signal: 'amount', score: 1, weight: 1.5, note: '' },
      { signal: 'date', score: 0.9, weight: 1, note: '' },
    ]);
    expect(s.score).toBeCloseTo((1.5 + 1.5 + 0.9) / 4, 5);
    expect(zoneOf(s.score)).toBe('auto');
    expect(zoneOf(0.6)).toBe('suggest');
    expect(zoneOf(0.2)).toBe('ignore');
  });

  it('two equal refunds do not both grab the same purchase', () => {
    const purchases = [{ id: 'p1' }, { id: 'p2' }];
    const refunds = [{ id: 'r1' }, { id: 'r2' }];
    const pairs = refunds.flatMap((r) => purchases.map((p) => ({ a: r, b: p, scored: combine([{ signal: 'x', score: p.id === 'p1' ? 0.95 : 0.9, weight: 1, note: '' }]) })));
    const out = assign(pairs, (r) => r.id, (p) => p.id);
    expect(out).toHaveLength(2);
    expect(new Set(out.map((o) => o.b.id))).toEqual(new Set(['p1', 'p2']));
  });

  it('capacity lets one purchase absorb several partial refunds', () => {
    const purchase = { id: 'p' };
    const refunds = [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }];
    const pairs = refunds.map((r) => ({ a: r, b: purchase, scored: combine([{ signal: 'x', score: 0.9, weight: 1, note: '' }]) }));
    expect(assign(pairs, (r) => r.id, (p) => p.id, { capacityB: () => 2 })).toHaveLength(2);
  });

  it('amount and date helpers', () => {
    expect(amountSignal(10000, 10000).score).toBe(1);
    expect(amountSignal(10000, 10300).score).toBe(0.85);
    expect(amountSignal(4000, 10000, { allowPartial: true }).score).toBe(0.75);
    expect(amountSignal(4000, 10000).score).toBe(0);
    expect(dateSignal(0, 90).score).toBe(1);
    expect(dateSignal(45, 90).score).toBe(0.5);
    expect(dateSignal(-2, 90).score).toBe(0.6);
    expect(dateSignal(-10, 90).score).toBe(-1);
  });
});
