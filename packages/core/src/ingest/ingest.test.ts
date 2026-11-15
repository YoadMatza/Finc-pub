import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { ensureAccount } from '../db/accounts.js';
import { type Db, openDb } from '../db/db.js';
import { finishRunOk, startRun } from '../db/runs.js';
import { connection, event, eventTxn, link, rawTransaction, syncRun, transactions } from '../db/schema.js';
import { descriptionSimilarity, ingestBatch, isMirror, mergeCrossSourceDuplicates } from './ingest.js';
import { fromRiseupTransaction, type RiseupTransaction } from './riseup-convert.js';
import { fromScraperAccount, fromScraperTransaction, type ScraperAccount } from './scraper-convert.js';
import type { NormalizedRow } from './types.js';

const FIXTURES = fileURLToPath(new URL('../../../../fixtures/', import.meta.url));
const loadJson = <T>(p: string): T => JSON.parse(readFileSync(path.join(FIXTURES, p), 'utf8')) as T;

let db: Db;
let maxAccount: number;

const row = (over: Partial<NormalizedRow> = {}): NormalizedRow => ({
  externalAccountId: '0000',
  date: '2026-10-03',
  amount: -8990,
  description: 'סופר אלונית -דור חולון',
  status: 'completed',
  type: 'normal',
  payload: { fixture: true },
  ...over,
});

const allTxns = () => db.select().from(transactions).orderBy(transactions.id).all();
const allRaw = () => db.select().from(rawTransaction).all();

beforeEach(() => {
  db = openDb(':memory:');
  maxAccount = ensureAccount(db, {
    institutionId: 'max',
    institutionKind: 'card',
    institutionDisplayName: 'Max',
    scraperId: 'max',
    source: 'scraper:max',
    externalId: '0000',
    type: 'credit_card',
    last4: '0000',
  }).accountId;
});

describe('ingestBatch: dedupe', () => {
  it('ingesting the same batch twice creates nothing new', () => {
    const rows = [row(), row({ amount: -4200, description: 'קפה' })];
    const a = ingestBatch(db, { source: 'scraper:max', runId: 1, accountId: maxAccount, rows });
    const b = ingestBatch(db, { source: 'scraper:max', runId: 2, accountId: maxAccount, rows });
    expect(a).toMatchObject({ seen: 2, new: 2, updated: 0 });
    expect(b).toMatchObject({ seen: 2, new: 0, updated: 0, completed: 0, voided: 0 });
    expect(allTxns()).toHaveLength(2);
    expect(allRaw()).toHaveLength(2);
    expect(allRaw()[0]?.lastSeenRunId).toBe(2);
    expect(allRaw()[0]?.firstSeenRunId).toBe(1);
  });

  it('two identical same-day rows are two transactions, and stay two on re-sync', () => {
    const rows = [row({ identifier: 'A1' }), row({ identifier: 'A2' })];
    ingestBatch(db, { source: 'scraper:max', runId: 1, accountId: maxAccount, rows });
    ingestBatch(db, { source: 'scraper:max', runId: 2, accountId: maxAccount, rows });
    expect(allTxns()).toHaveLength(2);
  });

  it('a row that differs only by amount is a different transaction', () => {
    ingestBatch(db, { source: 'scraper:max', runId: 1, accountId: maxAccount, rows: [row(), row({ amount: -8991 })] });
    expect(allTxns()).toHaveLength(2);
  });

  it('raw payload is kept verbatim and never modified', () => {
    ingestBatch(db, { source: 'scraper:max', runId: 1, accountId: maxAccount, rows: [row({ payload: { a: 1, nested: ['x'] } })] });
    ingestBatch(db, { source: 'scraper:max', runId: 2, accountId: maxAccount, rows: [row({ payload: { a: 2 } })] });
    expect(JSON.parse(allRaw()[0]!.payloadJson)).toEqual({ a: 1, nested: ['x'] });
  });
});

