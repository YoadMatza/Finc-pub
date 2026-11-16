/**
 * Bill calendar (wave 5, research_notes/proposals/bill-calendar.md): the days fixed money moves in one month.
 *
 * - expected occurrences of confirmed recurring streams (fixed expenses and fixed income), each consumed by the real
 *   charge when it came (§7b): paid ones show the real amount and date;
 * - instalment slices: the ones already charged this month and the ones still to come;
 * - card bills: per card and billing day, the sum of the card's charges with that charge date (what the bank will
 *   take); paid once the bank debit is linked to them (card_settlement).
 *
 * Every item says whether it goes through a card or the bank directly. For the current month a balance line follows
 * the bank (checking) accounts from today's balance through the bank-side items still to come, with its lowest point.
 * Nothing is stored; all of it comes from the stream, instalment and settlement engines.
 */
import type { Db } from '../db/db.js';
import { projectRemainingSlices } from '../engine/installments.js';
import { expectedSlots } from '../engine/recurring.js';
import { installmentPlan } from '../db/schema.js';
import { eq } from 'drizzle-orm';

export type CalendarItemKind = 'fixed' | 'income' | 'installment' | 'card_bill';
export type CalendarStatus = 'paid' | 'upcoming' | 'missing';

export interface CalendarItem {
  date: string;
  kind: CalendarItemKind;
  name: string;
  /** signed agorot: the real amount once paid, else the expected one */
  amount: number;
  /** what was expected, when it differs from what was paid */
  expected?: number;
  status: CalendarStatus;
  /** paid through a card (counted in its card bill) or straight from / into the bank */
  via: 'card' | 'bank';
  streamId?: number;
  planId?: number;
  accountId?: number;
  txnId?: number;
  /** card bills: how many card charges it covers */
  count?: number;
}

export interface CalendarDay {
  date: string;
  items: CalendarItem[];
  /** agorot, positive: what leaves / arrives that day (card items counted once, in their bill) */
  out: number;
  in: number;
}

export interface BillCalendar {
  month: string;
  today: string;
  isCurrentMonth: boolean;
  days: CalendarDay[];
  totals: { out: number; in: number; paidOut: number; toComeOut: number; toComeIn: number };
  /** current month only: the bank accounts' balance from today to the month's end */
  balance?: { start: number; asOf: string; points: Array<{ date: string; balance: number }>; lowest: { date: string; balance: number } };
}

/** Days after the expected day before an unpaid item counts as missing (the stream engine's own grace). */
const GRACE_DAYS = 3;

const addDays = (date: string, n: number): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const lastDay = (month: string): string => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
const localToday = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

