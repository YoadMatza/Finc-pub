/**
 * Installment plans (§5 step 4c, §7): group "n of N" slices into one plan per purchase, so the
 * remaining slices are known commitments and a refund can be matched against the plan.
 *
 * Plan key: Max identifiers are `ARN_n`, so the ARN is the plan. Other sources get an inferred
 * key from (merchant, total N, full amount, start month), where start month = slice date shifted
 * back by n−1 months. Two parallel plans at the same merchant with the same amounts but different
 * start months stay apart (seen on Isracard: two "speed" 6×225 plans overlapping).
 */
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { Db } from '../db/db.js';
import { nowIso } from '../db/db.js';
import { installmentPlan, transactions } from '../db/schema.js';
import { mergeTransactionInto } from '../ingest/ingest.js';
import { SOURCE_PRECEDENCE, sourceKind } from '../ingest/types.js';

type TxnRow = typeof transactions.$inferSelect;

export function shiftMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

export function planKeyFor(t: Pick<TxnRow, 'source' | 'identifier' | 'merchantId' | 'installmentN' | 'installmentTotal' | 'originalAmount' | 'amountIls' | 'txnDate'>): string {
  if (t.source === 'scraper:max' && t.identifier && t.identifier.includes('_')) return `arn:${t.identifier.slice(0, t.identifier.lastIndexOf('_'))}`;
  const n = t.installmentN ?? 1;
  const total = t.installmentTotal ?? 0;
  // Amount is deliberately NOT part of the key: the first slice often differs by the rounding
  // remainder (963 vs 962), and RiseUp rows carry no full amount at all.
  const startMonth = shiftMonths(t.txnDate, -(n - 1)).slice(0, 7);
  return `inf:${t.merchantId ?? 'm?'}:${total}:${startMonth}`;
}

/**
 * An inferred plan whose slices complement an ARN plan on the same account (same merchant, same N,
 * start months within one month, disjoint slice numbers) is the same purchase seen through another
 * source: fold it into the ARN plan.
 */
function foldShadowPlans(tx: Pick<Db, 'select' | 'update' | 'delete'>, res: InstallmentBuildResult): void {
  const plans = tx.select().from(installmentPlan).all();
  const slicesOf = (id: number) => tx.select({ id: transactions.id, n: transactions.installmentN }).from(transactions).where(eq(transactions.installmentPlanId, id)).all();
  for (const inf of plans.filter((p) => p.planKey.startsWith('inf:'))) {
    const infSlices = slicesOf(inf.id);
    const target = plans.find(
      (p) =>
        p.id !== inf.id &&
        p.planKey.startsWith('arn:') &&
        p.accountId === inf.accountId &&
        p.merchantId === inf.merchantId &&
        p.totalN === inf.totalN &&
        Math.abs(monthIndex(p.firstDate) - monthIndex(inf.firstDate)) <= 1 &&
        !slicesOf(p.id).some((s) => infSlices.some((i) => i.n === s.n)),
    );
    if (!target) continue;
    tx.update(transactions).set({ installmentPlanId: target.id }).where(eq(transactions.installmentPlanId, inf.id)).run();
    const all = slicesOf(target.id);
    const seenN = Math.max(...all.map((s) => s.n ?? 0));
    tx.update(installmentPlan)
      .set({ seenN, status: seenN >= target.totalN ? 'done' : 'active', firstDate: [target.firstDate, inf.firstDate].sort()[0]!, updatedAt: nowIso() })
      .where(eq(installmentPlan.id, target.id))
      .run();
    tx.delete(installmentPlan).where(eq(installmentPlan.id, inf.id)).run();
    res.plansFolded++;
  }
}

const monthIndex = (date: string): number => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7));

export interface InstallmentBuildResult {
  plansCreated: number;
  plansUpdated: number;
  slicesLinked: number;
  duplicatesMerged: number;
  plansFolded: number;
}

