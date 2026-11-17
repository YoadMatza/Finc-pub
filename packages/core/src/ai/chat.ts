/**
 * "Ask my money" (design §8): a chat whose answers come from fixed local aggregations. The model
 * never sees the database; it chooses one of the tools below, finc runs it here, and only the
 * tool's result goes back: category names, amounts, dates, counts, the user's own stream labels,
 * event names and manual holding names, and merchant names of card purchases only.
 * Every transaction name goes through `modelName` (model-names.ts, security research P1-14). The
 * engine names each merchant from the row's own description, so the default is inverted. A
 * bank-side (non-card) expense never goes out by name: its category name, else "unnamed
 * transaction". A card purchase keeps its merchant name (booking numbers and digit runs removed)
 * unless it goes through a processor or wallet ("PAYPAL *<name>", "PEPPER PAY <name>",
 * "<word>*<name>" → "PayPal payment", "Pepper payment"…) or its merchant also appears on a bank-side
 * row (then its category). Person-to-person money is "money sent to / received from a person";
 * transfers, standing orders and cheques "bank transfer"; card bills "card bill". Income never
 * names the payer: its category name ("Salary"), or the user's own stream label. Never raw or
 * normalised bank descriptions, memos, notes, account numbers, identifiers or balances per account
 * number. The chat's search (`q`) matches only what the model may see (the names above and category
 * names), never descriptions or memos. A last guard (`guardEgress`) replaces digit runs of 5+ and any
 * string that is exactly a stored bank description. The user's own question is sent as typed.
 *
 * The loop works with every provider through the plain "system + user → text" interface: the model
 * replies with one JSON object, either {"tool": name, "args": {...}} or {"answer": "..."}.
 *
 * Chat v2 step 2: `spend_summary` totals and averages spending on the PC (the Now screen's counting), the prompt asks
 * for an answer first, and a turn returns its lookups (strings the model already saw) so the worker can hand them back
 * as `previousLookups` on the next turn of the same conversation (apps/worker/src/api/chat-memory.ts).
 *
 * Chat v2 step 4: a final answer may carry `followUps` (up to 3 questions the user may ask next, shown as chips), and a
 * Hebrew answer writes the generic labels in Hebrew (MODEL_LABELS_HE; the tool results keep the English labels).
 */
import type { Db } from '../db/db.js';
import { CATEGORY_GROUPS, CATEGORY_SEED } from '../engine/categories.js';
import { classifyMonthRows, monthSummary, monthsBetween } from '../engine/summary.js';
import { listEvents } from '../hub/events.js';
import { netWorthOverview } from '../hub/networth.js';
import { hubOverview, todayLocal } from '../hub/overview.js';
import { recurringOverview } from '../hub/recurring.js';
import { listTransactions } from '../hub/transactions.js';
import { projectToolResult } from './egress.js';

/** The payment app a person-to-person row went through (the app's name only, never the person's). */
export function paymentApp(description: string): 'Bit' | 'PayBox' | undefined {
  if (/paybox|pay\s*box|פיי\s*בוקס|פייבוקס/i.test(description)) return 'PayBox';
  if (/(^|[\s\-:.,])[במלה]?ביט($|[\s\-:.,])|(^|[^a-z])bit($|[^a-z])/i.test(description)) return 'Bit';
  return undefined;
}
import { trendsOverview } from '../hub/trends.js';
import { sanitizeForModel } from './categorize-ai.js';
import { type EgressContext, MODEL_LABELS, MODEL_LABELS_HE, bankMerchantIds, guardEgress, modelName } from './model-names.js';
import { AiError, type AiProvider, type ReplyFormat } from './provider.js';
import { getSetting } from './settings.js';
import { errorSummary } from '../errors.js';
import { SPLIT_CATEGORY, SPLIT_JOIN, allocateSplit, splitShare, splitsByTxn } from '../hub/splits.js';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatStep {
  tool: string;
  args: Record<string, unknown>;
  /** one line for the UI: what was looked up */
  summary: string;
}

export interface ChatResult {
  answer: string;
  steps: ChatStep[];
  model: string;
  rounds: number;
  /**
   * This turn's lookups exactly as the model saw them ("{tool,args} → result", already through guardEgress), for the
   * caller to hand back as `previousLookups` on the next turn of the same conversation. Not for the browser.
   */
  lookups: string[];
  /** chat v2 step 4: up to 3 questions the user may ask next (cleanFollowUps), [] when none or not a final answer */
  followUps: string[];
}

export interface ChatOptions {
  today?: string;
  /** lookups from earlier turns of this conversation (strings the model already saw); nothing new leaves the PC */
  previousLookups?: readonly string[];
}

interface ToolSpec {
  name: string;
  description: string;
  params: string;
  run: (db: Db, args: Record<string, unknown>, today: string, ctx?: ToolContext) => unknown;
}

/** Computed once per chat call and shared by its lookups. */
export interface ToolContext {
  /** records a name the tool approved, so the egress guard lets it through */
  allow: (name: string) => string;
  /** merchants seen on a bank-side row (their card rows are not sent by name) */
  bankMerchants: () => Set<number>;
  cats: () => Map<number, CatName>;
}

export interface CatName {
  key: string;
  he: string;
  en: string;
  group: string;
}

export function toolContext(db: Db, allow: (name: string) => string = (n) => n): ToolContext {
  let bank: Set<number> | undefined;
  let cats: Map<number, CatName> | undefined;
  return { allow, bankMerchants: () => (bank ??= bankMerchantIds(db)), cats: () => (cats ??= catNames(db)) };
}

/** The same day twelve months earlier. */
const yearBefore = (date: string): string => `${Number(date.slice(0, 4)) - 1}${date.slice(4)}`;

const ils = (minor: number) => Math.round(minor) / 100;
const str = (v: unknown, fallback?: string): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : fallback);
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : fallback);
const monthOf = (v: unknown, today: string): string => {
  const s = str(v);
  return s && /^\d{4}-\d{2}$/.test(s) ? s : today.slice(0, 7);
};
const dateOk = (s: string | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Names that may reach the model: merchant and category names with digit runs removed. */
const safeName = (s: string | null | undefined): string => sanitizeForModel((s ?? '').replace(/\*+\s*\d+/g, '').trim()) || '?';

function catNames(db: Db): Map<number, CatName> {
  return new Map((db.$client.prepare('select id, key, name_he, name_en, group_key from category').all() as Array<{ id: number; key: string; name_he: string; name_en: string; group_key: string }>).map((c) => [c.id, { key: c.key, he: c.name_he, en: c.name_en, group: c.group_key }]));
}

const addMonths = (month: string, n: number): string => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
};
/** "YYYY-MM" or "YYYY-MM-DD" → its month; anything else undefined. */
const monthArg = (v: unknown): string | undefined => {
  const s = str(v);
  return s && /^\d{4}-(0[1-9]|1[0-2])(-\d{2})?$/.test(s) ? s.slice(0, 7) : undefined;
};

/** Foreign = the row was charged in a currency other than the shekel (the bank data's only reliable signal). */
const SHEKEL = new Set(['ILS', 'NIS', '₪', 'ש"ח', 'ש״ח', 'שח', 'שקל']);
export const isForeignCurrency = (c: string | null | undefined): boolean => {
  const u = (c ?? '').trim().toUpperCase();
  return !!u && !SHEKEL.has(u);
};
/**
 * RiseUp's export carries no currency (ingest/riseup-convert.ts), so ingest stores 'ILS' for every RiseUp row. A row
 * still owned by RiseUp (no bank/card source took it over) with 'ILS' has an UNKNOWN currency: counted as ILS by the
 * currency filters, and reported apart as `currencyUnknown`.
 */