export function billCalendar(db: Db, month: string, opts: { today?: string } = {}): BillCalendar {
  const today = opts.today ?? localToday();
  const c = db.$client;
  const first = `${month}-01`;
  const last = lastDay(month);
  const isCurrentMonth = today.slice(0, 7) === month;
  const statusOf = (date: string): CalendarStatus => (date >= today || addDays(date, GRACE_DAYS) >= today ? 'upcoming' : 'missing');
  const accountType = new Map((c.prepare('select id, type from account').all() as Array<{ id: number; type: string }>).map((a) => [a.id, a.type]));
  const via = (accountId: number | undefined): 'card' | 'bank' => (accountId !== undefined && accountType.get(accountId) === 'credit_card' ? 'card' : 'bank');
  const merchantName = c.prepare('select name from merchant where id = ?');
  const nameOf = (merchantId: number | null | undefined, fallback = '?'): string => (merchantId ? ((merchantName.get(merchantId) as { name: string } | undefined)?.name ?? fallback) : fallback);
  const items: CalendarItem[] = [];

  // recurring streams: fixed expenses and fixed income
  const streamInfo = c.prepare('select label, account_id from recurring_stream where id = ?');
  const txnInfo = c.prepare('select txn_date, amount_ils from "transaction" where id = ?');
  for (const slot of expectedSlots(db, month, { today, graceDays: GRACE_DAYS })) {
    const st = streamInfo.get(slot.streamId) as { label: string | null; account_id: number } | undefined;
    const base = { kind: (slot.direction === 'income' ? 'income' : 'fixed') as CalendarItemKind, name: st?.label ?? nameOf(slot.merchantId), via: via(st?.account_id), streamId: slot.streamId, ...(st ? { accountId: st.account_id } : {}) };
    if (slot.status === 'matched' && slot.matchedTxnId !== null) {
      const t = txnInfo.get(slot.matchedTxnId) as { txn_date: string; amount_ils: number } | undefined;
      const amount = t?.amount_ils ?? slot.amount;
      items.push({ ...base, date: t?.txn_date ?? slot.expectedDate, amount, ...(amount !== slot.amount ? { expected: slot.amount } : {}), status: 'paid', txnId: slot.matchedTxnId });
    } else {
      items.push({ ...base, date: slot.expectedDate, amount: slot.amount, status: slot.status === 'missing' ? 'missing' : 'upcoming' });
    }
  }

  // instalments: slices charged this month, and the ones still to come
  const charged = c
    .prepare(
      `select t.id, t.txn_date, t.amount_ils, t.account_id, t.merchant_id, t.installment_plan_id plan, t.installment_n n, t.installment_total total
       from "transaction" t where t.installment_plan_id is not null and t.status = 'completed' and t.txn_date between ? and ?`,
    )
    .all(first, last) as Array<{ id: number; txn_date: string; amount_ils: number; account_id: number; merchant_id: number | null; plan: number; n: number | null; total: number | null }>;
  for (const r of charged) {
    items.push({ date: r.txn_date, kind: 'installment', name: `${nameOf(r.merchant_id)}${r.n && r.total ? ` ${r.n}/${r.total}` : ''}`, amount: r.amount_ils, status: 'paid', via: via(r.account_id), planId: r.plan, accountId: r.account_id, txnId: r.id });
  }
  for (const p of db.select().from(installmentPlan).where(eq(installmentPlan.status, 'active')).all()) {
    for (const sl of projectRemainingSlices(p)) {
      if (sl.expectedDate < first || sl.expectedDate > last) continue;
      items.push({ date: sl.expectedDate, kind: 'installment', name: `${nameOf(sl.merchantId)} ${sl.n}/${sl.totalN}`, amount: sl.amount, status: statusOf(sl.expectedDate), via: via(sl.accountId), planId: sl.planId, accountId: sl.accountId });
    }
  }

  // card bills: the card's charges grouped by the day the bank is charged for them
  const bills = c
    .prepare(
      `select t.account_id, t.charge_date, sum(t.amount_ils) total, count(*) n, a.display_name name,
              (select l.from_txn_id from link l join "transaction" x on x.id = l.to_txn_id
                where l.type = 'card_settlement' and coalesce(l.decision, '') <> 'rejected' and x.account_id = t.account_id and x.charge_date = t.charge_date limit 1) debit
       from "transaction" t join account a on a.id = t.account_id
       where a.type = 'credit_card' and t.charge_date between ? and ? and t.status <> 'voided'
       group by t.account_id, t.charge_date`,
    )
    .all(first, last) as Array<{ account_id: number; charge_date: string; total: number; n: number; name: string | null; debit: number | null }>;
  for (const b of bills) {
    const debit = b.debit !== null ? (txnInfo.get(b.debit) as { txn_date: string; amount_ils: number } | undefined) : undefined;
    const base = { kind: 'card_bill' as const, name: b.name ?? '?', via: 'bank' as const, accountId: b.account_id, count: b.n };
    if (debit) items.push({ ...base, date: debit.txn_date, amount: debit.amount_ils, ...(debit.amount_ils !== b.total ? { expected: b.total } : {}), status: 'paid', txnId: b.debit! });
    else items.push({ ...base, date: b.charge_date, amount: b.total, status: statusOf(b.charge_date) });
  }

  // the days of the month, each with what moves (card items are counted once, inside their card bill)
  const byDate = new Map<string, CalendarItem[]>();
  for (const it of items) byDate.set(it.date, [...(byDate.get(it.date) ?? []), it]);
  const days: CalendarDay[] = [];
  const totals = { out: 0, in: 0, paidOut: 0, toComeOut: 0, toComeIn: 0 };
  for (let d = first; d <= last; d = addDays(d, 1)) {
    const list = (byDate.get(d) ?? []).sort((a, b) => a.amount - b.amount);
    let out = 0;
    let inn = 0;
    for (const it of list) {
      if (it.via === 'card' && it.kind !== 'card_bill') continue;
      if (it.amount < 0) out += -it.amount;
      else inn += it.amount;
      if (it.amount < 0 && it.status === 'paid') totals.paidOut += -it.amount;
      if (it.status !== 'paid') {
        if (it.amount < 0) totals.toComeOut += -it.amount;
        else totals.toComeIn += it.amount;
      }
    }
    totals.out += out;
    totals.in += inn;
    days.push({ date: d, items: list, out, in: inn });
  }

  const cal: BillCalendar = { month, today, isCurrentMonth, days, totals };
  if (isCurrentMonth) {
    // the bank (checking) accounts' latest balances, then the bank-side items still to come
    const latest = c
      .prepare(
        `select b.balance, b.taken_at from balance_snapshot b join account a on a.id = b.account_id
         where a.type = 'checking' and b.id = (select id from balance_snapshot x where x.account_id = b.account_id order by x.taken_at desc, x.id desc limit 1)`,
      )
      .all() as Array<{ balance: number; taken_at: string }>;
    if (latest.length) {
      const start = latest.reduce((a, r) => a + r.balance, 0);
      const asOf = latest.map((r) => r.taken_at).sort()[0]!;
      // still due but not seen yet (within the grace days, not missing): it will still leave, so it counts from today
      const bankSide = (it: CalendarItem): boolean => it.via === 'bank' || it.kind === 'card_bill';
      let run = start;
      for (const day of days) if (day.date <= today) for (const it of day.items) if (it.status === 'upcoming' && bankSide(it)) run += it.amount;
      const points: Array<{ date: string; balance: number }> = [{ date: today, balance: run }];
      let lowest = { date: today, balance: run };
      for (const day of days) {
        if (day.date <= today) continue;
        for (const it of day.items) if (it.status !== 'paid' && bankSide(it)) run += it.amount;
        points.push({ date: day.date, balance: run });
        if (run < lowest.balance) lowest = { date: day.date, balance: run };
      }
      cal.balance = { start, asOf, points, lowest };
    }
  }
  return cal;
}