describe('ingestBatch: pending → completed → voided', () => {
  it('pending then completed (different identifier) becomes one completed transaction with two raw rows', () => {
    ingestBatch(db, { source: 'scraper:max', runId: 1, accountId: maxAccount, rows: [row({ status: 'pending' })] });
    const r = ingestBatch(db, {
      source: 'scraper:max',
      runId: 2,
      accountId: maxAccount,
      rows: [row({ status: 'completed', identifier: 'ARN9', chargeDate: '2026-11-02' })],
      batchIsComplete: true,
    });
    expect(r).toMatchObject({ new: 0, completed: 1, voided: 0 });
    const t = allTxns();
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ status: 'completed', identifier: 'ARN9', chargeDate: '2026-11-02' });
    expect(t[0]?.completedAt).not.toBeNull();
    expect(allRaw()).toHaveLength(2);
  });

  it('a pending row that vanishes is voided only after the grace period', () => {
    const t0 = new Date('2026-11-01T06:00:00Z');
    ingestBatch(db, { source: 'scraper:max', runId: 1, accountId: maxAccount, rows: [row({ status: 'pending' }), row({ amount: -1 })], now: t0 });

    // 3 days later: gone from the bank, but still inside the 7-day window
    const r1 = ingestBatch(db, {
      source: 'scraper:max',
      runId: 2,
      accountId: maxAccount,
      rows: [row({ amount: -1 })],
      batchIsComplete: true,
      now: new Date('2026-11-04T06:00:00Z'),
    });
    expect(r1.voided).toBe(0);
    expect(allTxns().find((t) => t.amountIls === -8990)?.status).toBe('pending');

    // 8 days later: voided
    const r2 = ingestBatch(db, {
      source: 'scraper:max',
      runId: 3,
      accountId: maxAccount,
      rows: [row({ amount: -1 })],
      batchIsComplete: true,
      now: new Date('2026-11-09T06:00:00Z'),
    });
    expect(r2.voided).toBe(1);
    const v = allTxns().find((t) => t.amountIls === -8990);
    expect(v?.status).toBe('voided');
    expect(v?.voidedAt).not.toBeNull();
  });

  it('void detection never runs for partial batches (imports, RiseUp)', () => {
    ingestBatch(db, { source: 'scraper:max', runId: 1, accountId: maxAccount, rows: [row({ status: 'pending' })], now: new Date('2026-10-01T00:00:00Z') });
    const r = ingestBatch(db, { source: 'riseup', runId: 2, accountId: maxAccount, rows: [], now: new Date('2026-11-01T00:00:00Z') });
    expect(r.voided).toBe(0);
  });

  it('a voided transaction that later completes is re-opened as completed', () => {
    ingestBatch(db, { source: 'scraper:max', runId: 1, accountId: maxAccount, rows: [row({ status: 'pending' })], now: new Date('2026-10-01T00:00:00Z') });
    ingestBatch(db, { source: 'scraper:max', runId: 2, accountId: maxAccount, rows: [], batchIsComplete: true, now: new Date('2026-10-20T00:00:00Z') });
    expect(allTxns()[0]?.status).toBe('voided');
    ingestBatch(db, { source: 'scraper:max', runId: 3, accountId: maxAccount, rows: [row({ identifier: 'late' })], batchIsComplete: true });
    expect(allTxns()[0]).toMatchObject({ status: 'completed', voidedAt: null });
  });
});

describe('ingestBatch: cross-source precedence', () => {
  const riseupRow = (): NormalizedRow => row({ externalAccountId: 'a1b2c3', identifier: 'ru-1', annotations: { categoryLabel: 'סופר', isExcluded: false } });

  it('RiseUp after scraper: annotates, no new transaction, scraper keeps the core fields', () => {
    ingestBatch(db, { source: 'scraper:max', runId: 1, accountId: maxAccount, rows: [row({ identifier: 'ARN1' })] });
    const r = ingestBatch(db, { source: 'riseup', runId: 2, accountId: maxAccount, rows: [riseupRow()] });
    expect(r).toMatchObject({ new: 0, annotated: 1 });
    const t = allTxns();
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ source: 'scraper:max', identifier: 'ARN1' });
    expect(JSON.parse(t[0]!.annotationsJson!).riseup).toMatchObject({ categoryLabel: 'סופר', isExcluded: false, descriptionRaw: 'סופר אלונית -דור חולון', identifier: 'ru-1' });
    expect(allRaw()).toHaveLength(2);
  });

  it('scraper after RiseUp: scraper takes over the core fields, RiseUp data survives as annotation', () => {
    ingestBatch(db, { source: 'riseup', runId: 1, accountId: maxAccount, rows: [riseupRow()] });
    const r = ingestBatch(db, { source: 'scraper:max', runId: 2, accountId: maxAccount, rows: [row({ identifier: 'ARN1', memo: 'm' })] });
    expect(r).toMatchObject({ new: 0, updated: 1, annotated: 0 });
    const t = allTxns();
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ source: 'scraper:max', identifier: 'ARN1', memo: 'm' });
    const ann = JSON.parse(t[0]!.annotationsJson!);
    expect(ann.riseup).toMatchObject({ categoryLabel: 'סופר', identifier: 'ru-1' });
  });
});