export const currencyUnknown = (source: string | null | undefined, c: string | null | undefined): boolean => (source ?? '').startsWith('riseup') && !isForeignCurrency(c);

/** Rows of unknown currency that a currency filter met: counted as ILS, reported here. */
class UnknownCurrency {
  count = 0;
  minor = 0;
  private first = '';
  private last = '';
  add(month: string, minor: number): void {
    this.count++;
    this.minor += minor;
    if (!this.first || month < this.first) this.first = month;
    if (!this.last || month > this.last) this.last = month;
  }
  /** `total` in ILS with the caller's sign convention; `counted` says whether the filter kept them (ils) or not (foreign). */
  out(filter: CurrencyFilter): { currencyUnknown?: { count: number; total: number; months: string; counted: 'as ILS' | 'not in foreign' } } {
    if (filter === 'all' || !this.count) return {};
    return { currencyUnknown: { count: this.count, total: ils(this.minor), months: this.months(), counted: filter === 'ils' ? 'as ILS' : 'not in foreign' } };
  }
  note(filter: CurrencyFilter): string[] {
    if (filter === 'all' || !this.count) return [];
    const what = `${this.count} charge${this.count === 1 ? '' : 's'} in ${this.months()} ${this.count === 1 ? 'comes' : 'come'} from RiseUp history without a currency and ${this.count === 1 ? 'is' : 'are'} counted as ILS`;
    return [filter === 'ils' ? what : `${what}, so they are not in these totals`];
  }
  private months(): string {
    return this.first === this.last ? this.first : `${this.first}..${this.last}`;
  }
}
export type CurrencyFilter = 'ils' | 'foreign' | 'all';
const currencyArg = (v: unknown): CurrencyFilter => {
  const s = (str(v) ?? '').toLowerCase();
  if (['ils', 'nis', '₪', 'shekel', 'shekels', 'local', 'israel', 'domestic', 'ש״ח', 'ש"ח', 'שקל', 'שקלים'].includes(s)) return 'ils';
  if (['foreign', 'fx', 'abroad', 'non-ils', 'חו״ל', 'חו"ל', 'מט״ח', 'מט"ח'].includes(s)) return 'foreign';
  return 'all';
};
const currencyOk = (filter: CurrencyFilter, c: string | null | undefined): boolean => filter === 'all' || (filter === 'foreign') === isForeignCurrency(c);

const UNCATEGORISED = { en: 'Uncategorised', he: 'ללא קטגוריה' } as const;
const lc = (s: string) => s.trim().toLowerCase();

/**
 * A category or a category GROUP by its key, English or Hebrew name (groups also by everyday words: "car", "רכב").
 * A group wins over a category of the same name. `null` ids = uncategorised rows.
 */
export function resolveChatCategory(cats: Map<number, CatName>, arg: string): { kind: 'group' | 'category'; key: string; en: string; he: string; ids: Set<number | null> } | null {
  const q = lc(arg);
  if (!q) return null;
  const known = CATEGORY_GROUPS.find((g) => [g.key, g.en, g.he, ...g.aliases].some((n) => lc(n) === q));
  const groupKey = known?.key ?? [...cats.values()].find((c) => lc(c.group) === q)?.group;
  if (groupKey) {
    const g = CATEGORY_GROUPS.find((x) => x.key === groupKey);
    return { kind: 'group', key: groupKey, en: g?.en ?? groupKey, he: g?.he ?? groupKey, ids: new Set([...cats.entries()].filter(([, c]) => c.group === groupKey).map(([id]) => id)) };
  }
  for (const [id, c] of cats) if ([c.key, c.en, c.he].some((n) => lc(n) === q)) return { kind: 'category', key: c.key, en: c.en, he: c.he, ids: new Set([id]) };
  if ([UNCATEGORISED.en, UNCATEGORISED.he, 'uncategorized', 'uncategorised'].some((n) => lc(n) === q)) return { kind: 'category', key: 'uncategorised', ...UNCATEGORISED, ids: new Set([null]) };
  return null;
}

const unknownCategory = (arg: string) => ({ error: `unknown category or group "${arg}"; groups: ${CATEGORY_GROUPS.map((g) => g.key).join(', ')}; or a category's English or Hebrew name` });

const SPEND_BUCKETS = ['fixed', 'variable', 'installments'] as const;
type SpendBucket = (typeof SPEND_BUCKETS)[number];

/**
 * spend_summary (chat v2): spending over full months, counted the way the Now screen counts it (classifyMonthRows,
 * purchase view = the row's cashflow month): fixed + variable + installments, refunds netted into their purchase,
 * settlements / transfers / excluded rows out, savings and income out, money paid back to the owner (kind paid_back)
 * reduces variable spending. Positive numbers = spending. Only aggregates and names that may be sent leave.
 */
