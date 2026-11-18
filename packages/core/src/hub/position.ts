/**
 * Position view, step 1 (research_notes/proposals/position-view.md §4): store the bank's purchase lots and its
 * realised tax figures per year. The calculations (step 2) read them from here.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/db.js';
import { costLotSnapshot, taxYearSummary } from '../db/schema.js';
import type { CostLotRow, TaxYearSummary } from '../ingest/fibi-pages.js';

const LOT_KEYS = ['paperId', 'action', 'quantity', 'costPrice', 'costPriceIls', 'currency', 'tradeDate'] as const;
const lotKey = (l: Pick<CostLotRow, (typeof LOT_KEYS)[number]>): string => LOT_KEYS.map((k) => String(l[k])).join('|');

/** The account's current lots: the latest set written. */
export function latestCostLots(db: Db, accountId: number): { takenAt: string | null; lots: CostLotRow[] } {
  const latest = db.select({ takenAt: costLotSnapshot.takenAt }).from(costLotSnapshot).where(eq(costLotSnapshot.accountId, accountId)).orderBy(desc(costLotSnapshot.takenAt)).limit(1).get();
  if (!latest) return { takenAt: null, lots: [] };
  const rows = db
    .select()
    .from(costLotSnapshot)
    .where(and(eq(costLotSnapshot.accountId, accountId), eq(costLotSnapshot.takenAt, latest.takenAt)))
    .orderBy(costLotSnapshot.tradeDate, costLotSnapshot.id)
    .all();
  return {
    takenAt: latest.takenAt,
    lots: rows.map((r) => ({
      paperId: r.paperId,
      name: r.name,
      action: r.action as CostLotRow['action'],
      actionText: r.actionText,
      quantity: r.quantity,
      costPrice: r.costPrice,
      costPriceIls: r.costPriceIls,
      currency: r.currency,
      tradeDate: r.tradeDate,
      avgPrice: r.avgPrice,
      lastPrice: r.lastPrice,
      changePct: r.changePct,
    })),
  };
}

/**
 * Write the lots when they differ from the current set (a buy, a sale, a split); prices alone changing does not
 * count, so two syncs a day do not grow the table. Returns whether a new set was written.
 */
export function recordCostLots(db: Db, p: { accountId: number; runId: number | null; lots: CostLotRow[]; takenAt?: string }): boolean {
  const current = latestCostLots(db, p.accountId);
  const same = current.takenAt !== null && current.lots.map(lotKey).sort().join('\n') === p.lots.map(lotKey).sort().join('\n');
  // An empty page is not written: a set needs at least one row, and the view only shows lots of papers that the
  // holdings page still lists, so lots left over after selling everything are never shown.
  if (same || !p.lots.length) return false;
  const takenAt = p.takenAt ?? new Date().toISOString();
  db.transaction((tx) => {
    for (const l of p.lots) {
      tx.insert(costLotSnapshot)
        .values({ accountId: p.accountId, syncRunId: p.runId, takenAt, paperId: l.paperId, name: l.name, action: l.action, actionText: l.actionText, quantity: l.quantity, costPrice: l.costPrice, costPriceIls: l.costPriceIls, currency: l.currency, tradeDate: l.tradeDate, avgPrice: l.avgPrice, lastPrice: l.lastPrice, changePct: l.changePct })
        .run();
    }
  });
  return true;
}

/** Insert or update one year's figures. */
export function recordTaxYear(db: Db, p: { accountId: number; summary: TaxYearSummary; takenAt?: string }): void {
  const s = p.summary;
  const values = {
    accountId: p.accountId,
    year: s.year,
    takenAt: p.takenAt ?? new Date().toISOString(),
    lossesIls: s.lossesIls,
    gainsJson: JSON.stringify(s.gains),
    taxWithheldJson: JSON.stringify(s.taxWithheld),
    interestDividendIls: s.interestDividendIls,
    interestDividendTaxIls: s.interestDividendTaxIls,
  };
  db.insert(taxYearSummary)
    .values(values)
    .onConflictDoUpdate({ target: [taxYearSummary.accountId, taxYearSummary.year], set: values })
    .run();
}

/** Every stored year for the account, newest first. */
export function taxYears(db: Db, accountId: number): Array<TaxYearSummary & { takenAt: string }> {
  return db
    .select()
    .from(taxYearSummary)
    .where(eq(taxYearSummary.accountId, accountId))
    .orderBy(desc(taxYearSummary.year))
    .all()
    .map((r) => ({
      year: r.year,
      takenAt: r.takenAt,
      lossesIls: r.lossesIls,
      gains: JSON.parse(r.gainsJson) as TaxYearSummary['gains'],
      taxWithheld: JSON.parse(r.taxWithheldJson) as TaxYearSummary['taxWithheld'],
      interestDividendIls: r.interestDividendIls,
      interestDividendTaxIls: r.interestDividendTaxIls,
    }));
}
