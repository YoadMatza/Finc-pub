import { beforeEach, describe, expect, it } from 'vitest';
import { ensureAccount } from '../db/accounts.js';
import { type Db, openDb } from '../db/db.js';
import { link, transactions } from '../db/schema.js';
import { ingestBatch } from '../ingest/ingest.js';
import type { NormalizedRow } from '../ingest/types.js';
import { assignMerchants } from './merchant.js';
import { decideLink } from '../hub/actions.js';
import { linkRefunds } from './refunds.js';
import { applyCounterpartyRules, classifyRemaining, seedDefaultRules } from './rules.js';
import { linkCardSettlements } from './settlement.js';

let db: Db;
let bank: number;
let max: number;
const row = (over: Partial<NormalizedRow> & Pick<NormalizedRow, 'date' | 'amount' | 'description'>): NormalizedRow => ({ externalAccountId: 'x', status: 'completed', type: 'normal', payload: {}, ...over });
const maxRow = (date: string, charge: string, amount: number, description: string, plan = 'רגילה', extra: Partial<NormalizedRow> = {}): NormalizedRow =>
  row({ date, chargeDate: charge, amount, description, identifier: `${description}-${date}-${amount}`, payload: { rawTransaction: { planName: plan, merchantData: { merchantNumber: description.length } } }, ...extra });

beforeEach(() => {
  db = openDb(':memory:');
  bank = ensureAccount(db, { institutionId: 'beinleumi', institutionKind: 'bank', institutionDisplayName: 'FIBI', source: 'scraper:beinleumi', externalId: 'b', type: 'checking' }).accountId;
  max = ensureAccount(db, { institutionId: 'max', institutionKind: 'card', institutionDisplayName: 'Max', source: 'scraper:max', externalId: 'm', type: 'credit_card' }).accountId;
});

describe('card settlement links', () => {
  it('links the monthly cycle and the immediate-charge bundles; the bank debits become excluded settlements', () => {
    ingestBatch(db, {
      source: 'scraper:max',
      runId: null,
      accountId: max,
      rows: [
        maxRow('2026-10-03', '2026-11-02', -8990, 'סופר'),
        maxRow('2026-10-20', '2026-11-02', -19260, 'STREAMLY'),
        maxRow('2026-10-03', '2026-10-06', -15000, 'קפה', 'חיוב עסקות מיידי'),
        maxRow('2026-10-04', '2026-10-06', -21840, 'מסעדה', 'חיוב עסקות מיידי'),
        maxRow('2026-10-05', '2026-10-08', -5000, 'ספר', 'חיוב עסקות מיידי'),
      ],
    });
    ingestBatch(db, {
      source: 'scraper:beinleumi',
      runId: null,
      accountId: bank,
      rows: [
        row({ date: '2026-11-02', amount: -28250, description: 'מקס איט פיננסים', identifier: '1' }),
        row({ date: '2026-10-06', amount: -36840, description: 'מקס איט פיננסים', identifier: '2' }),
        row({ date: '2026-10-08', amount: -5100, description: 'מקס איט פיננסים', identifier: '3' }), // ₪1 gap → tolerance
        row({ date: '2026-10-15', amount: -99900, description: 'מקס איט פיננסים', identifier: '4' }), // nothing charged that day
        row({ date: '2026-11-05', amount: 1250000, description: 'משכורת', identifier: '5' }),
      ],
    });
    const r = linkCardSettlements(db);
    expect(r).toMatchObject({ bankDebitsSeen: 4, matchedExact: 3, matchedWithGap: 0, linksCreated: 5 });
    expect(r.unmatched).toHaveLength(1);
    expect(r.unmatched[0]).toMatchObject({ amount: -99900 });
    const bankRows = db.select().from(transactions).where(eq(transactions.accountId, bank)).all();
    expect(bankRows.filter((b) => b.kind === 'settlement' && b.excluded)).toHaveLength(3);
    expect(bankRows.find((b) => b.amountIls === -99900)?.kind).toBeNull();
    const links = db.select().from(link).all();
    expect(links.every((l) => l.type === 'card_settlement' && l.source === 'auto')).toBe(true);
    expect(links.filter((l) => l.confidence === 1)).toHaveLength(4);
    expect(links.filter((l) => l.confidence === 0.95)).toHaveLength(1);
    // idempotent
    const r2 = linkCardSettlements(db);
    expect(r2.linksCreated).toBe(5);
    expect(db.select().from(link).all()).toHaveLength(5);
  });
});

