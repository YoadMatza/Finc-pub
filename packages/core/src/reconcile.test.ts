import { beforeEach, describe, expect, it } from 'vitest';
import { ensureAccount } from './db/accounts.js';
import { type Db, openDb } from './db/db.js';
import { recordBalance } from './db/runs.js';
import { ingestBatch } from './ingest/ingest.js';
import type { NormalizedRow } from './ingest/types.js';
import { reconcileAccount, reconcileAll } from './reconcile.js';

let db: Db;
let bank: number;
const row = (date: string, amount: number, description: string, status: 'pending' | 'completed' = 'completed', identifier?: string): NormalizedRow => ({
  externalAccountId: 'fibi',
  date,
  chargeDate: date,
  amount,
  description,
  status,
  type: 'normal',
  payload: {},
  ...(identifier ? { identifier } : {}),
});

beforeEach(() => {
  db = openDb(':memory:');
  bank = ensureAccount(db, { institutionId: 'beinleumi', institutionKind: 'bank', institutionDisplayName: 'FIBI', source: 'scraper:beinleumi', externalId: 'fibi', type: 'checking' }).accountId;
});

describe('recordBalance', () => {
  it('is idempotent for an identical snapshot', () => {
    const p = { accountId: bank, runId: null, balanceMinor: 100000, source: 'scraper:beinleumi', takenAt: '2026-11-01T04:00:00.000Z' };
    expect(recordBalance(db, p)).toBe(true);
    expect(recordBalance(db, p)).toBe(false);
    expect(recordBalance(db, { ...p, balanceMinor: 100001 })).toBe(true);
    expect(reconcileAccount(db, bank)).toBeNull();
  });
});

describe('reconcileAccount', () => {
  it('returns null with fewer than two snapshots on different days', () => {
    expect(reconcileAccount(db, bank)).toBeNull();
    recordBalance(db, { accountId: bank, runId: null, balanceMinor: 100000, source: 'scraper:beinleumi', takenAt: '2026-11-01T04:00:00.000Z' });
    recordBalance(db, { accountId: bank, runId: null, balanceMinor: 100000, source: 'scraper:beinleumi', takenAt: '2026-11-01T16:00:00.000Z' });
    expect(reconcileAccount(db, bank)).toBeNull();
  });

  it('balance delta equals the sum of completed transactions in (from, to]', () => {
    // balance 1,000.00 on Nov 1 (06:00 local) → 8,380.60 on Nov 7 (06:00 local): +7,380.60
    recordBalance(db, { accountId: bank, runId: null, balanceMinor: 100000, source: 'scraper:beinleumi', takenAt: '2026-11-01T04:00:00.000Z' });
    recordBalance(db, { accountId: bank, runId: null, balanceMinor: 830060, source: 'scraper:beinleumi', takenAt: '2026-11-07T04:00:00.000Z' });
    ingestBatch(db, {
      source: 'scraper:beinleumi',
      runId: null,
      accountId: bank,
      rows: [
        row('2026-11-01', -45000, 'הוראת קבע פנסיה'), // on the FROM day: excluded (already in the Nov 1 balance)
        row('2026-11-03', -520000, 'משיכת שיק'),
        row('2026-11-05', 1250000, 'משכורת'),
        row('2026-11-07', 60, 'ריבית'), // on the TO day: included
        row('2026-11-06', -5000, 'ממתין', 'pending'), // pending: ignored
        row('2026-11-08', -9999, 'אחרי החלון'),
      ],
    });
    const r = reconcileAccount(db, bank)!;
    expect(r.from).toMatchObject({ date: '2026-11-01', balance: 100000 });
    expect(r.to).toMatchObject({ date: '2026-11-07', balance: 830060 });
    expect(r.balanceDelta).toBe(730060);
    expect(r.txnSum).toBe(-520000 + 1250000 + 60);
    expect(r.txnCount).toBe(3);
    expect(r.pendingInWindow).toBe(1);
    expect(r.diff).toBe(0);
    expect(r.ok).toBe(true);
    expect(r.boundary.map((b) => b.description).sort()).toEqual(['הוראת קבע פנסיה', 'ריבית']);
  });

  it('explains a diff that equals a boundary-day row (snapshot taken before that row posted)', () => {
    // FROM-day standing order of 450 posted after the morning snapshot → bank delta is 450 lower than our window sum
    recordBalance(db, { accountId: bank, runId: null, balanceMinor: 100000, source: 'scraper:beinleumi', takenAt: '2026-08-11T04:00:00.000Z' });
    recordBalance(db, { accountId: bank, runId: null, balanceMinor: 100000 - 45000 + 50000, source: 'scraper:beinleumi', takenAt: '2026-08-20T04:00:00.000Z' });
    ingestBatch(db, { source: 'scraper:beinleumi', runId: null, accountId: bank, rows: [row('2026-08-11', -45000, 'הוראת קבע'), row('2026-08-15', 50000, 'העברה')] });
    const r = reconcileAccount(db, bank)!;
    expect(r.diff).toBe(-45000);
    expect(r.explanation).toBe('boundary');
    expect(r.ok).toBe(true);
  });

  it('reports a mismatch with the diff and boundary rows', () => {
    recordBalance(db, { accountId: bank, runId: null, balanceMinor: 0, source: 'scraper:beinleumi', takenAt: '2026-11-01T04:00:00.000Z' });
    recordBalance(db, { accountId: bank, runId: null, balanceMinor: 10000, source: 'scraper:beinleumi', takenAt: '2026-11-03T04:00:00.000Z' });
    ingestBatch(db, { source: 'scraper:beinleumi', runId: null, accountId: bank, rows: [row('2026-11-02', 7500, 'חלקי')] });
    const r = reconcileAccount(db, bank)!;
    expect(r.ok).toBe(false);
    expect(r.explanation).toBe('unexplained');
    expect(r.diff).toBe(2500);
    expect(reconcileAccount(db, bank, { toleranceMinor: 2500 })!).toMatchObject({ ok: true, explanation: 'tolerance' });
  });

  it('can restrict snapshots to one source and reconcileAll covers checking accounts only', () => {
    recordBalance(db, { accountId: bank, runId: null, balanceMinor: 0, source: 'riseup', takenAt: '2026-10-01T04:00:00.000Z' });
    recordBalance(db, { accountId: bank, runId: null, balanceMinor: 500, source: 'scraper:beinleumi', takenAt: '2026-11-01T04:00:00.000Z' });
    recordBalance(db, { accountId: bank, runId: null, balanceMinor: 500, source: 'scraper:beinleumi', takenAt: '2026-11-02T04:00:00.000Z' });
    const card = ensureAccount(db, { institutionId: 'max', institutionKind: 'card', institutionDisplayName: 'Max', source: 'scraper:max', externalId: '6150', type: 'credit_card' }).accountId;
    recordBalance(db, { accountId: card, runId: null, balanceMinor: -1, source: 'scraper:max', takenAt: '2026-11-01T04:00:00.000Z' });
    recordBalance(db, { accountId: card, runId: null, balanceMinor: -2, source: 'scraper:max', takenAt: '2026-11-02T04:00:00.000Z' });

    const scoped = reconcileAccount(db, bank, { source: 'scraper:beinleumi' })!;
    expect(scoped.from.date).toBe('2026-11-01');
    expect(scoped.ok).toBe(true);
    const all = reconcileAll(db);
    expect(all).toHaveLength(1);
    expect(all[0]!.accountId).toBe(bank);
    expect(all[0]!.from.source).toBe('riseup');
  });
});