export function buildInstallmentPlans(db: Db): InstallmentBuildResult {
  const res: InstallmentBuildResult = { plansCreated: 0, plansUpdated: 0, slicesLinked: 0, duplicatesMerged: 0, plansFolded: 0 };
  db.transaction((tx) => {
    const rows = tx
      .select()
      .from(transactions)
      .where(and(isNotNull(transactions.installmentTotal), sql`${transactions.installmentTotal} > 1`))
      .all()
      .sort((a, b) => SOURCE_PRECEDENCE[sourceKind(b.source)] - SOURCE_PRECEDENCE[sourceKind(a.source)] || a.txnDate.localeCompare(b.txnDate));

    // 1. Lower-source slices that duplicate a higher-source slice (same account, merchant, n/N, amount,
    //    within ±45 days: RiseUp dates slices on their charge day) fold into it.
    const higher = rows.filter((r) => sourceKind(r.source) === 'scraper');
    const alive = new Set(rows.map((r) => r.id));
    for (const r of rows) {
      if (sourceKind(r.source) === 'scraper') continue;
      const twin = higher.find(
        (h) =>
          alive.has(h.id) &&
          h.accountId === r.accountId &&
          h.installmentN === r.installmentN &&
          h.installmentTotal === r.installmentTotal &&
          h.amountIls === r.amountIls &&
          (h.merchantId === r.merchantId || h.merchantId === null || r.merchantId === null) &&
          Math.abs(daysBetween(h.txnDate, r.txnDate)) <= 45 &&
          !(sourceKind(r.source) in parseAnn(h.annotationsJson)),
      );
      if (twin) {
        mergeTransactionInto(tx, r, twin);
        alive.delete(r.id);
        res.duplicatesMerged++;
      }
    }

    // 2. Group the survivors into plans.
    const groups = new Map<string, TxnRow[]>();
    for (const r of rows) {
      if (!alive.has(r.id)) continue;
      const key = `${r.accountId}|${planKeyFor(r)}`;
      const g = groups.get(key) ?? [];
      g.push(r);
      groups.set(key, g);
    }
    for (const [compound, slices] of groups) {
      const planKey = compound.slice(compound.indexOf('|') + 1);
      const first = slices[0]!;
      const totalN = Math.max(...slices.map((s) => s.installmentTotal ?? 0));
      const seenN = Math.max(...slices.map((s) => s.installmentN ?? 0));
      const firstDate = slices.map((s) => shiftMonths(s.txnDate, -((s.installmentN ?? 1) - 1))).sort()[0]!;
      const sliceAmount = median(slices.map((s) => s.amountIls));
      const original = slices.map((s) => s.originalAmount).find((o) => o !== null && o !== 0) ?? sliceAmount * totalN;
      const status = seenN >= totalN ? 'done' : 'active';
      const existing = tx.select().from(installmentPlan).where(and(eq(installmentPlan.accountId, first.accountId), eq(installmentPlan.planKey, planKey))).get();
      let planId: number;
      if (existing) {
        planId = existing.id;
        if (existing.seenN !== seenN || existing.status !== status || existing.totalN !== totalN) {
          tx.update(installmentPlan).set({ seenN, status, totalN, sliceAmount, updatedAt: nowIso() }).where(eq(installmentPlan.id, planId)).run();
          res.plansUpdated++;
        }
      } else {
        const ins = tx
          .insert(installmentPlan)
          .values({ accountId: first.accountId, merchantId: first.merchantId, planKey, totalN, originalAmount: original, sliceAmount, firstDate, seenN, status, createdAt: nowIso(), updatedAt: nowIso() })
          .run();
        planId = Number(ins.lastInsertRowid);
        res.plansCreated++;
      }
      for (const s of slices) {
        if (s.installmentPlanId !== planId) {
          tx.update(transactions).set({ installmentPlanId: planId }).where(eq(transactions.id, s.id)).run();
          res.slicesLinked++;
        }
      }
    }
    foldShadowPlans(tx, res);
    // plans that lost every slice (keys changed) go away
    for (const p of tx.select().from(installmentPlan).all()) {
      const n = tx.select({ id: transactions.id }).from(transactions).where(eq(transactions.installmentPlanId, p.id)).all().length;
      if (n === 0) tx.delete(installmentPlan).where(eq(installmentPlan.id, p.id)).run();
    }
  });
  return res;
}

export interface ProjectedSlice {
  planId: number;
  n: number;
  totalN: number;
  expectedDate: string;
  amount: number;
  merchantId: number | null;
  accountId: number;
}

/** Slices not yet seen, one per month after the last observed one. */
export function projectRemainingSlices(plan: typeof installmentPlan.$inferSelect): ProjectedSlice[] {
  const out: ProjectedSlice[] = [];
  if (plan.status !== 'active') return out;
  for (let n = plan.seenN + 1; n <= plan.totalN; n++) {
    out.push({ planId: plan.id, n, totalN: plan.totalN, expectedDate: shiftMonths(plan.firstDate, n - 1), amount: plan.sliceAmount ?? 0, merchantId: plan.merchantId, accountId: plan.accountId });
  }
  return out;
}

export function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

function parseAnn(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}
