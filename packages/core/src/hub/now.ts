/**
 * The Now screen's income split, "without the extra", typical month, large-extra rule and explain sheet
 * (research_notes/proposals/now-screen-and-limit.md, build step 1). The arithmetic is in engine/income.ts; this
 * file reads the database and the settings:
 *
 *   income.kind.<categoryKey>   regular | extra   the owner's tag for an income category (default: engine/income.ts)
 *   spend.spreadExtra.<YYYY-MM> true              spread a large extra into the weekly envelope this month too
 *   transaction.income_kind_override             one payment re-tagged (regular | extra | null)
 */
import { getSetting, setSetting } from '../ai/settings.js';
import type { Db } from '../db/db.js';
import { nowIso } from '../db/db.js';
import { transactions } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import type { Forecast } from '../engine/forecast.js';
import {
  type ExplainItem,
  type ExplainKey,
  type ExplainTerm,
  type IncomeKind,
  type IncomeSplit,
  type KindContext,
  type MonthTotals,
  type Spread,
  type TypicalMonth,
  type WithoutExtraTone,
  TYPICAL_WINDOW,
  applySpread,
  effectiveIncomeKinds,
  explainTerms,
  incomeKindOf,
  isIncomeKind,
  splitIncome,
  typicalMonth,
  withoutExtra,
} from '../engine/income.js';
import { type MonthSummary, type View, classifyMonthRows } from '../engine/summary.js';
import type { ExtraItem } from '../engine/income.js';
import type { PaidBackSummary } from '../engine/paidback.js';
import { paidBackContext, paidBackForMonth } from './paidback.js';

export const INCOME_KIND_PREFIX = 'income.kind.';
export const SPREAD_EXTRA_PREFIX = 'spend.spreadExtra.';

/**
 * An extra income item on the Now screen (hub/paidback.ts): `askPaidBack` when finc asks whether it is paying the owner
 * back; `canRemember` when the answers that remember the payer (always / no) are offered.
 */
export type NowExtraItem = ExtraItem & { askPaidBack: boolean; canRemember: boolean };
export type NowIncomeSplit = Omit<IncomeSplit, 'extra'> & { extra: Omit<IncomeSplit['extra'], 'items'> & { items: NowExtraItem[] } };

export interface NowIncome {
  incomeSplit: NowIncomeSplit;
  /** the month's payments marked as paid back (counted against day-to-day spending, not as income); total positive */
  paidBack: PaidBackSummary;
  withoutExtra: { left: number; tone: WithoutExtraTone };
  typical: TypicalMonth | null;
  spread: Spread;
  explain: ExplainTerm[];
  /** the forecast after the large-extra rule (weekly envelope and projection on the regular part when it applies) */
  forecast: Forecast;
}

/** Keys of the income-section categories. */
export function incomeCategoryKeys(db: Db): string[] {
  return (db.$client.prepare(`select key from category where section = 'income' order by sort_order, id`).all() as Array<{ key: string }>).map((r) => r.key);
}

/** Categories used by a confirmed recurring income stream (regular by default). */
export function streamIncomeCategoryKeys(db: Db): Set<string> {
  return new Set(
    (db.$client.prepare(`select distinct c.key from recurring_stream rs join category c on c.id = rs.category_id where rs.state = 'confirmed' and rs.direction = 'income'`).all() as Array<{ key: string }>).map((r) => r.key),
  );
}

function kindSettings(db: Db): Record<string, string> {
  const rows = db.$client.prepare(`select key, value from setting where substr(key, 1, ?) = ?`).all(INCOME_KIND_PREFIX.length, INCOME_KIND_PREFIX) as Array<{ key: string; value: string }>;
  return Object.fromEntries(rows.map((r) => [r.key.slice(INCOME_KIND_PREFIX.length), r.value]));
}

/** The effective kind of every income category (plus the categories of confirmed income streams and `extraKeys`). */
export function incomeKinds(db: Db, extraKeys: Iterable<string> = []): Record<string, IncomeKind> {
  const streams = streamIncomeCategoryKeys(db);
  const keys = new Set([...incomeCategoryKeys(db), ...streams, ...extraKeys]);
  return effectiveIncomeKinds(keys, streams, kindSettings(db));
}

