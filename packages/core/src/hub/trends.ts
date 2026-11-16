/**
 * Trends (design §6): monthly in / out / net over 12–24 months, group and category series, a Sankey
 * of one month (income → groups → categories) and a year-over-year view. Everything is derived from
 * monthSummary so the numbers agree with Now and Categories.
 */
import type { Db } from '../db/db.js';
import { type MonthSummary, type View, monthSummary, monthsBetween } from '../engine/summary.js';
import { median } from '../engine/forecast.js';
import { todayLocal } from './overview.js';

export interface TrendMonth {
  month: string;
  income: number; // minor, positive
  fixed: number; // minor, positive (spend)
  variable: number;
  installments: number;
  savings: number;
  out: number; // fixed + variable + installments + savings
  net: number; // signed
  /** the current month: not finished, so lighter on charts */
  partial: boolean;
}

export interface TrendSeries {
  key: string;
  section: string;
  /** spend per month (minor, positive), aligned with `months` */
  series: number[];
  total: number;
  /** median of the finished months in the window */
  median: number;
  last: number; // last finished month
  prev: number; // the one before it
}

export interface CategorySeries extends TrendSeries {
  nameHe: string;
  nameEn: string;
  group: string;
}

export interface SankeyNode {
  key: string;
  /** paid_back: money paid back to the owner for a shared expense; it flows in beside income but is not income */
  kind: 'income' | 'paid_back' | 'pool' | 'group' | 'category' | 'left' | 'deficit';
  nameHe: string;
  nameEn: string;
}