function spendSummary(db: Db, a: Record<string, unknown>, today: string, ctx: ToolContext): unknown {
  const cats = ctx.cats();
  const current = today.slice(0, 7);
  const lastFull = addMonths(current, -1);
  // half-given ranges: only `to` → the 12 months ending there; only `from` → up to the last full month, or to the
  // current month (reported as so far) when `from` is the current month or later
  const fromArg = monthArg(a.from);
  const toArg = monthArg(a.to);
  const to = toArg ?? (fromArg && fromArg >= current ? current : lastFull);
  let from = fromArg ?? addMonths(to < current ? to : lastFull, -11);
  if (from > to) return { error: `from (${from}) is after to (${to})` };
  let clipped = false;
  const fullEnd = to < current ? to : lastFull;
  if (from <= fullEnd && monthsBetween(from, fullEnd).length > 36) {
    from = addMonths(fullEnd, -35);
    clipped = true;
  }
  const currency = currencyArg(a.currency);
  const bucketArg = lc(str(a.bucket) ?? 'all');
  const buckets = new Set<SpendBucket>((SPEND_BUCKETS as readonly string[]).includes(bucketArg) ? [bucketArg as SpendBucket] : SPEND_BUCKETS);
  const catArg = str(a.category);
  const cat = catArg ? resolveChatCategory(cats, catArg) : null;
  if (catArg && !cat) return unknownCategory(catArg);
  const q = str(a.merchant);
  if (q !== undefined && q.length < 2) return { error: 'merchant needs at least 2 characters' };
  const needle = q?.toLowerCase();
  const groupByArg = lc(str(a.groupBy) ?? 'none');
  const groupBy = (['month', 'category', 'merchant'] as const).find((g) => g === groupByArg) ?? 'none';
  const limit = Math.min(30, Math.max(1, Math.round(num(a.limit, 12))));

  // names as the model may see them, computed only when a merchant search or grouping needs them
  const needNames = needle !== undefined || groupBy === 'merchant';
  const merchants = needNames ? new Map((db.$client.prepare('select id, name from merchant').all() as Array<{ id: number; name: string }>).map((m) => [m.id, m.name])) : new Map<number, string>();
  const accTypes = needNames ? new Map((db.$client.prepare('select id, type from account').all() as Array<{ id: number; type: string }>).map((x) => [x.id, x.type])) : new Map<number, string>();
  const onBank = needNames ? ctx.bankMerchants() : new Set<number>();

  const full = to < current ? monthsBetween(from, to) : from <= lastFull ? monthsBetween(from, lastFull) : [];
  const withCurrent = from <= current && to >= current;
  const perMonth = new Map<string, { total: number; count: number }>(full.map((m) => [m, { total: 0, count: 0 }]));
  const groups = new Map<string, { name: string; he?: string; total: number; count: number }>();
  let total = 0;
  let count = 0;
  let paidBack = 0;
  const unknown = new UnknownCurrency();
  const now = { total: 0, count: 0 };
  // split transactions (hub/splits.ts): each part counts in its own category
  const splits = splitsByTxn(db);
  for (const month of withCurrent ? [...full, current] : full) {
    const isCurrent = month === current;
    for (const r of classifyMonthRows(db, month)) {
      if (!(buckets as Set<string>).has(r.bucket)) continue;
      const t = r.t;
      const parts = splits.get(t.id);
      const pieces = (parts ? allocateSplit(r.amount, parts) : [{ categoryId: t.categoryId, amount: r.amount }]).filter((p) => !cat || cat.ids.has(p.categoryId));
      if (!pieces.length) continue;
      const unknownCur = currencyUnknown(t.source, t.originalCurrency);
      if (!unknownCur && !currencyOk(currency, t.originalCurrency)) continue;
      const c = t.categoryId === null ? undefined : cats.get(t.categoryId);
      let name: string | undefined;
      if (needNames) {
        name = modelName({ merchantName: t.merchantId === null ? null : merchants.get(t.merchantId), descriptions: [t.descriptionRaw, t.descriptionNorm], kind: t.kind, categoryKey: c?.key ?? null, categoryName: c?.en, amount: t.amountIls, onCard: accTypes.get(t.accountId) === 'credit_card', merchantOnBank: t.merchantId !== null && onBank.has(t.merchantId) });
        if (needle && ![name, c?.en ?? '', c?.he ?? ''].some((s) => s.toLowerCase().includes(needle))) continue;
      }
      // purchase minus its refunds (only the parts in the asked category of a split one); a paid-back row is positive
      // money in, so it reduces
      const spend = -pieces.reduce((a, p) => a + p.amount, 0);
      if (unknownCur && currency !== 'all') {
        // RiseUp history without a currency: counted as ILS, never as foreign; reported apart either way
        if (!isCurrent) unknown.add(month, spend);
        if (currency === 'foreign') continue;
      }
      if (isCurrent) {
        now.total += spend;
        now.count++;
        continue;
      }
      total += spend;
      count++;
      if (t.kind === 'paid_back') paidBack += r.amount;
      const pm = perMonth.get(month)!;
      pm.total += spend;
      pm.count++;
      if (groupBy === 'category') {
        for (const p of pieces) {
          const pc = p.categoryId === null ? undefined : cats.get(p.categoryId);
          const k = pc ? pc.key : 'uncategorised';
          const g = groups.get(k) ?? { name: pc?.en ?? UNCATEGORISED.en, he: pc?.he ?? UNCATEGORISED.he, total: 0, count: 0 };
          g.total += -p.amount;
          g.count++;
          groups.set(k, g);
        }
      } else if (groupBy === 'merchant') {
        const k = name!.toLowerCase();
        const g = groups.get(k) ?? { name: name!, total: 0, count: 0 };
        g.total += spend;
        g.count++;
        groups.set(k, g);
      }
    }
  }
  const months = full.length;
  const avg = (minor: number) => (months ? ils(minor / months) : 0);
  const fromOut = full[0] ?? from;
  const toOut = full[full.length - 1] ?? to;
  const method = [
    months ? `${months} full month${months === 1 ? '' : 's'} ${fromOut}..${toOut}` : 'no full month in the range',
    cat ? `${cat.kind} ${cat.en} / ${cat.he}` : 'all spending categories',
    currency === 'ils' ? 'ILS charges only (foreign = charged in a foreign currency)' : currency === 'foreign' ? 'foreign only (= charged in a foreign currency)' : 'all currencies',
    ...unknown.note(currency),
    ...(q ? [`names matching "${q}"`] : []),
    ...(buckets.size === 1 ? [`${[...buckets][0]} only`] : []),
    'refunds netted, transfers / card bills / savings left out',
    ...(paidBack ? ['money paid back to you subtracted'] : []),
    ...(withCurrent ? [`${current} (not finished) not in the totals`] : []),
    ...(clipped ? ['range cut to the last 36 full months'] : []),
  ].join('; ');
  let groupsOut: Array<Record<string, unknown>> | undefined;
  let otherGroups: { groups: number; total: number; count: number } | undefined;
  if (groupBy === 'month') groupsOut = full.map((m) => ({ name: m, total: ils(perMonth.get(m)!.total), count: perMonth.get(m)!.count }));
  else if (groupBy !== 'none') {
    const ranked = [...groups.values()].sort((x, y) => y.total - x.total);
    groupsOut = ranked.slice(0, limit).map((g) => ({ name: ctx.allow(g.name), ...(g.he ? { he: g.he } : {}), total: ils(g.total), count: g.count, monthlyAverage: avg(g.total) }));
    const rest = ranked.slice(limit);
    if (rest.length) otherGroups = { groups: rest.length, total: ils(rest.reduce((s, g) => s + g.total, 0)), count: rest.reduce((s, g) => s + g.count, 0) };
  }
  return {
    from: fromOut,
    to: toOut,
    months,
    total: months ? ils(total) : null,
    monthlyAverage: months ? avg(total) : null,
    yearlyEstimate: months ? ils((total / months) * 12) : null,
    count,
    currencyFilter: currency,
    ...unknown.out(currency),
    ...(cat ? { category: { kind: cat.kind, key: cat.key, name: cat.en, he: cat.he } } : {}),
    ...(groupsOut ? { groupBy, groups: groupsOut } : {}),
    ...(otherGroups ? { otherGroups } : {}),
    ...(paidBack ? { paidBackSubtracted: ils(paidBack) } : {}),
    ...(withCurrent ? { currentMonthSoFar: { month: current, total: ils(now.total), count: now.count } } : {}),
    method,
  };
}

/**
 * compare_periods (chat v2 plan, step 2): one month's spending per category against the same month last year, or
 * against the average of the N full months before it. Computed here from the month summaries (refunds netted,
 * transfers and card bills left out, like spend_by_category); the model gets totals and changes only.
 */
