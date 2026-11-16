import { describe, expect, it } from 'vitest';
import { CHAT_TOOLS } from '../ai/chat.js';
import { ensureAccount } from '../db/accounts.js';
import { openDb } from '../db/db.js';
import { monthSummary } from '../engine/summary.js';
import { runEngine } from '../engine/run.js';
import { ingestBatch } from '../ingest/ingest.js';
import type { NormalizedRow } from '../ingest/types.js';
import { categoriesOverview } from './categories.js';
import { hubOverview } from './overview.js';
import { SplitError, allocateSplit, removeSplit, setSplit, splitOf } from './splits.js';

// wave 5, research_notes/proposals/split-transaction.md: a made-up pharmacy receipt of ₪240 = ₪150 pharmacy + ₪90 home

const row = (date: string, amount: number, description: string): NormalizedRow => ({ externalAccountId: 'x', date, amount, description, status: 'completed', type: 'normal', identifier: `${description}|${date}|${amount}`, payload: {} });

function seed() {
  const db = openDb(':memory:');
  const card = ensureAccount(db, { institutionId: 'max', institutionKind: 'card', institutionDisplayName: 'Card', source: 'scraper:max', externalId: 'c', type: 'credit_card' }).accountId;
  ingestBatch(db, { source: 'scraper:max', runId: null, accountId: card, rows: [row('2026-10-05', -24000, 'DEMO PHARM'), row('2026-10-06', -5000, 'DEMO GROCER'), row('2026-10-07', 900000, 'DEMO SALARY')] });
  runEngine(db);
  const c = db.$client;
  const cat = (key: string) => (c.prepare('select id from category where key = ?').get(key) as { id: number }).id;
  const txn = (d: string) => (c.prepare('select id from "transaction" where description_raw = ?').get(d) as { id: number }).id;
  c.prepare('update "transaction" set category_id = ? where id = ?').run(cat('daily.pharm'), txn('DEMO PHARM'));
  return { db, card, cat, txn };
}

describe('split rules', () => {
  it('saves parts that add up exactly, and refuses everything else with a reason', () => {
    const { db, cat, txn } = seed();
    const id = txn('DEMO PHARM');
    const bad = (parts: Array<{ categoryId: number; amount: number }>, t = id) => () => setSplit(db, t, parts);
    expect(bad([{ categoryId: cat('daily.pharm'), amount: -24000 }])).toThrow(SplitError); // one part
    expect(bad([{ categoryId: cat('daily.pharm'), amount: -15000 }, { categoryId: cat('daily.home'), amount: -8000 }])).toThrow(/add up/);
    expect(bad([{ categoryId: cat('daily.pharm'), amount: -15000 }, { categoryId: cat('income.salary'), amount: -9000 }])).toThrow(/income/);
    expect(bad([{ categoryId: cat('daily.pharm'), amount: -15000 }, { categoryId: cat('transfers'), amount: -9000 }])).toThrow(/transfers/);
    expect(bad([{ categoryId: cat('daily.pharm'), amount: -15000 }, { categoryId: cat('daily.pharm'), amount: -9000 }])).toThrow(/once/);
    expect(bad([{ categoryId: cat('daily.pharm'), amount: -25000 }, { categoryId: cat('daily.home'), amount: 1000 }])).toThrow(/spending/);
    expect(bad([{ categoryId: cat('income.salary'), amount: 450000 }, { categoryId: cat('income.other'), amount: 450000 }], txn('DEMO SALARY'))).toThrow(/only spending/);
    setSplit(db, id, [{ categoryId: cat('daily.pharm'), amount: -15000 }, { categoryId: cat('daily.home'), amount: -9000 }]);
    expect(splitOf(db, id)?.map((p) => [p.categoryKey, p.amount])).toEqual([['daily.pharm', -15000], ['daily.home', -9000]]);
    expect(removeSplit(db, id)).toBe(true);
    expect(splitOf(db, id)).toBeNull();
  });

  it('divides an amount in the parts\' proportions, in whole agorot that add up', () => {
    expect(allocateSplit(-24000, [{ categoryId: 1, amount: -15000 }, { categoryId: 2, amount: -9000 }])).toEqual([{ categoryId: 1, amount: -15000 }, { categoryId: 2, amount: -9000 }]);
    // a ₪60 refund on the ₪240 receipt leaves ₪180, divided 5:3
    expect(allocateSplit(-18000, [{ categoryId: 1, amount: -15000 }, { categoryId: 2, amount: -9000 }])).toEqual([{ categoryId: 1, amount: -11250 }, { categoryId: 2, amount: -6750 }]);
    const odd = allocateSplit(-1000, [{ categoryId: 1, amount: -1 }, { categoryId: 2, amount: -1 }, { categoryId: 3, amount: -1 }]);
    expect(odd.reduce((a, p) => a + p.amount, 0)).toBe(-1000);
  });
});

describe('a split moves money between categories and nothing else', () => {
  it('month summary, Categories, the hub and the chat read the parts; buckets and totals do not change', () => {
    const { db, cat, txn } = seed();
    const before = monthSummary(db, '2026-10');
    const dailyBefore = hubOverview(db, '2026-10').breakdown.find((g) => g.group === 'daily')?.spent;
    setSplit(db, txn('DEMO PHARM'), [{ categoryId: cat('daily.pharm'), amount: -15000 }, { categoryId: cat('daily.home'), amount: -9000 }]);
    const after = monthSummary(db, '2026-10');
    const byKey = (s: typeof after) => Object.fromEntries(s.byCategory.map((c) => [c.key, c.sum]));
    expect(byKey(after)['daily.pharm']).toBe(-15000);
    expect(byKey(after)['daily.home']).toBe(-9000);
    // buckets, net and the integrity check are the same as before the split
    expect([after.variable.sum, after.fixed.sum, after.income.sum, after.net, after.integrity.ok]).toEqual([before.variable.sum, before.fixed.sum, before.income.sum, before.net, before.integrity.ok]);

    const home = categoriesOverview(db, '2026-10').groups.flatMap((g) => g.categories).find((c) => c.key === 'daily.home');
    expect(home?.spent).toBe(-9000);
    expect(categoriesOverview(db, '2026-10').groups.flatMap((g) => g.categories).find((c) => c.key === 'daily.pharm')?.spent).toBe(-15000);

    // pharmacy and home are both in "daily": the group's total on the hub does not move
    expect(hubOverview(db, '2026-10').breakdown.find((g) => g.group === 'daily')?.spent).toBe(dailyBefore);

    const spend = CHAT_TOOLS.find((t) => t.name === 'spend_summary')!.run(db, { from: '2026-10', to: '2026-10', groupBy: 'category' }, '2026-11-16') as { groups: Array<{ name: string; total: number }> };
    expect(spend.groups.find((g) => g.name === 'Home')?.total).toBe(90);
    const range = CHAT_TOOLS.find((t) => t.name === 'spend_by_category')!.run(db, { from: '2026-10-01', to: '2026-10-31' }, '2026-11-16') as { categories: Array<{ category: { key: string } | null; spent: number }> };
    expect(range.categories.find((c) => c.category?.key === 'daily.home')?.spent).toBe(90);
  });
});
