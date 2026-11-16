/**
 * Monthly summary with the counting rules of §7b: every non-excluded transaction lands in exactly
 * one bucket (income, expense, installments, savings); refunds are netted against the purchase they
 * cancel, never counted as income; settlements and transfers are excluded. The sum of buckets must
 * equal the sum of non-excluded rows, and the summary says so.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/db.js';
import { account, category, installmentPlan, link, recurringStream, transactions } from '../db/schema.js';
import { type ProjectedSlice, projectRemainingSlices } from './installments.js';
import { type ExpectedSlot, expectedSlots } from './recurring.js';
import { allocateSplit, splitsByTxn } from '../hub/splits.js';

export type View = 'purchase' | 'billing';

export interface Bucket {
  count: number;
  sum: number; // minor, signed
}

export interface MonthSummary {
  month: string;
  view: View;
  income: Bucket;
  expense: Bucket; // fixed + variable, after refund netting
  /** rows that belong to a confirmed recurring stream (§7b rule 5: never counted as variable) */
  fixed: Bucket;
  variable: Bucket;
  installments: Bucket;
  savings: Bucket;
  refundsNetted: number; // minor, positive: credits subtracted from expense/installments
  excluded: { settlements: Bucket; transfers: Bucket; refunds: Bucket; other: Bucket };
  net: number; // income + expense + installments + savings (signed)
  /** confirmed-stream slots this month: matched ones were consumed by a real charge, the rest are still expected (§7b rule 2) */
  expectedFixed: ExpectedSlot[];
  expectedFixedRemaining: number; // minor, signed: sum of unmatched expense slots
  expectedIncomeRemaining: number; // minor: sum of unmatched income slots
  expectedInstallments: ProjectedSlice[];
  byAccount: Array<{ accountId: number; displayName: string | null; type: string; income: number; out: number; count: number }>;
  /** non-excluded rows by category (refunds netted), biggest spend first; uncategorised rows under key null */
  /** `paidBack`: the part of `sum` that is money paid back to the owner (kind paid_back), which nets spending, not income */
  byCategory: Array<{ categoryId: number | null; key: string | null; nameHe: string | null; group: string | null; section: string | null; count: number; sum: number; paidBack: number }>;
  integrity: {
    bucketsSum: number;
    nonExcludedSum: number;
    ok: boolean;
    unmatchedSettlementDebits: Array<{ txnId: number; date: string; amount: number; description: string }>;
    pendingCount: number;
  };
}

const emptyBucket = (): Bucket => ({ count: 0, sum: 0 });

/**
 * Which month a row counts in. Purchase view: cashflow_month (calendar month of the transaction,
 * with the month-end salary shift). Billing view: card rows move to the month of their charge date.
 */
export function monthExpr(view: View) {
  return view === 'billing'
    ? sql<string>`case when ${account.type} = 'credit_card' then substr(coalesce(${transactions.chargeDate}, ${transactions.txnDate}), 1, 7) else ${transactions.cashflowMonth} end`
    : sql<string>`${transactions.cashflowMonth}`;
}

/** Which bucket of §7b a completed row of the month lands in ('excluded' for settlements, transfers, refunds, …). */
export type RowBucket = 'income' | 'savings' | 'installments' | 'fixed' | 'variable' | 'excluded';

export interface ClassifiedRow {
  t: typeof transactions.$inferSelect;
  /** refunds netted into this row (positive, 0 when none) */
  netted: number;
  /** what the month counts: amountIls + netted */
  amount: number;
  bucket: RowBucket;
}

/**
 * The completed rows of a month with the bucket each one counts in, refunds netted. monthSummary is built
 * from this, so anything that lists rows per bucket (the Now screen's explain sheet) ties out to it exactly.
 */
