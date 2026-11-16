/**
 * Yearly report (research_notes/proposals/yearly-report.md, approved 2026-11-16, static): one page per year. Every
 * money number is summed from monthSummary (and its classified rows), so a year adds up to exactly the months the
 * Now screen and Trends show. Paid-back rows net spending inside their category and are never income, as there.
 * The current year is "so far": the months to date, the current one marked partial.
 */
import type { Db } from '../db/db.js';
import { type ClassifiedRow, type MonthSummary, type View, classifyMonthRows, monthSummary, monthsBetween } from '../engine/summary.js';
import { listEvents } from './events.js';
import { netWorthAt } from './networth.js';
import { addDays, todayLocal } from './overview.js';

export interface YearMonth {
  month: string;
  income: number; // minor, positive
  /** fixed + variable + installments (minor, positive; paid back already netted) */
  spending: number;
  /** money moved to savings (minor, positive) */
  savings: number;
  out: number; // spending + savings, as Trends draws it
  net: number; // signed, = monthSummary.net
  partial: boolean;
  hasData: boolean;
}

export interface YearTotals {
  income: number;
  spending: number;
  savings: number;
  out: number;
  net: number;
  /** income − spending: what was not spent, the money moved to savings included */
  saved: number;
  /** saved / income, 0..1 (negative when spending passed income); null without income */
  savingsRate: number | null;
  /** paid back to the owner during the year (already netted out of spending, shown for the record) */
  paidBack: number;
  /** months with data that count in the totals */
  months: number;
}

export interface YearCategory {
  key: string;
  nameHe: string;
  nameEn: string;
  total: number; // minor, positive spend
  /** the same months a year earlier; null when that period has no data */
  previous: number | null;
}

export interface YearGroup {
  key: string;
  section: string;
  total: number;
  previous: number | null;
  /** the group's biggest categories, at most five */
  categories: YearCategory[];
}

export interface YearStream {
  id: number;
  name: string;
  frequency: string;
  state: string;
  /** what it actually cost during the year (minor, positive) */
  cost: number;
  count: number;
  firstDate: string;
  lastDate: string;
  /** first charged this year (and data reaches far enough back to know) */
  isNew: boolean;
  /** last charged this year and over since */
  ended: boolean;
}

export interface YearlyReport {
  year: number;
  today: string;
  view: View;
  /** the current year: totals are "so far" */
  partial: boolean;
  /** no full month of data in the year: everything below is empty */
  empty: boolean;
  /** years that have data, newest first (the current year always included) */
  availableYears: number[];
  months: YearMonth[];
  totals: YearTotals;
  /** best and worst finished month by net (needs two) */
  best: { month: string; net: number } | null;
  worst: { month: string; net: number } | null;
  /** the same months a year earlier, when they have data */
  previous: { year: number; months: number; income: number; spending: number; saved: number } | null;
  groups: YearGroup[];
  merchants: Array<{ merchantId: number | null; name: string; total: number; count: number }>;
  fixed: {
    total: number;
    streams: YearStream[];
    priceChanges: Array<{ streamId: number; name: string; from: number; to: number; date: string }>;
  };
  big: {
    purchases: Array<{ txnId: number; date: string; name: string; amount: number }>;
    plans: Array<{ id: number; name: string; firstDate: string; totalN: number; total: number }>;
    events: Array<{ id: number; name: string; spent: number; net: number; firstDate: string | null; lastDate: string | null; count: number }>;
  };
  /** start (end of the previous year) and end of the year (today for the current one); null where no balance was recorded */
  netWorth: { start: NetWorthPoint | null; end: NetWorthPoint | null };
}

export interface NetWorthPoint {
  date: string;
  total: number;
  assets: number;
  liabilities: number;
}

interface CategoryRow {
  id: number;
  key: string;
  name_he: string;
  name_en: string;
  group_key: string;
  section: string;
}

const UNCAT: CategoryRow = { id: -1, key: 'uncategorised', name_he: 'ללא קטגוריה', name_en: 'Uncategorised', group_key: 'uncategorised', section: 'variable' };

