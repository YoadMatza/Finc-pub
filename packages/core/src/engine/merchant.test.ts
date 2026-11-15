import { beforeEach, describe, expect, it } from 'vitest';
import { ensureAccount } from '../db/accounts.js';
import { type Db, openDb } from '../db/db.js';
import { merchant, transactions } from '../db/schema.js';
import { ingestBatch } from '../ingest/ingest.js';
import type { NormalizedRow } from '../ingest/types.js';
import { assignMerchants, mergeCrossSourceMerchants, merchantKey } from './merchant.js';

describe('merchantKey', () => {
  const k = (s: string): string => merchantKey(s).key;
  it('strips legal suffixes, branches, cities and country codes', () => {
    expect(k('טיב טעם רשתות דיילי רעננ')).toBe('טיב טעם רשתות דיילי רעננ'); // truncated city stays: never guess
    expect(k('טיב טעם רשתות חולון')).toBe('טיב טעם רשתות');
    expect(k('מאפה השכונה נתניה בע"מ')).toBe('מאפה השכונה');
    expect(k('סופר אלונית -דור חולון')).toBe('סופר אלונית דור');
    expect(k('יוחננוף תל אביב')).toBe('יוחננוף');
    expect(k('SP* STREAMLY STREAMLY.CO US')).toBe('streamly streamly');
    expect(k('GOOGLE YOUTUBE 650-253-0000 US')).toBe('google youtube');
    expect(k('PAYPAL *SONGSTERR')).toBe('songsterr');
    expect(k('ALIEXPRESS LUXEMBOURG LU')).toBe('aliexpress');
    expect(k('www.aliexpress.com')).toBe('aliexpress');
    expect(k('ALIEXPRESS')).toBe('aliexpress');
    expect(k('PAYBOX TEL AVIV IL')).toBe('paybox');
    expect(k('OPENAI *CHATGPT SUBSCR OPENAI.COM    US')).toBe('openai chatgpt subscr openai');
  });
  it('keeps alphanumeric names and never collapses to a country code', () => {
    expect(k('SHOPXYZ1234 SHANGHAI CN')).toBe('shopxyz1234');
    expect(k('EBAY O 01 10000 1000')).toBe('ebay o');
    expect(k('HWANGJIN      9605 SEOUL         KR')).toBe('hwangjin');
  });
  it('keeps distinct businesses distinct', () => {
    expect(k('אי.אם.פי.אם הרחוב הראשי')).not.toBe(k('אי.אם.פי.אם השדרה'));
    expect(k('קפה לנדוור')).not.toBe(k('קפה גרג'));
  });
  it('never returns an empty key', () => {
    expect(k('123456789')).toBe('123456789');
    expect(k('')).toBe('unknown');
  });
});

describe('mergeCrossSourceMerchants', () => {
  it('unifies a merchant spelled differently by the card and by RiseUp', () => {
    const db = openDb(':memory:');
    const acc = ensureAccount(db, { institutionId: 'isracard', institutionKind: 'card', institutionDisplayName: 'Isracard', source: 'scraper:isracard', externalId: 'i', type: 'credit_card' }).accountId;
    const r = (date: string, description: string, source: string, extra: Partial<NormalizedRow> = {}): NormalizedRow => ({ externalAccountId: 'x', date, amount: -6280, description, status: 'completed', type: 'normal', identifier: `${source}${date}`, payload: {}, ...extra });
    // RiseUp-only history under its own spelling, then two months seen by both sources
    ingestBatch(db, { source: 'riseup', runId: null, accountId: acc, rows: [r('2026-01-20', 'CLAUDE.AI SUBSCRIPTION', 'ru'), r('2026-02-20', 'CLAUDE.AI SUBSCRIPTION', 'ru')] });
    ingestBatch(db, { source: 'scraper:isracard', runId: null, accountId: acc, rows: [r('2026-03-20', 'ANTHROPIC CLAUDE SU', 's'), r('2026-04-20', 'ANTHROPIC CLAUDE SU', 's')] });
    ingestBatch(db, { source: 'riseup', runId: null, accountId: acc, rows: [r('2026-03-20', 'CLAUDE.AI SUBSCRIPTION', 'ru'), r('2026-04-20', 'CLAUDE.AI SUBSCRIPTION', 'ru')] });
    assignMerchants(db);
    expect(db.select().from(merchant).all()).toHaveLength(2);
    const m = mergeCrossSourceMerchants(db);
    expect(m.merged).toBe(1);
    const left = db.select().from(merchant).all();
    expect(left).toHaveLength(1);
    expect(JSON.parse(left[0]!.aliasesJson)).toEqual(expect.arrayContaining(['CLAUDE.AI SUBSCRIPTION', 'ANTHROPIC CLAUDE SU']));
    expect(db.select().from(transactions).all().every((t) => t.merchantId === left[0]!.id)).toBe(true);
    expect(mergeCrossSourceMerchants(db).merged).toBe(0);
  });
});

describe('assignMerchants', () => {
  let db: Db;
  let acc: number;
  const row = (description: string, amount: number, payload: unknown = {}): NormalizedRow => ({ externalAccountId: 'x', date: '2026-10-03', amount, description, status: 'completed', type: 'normal', payload });
  beforeEach(() => {
    db = openDb(':memory:');
    acc = ensureAccount(db, { institutionId: 'max', institutionKind: 'card', institutionDisplayName: 'Max', source: 'scraper:max', externalId: 'x', type: 'credit_card' }).accountId;
  });
  it('creates one merchant per key, records aliases and Max merchant numbers, and is idempotent', () => {
    ingestBatch(db, {
      source: 'scraper:max',
      runId: null,
      accountId: acc,
      rows: [
        row('ALIEXPRESS LUXEMBOURG LU', -1000, { rawTransaction: { merchantData: { merchantNumber: '111' } } }),
        row('www.aliexpress.com', -2000, { rawTransaction: { merchantData: { merchantNumber: '222' } } }),
        row('WOLT', -3000, { rawTransaction: { merchantData: { merchantNumber: '333' } } }),
      ],
    });
    const r1 = assignMerchants(db);
    expect(r1).toEqual({ transactionsAssigned: 3, merchantsCreated: 2 });
    const ms = db.select().from(merchant).all();
    const ali = ms.find((m) => m.key === 'aliexpress')!;
    expect(JSON.parse(ali.aliasesJson).sort()).toEqual(['ALIEXPRESS LUXEMBOURG LU', 'www.aliexpress.com']);
    expect(JSON.parse(ali.externalIdsJson)).toEqual({ max: ['111', '222'] });
    expect(db.select().from(transactions).all().every((t) => t.merchantId !== null)).toBe(true);
    expect(assignMerchants(db)).toEqual({ transactionsAssigned: 0, merchantsCreated: 0 });
  });
});
