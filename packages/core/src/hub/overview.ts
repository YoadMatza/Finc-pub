/**
 * The hub screen: how the month will end, safe to spend, where the money went, what needs
 * attention, what is coming up. Everything is derived from monthSummary (§7b counting rules) so
 * the numbers here equal the numbers in `finc month`.
 */
import { getSetting, setSetting } from '../ai/settings.js';
import type { Db } from '../db/db.js';
import { daysInMonth } from '../engine/cashflow.js';
import { type MonthSummary, type View, monthSummary } from '../engine/summary.js';
import { syncErrorKind } from '../errors.js';
import { INSTITUTIONS } from '../institutions.js';
import { currentMonth } from '../riseup/client.js';
import { type TxnListItem, listTransactions } from './transactions.js';
import { effectiveGroupTargets } from './targets.js';
import { type BandRow, type Forecast, forecastMonth } from '../engine/forecast.js';
import { type NowIncome, nowIncome } from './now.js';
import { type HubLimit, spendLimitStatus } from './limit.js';
import { VARIABLE_ROW_SQL } from '../engine/paidback.js';
import { collectMoneyAlerts } from '../alerts/money.js';
import { SPLIT_CATEGORY, SPLIT_JOIN, splitShare } from './splits.js';

export type InsightKind = 'missing_fixed' | 'refund_matched' | 'uncategorised' | 'candidate' | 'price_change' | 'big_purchase' | 'unusual_charge' | 'sync_error' | 'stale_sync' | 'integrity' | 'suggested_links' | 'over_target';

/** A scraped institution with no successful sync for longer than this is reported as stale_sync. */
export const STALE_SYNC_HOURS = 36;

export interface Insight {
  key: string;
  kind: InsightKind;
  severity: 'warn' | 'info' | 'ok';
  amount?: number;
  count?: number;
  name?: string;
  date?: string;
  txnId?: number;
  streamId?: number;
  merchantId?: number;
  categoryId?: number;
  institutionId?: string;
  /** previous amount for price changes, target for over_target */
  reference?: number;
}

export interface GroupLine {
  group: string;
  section: string;
  spent: number; // minor, signed (negative = out)
  /** minor, signed: what the whole month is expected to reach; for basis 'targets' this is the target itself */
  expected: number;
  count: number;
  basis: 'actual+expected' | 'targets' | 'history' | 'actual';
}

export interface HubOverview {
  month: string;
  view: View;
  today: string;
  isCurrentMonth: boolean;
  summary: MonthSummary;
  projected: {
    end: number;
    netSoFar: number;
    incomeRemaining: number;
    fixedRemaining: number;
    installmentsRemaining: number;
    variableRemaining: number;
    variableBudget: number;
    variableSpent: number;
    budgetBasis: 'targets' | 'history';
  };
  safeToSpend: { perDay: number; daysLeft: number; remaining: number };
  breakdown: GroupLine[];
  /** cash-grounded left to spend, the pace-based projection with its band, weekly envelope (engine/forecast.ts) */
  forecast: Forecast;
  /** this month's income: regular/extra × received/expected, and the effective kind per income category (hub/now.ts) */
  incomeSplit: NowIncome['incomeSplit'];
  /** left to spend on the regular income alone, and its tone */
  withoutExtra: NowIncome['withoutExtra'];
  /** medians of the last complete months (≥ 3 of the last 6 with data), else null */
  typical: NowIncome['typical'];
  /** the large-extra rule: whether forecast.weekly.envelope / forecast.projected were computed without the extra */
  spread: NowIncome['spread'];
  /** every term of forecast.left with its rows and slots; the amounts sum exactly to forecast.left */
  explain: NowIncome['explain'];
  /** the month's payments marked as paid back (hub/paidback.ts): counted against day-to-day spending, never as income */
  paidBack: NowIncome['paidBack'];
  /** the monthly spending limit on variable spending (hub/limit.ts); null when none applies or for a future month */
  limit: HubLimit | null;
  /** variable spend through the same day of the previous month, and the 6-month typical by this day */
  comparison: { lastMonthSameDay: number; lastMonthTotal: number; typicalSameDay: number | null; dayOfMonth: number; prevMonth: string };
  attention: Insight[];
  upcoming: Array<{ date: string; amount: number; name: string; kind: 'fixed' | 'installment' | 'income'; streamId?: number; planId?: number; status: 'upcoming' | 'missing' }>;
  recent: TxnListItem[];
  daily: Array<{ date: string; out: number; cumulative: number }>;
  months: { first: string; last: string };
}