export function classifyMonthRows(db: Db, month: string, view: View = 'purchase'): ClassifiedRow[] {
  const dateExpr = monthExpr(view);
  const rows = db
    .select({ t: transactions })
    .from(transactions)
    .innerJoin(account, eq(account.id, transactions.accountId))
    .where(and(sql`${dateExpr} = ${month}`, eq(transactions.status, 'completed')))
    .all()
    .map((r) => r.t);
  const ids = rows.map((r) => r.id);

  // refunds netted into this month's purchases: links whose TARGET (the purchase) is in this month
  const refundLinks = ids.length
    ? db
        .select()
        .from(link)
        .where(and(inArray(link.type, ['refund', 'cancellation']), eq(link.zone, 'auto'), inArray(link.toTxnId, ids), sql`coalesce(${link.decision}, '') <> 'rejected'`))
        .all()
    : [];
  const nettedByTarget = new Map<number, number>();
  for (const l of refundLinks) nettedByTarget.set(l.toTxnId, (nettedByTarget.get(l.toTxnId) ?? 0) + l.amount);
  const confirmedStreams = new Set(db.select({ id: recurringStream.id }).from(recurringStream).where(eq(recurringStream.state, 'confirmed')).all().map((r) => r.id));

  return rows.map((t) => {
    if (t.excluded) return { t, netted: 0, amount: t.amountIls, bucket: 'excluded' as const };
    const netted = nettedByTarget.get(t.id) ?? 0;
    const amount = t.amountIls + netted; // purchase minus its refunds
    // paid back to me (engine/paidback.ts): money coming in that repays a shared expense counts against day-to-day
    // spending with its positive amount, never as income; checked before the "positive → income" rule
    const bucket: RowBucket =
      t.kind === 'paid_back'
        ? 'variable'
        : t.kind === 'income' || (t.kind !== 'savings' && t.amountIls > 0)
        ? 'income'
        : t.kind === 'savings'
          ? 'savings'
          : t.installmentPlanId !== null
            ? 'installments'
            : t.recurringStreamId !== null && confirmedStreams.has(t.recurringStreamId)
              ? 'fixed'
              : 'variable';
    return { t, netted, amount, bucket };
  });
}

