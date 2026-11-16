/**
 * Recurring streams (architecture §7, §7b): group a merchant's charges on one account, detect the
 * cadence from the gaps, model the amount (fixed, variable-bounded, or FX by original currency),
 * and keep a state machine: candidate → confirmed → ended, with user overrides. Expected
 * occurrences are derived from the stream, never stored as transactions, and a real charge
 * CONSUMES its slot (§7b rule 2), so nothing is counted twice.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/db.js';
import { nowIso } from '../db/db.js';
import { category, merchant, recurringStream, transactions } from '../db/schema.js';
import { daysBetween, shiftMonths } from './installments.js';
// Person-to-person money (Bit, PayBox, "credit from <name>") is never a fixed expense or fixed income.
import { PERSON_TO_PERSON } from './p2p.js';

export type Frequency = 'weekly' | 'biweekly' | 'monthly' | 'bimonthly' | 'quarterly' | 'annual';

const CADENCES: Array<{ f: Frequency; days: number; minHits: number }> = [
  { f: 'weekly', days: 7, minHits: 4 },
  { f: 'biweekly', days: 14, minHits: 3 },
  { f: 'monthly', days: 30.4, minHits: 2 },
  // Rarer cadences need a third hit: two visits to a shop a year (or two months) apart are not a stream.
  { f: 'bimonthly', days: 60.8, minHits: 3 },
  { f: 'quarterly', days: 91.3, minHits: 3 },
  { f: 'annual', days: 365, minHits: 3 },
];

type TxnRow = typeof transactions.$inferSelect;

export interface CadenceFit {
  frequency: Frequency;
  intervalDays: number;
  /** share of gaps within ±25% of the cadence */
  fit: number;
}

export function detectCadence(dates: string[]): CadenceFit | null {
  if (dates.length < 2) return null;
  const sorted = [...dates].sort();
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(daysBetween(sorted[i - 1]!, sorted[i]!));
  const median = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)]!;
  let best: CadenceFit | null = null;
  for (const c of CADENCES) {
    if (Math.abs(median - c.days) / c.days > 0.25) continue;
    if (dates.length < c.minHits) continue;
    const fit = gaps.filter((g) => Math.abs(g - c.days) / c.days <= 0.25).length / gaps.length;
    if (!best || fit > best.fit) best = { frequency: c.f, intervalDays: c.days, fit };
  }
  return best && best.fit >= 0.5 ? best : null;
}

export interface AmountModel {
  model: 'fixed' | 'variable';
  expected: number; // minor, signed
  tolerance: number; // minor
  cv: number;
}

/**
 * Robust to a one-off outlier (a big purchase at a subscription merchant): the model is built on the
 * rows within 30% of the median, provided they are most of the group.
 */
export function modelAmounts(amounts: number[]): AmountModel | null {
  if (!amounts.length) return null;
  const allAbs = amounts.map(Math.abs).sort((a, b) => a - b);
  const med0 = allAbs[Math.floor(allAbs.length / 2)]!;
  if (med0 === 0) return null;
  const abs = allAbs.filter((x) => Math.abs(x - med0) / med0 <= 0.3);
  if (abs.length < 2 || abs.length / allAbs.length < 0.6) return null;
  const mean = abs.reduce((s, x) => s + x, 0) / abs.length;
  const sd = Math.sqrt(abs.reduce((s, x) => s + (x - mean) ** 2, 0) / abs.length);
  const cv = sd / mean;
  const sortedAbs = abs;
  const median = sortedAbs[Math.floor(sortedAbs.length / 2)]!;
  const sign = amounts[0]! < 0 ? -1 : 1;
  if (cv < 0.05) return { model: 'fixed', expected: sign * median, tolerance: Math.max(Math.round(median * 0.05), 200), cv };
  if (cv < 0.5) return { model: 'variable', expected: sign * median, tolerance: Math.round((sortedAbs[sortedAbs.length - 1]! - sortedAbs[0]!) / 2) + 100, cv };
  return null;
}

export interface RecurringBuildResult {
  groupsExamined: number;
  created: number;
  updated: number;
  ended: number;
  /** candidates (never confirmed) that no longer form a stream and were deleted */
  dropped: number;
  rowsAssigned: number;
}

const VARIABLE_SECTIONS = new Set(['variable']);