export function comparePeriods(db: Db, a: Record<string, unknown>, today: string, ctx: ToolContext = toolContext(db)): unknown {
  const current = today.slice(0, 7);
  const month = str(a.month) && /^\d{4}-\d{2}$/.test(str(a.month)!) ? str(a.month)! : addMonths(current, -1);
  const against = str(a.against) === 'last_year' ? 'last_year' : 'average';
  const n = Math.min(12, Math.max(2, Math.round(num(a.months, 6))));
  const cats = ctx.cats();
  const groupArg = str(a.group);
  const group = groupArg ? resolveChatCategory(cats, groupArg) : null;
  if (groupArg && !group) return unknownCategory(groupArg);
  const spendOf = (m: string): Map<number | null, number> => {
    const out = new Map<number | null, number>();
    for (const c of monthSummary(db, m).byCategory) if (c.sum < 0 && c.section !== 'income' && (!group || group.ids.has(c.categoryId))) out.set(c.categoryId, -c.sum);
    return out;
  };
  const now = spendOf(month);
  const thenMonths = against === 'last_year' ? [addMonths(month, -12)] : Array.from({ length: n }, (_, i) => addMonths(month, -(i + 1)));
  const then = new Map<number | null, number>();
  for (const m of thenMonths) for (const [id, v] of spendOf(m)) then.set(id, (then.get(id) ?? 0) + v / thenMonths.length);
  const ids = new Set([...now.keys(), ...then.keys()]);
  const rows = [...ids]
    .map((id) => {
      const x = now.get(id) ?? 0;
      const y = then.get(id) ?? 0;
      return { category: id === null ? null : cats.get(id), now: ils(x), then: ils(y), change: ils(x - y), changePct: y > 0 ? Math.round(((x - y) / y) * 100) : null };
    })
    .sort((p, q) => Math.abs(q.change) - Math.abs(p.change));
  const limit = Math.min(30, Math.max(1, Math.round(num(a.limit, 12))));
  const sum = (m: Map<number | null, number>) => [...m.values()].reduce((s2, v) => s2 + v, 0);
  return {
    month,
    ...(month === current ? { note: `${month} is not finished; its numbers are so far` } : {}),
    against: against === 'last_year' ? { kind: 'same month last year', month: thenMonths[0] } : { kind: `average of the ${n} full months before`, from: thenMonths[thenMonths.length - 1], to: thenMonths[0] },
    ...(group ? { group: group.key } : {}),
    total: { now: ils(sum(now)), then: ils(sum(then)), change: ils(sum(now) - sum(then)) },
    categories: rows.slice(0, limit),
    ...(rows.length > limit ? { otherCategories: rows.length - limit } : {}),
    method: 'spending per category; refunds netted, transfers and card bills left out; largest changes first',
  };
}

