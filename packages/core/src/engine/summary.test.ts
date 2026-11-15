import { beforeEach, describe, expect, it } from 'vitest';
import { ensureAccount } from '../db/accounts.js';
import { type Db, openDb } from '../db/db.js';
import { ingestBatch } from '../ingest/ingest.js';
import type { NormalizedRow } from '../ingest/types.js';
import { assignCashflowMonths, cashflowMonthFor } from './cashflow.js';
import { compareMonth, rawSourceCrossCheck } from './compare.js';
import { buildInstallmentPlans } from './installments.js';
import { assignMerchants } from './merchant.js';
import { linkRefunds } from './refunds.js';
import { applyCounterpartyRules, classifyRemaining, seedDefaultRules } from './rules.js';
import { linkCardSettlements } from './settlement.js';
import { monthSummary, monthsBetween } from './summary.js';

let db: Db;
let bank: number;
let max: number;
const row = (over: Partial<NormalizedRow> & Pick<NormalizedRow, 'date' | 'amount' | 'description'>): NormalizedRow => ({ externalAccountId: 'x', status: 'completed', type: 'normal', payload: {}, ...over });
const maxRow = (date: string, charge: string, amount: number, description: string, plan = 'רגילה', extra: Partial<NormalizedRow> = {}): NormalizedRow =>
  row({
    date,
    chargeDate: charge,
    amount,
    description,
    identifier: `${description}-${date}-${amount}`,
    payload: { status: 'completed', date: `${date}T00:00:00.000Z`, chargedAmount: amount / 100, rawTransaction: { planName: plan, merchantData: { merchantNumber: description } } },
    ...extra,
  });

function runEngine(): void {
  assignMerchants(db);
  buildInstallmentPlans(db);
  linkCardSettlements(db);
  seedDefaultRules(db);
  applyCounterpartyRules(db);
  linkRefunds(db);
  classifyRemaining(db);
  assignCashflowMonths(db);
}

beforeEach(() => {
  db = openDb(':memory:');
  bank = ensureAccount(db, { institutionId: 'beinleumi', institutionKind: 'bank', institutionDisplayName: 'FIBI', source: 'scraper:beinleumi', externalId: 'b', type: 'checking' }).accountId;
  max = ensureAccount(db, { institutionId: 'max', institutionKind: 'card', institutionDisplayName: 'Max', source: 'scraper:max', externalId: 'm', type: 'credit_card' }).accountId;
});

