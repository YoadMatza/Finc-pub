/**
 * Balance reconciliation (§4a, §7b): for a bank account, the change in balance between two
 * snapshots must equal the sum of completed transactions dated inside that window.
 * Card accounts are not reconciled here (their "balance" is utilization); they are checked
 * against the settlement debit in Phase 2.
 */
import { and, asc, eq, gt, lte, sql } from 'drizzle-orm';
import type { Db } from './db/db.js';
import { account, balanceSnapshot, transactions } from './db/schema.js';

export interface ReconcileResult {
  accountId: number;
  displayName: string | null;
  from: { takenAt: string; date: string; balance: number; source: string };
  to: { takenAt: string; date: string; balance: number; source: string };
  balanceDelta: number; // minor units
  txnSum: number; // minor units, completed transactions with date in (from.date, to.date]
  txnCount: number;
  pendingInWindow: number;
  diff: number; // balanceDelta - txnSum
  ok: boolean;
  /** 'exact' when diff is 0; 'boundary' when the diff equals a subset of boundary-day rows (snapshot taken mid-day). */
  explanation: 'exact' | 'boundary' | 'tolerance' | 'unexplained';
  /** Transactions on the boundary days, the usual explanation for a small diff. */
  boundary: Array<{ date: string; amount: number; description: string; status: string }>;
}

/** Can `target` be written as the sum of a subset of `values`? Small n, brute force. */
export function subsetSumExists(values: number[], target: number): boolean {
  if (target === 0) return true;
  const v = values.slice(0, 16);
  const n = v.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    let s = 0;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) s += v[i]!;
    if (s === target) return true;
  }
  return false;
}

export interface ReconcileOptions {
  /** Pick snapshots from this source only (e.g. 'scraper:beinleumi'). Default: any. */
  source?: string;
  /** Oldest snapshot to use (ISO). Default: the earliest. */
  fromAt?: string;
  /** Newest snapshot to use (ISO). Default: the latest. */
  toAt?: string;
  /** Use charge_date (value date) when present. Default true for bank accounts. */
  useChargeDate?: boolean;
  toleranceMinor?: number;
}

const localDate = (iso: string): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

export function reconcileAccount(db: Db, accountId: number, o: ReconcileOptions = {}): ReconcileResult | null {
  const acc = db.select().from(account).where(eq(account.id, accountId)).get();
  if (!acc) throw new Error(`no account #${accountId}`);
  const conds = [eq(balanceSnapshot.accountId, accountId)];
  if (o.source) conds.push(eq(balanceSnapshot.source, o.source));
  if (o.fromAt) conds.push(sql`${balanceSnapshot.takenAt} >= ${o.fromAt}`);
  if (o.toAt) conds.push(sql`${balanceSnapshot.takenAt} <= ${o.toAt}`);
  const snaps = db.select().from(balanceSnapshot).where(and(...conds)).orderBy(asc(balanceSnapshot.takenAt)).all();
  if (snaps.length < 2) return null;
  const first = snaps[0]!;
  const last = snaps[snaps.length - 1]!;
  const fromDate = localDate(first.takenAt);
  const toDate = localDate(last.takenAt);
  if (fromDate === toDate) return null;

  const dateCol = (o.useChargeDate ?? true) ? sql<string>`coalesce(${transactions.chargeDate}, ${transactions.txnDate})` : sql<string>`${transactions.txnDate}`;
  const rows = db
    .select({ date: dateCol, amount: transactions.amountIls, description: transactions.descriptionRaw, status: transactions.status })
    .from(transactions)
    .where(and(eq(transactions.accountId, accountId), gt(dateCol, fromDate), lte(dateCol, toDate)))
    .all();
  const completed = rows.filter((r) => r.status === 'completed');
  const txnSum = completed.reduce((s, r) => s + r.amount, 0);
  const balanceDelta = last.balance - first.balance;
  const diff = balanceDelta - txnSum;
  const boundaryRows = db
    .select({ date: dateCol, amount: transactions.amountIls, description: transactions.descriptionRaw, status: transactions.status })
    .from(transactions)
    .where(and(eq(transactions.accountId, accountId), sql`${dateCol} in (${fromDate}, ${toDate})`))
    .all();
  // A snapshot is taken at some moment of its day, so rows dated on the two boundary days may sit on
  // either side of it. Rows on the FROM day were excluded above: if the diff equals some of them, the
  // snapshot predates them. Rows on the TO day were included: if the diff equals minus some of them,
  // the snapshot predates those.
  const fromDayAmounts = boundaryRows.filter((b) => b.date === fromDate && b.status === 'completed').map((b) => b.amount);
  const toDayAmounts = boundaryRows.filter((b) => b.date === toDate && b.status === 'completed').map((b) => -b.amount);
  const boundaryExplained = diff !== 0 && subsetSumExists([...fromDayAmounts, ...toDayAmounts], diff);
  const tolerance = o.toleranceMinor ?? 0;
  const explanation: ReconcileResult['explanation'] = diff === 0 ? 'exact' : boundaryExplained ? 'boundary' : Math.abs(diff) <= tolerance ? 'tolerance' : 'unexplained';
  return {
    accountId,
    displayName: acc.displayName,
    from: { takenAt: first.takenAt, date: fromDate, balance: first.balance, source: first.source },
    to: { takenAt: last.takenAt, date: toDate, balance: last.balance, source: last.source },
    balanceDelta,
    txnSum,
    txnCount: completed.length,
    pendingInWindow: rows.length - completed.length,
    diff,
    ok: explanation !== 'unexplained',
    explanation,
    boundary: boundaryRows,
  };
}

/** Reconcile every bank (checking) account that has at least two snapshots on different days. */
export function reconcileAll(db: Db, o: ReconcileOptions = {}): ReconcileResult[] {
  const banks = db.select().from(account).where(eq(account.type, 'checking')).all();
  const out: ReconcileResult[] = [];
  for (const b of banks) {
    const r = reconcileAccount(db, b.id, o);
    if (r) out.push(r);
  }
  return out;
}
