/**
 * Cashflow month assignment (decision #8, amended 2026-11-08): calendar month of the transaction
 * date, except that a sizeable income received in the last days of a month belongs to the NEXT
 * month, the way RiseUp does it (a salary paid on the 31st because the 1st falls on a weekend is
 * next month's salary). Expenses never move.
 */
import { and, eq, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/db.js';
import { transactions } from '../db/schema.js';

export interface CashflowOptions {
  /** How many days before month end count as "end of month". */
  endOfMonthDays?: number;
  /** Only income at or above this (minor units) shifts; small credits stay put. */
  minIncomeMinor?: number;
  /**
   * The account's usual salary (minor). When known, only income within [0.7, 1.4] of it shifts, so a
   * one-off ₪20,000 credit on the 28th stays in its month (RiseUp kept such a row too). Until Phase 3's
   * recurring streams exist, it is estimated as the median of ≥ minIncome credits dated the 1st–3rd.
   */
  salaryMinor?: number | null;
}

const DEFAULTS: Required<Omit<CashflowOptions, 'salaryMinor'>> = { endOfMonthDays: 3, minIncomeMinor: 300_000 };

export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

export function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** The cashflow month a row belongs to under the rule. */
export function cashflowMonthFor(txnDate: string, amountMinor: number, kind: string | null, o: CashflowOptions = {}): string {
  const opts = { ...DEFAULTS, ...o };
  const month = txnDate.slice(0, 7);
  if (kind !== 'income' || amountMinor < opts.minIncomeMinor) return month;
  if (opts.salaryMinor && (amountMinor < opts.salaryMinor * 0.7 || amountMinor > opts.salaryMinor * 1.4)) return month;
  const [y, m, d] = txnDate.split('-').map(Number) as [number, number, number];
  const last = daysInMonth(y, m);
  return d > last - opts.endOfMonthDays ? nextMonth(month) : month;
}

/** Median of the account's early-month (1st–3rd) incomes at or above the floor; null when there are fewer than 3. */
export function estimateSalary(rows: Array<{ txnDate: string; amount: number; kind: string | null }>, minIncomeMinor = DEFAULTS.minIncomeMinor): number | null {
  const xs = rows
    .filter((r) => r.kind === 'income' && r.amount >= minIncomeMinor && Number(r.txnDate.slice(8, 10)) <= 3)
    .map((r) => r.amount)
    .sort((a, b) => a - b);
  if (xs.length < 3) return null;
  return xs[Math.floor(xs.length / 2)]!;
}

/** Recompute cashflow_month for every completed row; returns how many changed. */
export function assignCashflowMonths(db: Db, o: CashflowOptions = {}): number {
  let changed = 0;
  db.transaction((tx) => {
    const rows = tx
      .select({ id: transactions.id, accountId: transactions.accountId, txnDate: transactions.txnDate, amount: transactions.amountIls, kind: transactions.kind, current: transactions.cashflowMonth })
      .from(transactions)
      .where(and(eq(transactions.status, 'completed'), ne(transactions.excluded, true)))
      .all();
    const salaryByAccount = new Map<number, number | null>();
    for (const r of rows) {
      if (!salaryByAccount.has(r.accountId)) salaryByAccount.set(r.accountId, o.salaryMinor !== undefined ? o.salaryMinor : estimateSalary(rows.filter((x) => x.accountId === r.accountId), o.minIncomeMinor));
      const want = cashflowMonthFor(r.txnDate, r.amount, r.kind, { ...o, salaryMinor: salaryByAccount.get(r.accountId) ?? null });
      if (want !== r.current) {
        tx.update(transactions).set({ cashflowMonth: want }).where(eq(transactions.id, r.id)).run();
        changed++;
      }
    }
    // excluded rows and pending rows keep the plain calendar month
    tx.update(transactions)
      .set({ cashflowMonth: sql`substr(${transactions.txnDate}, 1, 7)` })
      .where(and(sql`(${transactions.excluded} = 1 or ${transactions.status} <> 'completed')`, sql`${transactions.cashflowMonth} <> substr(${transactions.txnDate}, 1, 7)`))
      .run();
  });
  return changed;
}
