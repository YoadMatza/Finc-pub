/** Categories screen: spent against target, pace, six-month sparkline, top merchants. */
import type { Db } from '../db/db.js';
import { groupTargets } from './targets.js';
import { daysInMonth } from '../engine/cashflow.js';
import { currentMonth } from '../riseup/client.js';
import { todayLocal } from './overview.js';
import { SPLIT_CATEGORY, SPLIT_JOIN, splitShare } from './splits.js';

export interface CategoryView {
  id: number;
  key: string;
  nameHe: string;
  nameEn: string;
  group: string;
  section: string;
  icon: string | null;
  track: boolean;
  monthlyTarget: number | null;
  sortOrder: number;
  spent: number; // minor, signed, this month (refunds netted)
  count: number;
  /** target × share of the month elapsed (minor, positive) */
  paceTarget: number | null;
  sparkline: Array<{ month: string; sum: number }>;
  topMerchants: Array<{ merchantId: number | null; name: string; sum: number; count: number }>;
}

export interface CategoriesOverview {
  month: string;
  elapsedShare: number;
  /** target = the effective group target (explicit group target, else the sum of category targets); groupTarget = the explicit one */
  groups: Array<{ key: string; section: string; spent: number; target: number | null; groupTarget: number | null; categories: CategoryView[] }>;
}

export function categoriesOverview(db: Db, monthArg?: string): CategoriesOverview {
  const c = db.$client;
  const month = monthArg ?? currentMonth();
  const today = todayLocal();
  const [y, m] = month.split('-').map(Number) as [number, number];
  const dim = daysInMonth(y, m);
  const elapsedShare = month === today.slice(0, 7) ? Number(today.slice(8, 10)) / dim : month < today.slice(0, 7) ? 1 : 0;
  const months: string[] = [];
  for (let i = 5; i >= 0; i--) {
    let yy = y;
    let mm = m - i;
    while (mm <= 0) {
      mm += 12;
      yy--;
    }
    months.push(`${yy}-${String(mm).padStart(2, '0')}`);
  }
  const NET = `t.amount_ils + coalesce((select sum(l.amount) from link l where l.to_txn_id = t.id and l.type in ('refund','cancellation') and l.zone = 'auto' and coalesce(l.decision,'') <> 'rejected'), 0)`;
  const cats = c.prepare('select * from category order by sort_order, id').all() as Array<Record<string, unknown>>;
  const sums = c
    .prepare(
      // a split transaction counts in each of its parts' categories (hub/splits.ts)
      `select ${SPLIT_CATEGORY} cid, t.cashflow_month mo, count(*) n, sum(${splitShare(NET)}) v from "transaction" t ${SPLIT_JOIN}
       where t.status = 'completed' and t.excluded = 0 and t.cashflow_month in (${months.map(() => '?').join(',')}) group by 1, 2`,
    )
    .all(...months) as Array<{ cid: number | null; mo: string; n: number; v: number }>;
  const tops = c
    .prepare(
      `select ${SPLIT_CATEGORY} cid, t.merchant_id mid, coalesce(m.name, t.description_raw) name, count(*) n, sum(${splitShare(NET)}) v from "transaction" t ${SPLIT_JOIN} left join merchant m on m.id = t.merchant_id
       where t.status = 'completed' and t.excluded = 0 and t.cashflow_month = ? group by 1, 2, 3 order by abs(sum(${splitShare(NET)})) desc`,
    )
    .all(month) as Array<{ cid: number | null; mid: number | null; name: string; n: number; v: number }>;

  const views: CategoryView[] = cats.map((r) => {
    const id = r.id as number;
    const cur = sums.find((s) => s.cid === id && s.mo === month);
    const target = (r.monthly_target as number | null) ?? null;
    return {
      id,
      key: r.key as string,
      nameHe: r.name_he as string,
      nameEn: r.name_en as string,
      group: r.group_key as string,
      section: r.section as string,
      icon: (r.icon as string | null) ?? null,
      track: (r.track as number) === 1,
      monthlyTarget: target,
      sortOrder: r.sort_order as number,
      spent: cur?.v ?? 0,
      count: cur?.n ?? 0,
      paceTarget: target !== null ? Math.round(target * elapsedShare) : null,
      sparkline: months.map((mo) => ({ month: mo, sum: sums.find((s) => s.cid === id && s.mo === mo)?.v ?? 0 })),
      topMerchants: tops
        .filter((t) => t.cid === id)
        .slice(0, 5)
        .map((t) => ({ merchantId: t.mid, name: t.name, sum: t.v, count: t.n })),
    };
  });
  const uncat = sums.find((s) => s.cid === null && s.mo === month);
  if (uncat) {
    views.push({
      id: 0,
      key: 'uncategorised',
      nameHe: 'ללא קטגוריה',
      nameEn: 'Uncategorised',
      group: 'uncategorised',
      section: 'variable',
      icon: '❔',
      track: true,
      monthlyTarget: null,
      sortOrder: 999,
      spent: uncat.v,
      count: uncat.n,
      paceTarget: null,
      sparkline: months.map((mo) => ({ month: mo, sum: sums.find((s) => s.cid === null && s.mo === mo)?.v ?? 0 })),
      topMerchants: tops
        .filter((t) => t.cid === null)
        .slice(0, 5)
        .map((t) => ({ merchantId: t.mid, name: t.name, sum: t.v, count: t.n })),
    });
  }
  const explicit = groupTargets(db);
  const groups = new Map<string, CategoriesOverview['groups'][number]>();
  for (const v of views) {
    const g = groups.get(v.group) ?? { key: v.group, section: v.section, spent: 0, target: null, groupTarget: explicit.get(v.group) ?? null, categories: [] };
    g.spent += v.spent;
    if (v.monthlyTarget !== null) g.target = (g.target ?? 0) + v.monthlyTarget;
    g.categories.push(v);
    groups.set(v.group, g);
  }
  for (const g of groups.values()) if (g.groupTarget !== null) g.target = g.groupTarget;
  return { month, elapsedShare, groups: [...groups.values()] };
}

export function updateCategory(db: Db, id: number, patch: { monthlyTarget?: number | null; nameHe?: string; nameEn?: string; track?: boolean; icon?: string | null }): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.monthlyTarget !== undefined) {
    sets.push('monthly_target = ?');
    params.push(patch.monthlyTarget);
  }
  if (patch.nameHe !== undefined) {
    sets.push('name_he = ?');
    params.push(patch.nameHe);
  }
  if (patch.nameEn !== undefined) {
    sets.push('name_en = ?');
    params.push(patch.nameEn);
  }
  if (patch.track !== undefined) {
    sets.push('track = ?');
    params.push(patch.track ? 1 : 0);
  }
  if (patch.icon !== undefined) {
    sets.push('icon = ?');
    params.push(patch.icon);
  }
  if (!sets.length) return;
  params.push(id);
  const r = db.$client.prepare(`update category set ${sets.join(', ')} where id = ?`).run(...params);
  if (!r.changes) throw new Error(`no category #${id}`);
}