export class IncomeKindError extends Error {}

/** Category keys the owner can tag: the income section plus the categories of confirmed income streams. */
export function incomeKindKeys(db: Db): Set<string> {
  return new Set([...incomeCategoryKeys(db), ...streamIncomeCategoryKeys(db)]);
}

/** Keys with an explicit income.kind.<key> setting (they win over the confirmed-stream rule). */
export function explicitIncomeKindKeys(db: Db): Set<string> {
  return new Set(Object.entries(kindSettings(db)).filter(([, v]) => isIncomeKind(v)).map(([k]) => k));
}

/** Ids of confirmed recurring income streams: their rows are regular unless overridden. */
export function confirmedIncomeStreamIds(db: Db): Set<number> {
  return new Set((db.$client.prepare(`select id from recurring_stream where state = 'confirmed' and direction = 'income'`).all() as Array<{ id: number }>).map((r) => r.id));
}

/**
 * Tag income categories (null = back to the default). Only keys of the effective kinds map are accepted (income
 * section + categories of confirmed income streams); nothing is written when any key is not one. Returns the keys.
 */
export function setIncomeKinds(db: Db, patch: Record<string, IncomeKind | null>): string[] {
  const known = incomeKindKeys(db);
  const bad = Object.keys(patch).filter((k) => !known.has(k));
  if (bad.length) throw new IncomeKindError(`not an income category: ${bad.join(', ')}`);
  if (Object.values(patch).some((v) => v !== null && !isIncomeKind(v))) throw new IncomeKindError('income kind must be regular or extra');
  for (const [k, v] of Object.entries(patch)) setSetting(db, `${INCOME_KIND_PREFIX}${k}`, v);
  return Object.keys(patch);
}

export function spreadExtraFor(db: Db, month: string): boolean {
  return getSetting(db, `${SPREAD_EXTRA_PREFIX}${month}`) === 'true';
}

/** Spread a large extra into this month's weekly envelope too (true), or not (false, the default: the setting is removed). */
export function setSpreadExtra(db: Db, month: string, value: boolean): void {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new IncomeKindError('month must be YYYY-MM');
  setSetting(db, `${SPREAD_EXTRA_PREFIX}${month}`, value ? 'true' : null);
}

/**
 * Re-tag one payment. Only a positive row the month counts as income may carry a kind; clearing (null) is always
 * allowed on an existing row.
 */
export function setIncomeKindOverride(db: Db, id: number, kind: IncomeKind | null): 'ok' | 'missing' | 'not_income' {
  const check = kind === null ? (db.select({ id: transactions.id }).from(transactions).where(eq(transactions.id, id)).get() ? 'ok' : 'missing') : incomeKindAllowed(db, id);
  if (check !== 'ok') return check;
  db.update(transactions).set({ incomeKindOverride: kind, updatedAt: nowIso() }).where(eq(transactions.id, id)).run();
  return 'ok';
}

/**
 * Whether a payment may carry a kind, after the rest of the same edit (`patch`) would apply: it must stay a positive
 * row counted as income (not excluded, not a transfer, not savings) and not move to a non-income category (which
 * clears the kind, see setCategory). For the transaction PATCH to refuse before it writes anything.
 */
export function incomeKindAllowed(db: Db, id: number, patch: { categoryId?: number; excluded?: boolean; transfer?: boolean } = {}): 'ok' | 'missing' | 'not_income' {
  const t = db.select().from(transactions).where(eq(transactions.id, id)).get();
  if (!t) return 'missing';
  const excluded = patch.excluded ?? patch.transfer ?? t.excluded;
  // un-excluding (excluded:false / transfer:false) resets the kind from the amount's sign, as setExcluded does
  const kind = patch.excluded === false || patch.transfer === false ? (t.amountIls < 0 ? 'expense' : 'income') : t.kind;
  if (excluded || patch.transfer === true || t.amountIls <= 0 || kind === 'savings') return 'not_income';
  if (patch.categoryId !== undefined) {
    const section = (db.$client.prepare('select section from category where id = ?').get(patch.categoryId) as { section: string } | undefined)?.section;
    if (section !== 'income') return 'not_income';
  }
  return 'ok';
}