/** A row that day-to-day spending counts: money out (not savings), or money paid back to the owner (engine/paidback.ts), which nets it. */
const VARIABLE_ROW = VARIABLE_ROW_SQL;

const DISMISSED_SETTING = 'ui.dismissedInsights';

export function dismissedInsights(db: Db): Set<string> {
  try {
    return new Set(JSON.parse(getSetting(db, DISMISSED_SETTING) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

export function dismissInsight(db: Db, key: string): void {
  const s = dismissedInsights(db);
  s.add(key);
  setSetting(db, DISMISSED_SETTING, JSON.stringify([...s].slice(-500)));
}

export function todayLocal(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function lastCompleteMonths(month: string, n: number): string[] {
  const out: string[] = [];
  let [y, m] = month.split('-').map(Number) as [number, number];
  for (let i = 0; i < n; i++) {
    m--;
    if (m === 0) {
      m = 12;
      y--;
    }
    out.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  return out;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

export function hubOverview(db: Db, monthArg?: string, view: View = 'purchase', opts: { now?: Date } = {}): HubOverview {
  const now = opts.now ?? new Date();
  const today = todayLocal(now);
  const month = monthArg ?? currentMonth();
  const isCurrentMonth = month === today.slice(0, 7);
  const s = monthSummary(db, month, view);
  const c = db.$client;

  // --- variable budget: per group, a target when one is set (group target, else the sum of category
  // targets), else the median of the last 3 complete months for that group; no targets at all → the
  // median of the total.
  const effTargets = effectiveGroupTargets(db);
  const history = lastCompleteMonths(month, 3);
  const variableHistory = history.map((m) => {
    const r = c
      .prepare(
        `select coalesce(sum(t.amount_ils),0) v from "transaction" t
         where t.cashflow_month = ? and t.status = 'completed' and t.excluded = 0 and ${VARIABLE_ROW} and t.installment_plan_id is null
           and (t.recurring_stream_id is null or not exists (select 1 from recurring_stream rs where rs.id = t.recurring_stream_id and rs.state = 'confirmed'))`,
      )
      .get(m) as { v: number };
    return -r.v;
  });
  const variableSpent = -s.variable.sum;
  const installmentsRemaining = s.expectedInstallments.reduce((a, e) => a + e.amount, 0);
  const [y, m] = month.split('-').map(Number) as [number, number];
  const dim = daysInMonth(y, m);
  const dayOfMonth = isCurrentMonth ? Number(today.slice(8, 10)) : dim;
  const daysLeft = Math.max(1, dim - dayOfMonth + 1);

  // --- breakdown by group: actual this month, expected for the whole month
  const groupRows = c
    .prepare(
      `select coalesce(c.group_key, 'uncategorised') g, coalesce(c.section, 'variable') section, count(*) n, sum(${splitShare('t.amount_ils')}) v
       from "transaction" t join account a on a.id = t.account_id ${SPLIT_JOIN} left join category c on c.id = ${SPLIT_CATEGORY}
       where ${view === 'billing' ? `(case when a.type = 'credit_card' then substr(coalesce(t.charge_date, t.txn_date), 1, 7) else t.cashflow_month end)` : 't.cashflow_month'} = ?
         and t.status = 'completed' and t.excluded = 0 and t.amount_ils < 0 and coalesce(t.kind,'') <> 'savings' and t.installment_plan_id is null
       group by 1, 2`,
    )
    .all(month) as Array<{ g: string; section: string; n: number; v: number }>;
  const groupTargets = new Map([...effTargets.entries()].map(([g, v]) => [g, v.target]));
  const groupHistory = new Map<string, number[]>();
  for (const hm of history) {
    const rows = c
      .prepare(
        `select coalesce(c.group_key, 'uncategorised') g, sum(${splitShare('t.amount_ils')}) v from "transaction" t ${SPLIT_JOIN} left join category c on c.id = ${SPLIT_CATEGORY}
         where t.cashflow_month = ? and t.status = 'completed' and t.excluded = 0 and t.amount_ils < 0 and coalesce(t.kind,'') <> 'savings' and t.installment_plan_id is null group by 1`,
      )
      .all(hm) as Array<{ g: string; v: number }>;
    for (const r of rows) groupHistory.set(r.g, [...(groupHistory.get(r.g) ?? []), r.v]);
  }
  const breakdown: GroupLine[] = [];
  breakdown.push({ group: 'fixed', section: 'fixed', spent: s.fixed.sum, expected: s.fixed.sum + s.expectedFixedRemaining, count: s.fixed.count, basis: 'actual+expected' });
  breakdown.push({ group: 'installments', section: 'fixed', spent: s.installments.sum, expected: s.installments.sum + installmentsRemaining, count: s.installments.count, basis: 'actual+expected' });
  breakdown.push({ group: 'savings', section: 'savings', spent: s.savings.sum, expected: s.savings.sum, count: s.savings.count, basis: 'actual' });
  // variable groups: exclude rows that belong to confirmed streams (those are "fixed" above)
  const variableByGroup = c
    .prepare(
      `select coalesce(c.group_key, 'uncategorised') g, count(*) n, sum(${splitShare('t.amount_ils')}) v
       from "transaction" t join account a on a.id = t.account_id ${SPLIT_JOIN} left join category c on c.id = ${SPLIT_CATEGORY}
       where ${view === 'billing' ? `(case when a.type = 'credit_card' then substr(coalesce(t.charge_date, t.txn_date), 1, 7) else t.cashflow_month end)` : 't.cashflow_month'} = ?
         and t.status = 'completed' and t.excluded = 0 and t.amount_ils < 0 and coalesce(t.kind,'') <> 'savings' and t.installment_plan_id is null
         and (t.recurring_stream_id is null or not exists (select 1 from recurring_stream rs where rs.id = t.recurring_stream_id and rs.state = 'confirmed'))
       group by 1`,
    )
    .all(month) as Array<{ g: string; n: number; v: number }>;
  const allGroups = new Set([...variableByGroup.map((r) => r.g), ...groupTargets.keys(), ...groupHistory.keys()]);
  let budgetFromGroups = 0;
  let anyTarget = false;
  for (const g of allGroups) {
    if (['fixed', 'installments', 'savings', 'income', 'transfers'].includes(g)) continue;
    const row = variableByGroup.find((r) => r.g === g);
    const spent = row?.v ?? 0;
    const target = groupTargets.get(g);
    const hist = groupHistory.get(g) ?? [];
    const expected = target !== undefined ? -target : hist.length ? median(hist) : spent;
    if (target !== undefined) anyTarget = true;
    budgetFromGroups += -expected;
    // with a target, show the target itself (so spend past it reads as over); otherwise the month
    // is expected to reach at least what is already spent
    breakdown.push({ group: g, section: groupRows.find((r) => r.g === g)?.section ?? 'variable', spent, expected: target !== undefined ? expected : Math.min(expected, spent), count: row?.n ?? 0, basis: target !== undefined ? 'targets' : hist.length ? 'history' : 'actual' });
  }
  breakdown.sort((a, b) => a.spent - b.spent);
  const budgetBasis: 'targets' | 'history' = anyTarget ? 'targets' : 'history';
  const variableBudget = anyTarget ? Math.round(budgetFromGroups) : median(variableHistory);

  // --- comparisons: same day last month, and the typical cumulative spend by this day (6 months)
  const prevMonth = `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, '0')}`;
  const prevDim = daysInMonth(Number(prevMonth.slice(0, 4)), Number(prevMonth.slice(5, 7)));
  const sameDay = `${prevMonth}-${String(Math.min(dayOfMonth, prevDim)).padStart(2, '0')}`;
  const variableWhere = `t.cashflow_month = ? and t.status = 'completed' and t.excluded = 0 and ${VARIABLE_ROW} and t.installment_plan_id is null
           and (t.recurring_stream_id is null or not exists (select 1 from recurring_stream rs where rs.id = t.recurring_stream_id and rs.state = 'confirmed'))`;
  const cmpSame = c.prepare(`select coalesce(sum(t.amount_ils),0) v from "transaction" t where ${variableWhere} and t.txn_date <= ?`).get(prevMonth, sameDay) as { v: number };
  const cmpTotal = c.prepare(`select coalesce(sum(t.amount_ils),0) v from "transaction" t where ${variableWhere}`).get(prevMonth) as { v: number };
  const typicalRows = lastCompleteMonths(month, 6).map((hm) => {
    const hd = `${hm}-${String(Math.min(dayOfMonth, daysInMonth(Number(hm.slice(0, 4)), Number(hm.slice(5, 7))))).padStart(2, '0')}`;
    return -(c.prepare(`select coalesce(sum(t.amount_ils),0) v from "transaction" t where ${variableWhere} and t.txn_date <= ?`).get(hm, hd) as { v: number }).v;
  });
  const comparison = { lastMonthSameDay: -cmpSame.v, lastMonthTotal: -cmpTotal.v, typicalSameDay: median(typicalRows) || null, dayOfMonth, prevMonth };

  // --- the forecast: cash in vs cash out, usual-pace projection with its band
  const sectionOf = new Map((c.prepare('select id, section from category').all() as Array<{ id: number; section: string }>).map((r) => [r.id, r.section]));
  const expectedSavingsRemaining = s.expectedFixed.filter((sl) => sl.status !== 'matched' && sl.direction === 'expense' && sectionOf.get(sl.categoryId ?? -1) === 'savings').reduce((a, sl) => a + sl.amount, 0);
  // refund-netted variable totals of the last 3 complete months, same definition as this month's "spent"
  const nettedHistory = history.map((hm) => -monthSummary(db, hm, view).variable.sum);
  const weekStart = addDays(today, -new Date(`${today}T00:00:00Z`).getUTCDay()); // Sunday
  const spentThisWeek = -(c.prepare(`select coalesce(sum(t.amount_ils),0) v from "transaction" t where ${variableWhere} and t.txn_date >= ? and t.txn_date <= ?`).get(month, weekStart, today) as { v: number }).v;
  const bandRaw = getSetting(db, 'forecast.band');
  let band: BandRow[] | undefined;
  if (bandRaw) {
    try {
      const parsed = JSON.parse(bandRaw) as { rows?: BandRow[] };
      if (Array.isArray(parsed.rows) && parsed.rows.length >= 2) band = parsed.rows;
    } catch {
      /* seed band */
    }
  }
  const baseForecast = forecastMonth({ summary: s, today, variableHistory: nettedHistory, typicalByToday: comparison.typicalSameDay, spentThisWeek: isCurrentMonth ? spentThisWeek || 0 : 0, expectedSavingsRemaining, ...(band ? { band } : {}) });
  // the income split, without-extra, typical month, explain; the large-extra rule may move the weekly envelope and the
  // projection to the regular part (the headline left never changes)
  const now_ = nowIncome(db, { month, view, today, summary: s, forecast: baseForecast });
  const forecast = now_.forecast;
  const variableRemaining = forecast.variable.remaining;
  const projectedEnd = forecast.projected.end;
  const safeToSpend = { perDay: isCurrentMonth && forecast.left > 0 ? Math.floor(forecast.left / daysLeft) : 0, daysLeft: isCurrentMonth ? daysLeft : 0, remaining: Math.max(0, forecast.left) };

  // --- upcoming 14 days (current month and next)
  const horizon = addDays(today, 14);
  const upcoming: HubOverview['upcoming'] = [];
  const nextM = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}`;
  const slotMonths = isCurrentMonth ? [month, nextM] : [month];
  for (const sm of slotMonths) {
    const slots = sm === month ? s.expectedFixed : monthSummary(db, sm, view).expectedFixed;
    for (const slot of slots) {
      if (slot.status === 'matched') continue;
      if (slot.expectedDate > horizon && slot.status !== 'missing') continue;
      if (!isCurrentMonth && slot.status === 'upcoming') continue;
      const mer = c.prepare('select name from merchant where id = ?').get(slot.merchantId) as { name: string } | undefined;
      const stream = c.prepare('select label from recurring_stream where id = ?').get(slot.streamId) as { label: string | null } | undefined;
      upcoming.push({ date: slot.expectedDate, amount: slot.amount, name: stream?.label ?? mer?.name ?? '?', kind: slot.direction === 'income' ? 'income' : 'fixed', streamId: slot.streamId, status: slot.status });
    }
  }
  for (const sl of s.expectedInstallments) {
    if (sl.expectedDate <= horizon || !isCurrentMonth) {
      const mer = sl.merchantId ? (c.prepare('select name from merchant where id = ?').get(sl.merchantId) as { name: string } | undefined) : undefined;
      upcoming.push({ date: sl.expectedDate, amount: sl.amount, name: `${mer?.name ?? '?'} ${sl.n}/${sl.totalN}`, kind: 'installment', planId: sl.planId, status: sl.expectedDate < today ? 'missing' : 'upcoming' });
    }
  }
  upcoming.sort((a, b) => a.date.localeCompare(b.date));

  // --- daily cumulative out (for the month line)
  const dailyRows = c
    .prepare(
      `select t.txn_date d, sum(t.amount_ils) v from "transaction" t
       where t.cashflow_month = ? and t.status = 'completed' and t.excluded = 0 and t.amount_ils < 0 and coalesce(t.kind,'') <> 'savings' group by 1 order by 1`,
    )
    .all(month) as Array<{ d: string; v: number }>;
  let cum = 0;
  const daily = dailyRows.map((r) => {
    cum += -r.v;
    return { date: r.d, out: -r.v, cumulative: cum };
  });

  const recent = listTransactions(db, { month, view, limit: 12 }).items;
  const range = c.prepare(`select min(cashflow_month) a, max(cashflow_month) b from "transaction"`).get() as { a: string | null; b: string | null };

  return {
    month,
    view,
    today,
    isCurrentMonth,
    summary: s,
    projected: { end: projectedEnd, netSoFar: s.net, incomeRemaining: s.expectedIncomeRemaining, fixedRemaining: s.expectedFixedRemaining, installmentsRemaining, variableRemaining: -variableRemaining, variableBudget, variableSpent, budgetBasis },
    safeToSpend,
    breakdown,
    forecast,
    incomeSplit: now_.incomeSplit,
    withoutExtra: now_.withoutExtra,
    typical: now_.typical,
    spread: now_.spread,
    explain: now_.explain,
    paidBack: now_.paidBack,
    limit: spendLimitStatus(db, { month, view, today, spent: variableSpent }),
    comparison,
    attention: insights(db, s, month, today, isCurrentMonth, breakdown, now),
    upcoming,
    recent,
    daily,
    months: { first: range.a ?? month, last: range.b && range.b > month ? range.b : month },
  };
}

function insights(db: Db, s: MonthSummary, month: string, today: string, isCurrentMonth: boolean, breakdown: GroupLine[], now: Date): Insight[] {
  const c = db.$client;
  const out: Insight[] = [];
  const dismissed = dismissedInsights(db);
  const merchantName = (id: number) => (c.prepare('select name from merchant where id = ?').get(id) as { name: string } | undefined)?.name ?? '?';

  for (const slot of s.expectedFixed.filter((x) => x.status === 'missing')) {
    out.push({ key: `missing:${slot.streamId}:${month}`, kind: 'missing_fixed', severity: 'warn', amount: slot.amount, name: merchantName(slot.merchantId), date: slot.expectedDate, streamId: slot.streamId });
  }
  // refunds matched in the last 14 days
  const refunds = c
    .prepare(
      `select l.id, l.amount, l.created_at, p.description_raw, p.id pid, m.name mname from link l join "transaction" p on p.id = l.to_txn_id left join merchant m on m.id = p.merchant_id
       where l.type in ('refund','cancellation') and l.zone = 'auto' and coalesce(l.decision,'') <> 'rejected' and l.amount >= 500 and l.created_at >= ? order by l.created_at desc limit 5`,
    )
    .all(`${addDays(today, -14)}T00:00:00`) as Array<{ id: number; amount: number; created_at: string; description_raw: string; pid: number; mname: string | null }>;
  for (const r of refunds) out.push({ key: `refund:${r.id}`, kind: 'refund_matched', severity: 'ok', amount: r.amount, name: r.mname ?? r.description_raw, txnId: r.pid });

  const uncat = c.prepare(`select count(*) n from "transaction" where excluded = 0 and status = 'completed' and category_id is null and cashflow_month = ?`).get(month) as { n: number };
  if (uncat.n) out.push({ key: `uncat:${month}:${uncat.n}`, kind: 'uncategorised', severity: 'info', count: uncat.n });

  const links = c.prepare(`select count(*) n from link where zone = 'suggest' and decision is null and type in ('refund','cancellation')`).get() as { n: number };
  if (links.n) out.push({ key: `links:${links.n}`, kind: 'suggested_links', severity: 'info', count: links.n });

  const cands = c.prepare(`select rs.id, rs.expected_amount, rs.frequency, m.name from recurring_stream rs join merchant m on m.id = rs.merchant_id where rs.state = 'candidate' order by abs(rs.expected_amount) desc limit 5`).all() as Array<{ id: number; expected_amount: number; frequency: string; name: string }>;
  for (const r of cands) out.push({ key: `cand:${r.id}`, kind: 'candidate', severity: 'info', amount: r.expected_amount, name: r.name, streamId: r.id });

  // price change: the latest charge of a confirmed stream is outside its tolerance, upwards
  const priced = c
    .prepare(
      `select rs.id, rs.expected_amount, rs.amount_tolerance, t.amount_ils, t.txn_date, m.name from recurring_stream rs join "transaction" t on t.id = rs.last_txn_id join merchant m on m.id = rs.merchant_id
       where rs.state = 'confirmed' and rs.direction = 'expense' and rs.original_currency is null and abs(t.amount_ils) > abs(rs.expected_amount) + rs.amount_tolerance and t.txn_date >= ?`,
    )
    .all(addDays(today, -45)) as Array<{ id: number; expected_amount: number; amount_tolerance: number; amount_ils: number; txn_date: string; name: string }>;
  for (const r of priced) out.push({ key: `price:${r.id}:${r.txn_date}`, kind: 'price_change', severity: 'warn', amount: r.amount_ils, reference: r.expected_amount, name: r.name, date: r.txn_date, streamId: r.id });

  // big one-off purchases this month (variable, > 3× the month's median variable row and > ₪1,000)
  const big = c
    .prepare(
      `select t.id, t.amount_ils, t.txn_date, coalesce(m.name, t.description_raw) name from "transaction" t left join merchant m on m.id = t.merchant_id
       where t.cashflow_month = ? and t.status = 'completed' and t.excluded = 0 and t.amount_ils < -100000 and t.installment_plan_id is null and coalesce(t.kind,'') not in ('savings')
         and (t.recurring_stream_id is null or not exists (select 1 from recurring_stream rs where rs.id = t.recurring_stream_id and rs.state = 'confirmed'))
       order by t.amount_ils asc limit 3`,
    )
    .all(month) as Array<{ id: number; amount_ils: number; txn_date: string; name: string }>;
  for (const r of big) out.push({ key: `big:${r.id}`, kind: 'big_purchase', severity: 'info', amount: r.amount_ils, name: r.name, date: r.txn_date, txnId: r.id });

  // charges far above that merchant's usual this month (the same rule as the Telegram alert, alerts/money.ts)
  const f = Number(getSetting(db, 'alerts.unusualFactor'));
  const unusualFactor = Number.isInteger(f) && f >= 2 && f <= 10 ? f : undefined;
  for (const u of collectMoneyAlerts(db, { since: '', month, ...(unusualFactor ? { unusualFactor } : {}) }).filter((a) => a.kind === 'unusual_charge').slice(0, 5)) {
    out.push({ key: `unusual:${u.txnId}`, kind: 'unusual_charge', severity: 'warn', amount: u.amount, reference: u.reference ?? 0, count: u.detail ?? 0, name: u.name, date: u.date, txnId: u.txnId });
  }

  for (const g of breakdown) {
    if (g.basis !== 'targets' || g.section !== 'variable') continue;
    // amounts are negative: spent below the (negative) target means more was spent than the target
    if (g.spent < g.expected) out.push({ key: `over:${g.group}:${month}`, kind: 'over_target', severity: 'warn', amount: g.spent, reference: g.expected, name: g.group });
  }

  // one key per outage: stable while the failures continue, new after the next success
  // name: the error KIND (syncErrorKind), never the error text: this insight becomes a Telegram message (P2-09)
  const errors = c
    .prepare(
      `select cn.institution_id, cn.consecutive_failures, cn.last_ok_at,
         coalesce((select r.error_type from sync_run r where r.id = cn.last_run_id), substr(cn.last_error, 1, instr(cn.last_error, ':') - 1)) error_type
       from connection cn where cn.last_error is not null and (cn.last_ok_at is null or cn.last_error_at > cn.last_ok_at) and cn.enabled = 1`,
    )
    .all() as Array<{ institution_id: string; error_type: string | null; consecutive_failures: number; last_ok_at: string | null }>;
  for (const e of errors) out.push({ key: `sync:${e.institution_id}:${e.last_ok_at ?? 'never'}`, kind: 'sync_error', severity: 'warn', institutionId: e.institution_id, name: syncErrorKind(e.error_type), count: e.consecutive_failures });

  // stale: an enabled scraped institution with no successful sync for STALE_SYNC_HOURS; one that never
  // succeeded counts from its first sync attempt (no attempts at all = not set up yet, not stale)
  const scraped = Object.values(INSTITUTIONS).filter((i) => i.scraperId).map((i) => i.id);
  const staleBefore = now.getTime() - STALE_SYNC_HOURS * 3600_000;
  const conns = c
    .prepare(
      `select cn.institution_id, cn.last_ok_at, cn.consecutive_failures, (select min(r.started_at) from sync_run r where r.institution_id = cn.institution_id) first_run
       from connection cn where cn.enabled = 1 and cn.institution_id in (${scraped.map(() => '?').join(',')})`,
    )
    .all(...scraped) as Array<{ institution_id: string; last_ok_at: string | null; consecutive_failures: number; first_run: string | null }>;
  for (const cn of conns) {
    const since = cn.last_ok_at ?? cn.first_run;
    if (!since || Date.parse(since) >= staleBefore) continue;
    out.push({
      key: `stale:${cn.institution_id}:${cn.last_ok_at ?? 'never'}`,
      kind: 'stale_sync',
      severity: 'warn',
      institutionId: cn.institution_id,
      ...(cn.last_ok_at ? { date: todayLocal(new Date(cn.last_ok_at)) } : {}),
      count: Math.floor((now.getTime() - Date.parse(since)) / 3600_000),
    });
  }

  if (!s.integrity.ok || s.integrity.unmatchedSettlementDebits.length) out.push({ key: `integrity:${month}`, kind: 'integrity', severity: 'warn', count: s.integrity.unmatchedSettlementDebits.length });

  void isCurrentMonth;
  const order: Record<Insight['severity'], number> = { warn: 0, info: 1, ok: 2 };
  return out.filter((i) => !dismissed.has(i.key)).sort((a, b) => order[a.severity] - order[b.severity]);
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