export function buildRecurringStreams(db: Db, opts: { today?: string } = {}): RecurringBuildResult {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const res: RecurringBuildResult = { groupsExamined: 0, created: 0, updated: 0, ended: 0, dropped: 0, rowsAssigned: 0 };
  db.transaction((tx) => {
    const cats = new Map(tx.select().from(category).all().map((c) => [c.id, c]));
    const rows = tx
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.status, 'completed'),
          eq(transactions.excluded, false),
          sql`${transactions.merchantId} is not null`,
          sql`${transactions.installmentPlanId} is null`,
          // paid back (engine/paidback.ts) is not income: never part of a recurring income stream
          sql`coalesce(${transactions.kind}, '') not in ('settlement', 'transfer', 'refund', 'ignore', 'paid_back')`,
        ),
      )
      .all();
    const p2pMerchants = new Set(
      tx
        .select({ id: merchant.id, name: merchant.name, key: merchant.key })
        .from(merchant)
        .all()
        .filter((m) => PERSON_TO_PERSON.test(m.name) || PERSON_TO_PERSON.test(m.key))
        .map((m) => m.id),
    );
    const groups = new Map<string, TxnRow[]>();
    for (const r of rows) {
      if (r.merchantId !== null && p2pMerchants.has(r.merchantId)) continue;
      const key = `${r.accountId}|${r.merchantId}|${r.amountIls < 0 ? 'expense' : 'income'}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    const existing = tx.select().from(recurringStream).all();
    const seenStreamIds = new Set<number>();

    // A merchant that bills several things (an insurer with five policies, a platform with several
    // subscriptions) is several streams: split each group into amount clusters first.
    // A price change (gaps plan 1.8) puts the new charges in another amount cluster; chainPriceSteps joins a later
    // cluster that starts on the stream's next expected date back onto it, as a new price step.
    const clustered = new Map<string, { steps: TxnRow[][] }>();
    for (const [key, members] of groups) {
      if (members.length < 2) continue;
      res.groupsExamined++;
      const useFxForCluster = fxMajority(members) !== null;
      const amountOf = (m: TxnRow): number => Math.abs(useFxForCluster ? (m.originalAmount ?? m.amountIls) : m.amountIls);
      // a small price change stays in the old amount cluster: split it off first (splitPriceTail), then chain
      chainPriceSteps(clusterByAmount(members, amountOf).flatMap((c) => splitPriceTail(c, amountOf)), amountOf).forEach((c, i) => {
        if (c.steps.reduce((n, st) => n + st.length, 0) >= 2) clustered.set(`${key}|${i}`, c);
      });
    }

    for (const [key, { steps }] of clustered) {
      const [accountId, merchantId, direction, clusterIdx] = key.split('|') as [string, string, 'expense' | 'income', string];
      const sorted = steps.flat().sort((a, b) => a.txnDate.localeCompare(b.txnDate));
      // FX stream: model on the original currency when most rows share one non-ILS currency
      const fxCurrency = fxMajority(sorted);
      const useFx = fxCurrency !== null;
      const amountIn = (m: TxnRow): number => (useFx ? (m.originalAmount ?? m.amountIls) : m.amountIls);
      // the price the stream expects: the latest step once it has two charges, else the one before (so the first charge
      // at a new price still shows as a price change against the old expectation)
      const latest = steps[steps.length - 1]!;
      const modelRows = steps.length === 1 || latest.length >= 2 ? latest : steps[steps.length - 2]!;
      const amount = modelAmounts(modelRows.map(amountIn));
      if (!amount) continue;
      // keep only rows that fit their own step's amount model (a one-off big purchase at a subscription merchant is not
      // part of the stream); a step of one charge is kept as it is, chainPriceSteps already checked it
      const fitting = steps
        .flatMap((st) => {
          const m = st.length >= 2 ? modelAmounts(st.map(amountIn)) : null;
          return m ? st.filter((r) => Math.abs(Math.abs(amountIn(r)) - Math.abs(m.expected)) <= m.tolerance) : st;
        })
        .sort((a, b) => a.txnDate.localeCompare(b.txnDate));
      if (fitting.length < 2) continue;
      const modelSet = new Set(modelRows.map((r) => r.id));
      const cadence = detectCadence(fitting.map((m) => m.txnDate));
      if (!cadence || cadence.fit < 0.6) continue;
      const catId = majorityNum(fitting.map((m) => m.categoryId).filter((c): c is number => c !== null));
      const cat = catId !== null ? cats.get(catId) : undefined;
      // variable-spend categories (supermarket, eating out, shopping) only form streams when the amount is fixed
      if (cat && VARIABLE_SECTIONS.has(cat.section) && amount.model !== 'fixed') continue;
      if (!cat && amount.model !== 'fixed') continue;

      const last = fitting[fitting.length - 1]!;
      const ilsAmounts = fitting.filter((m) => modelSet.has(m.id)).map((m) => m.amountIls);
      const ilsModel = modelAmounts(ilsAmounts) ?? { expected: last.amountIls, tolerance: Math.round(Math.abs(last.amountIls) * 0.1), model: 'variable' as const, cv: 1 };
      const expectedDay = cadence.frequency === 'monthly' || cadence.frequency === 'bimonthly' || cadence.frequency === 'quarterly' || cadence.frequency === 'annual' ? medianDay(fitting.map((m) => m.txnDate)) : null;
      const nextExpected = nextDate(last.txnDate, cadence, expectedDay);
      const endedByGap = daysBetween(last.txnDate, today) > cadence.intervalDays * 1.5 + 7;
      const autoState = endedByGap ? 'ended' : fitting.length >= 3 && cadence.fit >= 0.75 ? 'confirmed' : 'candidate';

      // the same stream across runs: same account, merchant, direction and an expected amount within tolerance
      // after a price step the stream may still be stored at an earlier price: any step's price finds it
      const stepPrices = steps.map((st) => modelAmounts(st.map((m) => m.amountIls))?.expected ?? st[st.length - 1]!.amountIls);
      const prev =
        existing.find((s) => !seenStreamIds.has(s.id) && s.accountId === Number(accountId) && s.merchantId === Number(merchantId) && s.direction === direction && Math.abs(s.expectedAmount - ilsModel.expected) <= Math.max(s.amountTolerance, ilsModel.tolerance)) ??
        existing.find((s) => !seenStreamIds.has(s.id) && s.accountId === Number(accountId) && s.merchantId === Number(merchantId) && s.direction === direction && stepPrices.some((p) => Math.abs(s.expectedAmount - p) <= Math.max(s.amountTolerance, Math.round(Math.abs(p) * 0.05)))) ??
        (clusterIdx === '0' ? existing.find((s) => !seenStreamIds.has(s.id) && s.accountId === Number(accountId) && s.merchantId === Number(merchantId) && s.direction === direction && s.stateSource === 'user') : undefined);
      const values = {
        accountId: Number(accountId),
        merchantId: Number(merchantId),
        categoryId: catId,
        frequency: cadence.frequency,
        expectedAmount: ilsModel.expected,
        amountTolerance: useFx ? Math.max(ilsModel.tolerance, Math.round(Math.abs(ilsModel.expected) * 0.1)) : ilsModel.tolerance,
        amountModel: amount.model,
        originalCurrency: useFx ? fxCurrency : null,
        expectedOriginalAmount: useFx ? amount.expected : null,
        expectedDay,
        nextExpectedDate: nextExpected,
        lastTxnDate: last.txnDate,
        lastTxnId: last.id,
        occurrences: fitting.length,
        direction,
        updatedAt: nowIso(),
      };
      let streamId: number;
      if (prev && prev.stateSource !== 'user' && prev.state === 'candidate' && autoState === 'ended') {
        // a candidate that went quiet was never a stream: drop it rather than listing it as "ended"
        dropStream(prev.id);
        seenStreamIds.add(prev.id);
        continue;
      }
      if (prev) {
        streamId = prev.id;
        const state = prev.stateSource === 'user' ? prev.state : autoState;
        tx.update(recurringStream).set({ ...values, state }).where(eq(recurringStream.id, prev.id)).run();
        res.updated++;
        if (state === 'ended' && prev.state !== 'ended') res.ended++;
        if (state === 'rejected') {
          seenStreamIds.add(streamId);
          tx.update(transactions).set({ recurringStreamId: null }).where(eq(transactions.recurringStreamId, streamId)).run();
          continue;
        }
      } else {
        const ins = tx.insert(recurringStream).values({ ...values, state: autoState, stateSource: 'auto', createdAt: nowIso() }).run();
        streamId = Number(ins.lastInsertRowid);
        res.created++;
      }
      seenStreamIds.add(streamId);
      const ids = fitting.map((m) => m.id);
      const r = tx
        .update(transactions)
        .set({ recurringStreamId: streamId })
        .where(and(inArray(transactions.id, ids), sql`coalesce(${transactions.recurringStreamId}, -1) <> ${streamId}`))
        .run();
      res.rowsAssigned += r.changes;
      // rows that no longer fit leave the stream
      tx.update(transactions)
        .set({ recurringStreamId: null })
        .where(and(eq(transactions.recurringStreamId, streamId), sql`${transactions.id} not in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`))
        .run();
    }
    // Streams whose group disappeared (merchant re-keyed, thresholds tightened): a confirmed one ends,
    // a candidate never was a stream and is dropped, unless the user pinned it. Auto "ended" streams that
    // never reached confirmation (fewer than three occurrences) are dropped the same way.
    for (const s of existing) {
      if (seenStreamIds.has(s.id) || s.stateSource === 'user') continue;
      // its charges now belong to another stream (an earlier or later price step, gaps plan 1.8): nothing is left of it
      const left = tx.select({ n: sql<number>`count(*)` }).from(transactions).where(eq(transactions.recurringStreamId, s.id)).get();
      if (!left?.n && s.occurrences > 0) {
        dropStream(s.id);
        continue;
      }
      if (s.state === 'candidate' || (s.state === 'ended' && s.occurrences < 3)) {
        dropStream(s.id);
        continue;
      }
      if (s.state === 'ended') continue;
      tx.update(recurringStream).set({ state: 'ended', updatedAt: nowIso() }).where(eq(recurringStream.id, s.id)).run();
      res.ended++;
    }

    function dropStream(id: number): void {
      tx.update(transactions).set({ recurringStreamId: null }).where(eq(transactions.recurringStreamId, id)).run();
      tx.delete(recurringStream).where(eq(recurringStream.id, id)).run();
      res.dropped++;
    }
  });
  return res;
}

export interface ExpectedSlot {
  streamId: number;
  merchantId: number;
  categoryId: number | null;
  expectedDate: string;
  amount: number; // minor, signed
  direction: 'income' | 'expense';
  matchedTxnId: number | null;
  status: 'matched' | 'upcoming' | 'missing';
}

/**
 * Expected occurrences of confirmed streams in a month, each consumed by the real charge that
 * matches it (same stream, same month for monthly-or-slower cadences; ±4 days for weekly ones).
 * A slot whose date passed more than `graceDays` ago without a match is "missing" (one per stream).
 */
export function expectedSlots(db: Db, month: string, opts: { today?: string; graceDays?: number } = {}): ExpectedSlot[] {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const grace = opts.graceDays ?? 7;
  const streams = db.select().from(recurringStream).where(eq(recurringStream.state, 'confirmed')).all();
  const out: ExpectedSlot[] = [];
  const [y, m] = month.split('-').map(Number) as [number, number];
  const monthStart = `${month}-01`;
  const monthEnd = `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
  for (const s of streams) {
    const slots = slotsInMonth(s, month, monthStart, monthEnd);
    if (!slots.length) continue;
    const actual = db
      .select({ id: transactions.id, date: transactions.txnDate })
      .from(transactions)
      .where(and(eq(transactions.recurringStreamId, s.id), eq(transactions.status, 'completed'), sql`${transactions.cashflowMonth} = ${month}`))
      .all()
      .sort((a, b) => a.date.localeCompare(b.date));
    const used = new Set<number>();
    // Income: a salary that landed outside the stream's amount tolerance is not linked to the stream,
    // but it is still this month's salary. Count any unlinked income row of the month within
    // 0.7–1.4× the expected amount as the slot's match, so the hub never expects a second salary.
    const looseIncome =
      s.direction === 'income'
        ? (
            db
              .select({ id: transactions.id, date: transactions.txnDate, amount: transactions.amountIls })
              .from(transactions)
              .where(and(sql`${transactions.recurringStreamId} is null`, eq(transactions.status, 'completed'), eq(transactions.excluded, false), sql`${transactions.amountIls} > 0`, sql`coalesce(${transactions.kind}, '') <> 'paid_back'`, sql`${transactions.cashflowMonth} = ${month}`))
              .all() as Array<{ id: number; date: string; amount: number }>
          ).filter((r) => r.amount >= 0.7 * s.expectedAmount && r.amount <= 1.4 * s.expectedAmount)
        : [];
    for (const slotDate of slots) {
      const pool = [...actual, ...looseIncome.map((r) => ({ id: r.id, date: r.date }))];
      const near = pool.filter((a) => !used.has(a.id)).sort((a, b) => Math.abs(daysBetween(slotDate, a.date)) - Math.abs(daysBetween(slotDate, b.date)))[0];
      const window = s.frequency === 'weekly' || s.frequency === 'biweekly' ? 4 : 31;
      const match = near && Math.abs(daysBetween(slotDate, near.date)) <= window ? near : undefined;
      if (match) used.add(match.id);
      const status: ExpectedSlot['status'] = match ? 'matched' : daysBetween(slotDate, today) > grace ? 'missing' : 'upcoming';
      out.push({ streamId: s.id, merchantId: s.merchantId, categoryId: s.categoryId, expectedDate: slotDate, amount: s.expectedAmount, direction: s.direction as 'income' | 'expense', matchedTxnId: match?.id ?? null, status });
    }
  }
  return out;
}

