/** Recurring screen: fixed expenses, subscriptions, fixed income, installments, the subscription audit. */
import type { Db } from '../db/db.js';
import { projectRemainingSlices } from '../engine/installments.js';
import { expectedSlots } from '../engine/recurring.js';
import { currentMonth } from '../riseup/client.js';
import { addDays, todayLocal } from './overview.js';

export interface StreamView {
  id: number;
  state: string;
  stateSource: string;
  direction: 'income' | 'expense';
  frequency: string;
  expectedAmount: number;
  amountTolerance: number;
  amountModel: string;
  originalCurrency: string | null;
  expectedOriginalAmount: number | null;
  expectedDay: number | null;
  nextExpectedDate: string | null;
  lastTxnDate: string | null;
  occurrences: number;
  label: string | null;
  merchantId: number;
  merchantName: string;
  accountId: number;
  accountName: string | null;
  categoryId: number | null;
  categoryKey: string | null;
  firstDate: string | null;
  lastAmount: number | null;
  /** yearly cost at the expected amount and cadence (minor, signed) */
  yearly: number;
  runningMonths: number;
  thisMonth: { status: 'matched' | 'upcoming' | 'missing' | 'none'; expectedDate: string | null; matchedTxnId: number | null; actualAmount: number | null };
  priceChange: { from: number; to: number; date: string } | null;
}

export interface PlanView {
  id: number;
  merchantId: number | null;
  merchantName: string;
  accountId: number;
  accountName: string | null;
  totalN: number;
  seenN: number;
  sliceAmount: number;
  originalAmount: number | null;
  firstDate: string;
  status: string;
  remainingN: number;
  remainingAmount: number;
  nextDate: string | null;
  endsMonth: string | null;
  thisMonth: { status: 'matched' | 'upcoming' | 'missing' | 'none'; n: number | null; txnId: number | null };
}

export interface RecurringOverview {
  month: string;
  streams: StreamView[];
  plans: PlanView[];
  audit: { yearlySubscriptions: number; monthlyFixed: number; monthlyIncome: number; overAYear: number; priceChanges: number };
}

const PER_YEAR: Record<string, number> = { weekly: 52, biweekly: 26, monthly: 12, bimonthly: 6, quarterly: 4, annual: 1 };

