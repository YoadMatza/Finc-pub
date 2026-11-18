import { describe, expect, it } from 'vitest';
import { openDb } from '../db/db.js';
import { ensureAccount } from '../db/accounts.js';
import type { CostLotRow, TaxYearSummary } from '../ingest/fibi-pages.js';
import { latestCostLots, recordCostLots, recordTaxYear, taxYears } from './position.js';

// made-up lots and amounts
const lot = (o: Partial<CostLotRow> = {}): CostLotRow => ({ paperId: '11111', name: 'ACME', action: 'buy', actionText: 'קניה בבורסה', quantity: 10, costPrice: 20.5, costPriceIls: 75.1, currency: 'USD', tradeDate: '2025-02-03', avgPrice: null, lastPrice: 1, changePct: -95, ...o });

function setup() {
  const db = openDb(':memory:');
  const { accountId } = ensureAccount(db, { institutionId: 'beinleumi', institutionKind: 'bank', institutionDisplayName: 'FIBI', scraperId: 'beinleumi', source: 'scraper:beinleumi', externalId: 'x-securities', type: 'securities', last4: '0000', displayName: 'FIBI securities' });
  return { db, accountId };
}

describe('cost lots', () => {
  it('writes a set only when the lots change, not when prices move', () => {
    const { db, accountId } = setup();
    expect(recordCostLots(db, { accountId, runId: null, lots: [lot()], takenAt: '2026-11-18T10:00:00Z' })).toBe(true);
    expect(recordCostLots(db, { accountId, runId: null, lots: [lot({ lastPrice: 2, changePct: -90 })], takenAt: '2026-11-18T16:00:00Z' })).toBe(false);
    expect(recordCostLots(db, { accountId, runId: null, lots: [lot(), lot({ paperId: '22222', tradeDate: '2026-11-18' })], takenAt: '2026-11-19T10:00:00Z' })).toBe(true);
    const cur = latestCostLots(db, accountId);
    expect(cur.takenAt).toBe('2026-11-19T10:00:00Z');
    expect(cur.lots.map((l) => l.paperId)).toEqual(['11111', '22222']);
  });

  it('never writes an empty set', () => {
    const { db, accountId } = setup();
    expect(recordCostLots(db, { accountId, runId: null, lots: [] })).toBe(false);
    expect(latestCostLots(db, accountId)).toEqual({ takenAt: null, lots: [] });
  });
});

describe('tax years', () => {
  it('keeps one row per year, updated in place', () => {
    const { db, accountId } = setup();
    const s = (losses: number): TaxYearSummary => ({ year: 2026, lossesIls: losses, gains: [{ ratePct: 25, amountIls: 0 }], taxWithheld: [], interestDividendIls: null, interestDividendTaxIls: null });
    recordTaxYear(db, { accountId, summary: s(-100) });
    recordTaxYear(db, { accountId, summary: s(-250) });
    recordTaxYear(db, { accountId, summary: { ...s(0), year: 2025 } });
    const ys = taxYears(db, accountId);
    expect(ys.map((y) => [y.year, y.lossesIls])).toEqual([[2026, -250], [2025, 0]]);
    expect(ys[0]!.gains).toEqual([{ ratePct: 25, amountIls: 0 }]);
  });
});