describe('counterparty rules and classification', () => {
  it('seeds defaults once, tags savings and transfers, classifies the rest by sign', () => {
    ingestBatch(db, {
      source: 'scraper:beinleumi',
      runId: null,
      accountId: bank,
      rows: [
        row({ date: '2026-11-10', amount: -60000, description: 'מסלול פנסיה וגמל', identifier: 'a' }),
        row({ date: '2026-11-11', amount: -170000, description: 'העברה מהחשבון', identifier: 'b' }),
        row({ date: '2026-11-12', amount: 1250000, description: 'משכורת', identifier: 'c' }),
        row({ date: '2026-11-13', amount: -520000, description: 'משיכת שיק 123', identifier: 'd' }),
      ],
    });
    expect(seedDefaultRules(db)).toBe(2);
    expect(seedDefaultRules(db)).toBe(0);
    expect(applyCounterpartyRules(db)).toEqual({ rules: 2, transactionsTagged: 2 });
    expect(classifyRemaining(db)).toBe(2);
    const t = Object.fromEntries(db.select().from(transactions).all().map((x) => [x.descriptionRaw, [x.kind, x.excluded]]));
    expect(t['מסלול פנסיה וגמל']).toEqual(['savings', false]);
    expect(t['העברה מהחשבון']).toEqual(['transfer', true]);
    expect(t['משכורת']).toEqual(['income', false]);
    expect(t['משיכת שיק 123']).toEqual(['expense', false]);
    expect(applyCounterpartyRules(db).transactionsTagged).toBe(0);
  });
});