/** Days per cadence: how long after the last charge a stream counts as over, how far back data must reach for "new". */
const PERIOD_DAYS: Record<string, number> = { weekly: 7, biweekly: 14, monthly: 31, bimonthly: 62, quarterly: 92, annual: 366 };

const hasData = (s: MonthSummary) => s.income.count + s.expense.count + s.installments.count + s.savings.count > 0;
const spendingOf = (s: MonthSummary) => -(s.fixed.sum + s.variable.sum + s.installments.sum);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const SPEND_BUCKETS = new Set(['fixed', 'variable', 'installments']);

function emptyTotals(): YearTotals {
  return { income: 0, spending: 0, savings: 0, out: 0, net: 0, saved: 0, savingsRate: null, paidBack: 0, months: 0 };
}

/** Spend per category of a set of months (positive), the same rule as Trends: debits only, income categories left out. */
function spendByCategory(summaries: MonthSummary[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const s of summaries) {
    for (const c of s.byCategory) {
      if (c.sum >= 0) continue; // credits, income and fully paid-back categories are not spend
      if (c.section === 'income') continue;
      const id = c.categoryId ?? UNCAT.id;
      out.set(id, (out.get(id) ?? 0) - c.sum);
    }
  }
  return out;
}

export function yearlyReport(db: Db, year: number, opts: { today?: string; view?: View } = {}): YearlyReport {
  const today = opts.today ?? todayLocal();
  const view = opts.view ?? 'purchase';
  const current = today.slice(0, 7);
  const thisYear = Number(today.slice(0, 4));
  const c = db.$client;
  const availableYears = [...new Set([thisYear, ...(c.prepare(`select distinct cast(substr(cashflow_month, 1, 4) as integer) y from "transaction" where status = 'completed'`).all() as Array<{ y: number }>).map((r) => r.y)])]
    .filter((y) => y <= thisYear)
    .sort((a, b) => b - a);

  const partial = year === thisYear;
  const base: YearlyReport = {
    year,
    today,
    view,
    partial,
    empty: true,
    availableYears,
    months: [],
    totals: emptyTotals(),
    best: null,
    worst: null,
    previous: null,
    groups: [],
    merchants: [],
    fixed: { total: 0, streams: [], priceChanges: [] },
    big: { purchases: [], plans: [], events: [] },
    netWorth: { start: null, end: null },
  };
  if (year > thisYear) return base;

  const list = monthsBetween(`${year}-01`, partial ? current : `${year}-12`);
  const summaries = list.map((m) => monthSummary(db, m, view));
  const months: YearMonth[] = summaries.map((s) => {
    const spending = spendingOf(s);
    const savings = -s.savings.sum;
    return { month: s.month, income: s.income.sum, spending, savings, out: spending + savings, net: s.net, partial: s.month === current, hasData: hasData(s) };
  });
  // a year needs at least one finished month with data; the current month alone is not enough (proposal)
  if (!months.some((m) => m.hasData && !m.partial)) return { ...base, months };

  const totals = emptyTotals();
  for (const [i, m] of months.entries()) {
    totals.income += m.income;
    totals.spending += m.spending;
    totals.savings += m.savings;
    totals.out += m.out;
    totals.net += m.net;
    if (m.hasData) totals.months++;
    for (const bc of summaries[i]!.byCategory) totals.paidBack += bc.paidBack;
  }
  totals.saved = totals.income - totals.spending;
  totals.savingsRate = totals.income > 0 ? totals.saved / totals.income : null;

  const finished = months.filter((m) => m.hasData && !m.partial);
  const byNet = [...finished].sort((a, b) => b.net - a.net);
  const best = byNet.length >= 2 ? { month: byNet[0]!.month, net: byNet[0]!.net } : null;
  const worst = byNet.length >= 2 ? { month: byNet[byNet.length - 1]!.month, net: byNet[byNet.length - 1]!.net } : null;

  // the same months a year earlier: a partial year is compared with the same stretch, not a whole year
  const prevList = list.map((m) => `${year - 1}${m.slice(4)}`);
  const prevSummaries = prevList.map((m) => monthSummary(db, m, view));
  const prevMonths = prevSummaries.filter(hasData).length;
  const previous =
    prevMonths > 0
      ? (() => {
          const income = prevSummaries.reduce((a, s) => a + s.income.sum, 0);
          const spending = prevSummaries.reduce((a, s) => a + spendingOf(s), 0);
          return { year: year - 1, months: prevMonths, income, spending, saved: income - spending };
        })()
      : null;

  // where it went: groups and their biggest categories, against the same months a year earlier
  const cats = new Map<number, CategoryRow>((c.prepare('select id, key, name_he, name_en, group_key, section from category').all() as CategoryRow[]).map((r) => [r.id, r]));
  const catOf = (id: number) => cats.get(id) ?? UNCAT;
  const now = spendByCategory(summaries);
  const then = previous ? spendByCategory(prevSummaries) : null;
  const groupMap = new Map<string, YearGroup>();
  const groupOf = (cat: CategoryRow) => {
    const g = groupMap.get(cat.group_key) ?? { key: cat.group_key, section: cat.section, total: 0, previous: then ? 0 : null, categories: [] };
    groupMap.set(cat.group_key, g);
    return g;
  };
  for (const [id, total] of now) {
    const cat = catOf(id);
    const g = groupOf(cat);
    g.total += total;
    g.categories.push({ key: cat.key, nameHe: cat.name_he, nameEn: cat.name_en, total, previous: then ? (then.get(id) ?? 0) : null });
  }
  // a group spent on only last year still shows its previous total (a cost that went away is news too)
  if (then) for (const [id, total] of then) groupOf(catOf(id)).previous! += total;
  const groups = [...groupMap.values()]
    .map((g) => ({ ...g, categories: g.categories.sort((a, b) => b.total - a.total).slice(0, 5) }))
    .sort((a, b) => b.total - a.total || (b.previous ?? 0) - (a.previous ?? 0));

  // the rows of the year, bucketed exactly as monthSummary counts them (refunds netted)
  const rows: ClassifiedRow[] = list.flatMap((m) => classifyMonthRows(db, m, view));
  const merchantNames = new Map((c.prepare('select id, name from merchant').all() as Array<{ id: number; name: string }>).map((r) => [r.id, r.name]));
  const nameOf = (t: ClassifiedRow['t']) => (t.merchantId !== null ? merchantNames.get(t.merchantId) : undefined) ?? t.descriptionRaw;

  // top merchants: spend rows only (paid-back money is an inflow, not a merchant's charge)
  const merch = new Map<string, { merchantId: number | null; name: string; total: number; count: number }>();
  for (const r of rows) {
    if (!SPEND_BUCKETS.has(r.bucket) || r.t.kind === 'paid_back') continue;
    const k = r.t.merchantId !== null ? `m:${r.t.merchantId}` : `d:${r.t.descriptionNorm}`;
    const e = merch.get(k) ?? { merchantId: r.t.merchantId, name: nameOf(r.t), total: 0, count: 0 };
    e.total -= r.amount;
    e.count++;
    merch.set(k, e);
  }
  const merchants = [...merch.values()]
    .filter((m) => m.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  // fixed costs: expense streams the owner kept (confirmed, or since paused or ended) charged during the year
  const streamRows = c
    .prepare(
      `select rs.id, rs.frequency, rs.state, rs.amount_model, rs.amount_tolerance, coalesce(rs.label, m.name) name,
         (select min(t.txn_date) from "transaction" t where t.recurring_stream_id = rs.id and t.status = 'completed') first_ever,
         (select max(t.txn_date) from "transaction" t where t.recurring_stream_id = rs.id and t.status = 'completed') last_ever
       from recurring_stream rs left join merchant m on m.id = rs.merchant_id
       where rs.direction = 'expense' and rs.state in ('confirmed', 'paused', 'ended')`,
    )
    .all() as Array<{ id: number; frequency: string; state: string; amount_model: string; amount_tolerance: number; name: string | null; first_ever: string | null; last_ever: string | null }>;
  const dataStart = (c.prepare(`select min(txn_date) d from "transaction" where status = 'completed'`).get() as { d: string | null }).d;
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const streams: YearStream[] = [];
  const priceChanges: YearlyReport['fixed']['priceChanges'] = [];
  for (const s of streamRows) {
    const charges = rows.filter((r) => r.t.recurringStreamId === s.id && r.bucket !== 'excluded' && r.bucket !== 'income').sort((a, b) => a.t.txnDate.localeCompare(b.t.txnDate));
    if (!charges.length) continue;
    const name = s.name ?? nameOf(charges[0]!.t);
    const period = PERIOD_DAYS[s.frequency] ?? 31;
    const isNew = !!s.first_ever && !!dataStart && s.first_ever >= yearStart && daysBetween(dataStart, s.first_ever) > period;
    const ended = !!s.last_ever && s.last_ever <= yearEnd && (s.state !== 'confirmed' || daysBetween(s.last_ever, today) > period * 1.5);
    streams.push({ id: s.id, name, frequency: s.frequency, state: s.state, cost: -charges.reduce((a, r) => a + r.amount, 0), count: charges.length, firstDate: charges[0]!.t.txnDate, lastDate: charges[charges.length - 1]!.t.txnDate, isNew, ended });
    // price changes: a fixed-price stream whose charge moved past its tolerance (or 2%) from one charge to the next
    if (s.amount_model !== 'fixed') continue;
    for (let i = 1; i < charges.length; i++) {
      const from = -charges[i - 1]!.amount;
      const to = -charges[i]!.amount;
      if (Math.abs(to - from) > Math.max(s.amount_tolerance, Math.round(Math.abs(from) * 0.02))) priceChanges.push({ streamId: s.id, name, from, to, date: charges[i]!.t.txnDate });
    }
  }
  streams.sort((a, b) => b.cost - a.cost);
  priceChanges.sort((a, b) => a.date.localeCompare(b.date));

  // big moments: the largest one-off purchases, instalment plans started, events of the year
  const purchases = rows
    .filter((r) => r.bucket === 'variable' && r.t.kind !== 'paid_back' && r.amount < 0)
    .sort((a, b) => a.amount - b.amount)
    .slice(0, 5)
    .map((r) => ({ txnId: r.t.id, date: r.t.txnDate, name: nameOf(r.t), amount: -r.amount }));
  const plans = (
    c
      .prepare(
        `select p.id, p.first_date, p.total_n, p.original_amount, p.slice_amount,
           coalesce(m.name, (select t.description_raw from "transaction" t where t.installment_plan_id = p.id order by t.txn_date limit 1)) name
         from installment_plan p left join merchant m on m.id = p.merchant_id
         where p.first_date between ? and ? and p.status <> 'cancelled'`,
      )
      .all(yearStart, yearEnd) as Array<{ id: number; first_date: string; total_n: number; original_amount: number | null; slice_amount: number | null; name: string | null }>
  )
    .map((p) => ({ id: p.id, name: p.name ?? '', firstDate: p.first_date, totalN: p.total_n, total: Math.abs(p.original_amount ?? (p.slice_amount ?? 0) * p.total_n) }))
    .sort((a, b) => b.total - a.total);
  // an event belongs to the year when its tagged rows (or, untagged, its dates) touch it; archived ones count too
  const events = listEvents(db, { includeArchived: true })
    .filter((e) => {
      const from = e.firstDate ?? e.fromDate;
      const to = e.lastDate ?? e.toDate ?? from;
      return e.count > 0 && !!from && !!to && from <= yearEnd && to >= yearStart;
    })
    .map((e) => ({ id: e.id, name: e.name, spent: e.spent, net: e.net, firstDate: e.firstDate, lastDate: e.lastDate, count: e.count }))
    .sort((a, b) => b.spent - a.spent);

  const netWorth = {
    start: netWorthAt(db, addDays(yearStart, -1), { today }),
    end: netWorthAt(db, partial ? today : yearEnd, { today }),
  };

  return {
    ...base,
    empty: false,
    months,
    totals,
    best,
    worst,
    previous,
    groups,
    merchants,
    fixed: { total: streams.reduce((a, s) => a + s.cost, 0), streams, priceChanges },
    big: { purchases, plans, events },
    netWorth,
  };
}