export interface TrendsOverview {
  months: TrendMonth[];
  groups: TrendSeries[];
  categories: CategorySeries[];
  sankey: { month: string; nodes: SankeyNode[]; links: Array<{ source: number; target: number; value: number }> };
  yoy: {
    /** the last 12 months against the same months a year earlier */
    rows: Array<{ month: string; now: { income: number; out: number; net: number } | null; then: { income: number; out: number; net: number } | null }>;
    now: { income: number; out: number; net: number; months: number };
    then: { income: number; out: number; net: number; months: number };
  };
  /** the one-line story: variable spend first vs last finished month in the window, and the window's net */
  story: { months: number; variableFirst: number; variableLast: number; netSum: number } | null;
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

function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

const spendOf = (s: MonthSummary) => ({
  fixed: -s.fixed.sum,
  variable: -s.variable.sum,
  installments: -s.installments.sum,
  savings: -s.savings.sum,
});

export function trendsOverview(db: Db, opts: { months?: number; view?: View; sankeyMonth?: string; today?: string } = {}): TrendsOverview {
  const today = opts.today ?? todayLocal();
  const current = today.slice(0, 7);
  const n = Math.min(36, Math.max(3, opts.months ?? 12));
  const view = opts.view ?? 'purchase';
  const list = monthsBetween(addMonths(current, -(n - 1)), current);
  const summaries = new Map(list.map((m) => [m, monthSummary(db, m, view)]));
  const cats = new Map<number, CategoryRow>((db.$client.prepare('select id, key, name_he, name_en, group_key, section from category').all() as CategoryRow[]).map((c) => [c.id, c]));

  const months: TrendMonth[] = list.map((month) => {
    const s = summaries.get(month)!;
    const sp = spendOf(s);
    const out = sp.fixed + sp.variable + sp.installments + sp.savings;
    return { month, income: s.income.sum, ...sp, out, net: s.net, partial: month === current };
  });

  // per group / per category spend series (abs, expenses only; income categories excluded)
  const groupSeries = new Map<string, { section: string; series: number[] }>();
  const catSeries = new Map<number, number[]>();
  list.forEach((month, i) => {
    const s = summaries.get(month)!;
    for (const c of s.byCategory) {
      if (c.sum >= 0) continue; // credits and income are not spend
      const cat = c.categoryId === null ? UNCAT : (cats.get(c.categoryId) ?? UNCAT);
      if (cat.section === 'income') continue;
      const g = groupSeries.get(cat.group_key) ?? { section: cat.section, series: new Array<number>(list.length).fill(0) };
      g.series[i] = (g.series[i] ?? 0) - c.sum;
      groupSeries.set(cat.group_key, g);
      const cs = catSeries.get(cat.id) ?? new Array<number>(list.length).fill(0);
      cs[i] = (cs[i] ?? 0) - c.sum;
      catSeries.set(cat.id, cs);
    }
  });
  const finished = list.map((m, i) => (m === current ? -1 : i)).filter((i) => i >= 0);
  const stats = (series: number[]) => {
    const fin = finished.map((i) => series[i] ?? 0);
    return { total: series.reduce((a, b) => a + b, 0), median: Math.round(median(fin) ?? 0), last: fin[fin.length - 1] ?? 0, prev: fin[fin.length - 2] ?? 0 };
  };
  const groups: TrendSeries[] = [...groupSeries.entries()].map(([key, g]) => ({ key, section: g.section, series: g.series, ...stats(g.series) })).sort((a, b) => b.total - a.total);
  const categories: CategorySeries[] = [...catSeries.entries()]
    .map(([id, series]) => {
      const c = cats.get(id) ?? UNCAT;
      return { key: c.key, nameHe: c.name_he, nameEn: c.name_en, group: c.group_key, section: c.section, series, ...stats(series) };
    })
    .sort((a, b) => b.total - a.total);

  // Sankey of one month: income categories → pool → groups → categories (+ left over / deficit)
  const sMonth = opts.sankeyMonth ?? (list.length > 1 ? list[list.length - 2]! : current);
  const sankey = buildSankey(summaries.get(sMonth) ?? monthSummary(db, sMonth, view), cats);

  // year over year: last 12 months vs the same months a year earlier
  const last12 = monthsBetween(addMonths(current, -11), current);
  const total = (ms: string[]) => {
    const acc = { income: 0, out: 0, net: 0, months: 0 };
    for (const m of ms) {
      const s = summaries.get(m) ?? monthSummary(db, m, view);
      if (!summaries.has(m)) summaries.set(m, s);
      const sp = spendOf(s);
      acc.income += s.income.sum;
      acc.out += sp.fixed + sp.variable + sp.installments + sp.savings;
      acc.net += s.net;
      acc.months++;
    }
    return acc;
  };
  const point = (m: string) => {
    const s = summaries.get(m) ?? monthSummary(db, m, view);
    if (!summaries.has(m)) summaries.set(m, s);
    if (s.income.count + s.expense.count + s.installments.count + s.savings.count === 0) return null;
    const sp = spendOf(s);
    return { income: s.income.sum, out: sp.fixed + sp.variable + sp.installments + sp.savings, net: s.net };
  };
  const rows = last12.map((m) => ({ month: m, now: point(m), then: point(addMonths(m, -12)) }));
  const yoy = { rows, now: total(last12), then: total(last12.map((m) => addMonths(m, -12))) };

  const fin = months.filter((m) => !m.partial);
  const story = fin.length >= 2 ? { months: fin.length, variableFirst: fin[0]!.variable, variableLast: fin[fin.length - 1]!.variable, netSum: fin.reduce((a, m) => a + m.net, 0) } : null;

  return { months, groups, categories, sankey: { month: sMonth, ...sankey }, yoy, story };
}

function buildSankey(s: MonthSummary, cats: Map<number, CategoryRow>): { nodes: SankeyNode[]; links: Array<{ source: number; target: number; value: number }> } {
  const nodes: SankeyNode[] = [];
  const links: Array<{ source: number; target: number; value: number }> = [];
  const idx = new Map<string, number>();
  const node = (n: SankeyNode): number => {
    const k = `${n.kind}:${n.key}`;
    if (!idx.has(k)) {
      idx.set(k, nodes.length);
      nodes.push(n);
    }
    return idx.get(k)!;
  };
  const pool = node({ key: 'pool', kind: 'pool', nameHe: 'הכנסות', nameEn: 'Income' });
  let incomeTotal = 0;
  let outTotal = 0;
  const byGroup = new Map<string, { section: string; total: number; cats: Array<{ cat: CategoryRow; sum: number }> }>();
  // paid back to me nets spending everywhere else (Now, limit, forecast), so it is never drawn as income: one inflow of
  // its own beside the income sources (fixes the Sankey showing a paid-back Bit as income, 2026-11-12)
  let paidBack = 0;
  for (const c of s.byCategory) {
    const cat = c.categoryId === null ? UNCAT : (cats.get(c.categoryId) ?? UNCAT);
    paidBack += c.paidBack;
    const sum = c.sum - c.paidBack;
    if (sum > 0) {
      if (cat.section !== 'income') continue; // a credit inside a spend category was netted already; skip the rest
      const i = node({ key: cat.key, kind: 'income', nameHe: cat.name_he, nameEn: cat.name_en });
      links.push({ source: i, target: pool, value: sum });
      incomeTotal += sum;
      continue;
    }
    if (sum === 0 || cat.section === 'income') continue;
    const g = byGroup.get(cat.group_key) ?? { section: cat.section, total: 0, cats: [] };
    g.total += -sum;
    g.cats.push({ cat, sum: -sum });
    byGroup.set(cat.group_key, g);
  }
  outTotal = [...byGroup.values()].reduce((a, g) => a + g.total, 0);
  if (paidBack > 0) {
    links.push({ source: node({ key: 'paid_back', kind: 'paid_back', nameHe: 'הוחזר לי', nameEn: 'Paid back to me' }), target: pool, value: paidBack });
    incomeTotal += paidBack; // what flows into the pool; still not income
  }
  // a category gets its own ribbon only when it is visible: at least 3% of the month's spend, four per group at most
  const minShown = outTotal * 0.03;
  for (const [key, g] of [...byGroup.entries()].sort((a, b) => b[1].total - a[1].total)) {
    const gi = node({ key, kind: 'group', nameHe: key, nameEn: key });
    links.push({ source: pool, target: gi, value: g.total });
    // a small group (under 6% of the month) stays a leaf: fanning it out would only add hairlines
    if (g.total < minShown * 2) continue;
    const sorted = g.cats.sort((a, b) => b.sum - a.sum);
    const firstSmall = sorted.findIndex((c) => c.sum < minShown);
    const cut = Math.min(4, firstSmall === -1 ? sorted.length : firstSmall);
    if (cut === 0) continue;
    const shown = sorted.slice(0, cut);
    const rest = sorted.slice(cut).reduce((a, c) => a + c.sum, 0);
    for (const c of shown) links.push({ source: gi, target: node({ key: c.cat.key, kind: 'category', nameHe: c.cat.name_he, nameEn: c.cat.name_en }), value: c.sum });
    if (rest > 0) links.push({ source: gi, target: node({ key: `${key}.rest`, kind: 'category', nameHe: 'שאר הקטגוריות', nameEn: 'Other categories' }), value: rest });
  }
  if (incomeTotal > outTotal) {
    links.push({ source: pool, target: node({ key: 'left', kind: 'left', nameHe: 'נשאר', nameEn: 'Left over' }), value: incomeTotal - outTotal });
  } else if (outTotal > incomeTotal) {
    links.push({ source: node({ key: 'deficit', kind: 'deficit', nameHe: 'מהיתרה', nameEn: 'From the balance' }), target: pool, value: outTotal - incomeTotal });
  }
  return { nodes, links };
}