function slotsInMonth(s: typeof recurringStream.$inferSelect, month: string, monthStart: string, monthEnd: string): string[] {
  const anchor = s.lastTxnDate ?? s.nextExpectedDate;
  if (!anchor) return [];
  const clampDay = (d: number) => `${month}-${String(Math.min(d, Number(monthEnd.slice(8, 10)))).padStart(2, '0')}`;
  switch (s.frequency) {
    case 'monthly':
      return [clampDay(s.expectedDay ?? Number(anchor.slice(8, 10)))];
    case 'weekly':
    case 'biweekly': {
      const step = s.frequency === 'weekly' ? 7 : 14;
      const out: string[] = [];
      let d = anchor;
      while (d > monthStart) d = addDays(d, -step);
      while (d <= monthEnd) {
        if (d >= monthStart) out.push(d);
        d = addDays(d, step);
      }
      return out;
    }
    case 'bimonthly':
    case 'quarterly':
    case 'annual': {
      const months = s.frequency === 'bimonthly' ? 2 : s.frequency === 'quarterly' ? 3 : 12;
      const diff = monthIndex(month) - monthIndex(anchor.slice(0, 7));
      return diff % months === 0 ? [clampDay(s.expectedDay ?? Number(anchor.slice(8, 10)))] : [];
    }
    default:
      return [];
  }
}