describe('cross-source twins (same day + amount, different spelling)', () => {
  it('RiseUp cheque row with reordered words annotates the scraped row instead of duplicating it', () => {
    ingestBatch(db, { source: 'scraper:beinleumi', runId: 1, accountId: maxAccount, rows: [row({ description: '4417023 משיכת שיק', amount: -520000, identifier: 'ref1' })] });
    const r = ingestBatch(db, { source: 'riseup', runId: 2, accountId: maxAccount, rows: [row({ description: 'משיכת שיק 4417023', amount: -520000, identifier: 'ru-9', annotations: { comment: 'שכר דירה' } })] });
    expect(r).toMatchObject({ new: 0, annotated: 1 });
    const t = allTxns();
    expect(t).toHaveLength(1);
    expect(JSON.parse(t[0]!.annotationsJson!).riseup).toMatchObject({ comment: 'שכר דירה' });
    // re-ingesting the RiseUp row resolves through the recorded fingerprint, still one row
    ingestBatch(db, { source: 'riseup', runId: 3, accountId: maxAccount, rows: [row({ description: 'משיכת שיק 4417023', amount: -520000, identifier: 'ru-9' })] });
    expect(allTxns()).toHaveLength(1);
  });

  it('truncated Isracard spelling matches the full RiseUp name; scraper takes over the row', () => {
    ingestBatch(db, { source: 'riseup', runId: 1, accountId: maxAccount, rows: [row({ description: 'CLAUDE.AI SUBSCRIPTION', amount: -6280, identifier: 'ru-1' })] });
    const r = ingestBatch(db, { source: 'scraper:isracard', runId: 2, accountId: maxAccount, rows: [row({ description: 'CLAUDE AI SUBSCRIPTI', amount: -6280, identifier: 'v1' })] });
    expect(r).toMatchObject({ new: 0, updated: 1 });
    const t = allTxns();
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ source: 'scraper:isracard', identifier: 'v1' });
  });

  it('two identical same-day rows pair with two twins, not one', () => {
    ingestBatch(db, { source: 'scraper:max', runId: 1, accountId: maxAccount, rows: [row({ description: 'באולינג רמת גן', amount: -3900, identifier: 'a' }), row({ description: 'באולינג רמת גן', amount: -3900, identifier: 'b' })] });
    const r = ingestBatch(db, {
      source: 'riseup',
      runId: 2,
      accountId: maxAccount,
      rows: [row({ description: 'באולינג רמת-גן', amount: -3900, identifier: 'r1', annotations: { categoryLabel: 'פנאי' } }), row({ description: 'באולינג רמת-גן', amount: -3900, identifier: 'r2', annotations: { categoryLabel: 'פנאי' } })],
    });
    expect(r).toMatchObject({ new: 0, annotated: 2 });
    const t = allTxns();
    expect(t).toHaveLength(2);
    expect(t.every((x) => x.annotationsJson?.includes('riseup'))).toBe(true);
  });

  it('never merges two rows of the same source, and prefers the similar description among several candidates', () => {
    ingestBatch(db, {
      source: 'scraper:max',
      runId: 1,
      accountId: maxAccount,
      rows: [row({ description: 'קפה א', amount: -2000, identifier: '1' }), row({ description: 'מסעדה ב', amount: -2000, identifier: '2' }), row({ description: 'קפה א', amount: -2000, identifier: '3' })],
    });
    expect(allTxns()).toHaveLength(3); // same source: occurrence index keeps the two identical rows apart, nothing merges
    const r = ingestBatch(db, { source: 'riseup', runId: 3, accountId: maxAccount, rows: [row({ description: 'מסעדה ב בעמ', amount: -2000, identifier: 'r', annotations: { categoryLabel: 'אוכל' } })] });
    expect(r).toMatchObject({ new: 0, annotated: 1 });
    expect(allTxns().find((t) => t.descriptionRaw === 'מסעדה ב')?.annotationsJson).toContain('riseup');
  });

  it('a lone same-day same-amount candidate with an alien name is not merged', () => {
    ingestBatch(db, { source: 'scraper:max', runId: 1, accountId: maxAccount, rows: [row({ description: 'סופר פארם', amount: -1200, identifier: '1' })] });
    const r = ingestBatch(db, { source: 'riseup', runId: 2, accountId: maxAccount, rows: [row({ description: 'WOLT', amount: -1200, identifier: 'r' })] });
    expect(r).toMatchObject({ new: 1, annotated: 0 });
    expect(allTxns()).toHaveLength(2);
  });

  it('mergeCrossSourceDuplicates repairs rows stored before second-level matching existed', () => {
    // simulate the old behaviour: insert both as separate rows by giving them different dates, then fix the date
    ingestBatch(db, { source: 'scraper:beinleumi', runId: 1, accountId: maxAccount, rows: [row({ description: '12345 משיכת שיק', amount: -625000, identifier: 'ref' })] });
    ingestBatch(db, { source: 'riseup', runId: 2, accountId: maxAccount, rows: [row({ date: '2026-10-04', description: 'משיכת שיק 12345', amount: -625000, identifier: 'ru', annotations: { categoryLabel: 'דיור' } })] });
    expect(allTxns()).toHaveLength(2);
    db.update(transactions).set({ txnDate: '2026-10-03' }).where(eq(transactions.source, 'riseup')).run();
    const res = mergeCrossSourceDuplicates(db);
    expect(res).toMatchObject({ merged: 1 });
    const t = allTxns();
    expect(t).toHaveLength(1);
    expect(t[0]?.source).toBe('scraper:beinleumi');
    expect(JSON.parse(t[0]!.annotationsJson!).riseup).toMatchObject({ categoryLabel: 'דיור', descriptionRaw: 'משיכת שיק 12345' });
    expect(mergeCrossSourceDuplicates(db).merged).toBe(0);
  });

  it('a Max row that settles under a mirrored name completes the pending row and keeps the readable name', () => {
    ingestBatch(db, { source: 'scraper:max', runId: 1, accountId: maxAccount, rows: [row({ description: 'ESCAPE ROOM', amount: -80500, status: 'pending', date: '2026-11-07' })] });
    const r = ingestBatch(db, { source: 'scraper:max', runId: 2, accountId: maxAccount, rows: [row({ description: 'MOOR EPACSE', amount: -80500, date: '2026-11-07', identifier: '7458', chargeDate: '2026-12-02' })], batchIsComplete: true });
    expect(r).toMatchObject({ new: 0, completed: 1 });
    const t = allTxns();
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ status: 'completed', identifier: '7458', chargeDate: '2026-12-02', descriptionRaw: 'ESCAPE ROOM' });
  });

  it('a settled row with an unrelated name does not swallow a pending one of the same amount', () => {
    ingestBatch(db, { source: 'scraper:max', runId: 1, accountId: maxAccount, rows: [row({ description: 'קפה א', amount: -2000, status: 'pending' })] });
    const r = ingestBatch(db, { source: 'scraper:max', runId: 2, accountId: maxAccount, rows: [row({ description: 'מסעדה ב', amount: -2000, identifier: 'x' })] });
    expect(r).toMatchObject({ new: 1 });
    expect(allTxns()).toHaveLength(2);
  });

  it('mergeCrossSourceDuplicates folds a settled mirrored copy into the earlier readable row, carrying what it knew', () => {
    ingestBatch(db, { source: 'scraper:max', runId: 1, accountId: maxAccount, rows: [row({ description: 'escape room', amount: -80500, date: '2026-11-07', identifier: 'ru-uuid', chargeDate: '2026-12-07' })] });
    db.update(transactions).set({ categoryId: 15, categorySource: 'riseup' }).run();
    // the settled copy stored separately (before mirrored names were understood)
    ingestBatch(db, { source: 'scraper:max', runId: 2, accountId: maxAccount, rows: [row({ description: 'MOOR EPACSE', amount: -80500, date: '2026-11-07', identifier: '7458', chargeDate: '2026-12-02' })] });
    const before = allTxns();
    expect(before).toHaveLength(1); // the live matcher already folds it; force the old state to test the repair
    db.insert(transactions)
      .values({ ...before[0]!, id: undefined as unknown as number, fingerprint: 'other', descriptionRaw: 'MOOR EPACSE', descriptionNorm: 'moor epacse', identifier: '7458', chargeDate: '2026-12-02', categoryId: null, categorySource: null, annotationsJson: null })
      .run();
    db.update(transactions).set({ identifier: 'ru-uuid', chargeDate: '2026-12-07' }).where(eq(transactions.id, before[0]!.id)).run();
    expect(allTxns()).toHaveLength(2);
    const res = mergeCrossSourceDuplicates(db);
    expect(res.merged).toBe(1);
    const t = allTxns();
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ descriptionRaw: 'escape room', identifier: '7458', chargeDate: '2026-12-02', categoryId: 15, status: 'completed' });
    expect(mergeCrossSourceDuplicates(db).merged).toBe(0);
  });

  it('descriptionSimilarity', () => {
    expect(isMirror('escape room', 'moor epacse')).toBe(true);
    expect(isMirror('abba', 'abba')).toBe(false);
    expect(descriptionSimilarity('escape room', 'MOOR EPACSE'.toLowerCase())).toBe(1);
    expect(descriptionSimilarity('claude ai subscripti', 'claude.ai subscription')).toBe(1);
    expect(descriptionSimilarity('משיכת שיק 12345', '12345 משיכת שיק')).toBeGreaterThan(0.8);
    expect(descriptionSimilarity('ebay o 06 12345 3992', 'ebay o06-12345-67890')).toBeGreaterThan(0.5);
    expect(descriptionSimilarity('קפה א', 'מסעדה ב')).toBeLessThan(0.15);
    expect(descriptionSimilarity('סופר פארם', 'wolt')).toBe(0);
  });
});