function monthsBefore(month: string, n: number): string[] {
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

/** The month's totals the typical month is made of; null when the month has no counted rows. */
export function monthTotals(db: Db, month: string, view: View, k: KindContext & { streamIds: ReadonlySet<number> }, catKey: (id: number | null) => string | null): MonthTotals | null {
  const rows = classifyMonthRows(db, month, view).filter((r) => r.bucket !== 'excluded');
  if (!rows.length) return null;
  const sum = (b: string) => rows.filter((r) => r.bucket === b).reduce((a, r) => a + r.amount, 0);
  const income = sum('income');
  const regularIncome = rows
    .filter((r) => r.bucket === 'income' && incomeKindOf({ categoryKey: catKey(r.t.categoryId), override: r.t.incomeKindOverride, stream: r.t.recurringStreamId !== null && k.streamIds.has(r.t.recurringStreamId) }, k.kinds, k.streamCategoryKeys, k.explicitKeys) === 'regular')
    .reduce((a, r) => a + r.amount, 0);
  return { income, regularIncome, fixed: 0 - (sum('fixed') + sum('installments')), variable: 0 - sum('variable') };
}

/**
 * Everything the Now card adds for `month`, from the month's summary and its (unchanged) forecast.
 * `expectedSavingsRemaining` is the same signed sum the forecast was given.
 */
export function nowIncome(db: Db, ctx: { month: string; view: View; today: string; summary: MonthSummary; forecast: Forecast }): NowIncome {
  const { month, view, today, summary: s, forecast: f } = ctx;
  const c = db.$client;
  const cats = new Map((c.prepare('select id, key, section from category').all() as Array<{ id: number; key: string; section: string }>).map((r) => [r.id, r]));
  const catKey = (id: number | null) => (id === null ? null : (cats.get(id)?.key ?? null));
  const merchantStmt = c.prepare('select name from merchant where id = ?');
  const merchantNames = new Map<number, string | null>();
  const merchantName = (id: number | null): string | null => {
    if (id === null) return null;
    if (!merchantNames.has(id)) merchantNames.set(id, (merchantStmt.get(id) as { name: string } | undefined)?.name ?? null);
    return merchantNames.get(id)!;
  };
  const streamLabels = new Map((c.prepare('select id, label from recurring_stream').all() as Array<{ id: number; label: string | null }>).map((r) => [r.id, r.label]));

  const rows = classifyMonthRows(db, month, view).filter((r) => r.bucket !== 'excluded');
  const incomeRows = rows.filter((r) => r.bucket === 'income');
  const streamKeys = streamIncomeCategoryKeys(db);
  const streamIds = confirmedIncomeStreamIds(db);
  const kinds = incomeKinds(db, incomeRows.map((r) => catKey(r.t.categoryId)).filter((k): k is string => k !== null));
  const kctx = { kinds, streamCategoryKeys: streamKeys, explicitKeys: explicitIncomeKindKeys(db), streamIds };
  const isIncomeSection = (id: number | null) => id !== null && cats.get(id)?.section === 'income';

  // expected = the forecast's still-expected slots; the forecast counts them for the current month only
  const current = f.isCurrentMonth;
  const openSlots = current ? s.expectedFixed.filter((sl) => sl.status !== 'matched') : [];
  const slotName = (sl: { streamId: number; merchantId: number }) => streamLabels.get(sl.streamId) ?? merchantName(sl.merchantId) ?? '?';
  const received = incomeRows.map((r) => ({
    id: r.t.id,
    name: merchantName(r.t.merchantId) ?? r.t.descriptionRaw,
    amount: r.amount,
    date: r.t.txnDate,
    categoryKey: catKey(r.t.categoryId),
    override: isIncomeKind(r.t.incomeKindOverride) ? r.t.incomeKindOverride : null,
    stream: r.t.recurringStreamId !== null && streamIds.has(r.t.recurringStreamId),
    incomeCategory: isIncomeSection(r.t.categoryId),
  }));
  const expected = openSlots
    .filter((sl) => sl.direction === 'income')
    .map((sl) => ({ name: slotName(sl), amount: sl.amount, date: sl.expectedDate, categoryKey: catKey(sl.categoryId), streamId: sl.streamId, incomeCategory: isIncomeSection(sl.categoryId) }));
  const incomeSplit = splitIncome(received, expected, kctx);
  const wx = withoutExtra(incomeSplit, f);

  // typical month: the last complete months before this one (and before today's month), those with data
  const thisMonth = today.slice(0, 7);
  const history = monthsBefore(month, TYPICAL_WINDOW).filter((m) => m < thisMonth);
  const typical = typicalMonth(history.map((m) => monthTotals(db, m, view, kctx, catKey)));

  const { forecast, spread } = applySpread(f, incomeSplit, wx.left, spreadExtraFor(db, month));

  // explain: every row and slot behind each term of `left`
  const kindOf = (r: { categoryKey: string | null; override?: string | null; stream?: boolean }) => incomeKindOf(r, kinds, streamKeys, kctx.explicitKeys);
  const items: Partial<Record<ExplainKey, ExplainItem[]>> = {};
  const push = (k: ExplainKey, i: ExplainItem) => (items[k] ??= []).push(i);
  for (const r of received) push(kindOf(r) === 'regular' ? 'income_regular_received' : 'income_extra_received', { id: r.id, name: r.name, amount: r.amount, date: r.date, status: 'received' });
  for (const e of expected) push(kindOf({ categoryKey: e.categoryKey, stream: true }) === 'regular' ? 'income_regular_expected' : 'income_extra_expected', { id: null, name: e.name, amount: e.amount, date: e.date, status: 'expected' });
  const bucketKey: Record<string, ExplainKey> = { fixed: 'fixed_paid', installments: 'installments_paid', savings: 'savings_actual', variable: 'variable_spent' };
  for (const r of rows) {
    const k = bucketKey[r.bucket];
    if (k) push(k, { id: r.t.id, name: merchantName(r.t.merchantId) ?? r.t.descriptionRaw, amount: r.amount, date: r.t.txnDate, status: 'paid' });
  }
  for (const sl of openSlots.filter((x) => x.direction === 'expense')) {
    const savings = cats.get(sl.categoryId ?? -1)?.section === 'savings';
    push(savings ? 'savings_planned' : 'fixed_expected', { id: null, name: slotName(sl), amount: sl.amount, date: sl.expectedDate, status: 'expected' });
  }
  if (current) for (const sl of s.expectedInstallments) push('installments_expected', { id: null, name: `${merchantName(sl.merchantId) ?? '?'} ${sl.n}/${sl.totalN}`, amount: sl.amount, date: sl.expectedDate, status: 'expected' });

  // paid back to me: who finc asks about, and the month's paid-back payments (already in variable_spent above)
  const pb = paidBackContext(db);
  const byId = new Map(incomeRows.map((r) => [r.t.id, r]));
  const flags = (id: number | null): { askPaidBack: boolean; canRemember: boolean } => {
    const r = id === null ? undefined : byId.get(id);
    if (!r) return { askPaidBack: false, canRemember: false };
    return {
      askPaidBack: pb.ask({ id: r.t.id, kind: r.t.kind, bucket: r.bucket, amount: r.amount, accountId: r.t.accountId, categoryId: r.t.categoryId, incomeKindOverride: r.t.incomeKindOverride, recurringStreamId: r.t.recurringStreamId, descriptionNorm: r.t.descriptionNorm }),
      canRemember: pb.canRemember({ kind: r.t.kind, excluded: r.t.excluded, amount: r.t.amountIls, accountId: r.t.accountId, descriptionNorm: r.t.descriptionNorm }),
    };
  };
  const splitOut: NowIncomeSplit = { ...incomeSplit, extra: { ...incomeSplit.extra, items: incomeSplit.extra.items.map((i) => ({ ...i, ...flags(i.id) })) } };

  return { incomeSplit: splitOut, paidBack: paidBackForMonth(db, rows, pb), withoutExtra: wx, typical, spread, explain: explainTerms(items), forecast };
}