function nextDate(last: string, c: CadenceFit, expectedDay: number | null): string {
  if (c.frequency === 'weekly' || c.frequency === 'biweekly') return addDays(last, c.frequency === 'weekly' ? 7 : 14);
  const months = c.frequency === 'monthly' ? 1 : c.frequency === 'bimonthly' ? 2 : c.frequency === 'quarterly' ? 3 : 12;
  const n = shiftMonths(last, months);
  if (!expectedDay) return n;
  const [y, m] = n.split('-').map(Number) as [number, number];
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${n.slice(0, 7)}-${String(Math.min(expectedDay, lastDay)).padStart(2, '0')}`;
}

/** Non-ILS currency shared by ≥ 80% of the rows, else null. */
function fxMajority(rows: TxnRow[]): string | null {
  const fx = majority(rows.map((m) => m.originalCurrency).filter((c) => c && c !== 'ILS') as string[]);
  if (fx === null) return null;
  return rows.filter((m) => m.originalCurrency === fx).length / rows.length >= 0.8 ? fx : null;
}

/**
 * A price change too small to leave its amount cluster (under ~15%, gaps plan 1.8 follow-up): the newest charges sit
 * outside the cluster's amount tolerance, so the stream would drop them. When the cluster's latest charges, and only
 * they, are outside the tolerance, all on the same side and one price among themselves (within 5%), they are split off
 * as a cluster of their own; chainPriceSteps then joins them back as the stream's next price step if they come on
 * schedule. One odd charge in the middle of the history is not a suffix, so it splits nothing.
 */
export function splitPriceTail(rows: TxnRow[], amountOf: (r: TxnRow) => number): TxnRow[][] {
  if (rows.length < 3) return [rows];
  const sorted = [...rows].sort((a, b) => a.txnDate.localeCompare(b.txnDate));
  const model = modelAmounts(sorted.map(amountOf));
  if (!model) return [rows];
  const expected = Math.abs(model.expected);
  const outside = (r: TxnRow): boolean => Math.abs(amountOf(r) - expected) > model.tolerance;
  let k = sorted.length;
  while (k > 0 && outside(sorted[k - 1]!)) k--;
  const head = sorted.slice(0, k);
  const tail = sorted.slice(k);
  if (!tail.length || head.length < 2 || tail.length >= head.length) return [rows];
  const amounts = tail.map(amountOf);
  if (Math.max(...amounts) > Math.min(...amounts) * 1.05) return [rows];
  if (!amounts.every((a) => a > expected) && !amounts.every((a) => a < expected)) return [rows];
  return [head, tail];
}

/**
 * Join price steps (gaps plan 1.8): a cluster whose first charge comes after a stream-like cluster's last charge, on
 * that cluster's next expected date (± a quarter of the cadence, at least 5 days), at ⅔–1.5× its last price, continues
 * it; a joined step of a single charge ends the chain. Only one such cluster may qualify (two would be ambiguous, so neither joins), and a joined cluster of two or more
 * charges must keep the cadence itself. Two subscriptions billed side by side interleave in time, so they never join.
 * Returns the clusters in their original order, each as its price steps (oldest first).
 */
export function chainPriceSteps(clusters: TxnRow[][], amountOf: (r: TxnRow) => number): Array<{ steps: TxnRow[][] }> {
  const byDate = (rows: TxnRow[]): TxnRow[] => [...rows].sort((a, b) => a.txnDate.localeCompare(b.txnDate));
  const out = clusters.map((c) => ({ steps: [byDate(c)] }));
  const used = new Set<number>();
  for (let i = 0; i < out.length; i++) {
    if (used.has(i)) continue;
    const base = out[i]!;
    for (;;) {
      const rows = base.steps.flat();
      if (rows.length < 2) break;
      const cadence = detectCadence(rows.map((r) => r.txnDate));
      if (!cadence || cadence.fit < 0.6) break;
      const last = rows.reduce((a, b) => (b.txnDate > a.txnDate ? b : a));
      const dayBased = cadence.frequency === 'monthly' || cadence.frequency === 'bimonthly' || cadence.frequency === 'quarterly' || cadence.frequency === 'annual';
      const next = nextDate(last.txnDate, cadence, dayBased ? medianDay(rows.map((r) => r.txnDate)) : null);
      const window = Math.max(5, Math.round(cadence.intervalDays * 0.25));
      let found = -1;
      for (let j = 0; j < out.length; j++) {
        if (j === i || used.has(j)) continue;
        const cand = out[j]!.steps.flat().sort((a, b) => a.txnDate.localeCompare(b.txnDate));
        const first = cand[0]!;
        if (first.txnDate <= last.txnDate || Math.abs(daysBetween(next, first.txnDate)) > window) continue;
        const ratio = amountOf(first) / Math.max(1, amountOf(last));
        if (ratio < 2 / 3 || ratio > 1.5) continue;
        if (cand.length >= 2 && (detectCadence(cand.map((r) => r.txnDate))?.fit ?? 0) < 0.6) continue;
        if (found !== -1) {
          found = -2;
          break;
        }
        found = j;
      }
      if (found < 0) break;
      used.add(found);
      base.steps = [...base.steps, ...out[found]!.steps];
      // a single charge at a new price is the latest price, not yet a pattern: nothing chains on from it
      if (out[found]!.steps.flat().length < 2) break;
    }
  }
  return out.filter((_, i) => !used.has(i));
}

/** Sort by amount and cut where neighbours differ by more than 15% (or ₪3): one cluster per billed thing. */
export function clusterByAmount<T>(rows: T[], amountOf: (r: T) => number): T[][] {
  const sorted = [...rows].sort((a, b) => amountOf(a) - amountOf(b));
  const out: T[][] = [];
  let cur: T[] = [];
  let prev: number | null = null;
  for (const r of sorted) {
    const a = amountOf(r);
    if (prev !== null && a - prev > Math.max(prev * 0.15, 300)) {
      out.push(cur);
      cur = [];
    }
    cur.push(r);
    prev = a;
  }
  if (cur.length) out.push(cur);
  // biggest clusters first so the main stream keeps index 0 across runs
  return out.sort((x, y) => y.length - x.length);
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const monthIndex = (ym: string): number => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7));
function medianDay(dates: string[]): number {
  const days = dates.map((d) => Number(d.slice(8, 10))).sort((a, b) => a - b);
  return days[Math.floor(days.length / 2)]!;
}
function majority(xs: string[]): string | null {
  if (!xs.length) return null;
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}
function majorityNum(xs: number[]): number | null {
  if (!xs.length) return null;
  const m = new Map<number, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}

export function setStreamState(db: Db, id: number, state: 'confirmed' | 'rejected' | 'ended' | 'paused', label?: string): void {
  db.update(recurringStream)
    .set({ state, stateSource: 'user', updatedAt: nowIso(), ...(label ? { label } : {}) })
    .where(eq(recurringStream.id, id))
    .run();
  if (state === 'rejected') db.update(transactions).set({ recurringStreamId: null }).where(eq(transactions.recurringStreamId, id)).run();
}