describe('a real charge is never merged away (security research P0-01)', () => {
  const sync = (runId: number, rows: NormalizedRow[]) => ingestBatch(db, { source: 'scraper:max', runId, accountId: maxAccount, rows, batchIsComplete: true });
  const shapes = () => allTxns().map((t) => ({ d: t.descriptionRaw, s: t.status }));

  it('a pending row that is still in the sync cannot absorb a second, completed charge of the same amount', () => {
    sync(1, [row({ description: 'ARCAFFE', amount: -2000, status: 'pending' })]);
    const r = sync(2, [row({ description: 'ARCAFFE', amount: -2000, status: 'pending' }), row({ description: 'ARCAFFE TLV', amount: -2000, identifier: 'x2' })]);
    expect(r).toMatchObject({ new: 1, completed: 0 });
    expect(shapes()).toEqual([{ d: 'ARCAFFE', s: 'pending' }, { d: 'ARCAFFE TLV', s: 'completed' }]);
    // and it stays two rows on the next sync (no fingerprint alias was recorded)
    sync(3, [row({ description: 'ARCAFFE', amount: -2000, status: 'pending' }), row({ description: 'ARCAFFE TLV', amount: -2000, identifier: 'x2' })]);
    expect(allTxns()).toHaveLength(2);
  });

  it('the same holds when the bank lists the completed charge before the pending one', () => {
    sync(1, [row({ description: 'ARCAFFE', amount: -2000, status: 'pending' })]);
    const r = sync(2, [row({ description: 'ARCAFFE TLV', amount: -2000, identifier: 'x2' }), row({ description: 'ARCAFFE', amount: -2000, status: 'pending' })]);
    expect(r).toMatchObject({ new: 1, completed: 0 });
    expect(allTxns()).toHaveLength(2);
  });

  it('a look-alike charge cannot take over a pending purchase and replace its name', () => {
    sync(1, [row({ description: 'AMAZON', amount: -150000, status: 'pending' })]);
    sync(2, [row({ description: 'AMAZON', amount: -150000, status: 'pending' }), row({ description: 'AMAZON MKTPL FRAUD', amount: -150000, identifier: 'f1' })]);
    expect(shapes()).toEqual([{ d: 'AMAZON', s: 'pending' }, { d: 'AMAZON MKTPL FRAUD', s: 'completed' }]);
  });

  it('two identically named charges stay two when one of them is still pending', () => {
    sync(1, [row({ description: 'ARCAFFE', amount: -2000, status: 'pending' })]);
    sync(2, [row({ description: 'ARCAFFE', amount: -2000, status: 'pending' }), row({ description: 'ARCAFFE', amount: -2000, identifier: 'x2' })]);
    expect(allTxns()).toHaveLength(2);
  });

  it('a lone cross-source candidate with a weakly similar name is a different charge (P2-04)', () => {
    expect(descriptionSimilarity('aroma', 'arcaffe')).toBeGreaterThanOrEqual(0.15);
    expect(descriptionSimilarity('aroma', 'arcaffe')).toBeLessThan(0.3);
    sync(1, [row({ description: 'ARCAFFE', amount: -2000, identifier: 's1' })]);
    const r = ingestBatch(db, { source: 'riseup', runId: 2, accountId: maxAccount, rows: [row({ description: 'AROMA', amount: -2000, identifier: 'r1' })] });
    expect(r).toMatchObject({ new: 1, annotated: 0 });
    expect(allTxns()).toHaveLength(2);
  });

  it('still: two pending rows that both settle under new names in one sync become two completed rows', () => {
    const first = sync(1, [row({ description: 'ARCAFFE', amount: -2000, status: 'pending' }), row({ description: 'ARCAFFE', amount: -2000, status: 'pending' })]);
    expect(first).toMatchObject({ new: 2 }); // two identical pending charges in one sync are two rows
    expect(allTxns()).toHaveLength(2);
    const r = sync(2, [row({ description: 'ARCAFFE TLV', amount: -2000, identifier: 'a' }), row({ description: 'ARCAFFE TLV', amount: -2000, identifier: 'b' })]);
    expect(r).toMatchObject({ new: 0, completed: 2 });
    expect(shapes()).toEqual([{ d: 'ARCAFFE TLV', s: 'completed' }, { d: 'ARCAFFE TLV', s: 'completed' }]);
  });
});

