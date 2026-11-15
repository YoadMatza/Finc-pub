import { beforeEach, describe, expect, it } from 'vitest';
import { ensureAccount } from '../db/accounts.js';
import { type Db, openDb } from '../db/db.js';
import { merchant, transactions } from '../db/schema.js';
import { ingestBatch } from '../ingest/ingest.js';
import type { NormalizedRow } from '../ingest/types.js';
import { categoryIndex, resolveCategory, seedCategories } from './categories.js';
import { categorize, coverage, heuristicCategory, setCategory } from './categorize.js';
import { assignMerchants } from './merchant.js';
import { applyCounterpartyRules, classifyRemaining, seedDefaultRules } from './rules.js';

let db: Db;
let acc: number;
const row = (date: string, amount: number, description: string, extra: Partial<NormalizedRow> = {}): NormalizedRow => ({ externalAccountId: 'x', date, amount, description, status: 'completed', type: 'normal', identifier: `${description}${date}${amount}`, payload: {}, ...extra });
/** A RiseUp row carrying a label; ingested from source 'riseup' it annotates the scraped twin. */
const ruRow = (date: string, amount: number, description: string, label: string): NormalizedRow => ({
  externalAccountId: 'r',
  date,
  amount,
  description,
  status: 'completed',
  type: 'normal',
  identifier: `ru-${description}${date}${amount}`,
  payload: {},
  annotations: { categoryLabel: label, cashflowDate: date.slice(0, 7), isExcluded: false },
});

function prep(): void {
  assignMerchants(db);
  seedDefaultRules(db);
  applyCounterpartyRules(db);
  classifyRemaining(db);
  seedCategories(db);
}

beforeEach(() => {
  db = openDb(':memory:');
  acc = ensureAccount(db, { institutionId: 'max', institutionKind: 'card', institutionDisplayName: 'Max', source: 'scraper:max', externalId: 'm', type: 'credit_card' }).accountId;
});

describe('taxonomy', () => {
  it('seeds once and resolves names in both languages', () => {
    expect(seedCategories(db)).toBeGreaterThan(30);
    expect(seedCategories(db)).toBe(0);
    expect(resolveCategory(db, 'car.fuel').key).toBe('car.fuel');
    expect(resolveCategory(db, 'fuel').key).toBe('car.fuel');
    expect(resolveCategory(db, 'דלק').key).toBe('car.fuel');
    expect(resolveCategory(db, 'Eating out').key).toBe('lifestyle.eating_out');
    expect(() => resolveCategory(db, 'xyz')).toThrow(/unknown/);
  });
  it('keyword heuristics', () => {
    seedCategories(db);
    const { byKey } = categoryIndex(db);
    expect(heuristicCategory('פז אפליקצית yellow', byKey)?.key).toBe('car.fuel');
    expect(heuristicCategory('wolt', byKey)?.key).toBe('lifestyle.eating_out');
    expect(heuristicCategory('openai chatgpt subscr', byKey)?.key).toBe('fixed.digital');
    expect(heuristicCategory('some unknown shop', byKey)).toBeNull();
  });
});

