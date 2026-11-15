/**
 * Calibration against RiseUp (Phase 2 acceptance): for each month, our in/out versus RiseUp's,
 * with every difference attributed row by row to a (our bucket, RiseUp bucket) cell, so nothing is
 * unexplained. Plus the raw-source cross-check: the sum of raw scraped rows per account and month
 * must equal what the transaction table holds for that source.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/db.js';
import { link, rawTransaction, transactions } from '../db/schema.js';
import { isoToLocalDate, toMinor } from '../ingest/normalize.js';

type OurBucket = 'in' | 'out' | 'excluded' | 'none';
type RiseupBucket = 'in' | 'out' | 'excluded' | 'none';

export interface CompareCell {
  ours: OurBucket;
  riseup: RiseupBucket;
  count: number;
  sum: number; // minor, signed as we store it
}

export interface MonthCompare {
  month: string;
  ours: { in: number; out: number };
  riseup: { in: number; out: number };
  diffIn: number; // ours.in - riseup.in
  diffOut: number; // ours.out - riseup.out
  cells: CompareCell[]; // only off-diagonal (where the two disagree)
  riseupRowsSeen: number;
}

interface Ann {
  cashflowDate?: string;
  isExcluded?: boolean;
  isIncome?: boolean;
}

function riseupAnn(json: string | null): Ann | null {
  if (!json) return null;
  try {
    const a = (JSON.parse(json) as { riseup?: Ann }).riseup;
    return a ?? null;
  } catch {
    return null;
  }
}

/**
 * Both views for one month. Ours uses purchase dates (txn_date), the default view. RiseUp uses
 * its cashflowDate. Refund credits we net count as "excluded" on our side (they live inside the
 * purchase); RiseUp counts them as income, which is the discrepancy this exists to show.
 */
export function compareMonth(db: Db, month: string): MonthCompare {
  const rows = db
    .select()
    .from(transactions)
    .where(and(eq(transactions.status, 'completed'), sql`(${transactions.cashflowMonth} = ${month} or json_extract(${transactions.annotationsJson}, '$.riseup.cashflowDate') = ${month})`))
    .all();
  const nettedTargets = new Set(
    db
      .select({ to: link.toTxnId })
      .from(link)
      .where(and(sql`${link.type} in ('refund','cancellation')`, eq(link.zone, 'auto')))
      .all()
      .map((l) => l.to),
  );
  void nettedTargets;
  const res: MonthCompare = { month, ours: { in: 0, out: 0 }, riseup: { in: 0, out: 0 }, diffIn: 0, diffOut: 0, cells: [], riseupRowsSeen: 0 };
  const cellMap = new Map<string, CompareCell>();
  for (const t of rows) {
    const inOurMonth = t.cashflowMonth === month;
    let ours: OurBucket = 'none';
    if (inOurMonth) ours = t.excluded ? 'excluded' : t.amountIls >= 0 && t.kind !== 'savings' ? 'in' : 'out';
    const a = riseupAnn(t.annotationsJson);
    let riseup: RiseupBucket = 'none';
    if (a && a.cashflowDate === month) {
      res.riseupRowsSeen++;
      riseup = a.isExcluded ? 'excluded' : t.amountIls >= 0 ? 'in' : 'out';
    }
    if (ours === 'in') res.ours.in += t.amountIls;
    if (ours === 'out') res.ours.out += t.amountIls;
    if (riseup === 'in') res.riseup.in += t.amountIls;
    if (riseup === 'out') res.riseup.out += t.amountIls;
    if (ours !== riseup) {
      const k = `${ours}|${riseup}`;
      const c = cellMap.get(k) ?? { ours, riseup, count: 0, sum: 0 };
      c.count++;
      c.sum += t.amountIls;
      cellMap.set(k, c);
    }
  }
  res.diffIn = res.ours.in - res.riseup.in;
  res.diffOut = res.ours.out - res.riseup.out;
  res.cells = [...cellMap.values()].sort((x, y) => Math.abs(y.sum) - Math.abs(x.sum));
  return res;
}

export interface RawCrossCheck {
  accountId: number;
  month: string;
  source: string;
  rawCount: number;
  rawSum: number;
  txnCount: number;
  txnSum: number;
  ok: boolean;
}

/** Raw scraped rows (completed) per account/month vs the transactions owned by that source. */
export function rawSourceCrossCheck(db: Db, opts: { from?: string; to?: string } = {}): RawCrossCheck[] {
  const raws = db.select().from(rawTransaction).where(sql`${rawTransaction.source} like 'scraper:%'`).all();
  const agg = new Map<string, RawCrossCheck>();
  for (const r of raws) {
    const p = JSON.parse(r.payloadJson) as { status?: string; chargedAmount?: number; originalAmount?: number; originalCurrency?: string; date?: string };
    if (p.status !== 'completed' || !p.date) continue;
    const month = isoToLocalDate(p.date).slice(0, 7);
    if ((opts.from && month < opts.from) || (opts.to && month > opts.to)) continue;
    const amount = toMinor(p.chargedAmount) ?? 0;
    const k = `${r.accountId}|${month}|${r.source}`;
    const c = agg.get(k) ?? { accountId: r.accountId, month, source: r.source, rawCount: 0, rawSum: 0, txnCount: 0, txnSum: 0, ok: false };
    c.rawCount++;
    c.rawSum += amount;
    agg.set(k, c);
  }
  const txns = db
    .select({ accountId: transactions.accountId, month: sql<string>`substr(${transactions.txnDate},1,7)`, source: transactions.source, n: sql<number>`count(*)`, s: sql<number>`sum(${transactions.amountIls})` })
    .from(transactions)
    .where(and(eq(transactions.status, 'completed'), sql`${transactions.source} like 'scraper:%'`))
    .groupBy(transactions.accountId, sql`substr(${transactions.txnDate},1,7)`, transactions.source)
    .all();
  for (const t of txns) {
    const k = `${t.accountId}|${t.month}|${t.source}`;
    const c = agg.get(k);
    if (!c) {
      if ((opts.from && t.month < opts.from) || (opts.to && t.month > opts.to)) continue;
      agg.set(k, { accountId: t.accountId, month: t.month, source: t.source, rawCount: 0, rawSum: 0, txnCount: t.n, txnSum: t.s, ok: false });
      continue;
    }
    c.txnCount = t.n;
    c.txnSum = t.s;
  }
  const out = [...agg.values()];
  for (const c of out) c.ok = c.rawCount === c.txnCount && c.rawSum === c.txnSum;
  return out.sort((a, b) => a.accountId - b.accountId || a.month.localeCompare(b.month));
}