describe('scraper converter: real-world quirks', () => {
  const base = { type: 'normal' as const, date: '2026-11-06T22:00:00.000Z', processedDate: '2026-11-06T22:00:00.000Z', description: 'x', status: 'pending' as const };
  it('Max pending rows: chargedAmount 0, amount lives in originalAmount (ILS)', () => {
    const r = fromScraperTransaction('0000', { ...base, chargedAmount: 0, originalAmount: -36, originalCurrency: 'ILS' });
    expect(r).toMatchObject({ amount: -3600, originalAmount: -3600, status: 'pending' });
  });
  it('FX pending rows stay at 0 until completed', () => {
    const r = fromScraperTransaction('0000', { ...base, chargedAmount: 0, originalAmount: -20, originalCurrency: 'USD' });
    expect(r).toMatchObject({ amount: 0, originalAmount: -2000, originalCurrency: 'USD' });
  });
  it('Max credits: originalAmount sign is aligned with the (positive) charged amount', () => {
    const r = fromScraperTransaction('0000', { ...base, status: 'completed', chargedAmount: 575, originalAmount: -575, originalCurrency: 'ILS', memo: 'ביטול עסקה' });
    expect(r).toMatchObject({ amount: 57500, originalAmount: 57500, memo: 'ביטול עסקה' });
  });
});

describe('converters on fixtures', () => {
  it('maps the Max scraper sample (installments, FX, refund, pending, duplicates)', () => {
    const fx = loadJson<{ accounts: ScraperAccount[] }>('scraper/max.sample.json');
    const rows = fromScraperAccount(fx.accounts[0]!);
    expect(rows).toHaveLength(6);
    expect(rows[0]).toMatchObject({ date: '2026-10-03', chargeDate: '2026-11-02', amount: -8990, identifier: 'ARN1001', status: 'completed' });
    expect(rows[2]).toMatchObject({ type: 'installments', installmentN: 3, installmentTotal: 12, amount: -30000, originalAmount: -360000 });
    expect(rows[3]).toMatchObject({ originalAmount: -4900, originalCurrency: 'USD', amount: -19260 });
    expect(rows[4]).toMatchObject({ amount: 8120, memo: 'זיכוי' });
    expect(rows[5]).toMatchObject({ status: 'pending', date: '2026-11-07' });
    expect(rows[5]?.identifier).toBeUndefined();

    const stats = ingestBatch(db, { source: 'scraper:max', runId: 1, accountId: maxAccount, rows, batchIsComplete: true });
    expect(stats).toMatchObject({ seen: 6, new: 6 });
    const dup = allTxns().filter((t) => t.amountIls === -8990);
    expect(dup).toHaveLength(2);
  });

  it('maps the RiseUp sample and links it onto scraped rows by fingerprint', () => {
    const fx = loadJson<{ accounts: ScraperAccount[] }>('scraper/max.sample.json');
    ingestBatch(db, { source: 'scraper:max', runId: 1, accountId: maxAccount, rows: fromScraperAccount(fx.accounts[0]!) });

    const ru = loadJson<{ transactions: RiseupTransaction[] }>('riseup/transactions.sample.json');
    const maxRows = ru.transactions.filter((t) => t.accountNumberHash === 'a1b2c3').map(fromRiseupTransaction);
    expect(maxRows[0]).toMatchObject({ amount: -19260, date: '2026-10-20', chargeDate: '2026-11-02', status: 'completed', identifier: 'ru-0001' });
    expect(maxRows[1]).toMatchObject({ amount: 8120 });
    expect(maxRows[2]).toMatchObject({ type: 'installments', installmentN: 3, installmentTotal: 12, amount: -30000 });

    // Scraper dates are local Israel dates; RiseUp's are the same calendar day → fingerprints meet,
    // except where the fixture deliberately differs (installment on the 15th vs 14th+1 → 15th: matches).
    const stats = ingestBatch(db, { source: 'riseup', runId: 2, accountId: maxAccount, rows: maxRows });
    expect(stats).toMatchObject({ seen: 3, annotated: 3, new: 0 });
    const bh = allTxns().find((t) => t.amountIls === -19260)!;
    expect(JSON.parse(bh.annotationsJson!).riseup).toMatchObject({ categoryLabel: 'מנויים', actualType: 'variable' });
  });
});