describe('categorize', () => {
  it('precedence: rule > memory > riseup label > heuristic; user decisions survive recompute', () => {
    ingestBatch(db, {
      source: 'scraper:max',
      runId: null,
      accountId: acc,
      rows: [
        row('2026-10-01', -5000, 'WOLT'),
        row('2026-10-02', -6000, 'WOLT'),
        row('2026-10-03', -7000, 'WOLT'),
        row('2026-10-04', -20000, 'פז אפליקצית-YELLOW'), // no RiseUp label → heuristic fuel
        row('2026-10-05', -3000, 'מסעדה פלונית'),
        row('2026-10-06', -9900, 'חנות עלומה'), // nothing → uncategorised
        row('2026-10-07', -2294, 'HWANGJIN 9605 SEOUL KR', { originalAmount: -890000, originalCurrency: 'KRW' }), // foreign currency → travel
      ],
    });
    ingestBatch(db, {
      source: 'riseup',
      runId: null,
      accountId: acc,
      rows: [
        ruRow('2026-10-01', -5000, 'WOLT', 'אוכל בחוץ'),
        ruRow('2026-10-02', -6000, 'WOLT', 'אוכל בחוץ'),
        ruRow('2026-10-03', -7000, 'WOLT', 'פנאי'), // one odd label: 2 of 3 agree = 66% < 90% → no memory seed
        ruRow('2026-10-05', -3000, 'מסעדה פלונית', 'אוכל בחוץ'), // single labelled row → source riseup
      ],
    });
    prep();
    const r = categorize(db);
    expect(r.uncategorized).toBe(1);
    const { byKey } = categoryIndex(db);
    const get = (desc: string) => db.select().from(transactions).where(eq(transactions.descriptionRaw, desc)).all();
    expect(get('פז אפליקצית-YELLOW')[0]).toMatchObject({ categoryId: byKey.get('car.fuel')!.id, categorySource: 'heuristic' });
    expect(get('מסעדה פלונית')[0]).toMatchObject({ categoryId: byKey.get('lifestyle.eating_out')!.id, categorySource: 'riseup' });
    // WOLT: RiseUp labels disagree (2 vs 1, < 90%) so no memory seed; row-level labels apply, then heuristic for none
    expect(get('WOLT').map((t) => t.categorySource).sort()).toEqual(['riseup', 'riseup', 'riseup']);
    expect(get('חנות עלומה')[0]?.categoryId).toBeNull();
    expect(get('HWANGJIN 9605 SEOUL KR')[0]).toMatchObject({ categoryId: byKey.get('lifestyle.travel')!.id, categorySource: 'heuristic' });

    // user decides the odd WOLT row and applies to the merchant with a rule
    const odd = get('WOLT').find((t) => t.amountIls === -7000)!;
    const res = setCategory(db, { txnId: odd.id, categoryId: byKey.get('lifestyle.eating_out')!.id, applyToMerchant: true, createRule: true });
    expect(res.merchantUpdated).toBe(true);
    expect(res.ruleId).not.toBeNull();
    expect(db.select().from(merchant).where(eq(merchant.key, 'wolt')).get()?.defaultCategoryId).toBe(byKey.get('lifestyle.eating_out')!.id);
    expect(get('WOLT').find((t) => t.id === odd.id)?.categorySource).toBe('user');
    expect(get('WOLT').filter((t) => t.id !== odd.id).every((t) => t.categorySource === 'memory')).toBe(true);
    // recompute keeps the user decision and now applies the rule to the others
    const r2 = categorize(db, { recomputeAutomatic: true });
    expect(get('WOLT').find((t) => t.id === odd.id)?.categorySource).toBe('user');
    expect(get('WOLT').filter((t) => t.id !== odd.id).every((t) => t.categorySource === 'rule')).toBe(true);
    expect(r2.uncategorized).toBe(1);

    const cov = coverage(db, '2026-01-01');
    expect(cov.rows).toBe(7);
    expect(cov.categorized).toBe(6);
    expect(cov.uncategorizedByMerchant[0]?.name).toContain('חנות עלומה');
  });

  it('memory seeds from a consistent RiseUp label and structural kinds get their categories', () => {
    const bank = ensureAccount(db, { institutionId: 'beinleumi', institutionKind: 'bank', institutionDisplayName: 'FIBI', source: 'scraper:beinleumi', externalId: 'b', type: 'checking' }).accountId;
    ingestBatch(db, { source: 'scraper:max', runId: null, accountId: acc, rows: [row('2026-10-01', -5000, 'ALIEXPRESS'), row('2026-10-02', -6000, 'ALIEXPRESS'), row('2026-10-03', -6500, 'ALIEXPRESS')] });
    ingestBatch(db, { source: 'riseup', runId: null, accountId: acc, rows: [ruRow('2026-10-01', -5000, 'ALIEXPRESS', 'קניות'), ruRow('2026-10-02', -6000, 'ALIEXPRESS', 'קניות')] });
    ingestBatch(db, {
      source: 'scraper:beinleumi',
      runId: null,
      accountId: bank,
      rows: [row('2026-10-01', 1200000, 'משכורת'), row('2026-10-10', -45000, 'מסלול פנסיה וגמל'), row('2026-10-11', -170000, 'העברה מהחשבון'), row('2026-10-15', 25000, 'זיכוי כלשהו'), row('2026-10-16', -30000, 'העברה בBit דני'), row('2026-10-17', -11840, 'מבטח א ביטוח בריאות')],
    });
    prep();
    const r = categorize(db);
    expect(r.memorySeeded).toBe(1);
    const { byKey } = categoryIndex(db);
    const byDesc = Object.fromEntries(db.select().from(transactions).all().map((t) => [t.descriptionRaw, t]));
    expect(byDesc['ALIEXPRESS']?.categorySource).toBe('memory');
    expect(byDesc['ALIEXPRESS']?.categoryId).toBe(byKey.get('lifestyle.shopping')!.id);
    expect(byDesc['משכורת']?.categoryId).toBe(byKey.get('income.salary')!.id);
    expect(byDesc['מסלול פנסיה וגמל']?.categoryId).toBe(byKey.get('savings.pension')!.id);
    expect(byDesc['העברה מהחשבון']?.categoryId).toBe(byKey.get('transfers')!.id);
    expect(byDesc['זיכוי כלשהו']?.categoryId).toBe(byKey.get('income.other')!.id);
    expect(byDesc['העברה בBit דני']?.categoryId).toBe(byKey.get('lifestyle.people')!.id); // Bit to a person: spending, own category
    expect(byDesc['מבטח א ביטוח בריאות']?.categoryId).not.toBe(byKey.get('lifestyle.people')!.id); // insurance is not Bit
  });
});

import { eq } from 'drizzle-orm';