export function recurringOverview(db: Db, monthArg?: string, states: string[] = ['confirmed', 'candidate', 'paused']): RecurringOverview {
  const c = db.$client;
  const month = monthArg ?? currentMonth();
  const today = todayLocal();
  const slots = expectedSlots(db, month);
  const marks = states.map(() => '?').join(',');
  const rows = c
    .prepare(
      `select rs.*, m.name merchant_name, a.display_name account_name, cat.key category_key,
              (select min(t.txn_date) from "transaction" t where t.recurring_stream_id = rs.id) first_date,
              (select t.amount_ils from "transaction" t where t.id = rs.last_txn_id) last_amount,
              (select t2.amount_ils from "transaction" t2 where t2.recurring_stream_id = rs.id and t2.id <> coalesce(rs.last_txn_id, -1) order by t2.txn_date desc limit 1) prev_amount
       from recurring_stream rs join merchant m on m.id = rs.merchant_id join account a on a.id = rs.account_id left join category cat on cat.id = rs.category_id
       where rs.state in (${marks}) order by rs.direction, abs(rs.expected_amount) desc`,
    )
    .all(...states) as Array<Record<string, unknown>>;
  const streams: StreamView[] = rows.map((r) => {
    const id = r.id as number;
    const mine = slots.filter((s) => s.streamId === id);
    const slot = mine.find((s) => s.status === 'missing') ?? mine.find((s) => s.status === 'upcoming') ?? mine[0];
    const actual = slot?.matchedTxnId ? (c.prepare('select amount_ils from "transaction" where id = ?').get(slot.matchedTxnId) as { amount_ils: number }).amount_ils : null;
    const expected = r.expected_amount as number;
    const tol = r.amount_tolerance as number;
    const last = (r.last_amount as number | null) ?? null;
    const prev = (r.prev_amount as number | null) ?? null;
    const priceChange = last !== null && prev !== null && Math.abs(last) > Math.abs(prev) + tol && (r.original_currency as string | null) === null ? { from: prev, to: last, date: r.last_txn_date as string } : null;
    const first = (r.first_date as string | null) ?? null;
    const runningMonths = first ? Math.max(1, Math.round((Date.parse(today) - Date.parse(first)) / (30.44 * 86_400_000))) : 0;
    return {
      id,
      state: r.state as string,
      stateSource: r.state_source as string,
      direction: r.direction as 'income' | 'expense',
      frequency: r.frequency as string,
      expectedAmount: expected,
      amountTolerance: tol,
      amountModel: r.amount_model as string,
      originalCurrency: (r.original_currency as string | null) ?? null,
      expectedOriginalAmount: (r.expected_original_amount as number | null) ?? null,
      expectedDay: (r.expected_day as number | null) ?? null,
      nextExpectedDate: (r.next_expected_date as string | null) ?? null,
      lastTxnDate: (r.last_txn_date as string | null) ?? null,
      occurrences: r.occurrences as number,
      label: (r.label as string | null) ?? null,
      merchantId: r.merchant_id as number,
      merchantName: r.merchant_name as string,
      accountId: r.account_id as number,
      accountName: (r.account_name as string | null) ?? null,
      categoryId: (r.category_id as number | null) ?? null,
      categoryKey: (r.category_key as string | null) ?? null,
      firstDate: first,
      lastAmount: last,
      yearly: expected * (PER_YEAR[r.frequency as string] ?? 12),
      runningMonths,
      thisMonth: slot ? { status: slot.status, expectedDate: slot.expectedDate, matchedTxnId: slot.matchedTxnId, actualAmount: actual } : { status: 'none', expectedDate: null, matchedTxnId: null, actualAmount: null },
      priceChange,
    };
  });

  const planRows = c
    .prepare(
      `select p.*, coalesce(m.name, '?') merchant_name, a.display_name account_name from installment_plan p left join merchant m on m.id = p.merchant_id join account a on a.id = p.account_id
       where p.status = 'active' or p.updated_at >= ? order by p.first_date desc`,
    )
    .all(`${addDays(today, -60)}T00:00:00`) as Array<Record<string, unknown>>;
  const plans: PlanView[] = planRows.map((p) => {
    const plan = {
      id: p.id as number,
      accountId: p.account_id as number,
      merchantId: (p.merchant_id as number | null) ?? null,
      planKey: p.plan_key as string,
      totalN: p.total_n as number,
      originalAmount: (p.original_amount as number | null) ?? null,
      sliceAmount: (p.slice_amount as number | null) ?? null,
      firstDate: p.first_date as string,
      seenN: p.seen_n as number,
      status: p.status as string,
      createdAt: p.created_at as string,
      updatedAt: p.updated_at as string,
    };
    const remaining = projectRemainingSlices(plan);
    const thisMonthSlice = remaining.find((s) => s.expectedDate.slice(0, 7) === month);
    const seenThisMonth = c.prepare(`select id, installment_n from "transaction" where installment_plan_id = ? and cashflow_month = ? and status = 'completed' limit 1`).get(plan.id, month) as { id: number; installment_n: number | null } | undefined;
    const last = remaining[remaining.length - 1];
    return {
      id: plan.id,
      merchantId: plan.merchantId,
      merchantName: p.merchant_name as string,
      accountId: plan.accountId,
      accountName: (p.account_name as string | null) ?? null,
      totalN: plan.totalN,
      seenN: plan.seenN,
      sliceAmount: plan.sliceAmount ?? 0,
      originalAmount: plan.originalAmount,
      firstDate: plan.firstDate,
      status: plan.status,
      remainingN: remaining.length,
      remainingAmount: remaining.reduce((a, s) => a + s.amount, 0),
      nextDate: remaining[0]?.expectedDate ?? null,
      endsMonth: last ? last.expectedDate.slice(0, 7) : null,
      thisMonth: seenThisMonth
        ? { status: 'matched', n: seenThisMonth.installment_n, txnId: seenThisMonth.id }
        : thisMonthSlice
          ? { status: thisMonthSlice.expectedDate < addDays(today, -7) ? 'missing' : 'upcoming', n: thisMonthSlice.n, txnId: null }
          : { status: 'none', n: null, txnId: null },
    };
  });

  const confirmed = streams.filter((s) => s.state === 'confirmed');
  return {
    month,
    streams,
    plans,
    audit: {
      yearlySubscriptions: confirmed.filter((s) => s.direction === 'expense' && (s.categoryKey === 'fixed.digital' || s.categoryKey === 'lifestyle.leisure')).reduce((a, s) => a + s.yearly, 0),
      monthlyFixed: confirmed.filter((s) => s.direction === 'expense').reduce((a, s) => a + s.yearly / 12, 0),
      monthlyIncome: confirmed.filter((s) => s.direction === 'income').reduce((a, s) => a + s.yearly / 12, 0),
      overAYear: confirmed.filter((s) => s.direction === 'expense' && s.runningMonths >= 12).length,
      priceChanges: confirmed.filter((s) => s.priceChange).length,
    },
  };
}