describe('sync_run bookkeeping', () => {
  it('records a run with stats and updates connection health', () => {
    const runId = startRun(db, { institutionId: 'max', source: 'scraper:max', trigger: 'manual' });
    const stats = ingestBatch(db, { source: 'scraper:max', runId, accountId: maxAccount, rows: [row()] });
    finishRunOk(db, runId, stats, { accounts: 1 });
    const run = db.select().from(syncRun).where(eq(syncRun.id, runId)).get();
    expect(run).toMatchObject({ status: 'ok', rowsSeen: 1, rowsNew: 1 });
    expect(run?.endedAt).not.toBeNull();
    const conn = db.select().from(connection).where(eq(connection.institutionId, 'max')).get();
    expect(conn).toMatchObject({ consecutiveFailures: 0, lastRunId: runId });
    expect(conn?.lastOkAt).not.toBeNull();
  });
});

describe('a first sync that fails is still recorded on the connection (P1-04)', () => {
  it('startRun creates the missing connection row, so finishRunError sets last_error', async () => {
    const { finishRunError } = await import('../db/runs.js');
    const fresh = openDb(':memory:');
    const runId = startRun(fresh, { institutionId: 'isracard', source: 'scraper:isracard', trigger: 'scheduled' });
    finishRunError(fresh, runId, 'CRASH', 'browser did not start');
    const c = fresh.select().from(connection).where(eq(connection.institutionId, 'isracard')).get();
    expect(c).toMatchObject({ lastError: 'CRASH: browser did not start', consecutiveFailures: 1 });
  });
});

