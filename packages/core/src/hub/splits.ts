/**
 * Split one transaction across categories (wave 5, research_notes/proposals/split-transaction.md; spending only, as
 * decided 2026-11-16). The parts are stored in txn_split and add up exactly to the transaction's amount when saved. The
 * transaction keeps its own category as the main one; every sum by category reads the parts instead, through the
 * helpers below, so a split moves money between categories without changing any bucket, total or the limit.
 *
 * Shares come from the parts themselves (part / sum of parts), not from the transaction's amount: a pending charge
 * that completes at a slightly different amount, or a refund netted against the purchase, is divided in the same
 * proportions.
 */
import type { Db } from '../db/db.js';
import { nowIso } from '../db/db.js';

export const SPLIT_MIN_PARTS = 2;
export const SPLIT_MAX_PARTS = 8;

export interface SplitPart {
  categoryId: number;
  amount: number;
}

export interface SplitPartView extends SplitPart {
  categoryKey: string;
  nameHe: string;
  nameEn: string;
}

/** Thrown for a split that cannot be saved; the message is meant for the owner. */
export class SplitError extends Error {}

/** Save (or replace) a transaction's split. Throws SplitError with a readable reason. */
export function setSplit(db: Db, txnId: number, parts: SplitPart[]): void {
  const c = db.$client;
  const t = c.prepare('select id, amount_ils a, kind, excluded from "transaction" where id = ?').get(txnId) as { id: number; a: number; kind: string | null; excluded: number } | undefined;
  if (!t) throw new SplitError('no such transaction');
  if (t.a >= 0) throw new SplitError('only spending can be split');
  if (t.excluded || (t.kind !== null && t.kind !== 'expense')) throw new SplitError('only an ordinary purchase can be split (not a transfer, card bill, refund, saving or money paid back)');
  if (parts.length < SPLIT_MIN_PARTS || parts.length > SPLIT_MAX_PARTS) throw new SplitError(`a split has ${SPLIT_MIN_PARTS} to ${SPLIT_MAX_PARTS} parts`);
  const catOf = c.prepare('select id, key, section from category where id = ?');
  const seen = new Set<number>();
  let sum = 0;
  for (const p of parts) {
    if (!Number.isInteger(p.amount) || p.amount >= 0) throw new SplitError('every part is an amount of spending (above zero)');
    const cat = catOf.get(p.categoryId) as { id: number; key: string; section: string } | undefined;
    if (!cat) throw new SplitError('a part has an unknown category');
    if (cat.section === 'income' || cat.key === 'transfers') throw new SplitError('a part cannot go to an income category or to transfers');
    if (seen.has(cat.id)) throw new SplitError('each category appears once in a split');
    seen.add(cat.id);
    sum += p.amount;
  }
  if (sum !== t.a) throw new SplitError(`the parts add up to ${(-sum / 100).toFixed(2)}, the charge is ${(-t.a / 100).toFixed(2)}`);
  const del = c.prepare('delete from txn_split where txn_id = ?');
  const ins = c.prepare('insert into txn_split (txn_id, category_id, amount, sort, created_at) values (?, ?, ?, ?, ?)');
  c.transaction(() => {
    del.run(txnId);
    parts.forEach((p, i) => ins.run(txnId, p.categoryId, p.amount, i, nowIso()));
  })();
}

/** Remove a split: the whole amount goes back to the transaction's own category. */
export function removeSplit(db: Db, txnId: number): boolean {
  return db.$client.prepare('delete from txn_split where txn_id = ?').run(txnId).changes > 0;
}

/** One transaction's parts with their category names, or null when it is not split. */
export function splitOf(db: Db, txnId: number): SplitPartView[] | null {
  const rows = db.$client
    .prepare(
      `select s.category_id categoryId, s.amount, c.key categoryKey, c.name_he nameHe, c.name_en nameEn
       from txn_split s join category c on c.id = s.category_id where s.txn_id = ? order by s.sort`,
    )
    .all(txnId) as SplitPartView[];
  return rows.length ? rows : null;
}

/** The parts of the given transactions (all split ones when no ids are given), keyed by transaction id. */
export function splitsByTxn(db: Db, txnIds?: number[]): Map<number, SplitPart[]> {
  const c = db.$client;
  const rows = (
    txnIds === undefined
      ? c.prepare('select txn_id t, category_id categoryId, amount from txn_split order by txn_id, sort').all()
      : txnIds.length
        ? c.prepare(`select txn_id t, category_id categoryId, amount from txn_split where txn_id in (${txnIds.map(() => '?').join(',')}) order by txn_id, sort`).all(...txnIds)
        : []
  ) as Array<{ t: number; categoryId: number; amount: number }>;
  const out = new Map<number, SplitPart[]>();
  for (const r of rows) out.set(r.t, [...(out.get(r.t) ?? []), { categoryId: r.categoryId, amount: r.amount }]);
  return out;
}

/**
 * Divide an amount (the transaction's amount, or what is left of it after refunds) across its parts in their
 * proportions, in whole agorot that add up exactly: each part gets its rounded share, the last one the remainder.
 */
export function allocateSplit(amount: number, parts: SplitPart[]): Array<{ categoryId: number; amount: number }> {
  const total = parts.reduce((a, p) => a + p.amount, 0);
  if (!total) return parts.map((p) => ({ categoryId: p.categoryId, amount: 0 }));
  let used = 0;
  return parts.map((p, i) => {
    const share = i === parts.length - 1 ? amount - used : Math.round((amount * p.amount) / total);
    used += share;
    return { categoryId: p.categoryId, amount: share };
  });
}

/**
 * SQL for sums by category over `"transaction" t`: join SPLIT_JOIN, group by SPLIT_CATEGORY, and wrap every money
 * expression in splitShare(). A split transaction becomes one row per part (count it with count(distinct t.id) when a
 * transaction count is wanted); an unsplit one stays one row with its own category. The shares round per part, so a
 * category's total can be off by an agora from allocateSplit's exact division.
 */
export const SPLIT_JOIN = 'left join txn_split sp on sp.txn_id = t.id';
export const SPLIT_CATEGORY = 'coalesce(sp.category_id, t.category_id)';
export const splitShare = (expr: string): string =>
  `(case when sp.id is null then (${expr}) else round((${expr}) * 1.0 * sp.amount / (select sum(x.amount) from txn_split x where x.txn_id = t.id)) end)`;
