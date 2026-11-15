import { describe, expect, it } from 'vitest';
import { ensureAccount } from '../db/accounts.js';
import { openDb } from '../db/db.js';
import { runEngine } from '../engine/run.js';
import { ingestBatch } from '../ingest/ingest.js';
import type { NormalizedRow } from '../ingest/types.js';
import { trendsOverview } from './trends.js';

const row = (date: string, amount: number, description: string): NormalizedRow => ({ externalAccountId: 'x', date, amount, description, status: 'completed', type: 'normal', identifier: `${description}${date}${amount}`, payload: {} });

function seed() {
  const db = openDb(':memory:');
  const acc = ensureAccount(db, { institutionId: 'max', institutionKind: 'card', institutionDisplayName: 'Max', source: 'scraper:max', externalId: 'm', type: 'credit_card' }).accountId;
  const rows: NormalizedRow[] = [];
  // 15 months ending 2026-11: salary, a supermarket habit that grows, a yearly-ish big purchase
  for (let i = 0; i < 15; i++) {
    const m = new Date(Date.UTC(2025, 8 + i, 1)).toISOString().slice(0, 7);
    rows.push(row(`${m}-01`, 1400000, 'SALARY'));
    rows.push(row(`${m}-05`, -(50000 + i * 2000), 'SUPERMARKET'));
    rows.push(row(`${m}-12`, -30000, 'WOLT'));
  }
  ingestBatch(db, { source: 'scraper:max', runId: null, accountId: acc, rows });
  runEngine(db);
  return db;
}

describe('trends', () => {
  it('builds aligned monthly series, group series, a sankey and a year-over-year view', () => {
    const db = seed();
    const t = trendsOverview(db, { months: 12, today: '2026-11-09' });
    expect(t.months).toHaveLength(12);
    expect(t.months[0]?.month).toBe('2025-12');
    expect(t.months[11]).toMatchObject({ month: '2026-11', partial: true });
    const oct = t.months.find((m) => m.month === '2026-10')!;
    expect(oct.income).toBe(1400000);
    expect(oct.out).toBe(oct.fixed + oct.variable + oct.installments + oct.savings);
    expect(oct.net).toBe(oct.income - oct.out);
    // every group series is aligned with the months and sums to its total
    for (const g of t.groups) {
      expect(g.series).toHaveLength(12);
      expect(g.series.reduce((a, b) => a + b, 0)).toBe(g.total);
    }
    expect(t.categories.length).toBeGreaterThan(0);
    // sankey defaults to the last finished month and conserves flow out of the pool
    expect(t.sankey.month).toBe('2026-10');
    const pool = t.sankey.nodes.findIndex((n) => n.kind === 'pool');
    const into = t.sankey.links.filter((l) => l.target === pool).reduce((a, l) => a + l.value, 0);
    const outOf = t.sankey.links.filter((l) => l.source === pool).reduce((a, l) => a + l.value, 0);
    expect(into).toBe(outOf);
    expect(t.sankey.nodes.some((n) => n.kind === 'left')).toBe(true);
    // year over year: 12 rows, a year-earlier point only where data exists
    expect(t.yoy.rows).toHaveLength(12);
    expect(t.yoy.rows.find((r) => r.month === '2026-10')?.then).not.toBeNull(); // 2025-10 seeded
    expect(t.yoy.rows.find((r) => r.month === '2026-08')?.then).toBeNull(); // 2025-08 not seeded
    expect(t.yoy.now.months).toBe(12);
    // the story compares the first and last finished months of the window
    expect(t.story).toMatchObject({ months: 11 });
    expect(t.story!.variableLast).toBeGreaterThan(t.story!.variableFirst);
  });

  it('clamps the window and accepts a sankey month', () => {
    const db = seed();
    const t = trendsOverview(db, { months: 1, sankeyMonth: '2026-09', today: '2026-11-09' });
    expect(t.months).toHaveLength(3);
    expect(t.sankey.month).toBe('2026-09');
  });
});
