import { describe, expect, it } from 'vitest';
import { addRow, parseShekels, planSplit, removeRow, shekelsText, splitChoices, startRows } from './split';

describe('split: shekels in and out', () => {
  it('parses whole, decimal and comma forms to agorot', () => {
    expect(parseShekels('150')).toBe(15000);
    expect(parseShekels(' 89.9 ')).toBe(8990);
    expect(parseShekels('89,90')).toBe(8990);
    expect(parseShekels('1,234.5')).toBe(123450);
    expect(parseShekels('₪12')).toBe(1200);
  });

  it('refuses text that is not an amount', () => {
    expect(parseShekels('')).toBeNull();
    expect(parseShekels('abc')).toBeNull();
    expect(parseShekels('-5')).toBeNull();
    expect(parseShekels('1.234')).toBeNull();
  });

  it('shows agorot without trailing zeros for whole shekels', () => {
    expect(shekelsText(-24000)).toBe('240');
    expect(shekelsText(8990)).toBe('89.90');
  });
});

describe('split: the last row takes the remainder', () => {
  it('starts with the main category at the full amount and an empty row (not yet savable)', () => {
    const rows = startRows(-24000, 7, null);
    expect(rows).toEqual([
      { category: 7, shekels: '240' },
      { category: '', shekels: '' },
    ]);
    const plan = planSplit(-24000, rows);
    expect(plan.remainder).toBe(0);
    expect(plan.valid).toBe(false);
  });

  it('starts from the existing parts when already split', () => {
    expect(startRows(-24000, 7, [{ categoryId: 7, amount: -15000 }, { categoryId: 9, amount: -9000 }])).toEqual([
      { category: 7, shekels: '150' },
      { category: 9, shekels: '90' },
    ]);
  });

  it('a valid split adds up exactly, as negative agorot', () => {
    const plan = planSplit(-24000, [
      { category: 7, shekels: '150.10' },
      { category: 9, shekels: 'ignored' },
    ]);
    expect(plan.remainder).toBe(8990);
    expect(plan.valid).toBe(true);
    expect(plan.parts).toEqual([
      { category: 7, amount: -15010 },
      { category: 9, amount: -8990 },
    ]);
    expect(plan.parts.reduce((a, p) => a + p.amount, 0)).toBe(-24000);
  });

  it('is not valid with a missing category, a bad amount, or rows over the charge', () => {
    expect(planSplit(-24000, [{ category: 7, shekels: '100' }, { category: '', shekels: '' }]).valid).toBe(false);
    expect(planSplit(-24000, [{ category: 7, shekels: '0' }, { category: 9, shekels: '' }]).valid).toBe(false);
    expect(planSplit(-24000, [{ category: 7, shekels: 'x' }, { category: 9, shekels: '' }]).valid).toBe(false);
    const over = planSplit(-24000, [{ category: 7, shekels: '300' }, { category: 9, shekels: '' }]);
    expect(over.remainder).toBe(-6000);
    expect(over.valid).toBe(false);
  });

  it('is never valid for income or with one row', () => {
    expect(planSplit(24000, [{ category: 7, shekels: '100' }, { category: 9, shekels: '' }]).valid).toBe(false);
    expect(planSplit(-24000, [{ category: 7, shekels: '' }]).valid).toBe(false);
  });

  it('adding a row keeps what the old last row showed; removing lets the new last row take the rest', () => {
    const two = [
      { category: 7 as const, shekels: '150' },
      { category: 9 as const, shekels: '' },
    ];
    const three = addRow(-24000, two);
    expect(three).toEqual([
      { category: 7, shekels: '150' },
      { category: 9, shekels: '90' },
      { category: '', shekels: '' },
    ]);
    expect(planSplit(-24000, three).remainder).toBe(0);
    const back = removeRow(three, 2);
    expect(planSplit(-24000, back).remainder).toBe(9000);
    expect(removeRow(two, 0)).toBe(two);
  });

  it('stops at eight rows', () => {
    let rows = startRows(-80000, 1, null);
    for (let i = 0; i < 10; i++) rows = addRow(-80000, rows);
    expect(rows).toHaveLength(8);
  });
});

describe('split: category choices', () => {
  it('leaves out income, transfers and placeholder ids', () => {
    const cats = [
      { id: 1, key: 'daily.pharm', section: 'variable' },
      { id: 2, key: 'income.salary', section: 'income' },
      { id: 3, key: 'transfers', section: 'transfer' },
      { id: 0, key: 'none', section: 'variable' },
      { id: 4, key: 'fixed.housing', section: 'fixed' },
    ];
    expect(splitChoices(cats).map((c) => c.id)).toEqual([1, 4]);
  });
});