describe('a bank pending row that takes over a RiseUp row follows the bank status (double-count fix)', () => {
  const day = '2026-11-08';
  const amount = -5304;
  const riseup = (runId: number, now: string) =>
    ingestBatch(db, {
      source: 'riseup',
      runId,
      accountId: maxAccount,
      rows: [row({ externalAccountId: 'a1b2c3', date: day, amount, description: 'MERCHANT', identifier: 'ru-77', payload: { transactionId: 'ru-77' }, annotations: { categoryLabel: 'Shopping' } })],
      now: new Date(now),
    });
  const maxSync = (runId: number, rows: NormalizedRow[], now: string) => ingestBatch(db, { source: 'scraper:max', runId, accountId: maxAccount, rows, batchIsComplete: true, now: new Date(now) });
  const pendingMax = () => row({ date: day, amount, description: 'MERCHANT', status: 'pending', originalAmount: amount, payload: { status: 'pending', chargedAmount: 0 } });
  const settledMax = () => row({ date: day, amount, description: 'MERCHANT-BRANCH', identifier: 'ARN5304', chargeDate: '2026-12-02', payload: { status: 'completed', id: 'settled' } });
  const rawIdOf = (marker: string) => allRaw().find((r) => JSON.parse(r.payloadJson)?.status === marker || JSON.parse(r.payloadJson)?.id === marker)!.id;

  it('RiseUp completed → Max pending → Max settled under a longer name: one completed transaction with the settled raw', () => {
    riseup(1, '2026-11-08T10:00:00Z');
    expect(allTxns()).toMatchObject([{ source: 'riseup', status: 'completed' }]);

    const r2 = maxSync(2, [pendingMax()], '2026-11-08T20:00:00Z');
    expect(r2).toMatchObject({ new: 0 });
    let t = allTxns();
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ source: 'scraper:max', status: 'pending', completedAt: null, rawId: rawIdOf('pending') });

    const r3 = maxSync(3, [settledMax()], '2026-11-09T20:00:00Z');
    expect(r3).toMatchObject({ new: 0, completed: 1, voided: 0 });
    t = allTxns();
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ source: 'scraper:max', status: 'completed', identifier: 'ARN5304', chargeDate: '2026-12-02', rawId: rawIdOf('settled') });
    expect(t[0]?.completedAt).not.toBeNull();
    expect(JSON.parse(t[0]!.annotationsJson!).riseup).toMatchObject({ categoryLabel: 'Shopping', identifier: 'ru-77' });
  });

  it('a RiseUp re-import does not mark the bank-pending row completed again (that would bring the double count back)', () => {
    riseup(1, '2026-11-08T10:00:00Z');
    maxSync(2, [pendingMax()], '2026-11-08T20:00:00Z');
    const r = riseup(3, '2026-11-09T06:00:00Z');
    expect(r).toMatchObject({ new: 0, completed: 0 });
    expect(allTxns()).toMatchObject([{ source: 'scraper:max', status: 'pending', completedAt: null }]);
    maxSync(4, [settledMax()], '2026-11-09T20:00:00Z');
    expect(allTxns()).toHaveLength(1);
    expect(allTxns()[0]).toMatchObject({ status: 'completed', identifier: 'ARN5304' });
  });

  it('a row that became pending this way and then vanishes is voided only after the usual grace period', () => {
    riseup(1, '2026-11-01T10:00:00Z');
    maxSync(2, [pendingMax()], '2026-11-01T20:00:00Z');
    expect(maxSync(3, [], '2026-11-05T20:00:00Z').voided).toBe(0);
    expect(allTxns()[0]?.status).toBe('pending');
    expect(maxSync(4, [], '2026-11-09T20:00:00Z').voided).toBe(1);
    expect(allTxns()[0]).toMatchObject({ status: 'voided' });
  });

  it('a completed bank row taking over a RiseUp row stays completed', () => {
    riseup(1, '2026-11-08T10:00:00Z');
    maxSync(2, [row({ date: day, amount, description: 'MERCHANT', identifier: 'ARN1', payload: { status: 'completed' } })], '2026-11-09T20:00:00Z');
    expect(allTxns()).toMatchObject([{ source: 'scraper:max', status: 'completed', identifier: 'ARN1' }]);
  });

  describe('repair: mergeCrossSourceDuplicates folds the settled copy into a row stuck as completed', () => {
    const other = () => row({ date: day, amount, description: 'OTHERSHOP', identifier: 'ARN9', payload: { status: 'completed' } });
    const cafe = () => row({ date: day, amount: -999, description: 'CAFE', identifier: 'c1', payload: { status: 'completed' } });
    const cafeTlv = () => row({ date: day, amount: -999, description: 'CAFE TLV', identifier: 'c2', payload: { status: 'completed' } });
    const at = (h: number) => new Date(Date.UTC(2026, 10, 8, 0) + h * 3_600_000).toISOString();
    const sync = (runId: number | null, h: number, rows: NormalizedRow[]) => ingestBatch(db, { source: 'scraper:max', runId, accountId: maxAccount, rows, batchIsComplete: true, now: new Date(at(h)) });
    const byName = (name: string) => allTxns().find((t) => t.descriptionRaw === name)!;

    /**
     * Reproduce the pre-fix state as it happened: RiseUp row, Max pending seen in runs 18..26 (the
     * takeover kept RiseUp's 'completed'), the settled copy first seen in run 26 and inserted beside it,
     * the pending gone from run 27 on.
     */
    const seedStuck = (opts: { runIds?: boolean; pendingStillListed?: boolean } = {}) => {
      const id = (n: number) => (opts.runIds === false ? null : n);
      riseup(17, at(1));
      for (let run = 18; run <= 25; run++) sync(id(run), run - 16, [pendingMax()]);
      const stuck = allTxns()[0]!;
      db.update(transactions).set({ status: 'completed', completedAt: at(1), categoryId: 7, categorySource: 'user', note: 'gift' }).where(eq(transactions.id, stuck.id)).run();
      sync(id(26), 10, [pendingMax(), settledMax(), other(), cafe()]);
      sync(id(27), 11, [...(opts.pendingStillListed ? [pendingMax()] : []), settledMax(), other(), cafe(), cafeTlv()]);
      return stuck.id;
    };

    it('the seeded stuck state counts the charge twice (sanity)', () => {
      seedStuck();
      expect(allTxns().filter((t) => t.amountIls === amount).map((t) => [t.descriptionRaw, t.status])).toEqual([
        ['MERCHANT', 'completed'],
        ['MERCHANT-BRANCH', 'completed'],
        ['OTHERSHOP', 'completed'],
      ]);
      const pendingRaw = allRaw().find((r) => r.id === rawIdOf('pending'))!;
      const settledRaw = allRaw().find((r) => r.id === rawIdOf('settled'))!;
      expect([pendingRaw.firstSeenRunId, pendingRaw.lastSeenRunId, settledRaw.firstSeenRunId, settledRaw.lastSeenRunId]).toEqual([18, 26, 26, 27]);
    });

    it('merges exactly the stuck pair, keeps the earlier id and its user data, takes the settled facts; idempotent', () => {
      const stuckId = seedStuck();
      const settledTxn = byName('MERCHANT-BRANCH');
      expect(settledTxn.rawId).toBe(rawIdOf('settled'));
      const res = mergeCrossSourceDuplicates(db);
      expect(res.merged).toBe(1);
      expect(res.needsReview).toEqual([]);
      expect(res.details).toEqual([{ from: settledTxn.id, into: stuckId, date: day, amount, kind: 'settled-pending' }]);
      const left = allTxns().filter((t) => t.amountIls === amount);
      expect(left.map((t) => t.descriptionRaw)).toEqual(['MERCHANT', 'OTHERSHOP']);
      expect(left[0]).toMatchObject({ id: stuckId, status: 'completed', rawId: settledTxn.rawId, identifier: 'ARN5304', chargeDate: '2026-12-02', categoryId: 7, categorySource: 'user', note: 'gift' });
      expect(JSON.parse(left[0]!.annotationsJson!).riseup).toMatchObject({ categoryLabel: 'Shopping' });
      expect(allTxns().filter((t) => t.amountIls === -999)).toHaveLength(2); // CAFE / CAFE TLV: raw completed, untouched
      expect(mergeCrossSourceDuplicates(db).merged).toBe(0);
      // the settled row's fingerprint now resolves to the survivor: the next sync adds nothing
      expect(sync(28, 12, [settledMax(), other(), cafe(), cafeTlv()])).toMatchObject({ new: 0 });
      expect(allTxns().filter((t) => t.amountIls === amount)).toHaveLength(2);
    });

    it('falls back to timestamps when run ids are null', () => {
      seedStuck({ runIds: false });
      expect(mergeCrossSourceDuplicates(db).merged).toBe(1);
      expect(allTxns().filter((t) => t.amountIls === amount)).toHaveLength(2);
    });

    it('guard: no lower-source annotation (no takeover happened) → not merged', () => {
      const stuckId = seedStuck();
      db.update(transactions).set({ annotationsJson: null }).where(eq(transactions.id, stuckId)).run();
      expect(mergeCrossSourceDuplicates(db).merged).toBe(0);
      expect(allTxns().filter((t) => t.amountIls === amount)).toHaveLength(3);
    });

    it('guard: the stuck row\'s raw is still seen after the copy appeared → not merged', () => {
      seedStuck({ pendingStillListed: true });
      expect(mergeCrossSourceDuplicates(db).merged).toBe(0);
      expect(allTxns().filter((t) => t.amountIls === amount)).toHaveLength(3);
    });

    it('reviewer repro: a row that settled under the same source hash (raw still says pending) never absorbs a second similar charge', () => {
      const cafe15 = (description: string, status: 'pending' | 'completed') => row({ date: day, amount: -1500, description, status, payload: { status } });
      sync(1, 1, [cafe15('CAFE', 'pending')]);
      sync(2, 2, [cafe15('CAFE', 'completed')]);
      sync(3, 3, [cafe15('CAFE', 'completed'), cafe15('CAFE TLV', 'completed')]);
      expect(allTxns().map((t) => [t.descriptionRaw, t.status])).toEqual([['CAFE', 'completed'], ['CAFE TLV', 'completed']]);
      expect(JSON.parse(allRaw()[0]!.payloadJson).status).toBe('pending'); // the raw is never rewritten
      expect(mergeCrossSourceDuplicates(db).merged).toBe(0);
      sync(4, 4, [cafe15('CAFE', 'completed'), cafe15('CAFE TLV', 'completed')]);
      expect(mergeCrossSourceDuplicates(db).merged).toBe(0);
      expect(allTxns()).toHaveLength(2);
    });

    it('same, when the row came from RiseUp and a Max pending took it over (fixed path)', () => {
      const cafe15 = (description: string, status: 'pending' | 'completed') => row({ date: day, amount: -1500, description, status, payload: { status } });
      ingestBatch(db, { source: 'riseup', runId: 1, accountId: maxAccount, rows: [row({ externalAccountId: 'a1b2c3', date: day, amount: -1500, description: 'CAFE', identifier: 'ru-c', annotations: { categoryLabel: 'Food' } })], now: new Date(at(1)) });
      sync(2, 2, [cafe15('CAFE', 'pending')]);
      sync(3, 3, [cafe15('CAFE', 'completed')]);
      sync(4, 4, [cafe15('CAFE', 'completed'), cafe15('CAFE TLV', 'completed')]);
      expect(allTxns().map((t) => [t.descriptionRaw, t.status])).toEqual([['CAFE', 'completed'], ['CAFE TLV', 'completed']]);
      expect(mergeCrossSourceDuplicates(db).merged).toBe(0);
      sync(5, 5, [cafe15('CAFE', 'completed'), cafe15('CAFE TLV', 'completed')]);
      expect(mergeCrossSourceDuplicates(db).merged).toBe(0);
      expect(allTxns()).toHaveLength(2);
    });

    it('carries a note the survivor lacks', () => {
      const stuckId = seedStuck();
      db.update(transactions).set({ note: null }).where(eq(transactions.id, stuckId)).run();
      db.update(transactions).set({ note: 'split with Dana' }).where(eq(transactions.id, byName('MERCHANT-BRANCH').id)).run();
      expect(mergeCrossSourceDuplicates(db).merged).toBe(1);
      expect(allTxns().find((t) => t.id === stuckId)).toMatchObject({ note: 'split with Dana', status: 'completed' });
    });

    it('needs a manual look (no merge) when the settled copy has a different note', () => {
      const stuckId = seedStuck();
      const copy = byName('MERCHANT-BRANCH');
      db.update(transactions).set({ note: 'other note' }).where(eq(transactions.id, copy.id)).run();
      const res = mergeCrossSourceDuplicates(db);
      expect(res.merged).toBe(0);
      expect(res.needsReview).toEqual([{ txnId: stuckId, settledId: copy.id, date: day, amount, reason: expect.stringContaining('note') }]);
      expect(allTxns().filter((t) => t.amountIls === amount)).toHaveLength(3);
    });

    it('needs a manual look when the settled copy has a different user category', () => {
      seedStuck();
      db.update(transactions).set({ categoryId: 9, categorySource: 'user' }).where(eq(transactions.id, byName('MERCHANT-BRANCH').id)).run();
      const res = mergeCrossSourceDuplicates(db);
      expect(res.merged).toBe(0);
      expect(res.needsReview[0]?.reason).toContain('category');
    });

    it('needs a manual look when the settled copy has a confirmed link', () => {
      seedStuck();
      db.insert(link)
        .values({ type: 'refund', fromTxnId: byName('MERCHANT-BRANCH').id, toTxnId: byName('OTHERSHOP').id, amount: 100, confidence: 0.9, zone: 'auto', source: 'auto', explanationJson: '[]', decision: 'confirmed', createdAt: at(12) })
        .run();
      const res = mergeCrossSourceDuplicates(db);
      expect(res.merged).toBe(0);
      expect(res.needsReview[0]?.reason).toContain('link');
    });

    it('needs a manual look when the settled copy belongs to an event', () => {
      seedStuck();
      const ev = db.insert(event).values({ name: 'Trip', createdAt: at(12), updatedAt: at(12) }).run();
      db.insert(eventTxn).values({ eventId: Number(ev.lastInsertRowid), txnId: byName('MERCHANT-BRANCH').id, addedAt: at(12) }).run();
      const res = mergeCrossSourceDuplicates(db);
      expect(res.merged).toBe(0);
      expect(res.needsReview[0]?.reason).toContain('event');
    });
  });
});