export const CHAT_TOOLS: ToolSpec[] = [
  {
    name: 'spend_summary',
    description:
      'Totals and averages of spending, computed here: total, full months counted, monthlyAverage, yearlyEstimate (average × 12), count, and optionally groups (by month, category or merchant). Spending only: never income or savings (use month_summary for those). Counts like the Now screen: refunds netted, transfers / card bills / savings left out, money paid back to the user subtracted. Defaults: the last 12 FULL months, all spending, all currencies. "category" takes a category or a group (key, English or Hebrew name, e.g. "car" or "רכב"); "merchant" searches merchant and category names; "currency": "ils" (charged in shekels) | "foreign" (charged in a foreign currency) | "all"; "bucket": "fixed" | "variable" | "installments" | "all". Positive numbers = spending.',
    params: '{"category": "car", "merchant": "text", "from": "YYYY-MM", "to": "YYYY-MM", "currency": "ils", "bucket": "all", "groupBy": "none|month|category|merchant", "limit": 12}',
    run: (db, a, today, ctx = toolContext(db)) => spendSummary(db, a, today, ctx),
  },
  {
    name: 'month_summary',
    description: 'Income, fixed, variable, installments, savings and net for one month; for the current month also what is left to spend and the projected end. The source for income, money put into savings, and the monthly instalment payment ("installments" of the current month).',
    params: '{"month": "YYYY-MM"}',
    run: (db, a, today) => {
      const month = monthOf(a.month, today);
      // the chat's own "today" (the eval's fixed date); the live chat's today is the real one, so nothing changes there
      const h = hubOverview(db, month, 'purchase', today === todayLocal() ? {} : { now: new Date(`${today}T12:00:00Z`) });
      const s = h.summary;
      const f = h.forecast;
      return {
        month,
        income: ils(s.income.sum),
        fixed: ils(-s.fixed.sum),
        variable: ils(-s.variable.sum),
        installments: ils(-s.installments.sum),
        savings: ils(-s.savings.sum),
        net: ils(s.net),
        transactions: s.income.count + s.expense.count + s.installments.count + s.savings.count,
        ...(f.isCurrentMonth ? { day: f.day, leftToSpend: ils(f.left), expectedFixedStillToCome: ils(s.expectedFixedRemaining ? -s.expectedFixedRemaining : 0), projectedEnd: ils(f.projected.end), projectedRange: [ils(f.projected.lo), ils(f.projected.hi)] } : {}),
        // a large extra income: projectedEnd above is on the regular income; projectedAll includes the extra
        ...(f.isCurrentMonth
          ? {
              regularIncome: ils(h.incomeSplit.regular.received + h.incomeSplit.regular.expected),
              extraIncome: ils(h.incomeSplit.extra.received + h.incomeSplit.extra.expected),
              leftWithoutExtra: ils(h.withoutExtra.left),
              extraExcluded: h.spread.extraExcluded,
              ...(h.spread.projectedAll ? { projectedAll: ils(h.spread.projectedAll.end), projectedAllRange: [ils(h.spread.projectedAll.lo), ils(h.spread.projectedAll.hi)] } : {}),
            }
          : {}),
        // payments marked as paid back to the owner: counted against variable spending, not as income (amounts and counts only)
        ...(h.paidBack.total > 0 ? { paidBackToYou: { total: ils(h.paidBack.total), payments: h.paidBack.items.length, countedAgainst: 'variable spending' } } : {}),
        // the monthly spending limit on variable spending, when one is set (amounts only)
        ...(h.limit
          ? {
              spendingLimit: {
                limit: ils(h.limit.amount),
                spent: ils(h.limit.spent),
                usedPct: h.limit.usedPct,
                pace: h.limit.pace.state,
                paceDelta: ils(h.limit.pace.delta),
                leftWithinLimit: ils(h.limit.leftWithin),
                ...(h.limit.week ? { thisWeekShare: ils(h.limit.week.limit), spentThisWeek: ils(h.limit.week.spent) } : {}),
              },
            }
          : {}),
      };
    },
  },
  {
    name: 'compare_periods',
    description: 'What changed: the spending of one month per category against the same month last year ("against": "last_year") or against the average of the full months before it ("against": "average", "months": 6 by default). Largest changes first, with the total. Default month: the last full month. Optional "group" limits it to one category group (e.g. "car").',
    params: '{"month": "YYYY-MM", "against": "average|last_year", "months": 6, "group": "car", "limit": 12}',
    run: (db, a, today, ctx = toolContext(db)) => comparePeriods(db, a, today, ctx),
  },
  {
    name: 'spend_by_category',
    description: 'Spending per category (and its group) for a month or a date range, largest first; optionally only the categories of one group.',
    params: '{"month": "YYYY-MM"} or {"from": "YYYY-MM-DD", "to": "YYYY-MM-DD"}, optional "group": "car"',
    run: (db, a, today, ctx = toolContext(db)) => {
      const cats = ctx.cats();
      const groupArg = str(a.group);
      const group = groupArg ? resolveChatCategory(cats, groupArg) : null;
      if (groupArg && !group) return unknownCategory(groupArg);
      const inGroup = (id: number | null) => !group || group.ids.has(id);
      const out = (r: Record<string, unknown>) => (group ? { group: group.key, ...r } : r);
      const from = str(a.from);
      const to = str(a.to);
      if (dateOk(from) && dateOk(to)) {
        const rows = db.$client
          .prepare(
            `select ${SPLIT_CATEGORY} id, sum(${splitShare('t.amount_ils')}) s, count(*) n from "transaction" t ${SPLIT_JOIN}
             where t.status = 'completed' and t.excluded = 0 and t.amount_ils < 0 and coalesce(t.kind,'') <> 'savings' and t.txn_date between ? and ?
             group by 1 order by s`,
          )
          .all(from, to) as Array<{ id: number | null; s: number; n: number }>;
        return out({ from, to, categories: rows.filter((r) => inGroup(r.id)).map((r) => ({ category: r.id === null ? null : cats.get(r.id), spent: ils(-r.s), count: r.n })) });
      }
      const month = monthOf(a.month, today);
      const s = monthSummary(db, month);
      return out({ month, categories: s.byCategory.filter((c) => c.sum < 0 && inGroup(c.categoryId)).map((c) => ({ category: c.categoryId === null ? null : cats.get(c.categoryId), spent: ils(-c.sum), count: c.count })) });
    },
  },
  {
    name: 'top_merchants',
    description: 'Where the money went: merchants ranked by total spend in a date range, optionally within one category (by its English or Hebrew name).',
    params: '{"from": "YYYY-MM-DD", "to": "YYYY-MM-DD", "limit": 10, "category": "optional name"}',
    run: (db, a, today, ctx = toolContext(db)) => {
      const from = dateOk(str(a.from)) ? (a.from as string) : `${today.slice(0, 7)}-01`;
      const to = dateOk(str(a.to)) ? (a.to as string) : today;
      const limit = Math.min(30, Math.max(1, Math.round(num(a.limit, 10))));
      const cat = str(a.category);
      // one line per merchant / account kind / kind / category / description, named here, then
      // summed per name sent: one "Wolt" line, one "bank transfer" line, one "Utilities" line
      const rows = db.$client
        .prepare(
          `select t.merchant_id mid, m.name mname, a.type = 'credit_card' card, t.kind kind, c.key ckey, c.name_en cname, t.description_raw dr, t.description_norm dn, sum(t.amount_ils) s, count(*) n from "transaction" t
           join account a on a.id = t.account_id left join merchant m on m.id = t.merchant_id left join category c on c.id = t.category_id
           where t.status = 'completed' and t.excluded = 0 and t.amount_ils < 0 and t.txn_date between ? and ?
             ${cat ? 'and (lower(c.name_en) = lower(?) or c.name_he = ? or c.key = ?)' : ''}
           group by 1, 2, 3, 4, 5, 6, 7, 8`,
        )
        .all(...(cat ? [from, to, cat, cat, cat] : [from, to])) as Array<{ mid: number | null; mname: string | null; card: number; kind: string | null; ckey: string | null; cname: string | null; dr: string; dn: string; s: number; n: number }>;
      const onBank = ctx.bankMerchants();
      const groups = new Map<string, { name: string; s: number; n: number }>();
      for (const r of rows) {
        const name = modelName({ merchantName: r.mname, descriptions: [r.dr, r.dn], kind: r.kind, categoryKey: r.ckey, categoryName: r.cname, amount: r.s, onCard: r.card === 1, merchantOnBank: r.mid !== null && onBank.has(r.mid) });
        const key = name.toLowerCase();
        const g = groups.get(key) ?? { name, s: 0, n: 0 };
        g.s += r.s;
        g.n += r.n;
        groups.set(key, g);
      }
      const ranked = [...groups.values()].sort((x, y) => x.s - y.s).slice(0, limit);
      return { from, to, merchants: ranked.map((g) => ({ merchant: ctx.allow(g.name), spent: ils(-g.s), count: g.n })) };
    },
  },
  {
    name: 'find_transactions',
    description: 'Transactions matching a search over merchant and category names (at least 2 characters) and/or a date range (default: the last 12 months) and/or an amount range (ILS) and/or currency ("ils" = charged in shekels, "foreign" = charged in a foreign currency). At most 50 rows: date, merchant, amount (negative = spend, positive = money in), category; "via" ("Bit" / "PayBox") on payments sent or received through those apps, searchable as "bit" / "ביט" / "paybox"; "refunded" (ILS) on a purchase that was partly or fully refunded, so its final cost = -amount - refunded; plus countAll (every match) and totalAll = SPENDING over all matches (positive ILS; fixed, variable and installments only, refunds netted, income and savings not counted). Names of people and bank descriptions are not searchable.',
    params: '{"q": "text", "from": "YYYY-MM-DD", "to": "YYYY-MM-DD", "min": 0, "max": 100000, "currency": "all", "limit": 20}',
    run: (db, a, today, ctx = toolContext(db)) => {
      const cats = ctx.cats();
      const q = str(a.q);
      if (q !== undefined && q.length < 2) return { error: 'q needs at least 2 characters' };
      const toArg = str(a.to);
      const fromArg = str(a.from);
      const to = dateOk(toArg) ? toArg : today;
      const from = dateOk(fromArg) ? fromArg : yearBefore(to);
      const min = num(a.min, 0) * 100;
      const max = num(a.max, Number.POSITIVE_INFINITY) * 100;
      const limit = Math.min(50, Math.max(1, Math.round(num(a.limit, 20))));
      const currency = currencyArg(a.currency);
      const onBank = ctx.bankMerchants();
      const needle = q?.toLowerCase();
      // RiseUp-owned rows carry no real currency (see currencyUnknown)
      const riseup = new Set((db.$client.prepare(`select id from "transaction" where source like 'riseup%' and txn_date between ? and ?`).all(from, to) as Array<{ id: number }>).map((r) => r.id));
      const unknown = new UnknownCurrency();
      // every row in range (listTransactions pages at most 1000), named as the model would see it;
      // the search matches only those names and category names, never descriptions, memos or notes
      const matches: Array<{ date: string; merchant: string; amount: number; spend: number; category: string | null; kind: string; currency?: string; via?: string; refunded?: number }> = [];
      const appNeedle = needle && (/^(bit|ביט)$/.test(needle) ? 'Bit' : /^(paybox|pay box|פייבוקס)$/.test(needle) ? 'PayBox' : undefined);
      for (let offset = 0; ; offset += 1000) {
        const page = listTransactions(db, { from, to, limit: 1000, offset, sort: 'date' });
        for (const t of page.items) {
          if (Math.abs(t.amount) < min || Math.abs(t.amount) > max) continue;
          const unknownCur = riseup.has(t.id) && currencyUnknown('riseup', t.originalCurrency);
          if (!unknownCur && !currencyOk(currency, t.originalCurrency)) continue;
          const cat = t.categoryId === null ? undefined : cats.get(t.categoryId);
          const merchant = modelName({ merchantName: t.merchantName, descriptions: [t.descriptionRaw], kind: t.kind, categoryKey: t.categoryKey, categoryName: cat?.en, amount: t.amount, onCard: t.accountType === 'credit_card', merchantOnBank: t.merchantId !== null && onBank.has(t.merchantId) });
          const via = paymentApp(t.descriptionRaw ?? '');
          // an app name matches only rows paid through that app ("ביט" is also the start of "ביטוח")
          if (appNeedle ? via !== appNeedle : needle && ![merchant, cat?.en ?? '', cat?.he ?? ''].some((s) => s.toLowerCase().includes(needle))) continue;
          // a purchase with a linked refund: the refund row itself is excluded (hidden), so show it on the purchase
          const refunded = t.amount < 0 && t.netAmount > t.amount ? t.netAmount - t.amount : 0;
          const spend = (SPEND_BUCKETS as readonly string[]).includes(t.bucket) ? -t.netAmount : 0;
          if (unknownCur && currency !== 'all') {
            unknown.add(t.month, spend);
            if (currency === 'foreign') continue;
          }
          matches.push({ date: t.date, merchant, amount: t.amount, spend, category: cat?.en ?? null, kind: t.bucket, ...(isForeignCurrency(t.originalCurrency) ? { currency: t.originalCurrency.trim().toUpperCase().slice(0, 3) } : {}), ...(via ? { via } : {}), ...(refunded ? { refunded } : {}) });
        }
        if (page.items.length < 1000 || offset + 1000 >= page.total) break;
      }
      const rows = matches.slice(0, limit);
      return {
        from,
        to,
        ...(currency !== 'all' ? { currencyFilter: currency } : {}),
        total: matches.length,
        shown: rows.length,
        countAll: matches.length,
        totalAll: ils(matches.reduce((s, t) => s + t.spend, 0)),
        ...unknown.out(currency),
        ...(unknown.count ? { note: unknown.note(currency)[0] } : {}),
        rows: rows.map((t) => ({ date: t.date, merchant: ctx.allow(t.merchant), amount: ils(t.amount), category: t.category, kind: t.kind, ...(t.currency ? { currency: t.currency } : {}), ...(t.via ? { via: t.via } : {}), ...(t.refunded ? { refunded: ils(t.refunded) } : {}) })),
      };
    },
  },
  {
    name: 'recurring',
    description: 'Confirmed fixed expenses and incomes: name, usual amount, frequency, next expected date, category.',
    params: '{}',
    run: (db, _a, _today, ctx = toolContext(db)) => {
      const r = recurringOverview(db, undefined, ['confirmed']);
      const cats = ctx.cats();
      const onBank = ctx.bankMerchants();
      // the stream's own rows: a standing order to a person is a stream whose descriptions say so
      const descs = db.$client.prepare('select distinct description_raw r, description_norm n from "transaction" where recurring_stream_id = ? order by txn_date desc limit 20');
      const accType = db.$client.prepare('select type from account where id = ?');
      return r.streams.map((s) => {
        const d = descs.all(s.id) as Array<{ r: string; n: string }>;
        const onCard = (accType.get(s.accountId) as { type: string } | undefined)?.type === 'credit_card';
        const name = modelName({ merchantName: s.merchantName, label: s.label, descriptions: [...d.map((x) => x.r), ...d.map((x) => x.n)], kind: null, categoryKey: s.categoryKey, categoryName: s.categoryId === null ? null : cats.get(s.categoryId)?.en, amount: s.expectedAmount, onCard, merchantOnBank: onBank.has(s.merchantId) });
        return { name: ctx.allow(name), amount: ils(s.expectedAmount), frequency: s.frequency, next: s.nextExpectedDate, category: s.categoryKey, direction: s.expectedAmount > 0 ? 'income' : 'expense' };
      });
    },
  },
  {
    name: 'trends',
    description: 'Monthly income / out / net / variable spending for the last N months (3–36), plus spend per group per month.',
    params: '{"months": 12}',
    run: (db, a, today) => {
      const t = trendsOverview(db, { months: Math.min(36, Math.max(3, Math.round(num(a.months, 12)))), today });
      return { months: t.months.map((m) => ({ month: m.month, income: ils(m.income), out: ils(m.out), net: ils(m.net), variable: ils(m.variable), fixed: ils(m.fixed), partial: m.partial })), groups: t.groups.map((g) => ({ group: g.key, perMonth: g.series.map(ils), median: ils(g.median) })) };
    },
  },
  {
    name: 'events',
    description: 'Events the user tagged (a trip, a repair…): name, cost, number of transactions, date span.',
    params: '{}',
    run: (db, _a, _today, ctx = toolContext(db)) => listEvents(db).map((e) => ({ name: ctx.allow(safeName(e.name)), cost: ils(e.spent - e.income), transactions: e.count, from: e.firstDate, to: e.lastDate })),
  },
  {
    name: 'net_worth',
    description: 'Net worth now: total, assets, liabilities, and each line by kind (bank, foreign currency, securities, card debt, manual holdings).',
    params: '{}',
    run: (db, _a, today, ctx = toolContext(db)) => {
      const n = netWorthOverview(db, { today });
      return { total: ils(n.total), assets: ils(n.assets), liabilities: ils(n.liabilities), lines: n.lines.map((l) => ({ kind: l.kind, side: l.side, value: ils(l.value), name: l.source === 'manual' ? ctx.allow(safeName(l.name)) : l.kind })) };
    },
  },
];