describe('monthSummary: no double counting', () => {
  it('one charge, one bucket; settlement excluded; refund netted, not income; installment slice in its own bucket', () => {
    ingestBatch(db, {
      source: 'scraper:max',
      runId: null,
      accountId: max,
      rows: [
        maxRow('2026-10-03', '2026-11-02', -8990, 'סופר'),
        maxRow('2026-10-20', '2026-11-02', -19260, 'STREAMLY'),
        maxRow('2026-10-10', '2026-11-02', -52900, 'מתנה פלוס'),
        maxRow('2026-10-25', '2026-11-02', 52900, 'מתנה פלוס', 'רגילה', { memo: 'ביטול עסקה' }),
        maxRow('2026-10-15', '2026-11-02', -27500, 'קאנטרי', 'תשלומים', { type: 'installments', installmentN: 3, installmentTotal: 12, originalAmount: -330000, identifier: 'ARN_3' }),
        maxRow('2026-10-30', '2026-11-02', 83, 'TOPCASH', 'רגילה', { memo: 'זיכוי' }),
      ],
    });
    ingestBatch(db, {
      source: 'scraper:beinleumi',
      runId: null,
      accountId: bank,
      rows: [
        row({ date: '2026-10-02', amount: -500000, description: 'מקס איט פיננסים', identifier: 's' }), // previous cycle: nothing charged on it here → unmatched
        row({ date: '2026-10-05', amount: 1250000, description: 'משכורת', identifier: 'c' }),
        row({ date: '2026-10-10', amount: -45000, description: 'מסלול פנסיה וגמל', identifier: 'p' }),
        row({ date: '2026-10-11', amount: -170000, description: 'העברה מהחשבון', identifier: 't' }),
        row({ date: '2026-11-02', amount: -8990 - 19260 - 52900 + 52900 - 27500 + 83, description: 'מקס איט פיננסים', identifier: 's2' }),
      ],
    });
    runEngine();
    const s = monthSummary(db, '2026-10');
    expect(s.income).toEqual({ count: 2, sum: 1250000 + 83 }); // salary + cashback (unmatched credit stays income)
    // 3 card purchases (the cancelled one nets to 0 but is still counted once) + the unmatched Oct 2 debit, which stays an expense until matched
    expect(s.expense).toEqual({ count: 4, sum: -8990 - 19260 + 0 - 500000 });
    expect(s.installments).toEqual({ count: 1, sum: -27500 });
    expect(s.savings).toEqual({ count: 1, sum: -45000 });
    expect(s.refundsNetted).toBe(52900);
    expect(s.excluded.refunds).toEqual({ count: 1, sum: 52900 });
    expect(s.excluded.transfers).toEqual({ count: 1, sum: -170000 });
    expect(s.excluded.settlements.count).toBe(0); // the Oct 2 debit found no rows → not a settlement → counted as expense!
    expect(s.integrity.unmatchedSettlementDebits).toHaveLength(1);
    expect(s.integrity.ok).toBe(true);
    expect(s.net).toBe(s.income.sum + s.expense.sum + s.installments.sum + s.savings.sum);
    // billing view moves the card rows to November, where the settlement debit is excluded
    const nov = monthSummary(db, '2026-11', 'billing');
    expect(nov.excluded.settlements).toEqual({ count: 1, sum: -8990 - 19260 - 52900 + 52900 - 27500 + 83 });
    expect(nov.expense.count + nov.installments.count + nov.income.count).toBe(5); // 6 card rows charged Nov 2, minus the excluded refund credit
    expect(nov.integrity.ok).toBe(true);
  });

  it('expected installment slices show up in future months', () => {
    ingestBatch(db, { source: 'scraper:max', runId: null, accountId: max, rows: [maxRow('2026-10-15', '2026-11-02', -27500, 'קאנטרי', 'תשלומים', { type: 'installments', installmentN: 3, installmentTotal: 5, originalAmount: -137500, identifier: 'ARN_3' })] });
    runEngine();
    expect(monthSummary(db, '2026-11').expectedInstallments).toMatchObject([{ n: 4, amount: -27500, expectedDate: '2026-11-15' }]);
    expect(monthSummary(db, '2026-12').expectedInstallments).toMatchObject([{ n: 5 }]);
    expect(monthSummary(db, '2027-01').expectedInstallments).toHaveLength(0);
  });

  it('a salary paid on the last day of the month counts in the next month (RiseUp convention); small credits and expenses stay', () => {
    ingestBatch(db, {
      source: 'scraper:beinleumi',
      runId: null,
      accountId: bank,
      rows: [
        row({ date: '2026-05-01', amount: 1200000, description: 'משכורת', identifier: 'sal0' }),
        row({ date: '2026-06-01', amount: 1210000, description: 'משכורת', identifier: 'sal1' }),
        row({ date: '2026-06-28', amount: 2000000, description: 'זיכוי', identifier: 'oneoff' }), // one-off, not salary-sized → stays in June
        row({ date: '2026-07-31', amount: 1350000, description: 'משכורת', identifier: 'sal' }),
        row({ date: '2026-07-30', amount: 1500, description: 'זיכוי קטן', identifier: 'small' }),
        row({ date: '2026-07-31', amount: -520000, description: 'משיכת שיק 1', identifier: 'chq' }),
        row({ date: '2026-08-01', amount: 1230000, description: 'משכורת', identifier: 'sal2' }),
      ],
    });
    runEngine(); // includes assignCashflowMonths
    expect(monthSummary(db, '2026-06').income).toEqual({ count: 2, sum: 1210000 + 2000000 });
    expect(monthSummary(db, '2026-07').income).toEqual({ count: 1, sum: 1500 });
    expect(monthSummary(db, '2026-07').expense).toEqual({ count: 1, sum: -520000 });
    expect(monthSummary(db, '2026-08').income).toEqual({ count: 2, sum: 1350000 + 1230000 });
    expect(cashflowMonthFor('2026-12-30', 500000, 'income')).toBe('2027-01');
    expect(cashflowMonthFor('2026-02-26', 500000, 'income')).toBe('2026-03'); // 28-day month: last 3 days are 26-28
    expect(cashflowMonthFor('2026-02-25', 500000, 'income')).toBe('2026-02');
    expect(cashflowMonthFor('2026-02-28', 2000000, 'income', { salaryMinor: 1200000 })).toBe('2026-02'); // not salary-sized
    expect(assignCashflowMonths(db)).toBe(0);
  });

  it('monthsBetween', () => {
    expect(monthsBetween('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });
});

describe('compareMonth and rawSourceCrossCheck', () => {
  it('attributes every difference to a (ours, riseup) cell', () => {
    ingestBatch(db, {
      source: 'scraper:max',
      runId: null,
      accountId: max,
      rows: [maxRow('2026-10-10', '2026-11-02', -52900, 'מתנה פלוס'), maxRow('2026-10-25', '2026-11-02', 52900, 'מתנה פלוס', 'רגילה', { memo: 'ביטול עסקה' }), maxRow('2026-10-03', '2026-11-02', -8990, 'סופר')],
    });
    ingestBatch(db, {
      source: 'riseup',
      runId: null,
      accountId: max,
      rows: [
        row({ date: '2026-10-10', amount: -52900, description: 'מתנה פלוס', identifier: 'r1', annotations: { cashflowDate: '2026-10', isExcluded: false, isIncome: false } }),
        row({ date: '2026-10-25', amount: 52900, description: 'מתנה פלוס', identifier: 'r2', annotations: { cashflowDate: '2026-10', isExcluded: false, isIncome: true } }), // RiseUp: income
        row({ date: '2026-10-03', amount: -8990, description: 'סופר', identifier: 'r3', annotations: { cashflowDate: '2026-11', isExcluded: false, isIncome: false } }), // RiseUp postponed it
      ],
    });
    runEngine();
    const c = compareMonth(db, '2026-10');
    expect(c.ours).toEqual({ in: 0, out: -52900 - 8990 });
    expect(c.riseup).toEqual({ in: 52900, out: -52900 });
    expect(c.cells).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ours: 'excluded', riseup: 'in', sum: 52900 }), // the refund: netted here, income there
        expect.objectContaining({ ours: 'out', riseup: 'none', sum: -8990 }), // postponed by RiseUp
      ]),
    );
    const checks = rawSourceCrossCheck(db);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ month: '2026-10', rawCount: 3, txnCount: 3, rawSum: -8990, txnSum: -8990, ok: true });
  });
});