export function monthSummary(db: Db, month: string, view: View = 'purchase'): MonthSummary {
  const classified = classifyMonthRows(db, month, view);

  const s: MonthSummary = {
    month,
    view,
    income: emptyBucket(),
    expense: emptyBucket(),
    fixed: emptyBucket(),
    variable: emptyBucket(),
    installments: emptyBucket(),
    savings: emptyBucket(),
    refundsNetted: 0,
    excluded: { settlements: emptyBucket(), transfers: emptyBucket(), refunds: emptyBucket(), other: emptyBucket() },
    net: 0,
    expectedFixed: [],
    expectedFixedRemaining: 0,
    expectedIncomeRemaining: 0,
    expectedInstallments: [],
    byAccount: [],
    byCategory: [],
    integrity: { bucketsSum: 0, nonExcludedSum: 0, ok: false, unmatchedSettlementDebits: [], pendingCount: 0 },
  };
  const perAccount = new Map<number, { income: number; out: number; count: number }>();
  const perCategory = new Map<number | null, { count: number; sum: number; paidBack: number }>();
  const add = (b: Bucket, amount: number) => {
    b.count++;
    b.sum += amount;
  };
  // split transactions (hub/splits.ts): their amount goes to their parts' categories, in proportion
  const splits = splitsByTxn(
    db,
    classified.filter((r) => r.bucket !== 'excluded' && r.t.amountIls < 0).map((r) => r.t.id),
  );

  for (const { t, netted, amount, bucket } of classified) {
    if (bucket === 'excluded') {
      const b = t.kind === 'settlement' ? s.excluded.settlements : t.kind === 'transfer' ? s.excluded.transfers : t.kind === 'refund' ? s.excluded.refunds : s.excluded.other;
      add(b, t.amountIls);
      continue;
    }
    s.refundsNetted += netted;
    s.integrity.nonExcludedSum += t.amountIls;
    const pa = perAccount.get(t.accountId) ?? { income: 0, out: 0, count: 0 };
    pa.count++;
    const parts = splits.get(t.id);
    for (const { categoryId, amount: share } of parts ? allocateSplit(amount, parts) : [{ categoryId: t.categoryId, amount }]) {
      const pc = perCategory.get(categoryId) ?? { count: 0, sum: 0, paidBack: 0 };
      pc.count++;
      pc.sum += share;
      if (t.kind === 'paid_back') pc.paidBack += share;
      perCategory.set(categoryId, pc);
    }
    if (bucket === 'income') {
      add(s.income, amount);
      pa.income += amount;
    } else if (bucket === 'savings') {
      add(s.savings, amount);
      pa.out += amount;
    } else if (bucket === 'installments') {
      add(s.installments, amount);
      pa.out += amount;
    } else {
      add(s.expense, amount);
      add(bucket === 'fixed' ? s.fixed : s.variable, amount);
      pa.out += amount;
    }
    perAccount.set(t.accountId, pa);
  }
  // expected occurrences of confirmed streams: matched slots were consumed above; the rest are still to come (or missing)
  s.expectedFixed = expectedSlots(db, month);
  for (const slot of s.expectedFixed) {
    if (slot.status === 'matched') continue;
    if (slot.direction === 'expense') s.expectedFixedRemaining += slot.amount;
    else s.expectedIncomeRemaining += slot.amount;
  }
  s.integrity.bucketsSum = s.income.sum + s.expense.sum + s.installments.sum + s.savings.sum;
  // buckets carry netted amounts; the refunds themselves sit in excluded.refunds, so:
  //   bucketsSum = nonExcludedSum + refundsNetted
  s.integrity.ok = s.integrity.bucketsSum === s.integrity.nonExcludedSum + s.refundsNetted;
  s.net = s.integrity.bucketsSum;

  const accounts = db.select().from(account).all();
  s.byAccount = [...perAccount.entries()].map(([id, v]) => {
    const a = accounts.find((x) => x.id === id);
    return { accountId: id, displayName: a?.displayName ?? null, type: a?.type ?? '?', ...v };
  });
  const cats = new Map(db.select().from(category).all().map((c) => [c.id, c]));
  s.byCategory = [...perCategory.entries()]
    .map(([id, v]) => {
      const c = id === null ? undefined : cats.get(id);
      return { categoryId: id, key: c?.key ?? null, nameHe: c?.nameHe ?? null, group: c?.groupKey ?? null, section: c?.section ?? null, ...v };
    })
    .sort((a, b) => a.sum - b.sum);

  // expected (not yet seen) installment slices falling in this month
  for (const p of db.select().from(installmentPlan).where(eq(installmentPlan.status, 'active')).all()) {
    for (const sl of projectRemainingSlices(p)) if (sl.expectedDate.slice(0, 7) === month) s.expectedInstallments.push(sl);
  }

  // integrity: settlement-looking bank debits in this month that nothing matched
  s.integrity.unmatchedSettlementDebits = db
    .select({ id: transactions.id, date: transactions.txnDate, amount: transactions.amountIls, description: transactions.descriptionRaw, kind: transactions.kind, norm: transactions.descriptionNorm })
    .from(transactions)
    .innerJoin(account, eq(account.id, transactions.accountId))
    .where(and(eq(account.type, 'checking'), sql`substr(${transactions.txnDate},1,7) = ${month}`, sql`${transactions.amountIls} < 0`, sql`coalesce(${transactions.kind},'') <> 'settlement'`))
    .all()
    .filter((r) => /ישראכרט|מקס איט|מקס פיננסים|לאומי קארד|ויזה כאל|כאל/.test(r.norm))
    .map((r) => ({ txnId: r.id, date: r.date, amount: r.amount, description: r.description }));
  s.integrity.pendingCount = db
    .select({ n: sql<number>`count(*)` })
    .from(transactions)
    .where(and(eq(transactions.status, 'pending'), sql`substr(${transactions.txnDate},1,7) = ${month}`))
    .get()!.n;
  return s;
}

/** Month list between two YYYY-MM inclusive. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number) as [number, number];
  const [ty, tm] = to.split('-').map(Number) as [number, number];
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}