const MAX_ROUNDS = 6;
/** One lookup's result as the model sees it, at most this many characters (also what lookup memory keeps). */
export const LOOKUP_CHARS = 12_000;

/** The category groups for the prompt: key, both names and the seed's categories in it (fixed words only). */
export function categoryGroupsLine(): string {
  return CATEGORY_GROUPS.map((g) => {
    const members = CATEGORY_SEED.filter((c) => c.group === g.key).map((c) => c.en);
    return `${g.key} = ${g.en} / ${g.he}${members.length > 1 ? ` (${members.join(', ')})` : ''}`;
  }).join('; ');
}

export function chatSystemPrompt(lang: 'he' | 'en', today: string): string {
  const tools = CHAT_TOOLS.map((t) => `- ${t.name}: ${t.description} Args: ${t.params}`).join('\n');
  return [
    'You are finc, a personal-finance assistant for one Israeli household. You answer questions about the user\'s own money using ONLY the tools below; you have no other knowledge of their finances.',
    `Today is ${today}. Amounts are in ILS (₪). Months are YYYY-MM. Write the answer in the language of the user's latest question (each turn says which); the interface default is ${lang === 'he' ? 'Hebrew' : 'English'}.`,
    'Protocol: reply with exactly ONE JSON object and nothing else. Either {"tool": "<name>", "args": {...}, "answer": null} to look something up, or {"tool": null, "args": {}, "answer": "<your answer>", "followUps": ["<question>", ...]} when you can answer. In Hebrew abbreviations write the gershayim ״ (חו״ל, ש״ח), never a straight double quote. Use as few lookups as possible (at most 5). Never invent numbers: every figure in the answer must come from a lookup.',
    'Answer first:',
    '- When the question leaves something open, use these defaults without asking: averages and totals over the last 12 full months; all accounts; "foreign" / "abroad" = charged in a foreign currency (so "without foreign" = currency "ils").',
    '- Time words: "this month" = the current month so far; "last month" = the previous full month; "this year" = 1 January of this year to today; "last year" = the previous calendar year. "A year" / "per year" / "yearly" / "ובשנה?" as a rate (e.g. after a monthly average) = the yearly total over the same window, not "this year". A month named without a year (e.g. "September") = its latest occurrence up to today; never ask which year. Use these exact ranges.',
    '- "Each month" / "per month" about commitments (instalments, fixed bills, subscriptions) means the current monthly amount, not a 12-month average: instalments = the "installments" of month_summary for the current month; fixed bills and subscriptions = recurring.',
    '- Mention only the assumptions that shaped THIS answer, in a few words at the end, e.g. "(last 12 full months, shekel charges only)". Never recite this list of defaults, and say nothing about defaults that do not apply (a date, a single month, a refusal).',
    '- Ask one short clarifying question (and look nothing up) when the question refers to something that was never specified in it or earlier in the conversation, e.g. "the two months", "that store", "the same as before" with nothing before. Otherwise ask only when the answer would be materially different; at most one question, and never ask the user to confirm what they already said. When the user says "both", do both.',
    '- A short follow-up ("and by merchant?", "yes", "both") continues the previous question with the same filters; use the earlier lookups when they already hold the answer.',
    '- For totals, averages and yearly figures prefer spend_summary (one call usually answers); use its groupBy for breakdowns, and find_transactions only to list rows.',
    'Answers: the numbers first, short and concrete, rounded to whole shekels unless cents matter; dates as they matter to the question (a payment date is part of the answer). Plain text, no markdown tables. A name the lookups show as a generic label (e.g. a person) stays that label: never guess or ask for it. No advice about investments or products; describing the user\'s own spending patterns is fine.',
    `When answering in Hebrew, write the generic labels in Hebrew, never in English: ${(Object.keys(MODEL_LABELS) as Array<keyof typeof MODEL_LABELS>).map((k) => `"${MODEL_LABELS[k]}" = "${MODEL_LABELS_HE[k]}"`).join('; ')}.`,
    'Follow-ups: with a final answer, put in "followUps" up to 3 short questions the user is likely to ask next, in the language of the answer, that the tools can answer, phrased as the user would type them (e.g. "And by month?", "ולפי בתי עסק?"). None ("followUps": []) after a refusal or when your answer is a clarifying question. Never write follow-up offers ("Do you want me to…?", "רוצה ש…?") in the answer text: they go in followUps only.',
    `Category groups (for "category" in spend_summary, "group" in spend_by_category): ${categoryGroupsLine()}.`,
    'Tools:',
    tools,
  ].join('\n');
}