describe('refund engine', () => {
  it('full cancellation, partial refund, FX refund, and an unmatched cashback', () => {
    ingestBatch(db, {
      source: 'scraper:max',
      runId: null,
      accountId: max,
      rows: [
        maxRow('2025-11-23', '2025-12-02', -52900, 'מתנה פלוס - מתנות ואתר'),
        maxRow('2025-12-22', '2026-01-02', 52900, 'מתנה פלוס - מתנות ואתר', 'רגילה', { memo: 'ביטול עסקה' }),
        maxRow('2026-01-24', '2026-02-02', -3750, 'GOOGLE ONE'),
        maxRow('2026-01-24', '2026-02-02', 190, 'GOOGLE ONE'),
        // different spellings (booking refs in the name) but the same Max merchant number
        maxRow('2026-06-18', '2026-07-02', -268450, 'SKYWAY SW0458 SKYWAYAIRL GR', 'חיוב עסקות מיידי', { originalAmount: -86900, originalCurrency: 'USD', payload: { rawTransaction: { planName: 'חיוב עסקות מיידי', merchantData: { merchantNumber: 'SKY1' } } } }),
        maxRow('2026-06-23', '2026-07-02', 256120, 'SKYWAY SW0458273914 SKYWAYAIRL GR', 'חיוב עסקות מיידי', { originalAmount: 86900, originalCurrency: 'USD', payload: { rawTransaction: { planName: 'חיוב עסקות מיידי', merchantData: { merchantNumber: 'SKY1' } } } }),
        maxRow('2025-11-30', '2025-12-02', 83, 'TOPCASH', 'רגילה', { memo: 'זיכוי' }),
        maxRow('2026-03-01', '2026-04-02', -1200, 'WOLT'),
        maxRow('2026-03-02', '2026-04-02', -1200, 'WOLT'),
      ],
    });
    assignMerchants(db);
    const r = linkRefunds(db);
    expect(r.creditsSeen).toBe(4);
    expect(r.auto).toBe(3);
    expect(r.unmatched).toHaveLength(1);
    expect(r.unmatched[0]?.description).toBe('TOPCASH');
    const links = db.select().from(link).all();
    const byAmount = Object.fromEntries(links.map((l) => [l.amount, l]));
    expect(byAmount[52900]?.type).toBe('cancellation');
    expect(byAmount[190]?.type).toBe('refund');
    expect(byAmount[256120]?.type).toBe('cancellation'); // same USD amount → full, even though ILS differs
    expect(JSON.parse(byAmount[256120]!.explanationJson).some((s: { signal: string; score: number }) => s.signal === 'fx' && s.score === 1)).toBe(true);
    const credits = db.select().from(transactions).where(sql`${transactions.amountIls} > 0`).all();
    expect(credits.filter((c) => c.kind === 'refund' && c.excluded)).toHaveLength(3);
    expect(credits.find((c) => c.descriptionRaw === 'TOPCASH')?.kind).toBeNull();
    // idempotent
    expect(linkRefunds(db).linksCreated).toBe(3);
    expect(db.select().from(link).all()).toHaveLength(3);
  });

  it('a returned cheque on the bank side cancels the cheque with the same number, even a day earlier', () => {
    ingestBatch(db, {
      source: 'scraper:beinleumi',
      runId: null,
      accountId: bank,
      rows: [row({ date: '2026-09-02', amount: 520000, description: '4417021 החזרת שיק', identifier: 'a' }), row({ date: '2026-09-03', amount: -520000, description: 'משיכת שיק 4417021', identifier: 'b' }), row({ date: '2026-09-01', amount: -520000, description: 'משיכת שיק 4417020', identifier: 'c' })],
    });
    assignMerchants(db);
    const r = linkRefunds(db);
    expect(r.auto).toBe(1);
    const l = db.select().from(link).get()!;
    expect(l.type).toBe('cancellation');
    expect(db.select().from(transactions).where(eq(transactions.id, l.toTxnId)).get()?.descriptionRaw).toBe('משיכת שיק 4417021');
    expect(JSON.parse(l.explanationJson).some((s: { signal: string; score: number }) => s.signal === 'reference' && s.score === 1)).toBe(true);
  });

  it('a decided link survives the next engine run: no second proposal, no re-proposal of a rejected pair', () => {
    ingestBatch(db, {
      source: 'scraper:max',
      runId: null,
      accountId: max,
      rows: [
        maxRow('2026-05-09', '2026-06-02', -58920, 'TERMINAL X'),
        maxRow('2026-05-22', '2026-06-02', 43750, 'TERMINAL X'), // partial: a suggestion, not automatic
        maxRow('2026-04-22', '2026-05-02', -215000, 'PAYBOX'),
        maxRow('2026-05-05', '2026-06-02', 21500, 'PAYBOX'),
      ],
    });
    assignMerchants(db);
    expect(linkRefunds(db).suggest).toBe(2);
    const [paybox, terminal] = db.select().from(link).all().sort((a, b) => a.amount - b.amount) as [typeof link.$inferSelect, typeof link.$inferSelect];
    decideLink(db, paybox.id, 'confirm');
    decideLink(db, terminal.id, 'reject');
    const again = linkRefunds(db);
    expect(again.linksCreated).toBe(0);
    const links = db.select().from(link).all();
    expect(links).toHaveLength(2);
    expect(links.map((l) => l.decision).sort()).toEqual(['confirmed', 'rejected']);
    // the confirmed credit stays a refund, the rejected one stays income, and nothing waits in the inbox
    const credits = db.select().from(transactions).where(sql`${transactions.amountIls} > 0`).all();
    expect(credits.find((c) => c.amountIls === 21500)?.kind).toBe('refund');
    expect(credits.find((c) => c.amountIls === 43750)?.kind).toBe('income');
    expect(links.filter((l) => l.decision === null)).toHaveLength(0);
  });

  it('two equal refunds pair with two purchases, not one', () => {
    ingestBatch(db, {
      source: 'scraper:max',
      runId: null,
      accountId: max,
      rows: [
        maxRow('2026-01-13', '2026-02-02', -6490, 'אייס'),
        maxRow('2026-01-10', '2026-02-02', -6490, 'אייס'),
        maxRow('2026-01-14', '2026-02-02', 6490, 'אייס', 'רגילה', { memo: 'ביטול עסקה' }),
        maxRow('2026-01-15', '2026-02-02', 6490, 'אייס', 'רגילה', { memo: 'ביטול עסקה' }),
      ],
    });
    assignMerchants(db);
    const r = linkRefunds(db);
    expect(r.auto).toBe(2);
    const targets = new Set(db.select().from(link).all().map((l) => l.toTxnId));
    expect(targets.size).toBe(2);
  });
});

import { eq, sql } from 'drizzle-orm';