/** The language of the latest user question: Hebrew when it has Hebrew letters, else English. */
export function questionLang(history: ChatMessage[]): 'he' | 'en' {
  const last = [...history].reverse().find((m) => m.role === 'user');
  return last && /[\u05D0-\u05EA]/.test(last.content) ? 'he' : 'en';
}

/** The reply shape the providers enforce (provider.ts ReplyFormat): a lookup, or the answer. */
export const CHAT_REPLY_FORMAT: ReplyFormat = {
  name: 'reply',
  description: 'Either look something up (tool + args, answer null) or give the final answer (answer, tool null).',
  schema: {
    type: 'object',
    properties: {
      tool: { type: ['string', 'null'], description: 'the lookup to run, or null when answering' },
      args: { type: 'object', description: 'the lookup arguments ({} when answering)' },
      answer: { type: ['string', 'null'], description: 'the final answer to the user, or null when looking something up' },
      // optional, so a lookup reply never needs it; read leniently by cleanFollowUps
      followUps: { type: 'array', items: { type: 'string' }, maxItems: 3, description: 'with a final answer: up to 3 short questions the user may ask next, as the user would type them; [] otherwise' },
    },
    required: ['tool', 'args', 'answer'],
  },
};

const FOLLOW_UP_CHARS = 80;
const MAX_FOLLOW_UPS = 3;
/** A question compared loosely: whitespace collapsed, case and trailing question marks ignored. */
const questionKey = (s: string): string => s.replace(/\s+/g, ' ').trim().replace(/[?؟\s]+$/, '').toLowerCase();

/**
 * The follow-up chips from a reply's `followUps`, whatever the model sent: strings only, trimmed, whitespace collapsed,
 * at most 80 characters each (longer ones dropped, not cut), no duplicates, none equal to the user's own question,
 * at most 3. Anything that is not an array is [].
 */
export function cleanFollowUps(v: unknown, question?: string): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>(question ? [questionKey(question)] : []);
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string') continue;
    const s = x.replace(/\s+/g, ' ').trim();
    if (!s || s.length > FOLLOW_UP_CHARS) continue;
    const k = questionKey(s);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length === MAX_FOLLOW_UPS) break;
  }
  return out;
}

/** Shown when a reply cannot be read at all; never the model's raw text. */
export const UNREADABLE_REPLY = { he: 'לא הצלחתי לנסח תשובה. נסה לשאול שוב.', en: "I couldn't put an answer together. Please ask again." } as const;
/** Shown when the model ran out of output tokens mid-reply. */
export const TOO_LONG_REPLY = { he: 'התשובה יצאה ארוכה מדי ונקטעה. נסה לשאול שאלה ממוקדת יותר.', en: 'The answer ran too long and was cut off. Please ask a narrower question.' } as const;

/** A straight quote between Hebrew letters is an abbreviation mark (חו"ל, ש"ח): the Hebrew gershayim ״ instead. */
export function hebrewGershayim(s: string): string {
  return s.replace(/(?<=[\u05D0-\u05EA])"(?=[\u05D0-\u05EA])/g, '\u05F4');
}

/**
 * The value of `"answer": "…"` from JSON that does not parse: up to the last quote before the closing brace, or before
 * a trailing `"followUps": [...]` (whose chips are then dropped).
 */
function salvageAnswer(json: string): string | undefined {
  const m = /"answer"\s*:\s*"([\s\S]*?)"\s*(?:,\s*"followUps"\s*:\s*\[[\s\S]*\]\s*)?}\s*$/.exec(json);
  if (!m) return undefined;
  return m[1]!.replace(/\\(["\\\/nrt])/g, (_x, c: string) => (c === 'n' ? '\n' : c === 'r' ? '' : c === 't' ? '\t' : c)).replace(/\\$/, '');
}

/** Lookup arguments: an object, or an object sent as a JSON string; anything else is {}. */
function argsOf(v: unknown): Record<string, unknown> {
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return {};
    }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * One reply: {"tool": …, "args": …} or {"answer": …}. Structured replies always parse; plain text (a local model) is
 * read leniently: Hebrew abbreviation quotes repaired, then the answer salvaged from broken JSON. Raw JSON never
 * reaches the user: a reply that still cannot be read is `unreadable`. An answer always carries `followUps` (chat v2
 * step 4; [] when missing or unusable, see cleanFollowUps); `question` is the user's latest question, never offered back.
 */
export function parseReply(text: string, question?: string): { tool?: string; args?: Record<string, unknown>; answer?: string; followUps?: string[]; unreadable?: boolean } {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  // JSON cut off before its closing brace (out of tokens) is not an answer
  if (start >= 0 && end < start && /^\{\s*"/.test(text.slice(start))) return { unreadable: true };
  if (start < 0 || end < start) return text.trim() ? { answer: text.trim(), followUps: [] } : { unreadable: true };
  const json = text.slice(start, end + 1);
  for (const candidate of [json, hebrewGershayim(json)]) {
    try {
      const o = JSON.parse(candidate) as Record<string, unknown>;
      const answer = typeof o.answer === 'string' && o.answer.trim() ? o.answer : undefined;
      const tool = typeof o.tool === 'string' && o.tool ? o.tool : undefined;
      // a model that fills both fields with a placeholder tool ("none", "answer") meant the answer
      if (answer !== undefined && (tool === undefined || !CHAT_TOOLS.some((t) => t.name === tool))) return { answer, followUps: cleanFollowUps(o.followUps, question) };
      if (tool !== undefined) return { tool, args: argsOf(o.args) };
      return { unreadable: true };
    } catch {
      /* try the next repair */
    }
  }
  const salvaged = salvageAnswer(json);
  if (salvaged?.trim()) return { answer: salvaged, followUps: [] };
  // prose around a brace (no JSON intended) is still an answer; JSON-looking text is not shown
  return start > 0 && !/^\s*\{\s*"/.test(json) ? { answer: text.trim(), followUps: [] } : { unreadable: true };
}

function summarize(tool: string, args: Record<string, unknown>): string {
  const bits = Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  return bits.length ? `${tool} (${bits.join(', ')})` : tool;
}

/** Per chat call: category names are approved up front; stored descriptions load once, on first use. */
export function egressContext(db: Db): EgressContext {
  // the labels and the fixed words the tools emit (kinds, buckets, frequencies, sides, line kinds)
  const allowed = new Set<string>([
    ...Object.values(MODEL_LABELS),
    ...'income expense fixed variable installments savings settlements transfers refunds excluded settlement transfer refund ignore weekly biweekly monthly bimonthly quarterly annual asset liability checking foreign_currency securities credit_card pension investment property cash loan other ils foreign all none month category merchant group'.split(' '),
    // the category groups' names (fixed words, engine/categories.ts)
    ...CATEGORY_GROUPS.flatMap((g) => [g.key, g.en, g.he]),
    UNCATEGORISED.en,
    UNCATEGORISED.he,
  ]);
  for (const c of db.$client.prepare('select key, name_he, name_en, group_key from category').all() as Array<Record<string, string | null>>) for (const v of Object.values(c)) if (v) allowed.add(v);
  let cache: { raw: Set<string>; norm: Set<string> } | undefined;
  let ids: { long: string[]; last4: string[] } | undefined;
  return {
    allowed,
    descriptions: () => {
      if (!cache) {
        const rows = db.$client.prepare('select distinct description_raw r, description_norm n from "transaction"').all() as Array<{ r: string; n: string }>;
        cache = { raw: new Set(rows.map((x) => x.r.trim())), norm: new Set(rows.map((x) => x.n)) };
      }
      return cache;
    },
    identifiers: () => (ids ??= accountIdentifiers(db)),
  };
}

/**
 * The accounts' own identifiers (MCP design §5.2): external ids with a digit and 4+ characters, and digit groups of
 * 4+ in account and institution names go in `long`; the last-4 values (and a 4-digit group of a name) in `last4`.
 * Longest first, so a longer id is removed before a part of it.
 */
export function accountIdentifiers(db: Db): { long: string[]; last4: string[] } {
  const long = new Set<string>();
  const last4 = new Set<string>();
  for (const r of db.$client.prepare('select external_id e from account_alias').all() as Array<{ e: string | null }>) {
    const e = (r.e ?? '').trim();
    if (e.length >= 4 && /\d/.test(e)) long.add(e);
  }
  const names = db.$client.prepare('select a.last4 l, a.display_name d, i.display_name n from account a left join institution i on i.id = a.institution_id').all() as Array<{ l: string | null; d: string | null; n: string | null }>;
  for (const r of names) {
    if (r.l && /^\d{4}$/.test(r.l.trim())) last4.add(r.l.trim());
    for (const g of `${r.d ?? ''} ${r.n ?? ''}`.match(/\d{4,}/g) ?? []) (g.length === 4 ? last4 : long).add(g);
  }
  return { long: [...long].sort((a, b) => b.length - a.length), last4: [...last4] };
}

/** One chat or MCP lookup, as it may leave finc: what the model sees, and the paths the allow-list dropped. */
export interface PrivateToolResult {
  value: unknown;
  /** paths only (never values), for a log line and the tests */
  dropped: string[];
}

/**
 * The one way a tool result leaves finc (chat and MCP, design mcp-server.md §4): the tool runs here, its result is
 * cut down to the tool's allow-list (egress.ts), then every string goes through `guardEgress`. An unknown tool or a
 * thrown error becomes a short `{error}`, never the exception's text (P2-09). Pass the same `egress` and `ctx` for
 * every lookup of one conversation turn, so names approved by one lookup pass in the next.
 */
export function runPrivateTool(db: Db, name: string, args: Record<string, unknown>, today: string, session: { egress: EgressContext; ctx: ToolContext } = privateToolSession(db)): PrivateToolResult {
  const tool = CHAT_TOOLS.find((t) => t.name === name);
  if (!tool) return { value: { error: `unknown tool ${name}; available: ${CHAT_TOOLS.map((t) => t.name).join(', ')}` }, dropped: [] };
  let raw: unknown;
  try {
    raw = tool.run(db, args, today, session.ctx);
  } catch (e) {
    raw = { error: `the lookup failed: ${errorSummary(e)}` };
  }
  const p = projectToolResult(name, raw);
  return { value: guardEgress(p.value, session.egress), dropped: p.dropped };
}

/** A fresh egress context and tool context that share the names one turn approves. */
export function privateToolSession(db: Db): { egress: EgressContext; ctx: ToolContext } {
  const egress = egressContext(db);
  const ctx = toolContext(db, (name) => {
    egress.allowed.add(name);
    return name;
  });
  return { egress, ctx };
}

/** Run one turn: the whole conversation goes in, the next assistant answer and its lookups come out. */
export async function chat(db: Db, provider: AiProvider, messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
  const today = opts.today ?? todayLocal();
  const lang = (getSetting(db, 'ui.language') as 'he' | 'en' | null) ?? 'he';
  const history = messages.slice(-12);
  if (!history.length || history[history.length - 1]!.role !== 'user') throw new Error('the last message must be the user\'s question');
  const system = chatSystemPrompt(lang, today);
  const steps: ChatStep[] = [];
  /** this turn's lookups, unnumbered: what the caller may keep for the next turn */
  const lookups: string[] = [];
  const earlier = opts.previousLookups?.length ? `Lookups from earlier in this conversation (exact when made; may predate a sync since):\n${opts.previousLookups.map((l, i) => `e${i + 1}. ${l}`).join('\n')}\n\n` : '';
  const question = [...history].reverse().find((m) => m.role === 'user')!.content;
  const done = (answer: string, rounds: number, followUps: string[] = []): ChatResult => ({ answer, steps, model: provider.model, rounds, lookups, followUps });
  const session = privateToolSession(db);
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const user = [
      'Conversation:',
      ...history.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`),
      '',
      `${earlier}${lookups.length ? `Lookups so far (results are exact):\n${lookups.map((l, i) => `${i + 1}. ${l}`).join('\n')}` : 'No lookups yet in this turn.'}`,
      '',
      `Answer in ${questionLang(history) === 'he' ? 'Hebrew' : 'English'}.`,
      round === MAX_ROUNDS ? 'This is the last round: answer now with what you have ({"tool": null, "args": {}, "answer": "..."}).' : 'Reply with one JSON object.',
    ].join('\n');
    let text: string;
    try {
      text = await provider.complete({ system, user, maxTokens: 2500, format: CHAT_REPLY_FORMAT });
    } catch (e) {
      if (e instanceof AiError && /out of output tokens/.test(e.message)) return done(TOO_LONG_REPLY[questionLang(history)], round);
      throw e;
    }
    const r = parseReply(text, question);
    if (r.unreadable) return done(UNREADABLE_REPLY[questionLang(history)], round);
    // follow-ups only on a final answer (a lookup reply has none; the last-round fallback message gets none)
    if (r.answer !== undefined) return done(r.answer, round, r.followUps ?? []);
    if (round === MAX_ROUNDS) return done(UNREADABLE_REPLY[questionLang(history)], round);
    const args = r.args ?? {};
    // allow-list, then the egress guard; the provider gets an error's kind only, never its text (P2-09)
    const result = runPrivateTool(db, r.tool ?? '', args, today, session).value;
    steps.push({ tool: r.tool ?? '?', args, summary: summarize(r.tool ?? '?', args) });
    lookups.push(`${JSON.stringify({ tool: r.tool, args })} → ${JSON.stringify(result).slice(0, LOOKUP_CHARS)}`);
  }
  return done('', MAX_ROUNDS);
}
