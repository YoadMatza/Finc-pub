/**
 * "Paid back to me" (research_notes/proposals/now-screen-and-limit.md §1, build step 3): an incoming bank payment that
 * repays something the owner paid for (a shared dinner, a ticket). Marked as such (transaction.kind = 'paid_back', by
 * the owner for one payment or by a 'paid_back' counterparty rule for a payer), it counts against day-to-day spending
 * with its positive amount (engine/summary.ts classifyMonthRows puts it in the variable bucket) instead of as income.
 * Until the owner answers, the payment counts as extra income and finc asks once per payer.
 *
 * Pure functions only; hub/paidback.ts reads and writes the database. All amounts in agorot.
 */
import type { IncomeKind } from './income.js';

/** kind of an incoming payment that repays something the owner paid for */
export const PAID_BACK = 'paid_back';

/**
 * always   remember the payer: a 'paid_back' counterparty rule (only for a payer-specific description)
 * once     this payment only
 * no       remember the payer as income: an 'income' counterparty rule, finc stops asking (payer-specific only)
 * no_once  this payment is income; finc does not ask about it again (no rule)
 * undo     this payment back to income (and asked again); a matching 'paid_back' rule is forgotten
 */
export type PaidBackAnswer = 'always' | 'once' | 'no' | 'no_once' | 'undo';
export const PAID_BACK_ANSWERS: readonly PaidBackAnswer[] = ['always', 'once', 'no', 'no_once', 'undo'];

/** setting `paidBack.notAsked.<txnId>` = 'true': the owner answered "no" for this payment only */
export const NOT_ASKED_PREFIX = 'paidBack.notAsked.';
/** setting `paidBack.prevKind.<txnId>` = regular | extra: the income re-tag a payment had before it was marked paid back */
export const PREV_KIND_PREFIX = 'paidBack.prevKind.';
/**
 * SQL (alias t): a row day-to-day spending counts, besides the bucket rules: money out (not savings), or money paid
 * back to the owner, which nets it. For the raw-SQL variable totals (overview, forecast backtest).
 */
export const VARIABLE_ROW_SQL = `(t.amount_ils < 0 and coalesce(t.kind,'') <> 'savings' or t.kind = 'paid_back')`;

/** a remembered payer description must be at least this long */
export const MIN_PATTERN_LENGTH = 6;

/** Income categories a paid-back payment usually lands in; a named category (salary, freelance, …) is never asked about. */
export const ASK_CATEGORY_KEYS: ReadonlySet<string> = new Set(['income.other']);

/** A counterparty rule as the ask needs it. */
export interface RuleLite {
  pattern: string;
  kind: string;
  accountId: number | null;
  /** the rule's note; NO_RULE_NOTE marks an 'income' rule written by the "no" answer (matched exactly) */
  note?: string | null;
}

/** note of the 'income' rule the "no" answer writes: such a rule matches the description exactly, like a 'paid_back' rule */
export const NO_RULE_NOTE = 'paid_back:no';

/**
 * Whether a rule matches the whole description rather than a substring of it: every 'paid_back' rule, and the 'income'
 * rules the "no" answer writes. Payer names are short and descriptions share prefixes ("זיכוי מביט דנה" is a prefix of
 * "זיכוי מביט דנה כהן"), so a payer is remembered by the exact text. Other rules keep the substring match.
 */
export function isExactRule(r: { kind: string; note?: string | null }): boolean {
  return r.kind === PAID_BACK || (r.kind === 'income' && r.note === NO_RULE_NOTE);
}

/**
 * Whether a rule pattern matches a description the way applyCounterpartyRules does: SQLite LIKE '%pattern%' (a literal
 * substring, ASCII letters case-insensitive), or with `exact` the trimmed description equals the pattern (ASCII
 * case-insensitive). An empty pattern matches nothing here (such a rule is never written).
 */
export function patternMatches(pattern: string, descriptionNorm: string, exact = false): boolean {
  if (!pattern) return false;
  return exact ? asciiLower(descriptionNorm.trim()) === asciiLower(pattern) : asciiLower(descriptionNorm).includes(asciiLower(pattern));
}

function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** Rules of `kinds` that match a row (pattern, exact or substring per isExactRule, and the rule's account when it has one). */
export function matchingRules<R extends RuleLite>(rules: readonly R[], row: { descriptionNorm: string; accountId: number }, kinds: readonly string[]): R[] {
  return rules.filter((r) => kinds.includes(r.kind) && (r.accountId === null || r.accountId === row.accountId) && patternMatches(r.pattern, row.descriptionNorm, isExactRule(r)));
}

/** Words that name the way money arrived, not who sent it: a description made only of these names no payer. */
export const GENERIC_TRANSFER_WORDS: ReadonlySet<string> = new Set([
  'זיכוי',
  'העברה',
  'העברת',
  'מביט',
  'ביט',
  'bit',
  'מפייבוקס',
  'פייבוקס',
  'paybox',
  'מפפר',
  'פפר',
  'pepper',
  'מ',
  'transfer',
  'from',
]);

/** What names the payer in a description: its words without punctuation, digits and GENERIC_TRANSFER_WORDS. */
export function payerWords(descriptionNorm: string): string[] {
  return asciiLower(descriptionNorm)
    .replace(/[^\p{L}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w && !GENERIC_TRANSFER_WORDS.has(w));
}

export interface AskRow {
  kind: string | null;
  /** the row's bucket as the month counts it (classifyMonthRows / BUCKET_EXPR) */
  bucket: string;
  amount: number;
  /** the row's account is a credit card */
  isCard: boolean;
  /** the effective income kind (engine/income.ts incomeKindOf) */
  incomeKind: IncomeKind;
  categoryKey: string | null;
  /** belongs to a confirmed recurring stream */
  inConfirmedStream: boolean;
  descriptionNorm: string;
  accountId: number;
  /** the owner answered "no" for this payment only (no_once) */
  notAsked?: boolean;
}

/**
 * Whether finc asks "is this paying you back?" about a payment: income counted as income, on a bank account, positive,
 * extra, in "other income" or no category, not part of a confirmed recurring stream, with a description to remember,
 * and not already answered for its payer (no 'income' or 'paid_back' counterparty rule matches it).
 */
export function isAskCandidate(row: AskRow, rules: readonly RuleLite[]): boolean {
  if (row.bucket !== 'income' || row.kind !== 'income' || row.isCard || row.amount <= 0) return false;
  if (row.incomeKind !== 'extra') return false;
  if (row.categoryKey !== null && !ASK_CATEGORY_KEYS.has(row.categoryKey)) return false;
  if (row.inConfirmedStream || row.notAsked) return false;
  if (!rulePatternOf(row.descriptionNorm)) return false;
  return matchingRules(rules, row, ['income', PAID_BACK]).length === 0;
}

/** The pattern an answer remembers for a payer: the row's description, trimmed (ASCII lowercased, as the exact match compares); null when there is nothing to match on. */
export function rulePatternOf(descriptionNorm: string): string | null {
  const p = asciiLower(descriptionNorm.trim());
  return p.length >= 2 ? p : null;
}

/** An incoming bank row as the specificity check sees it. */
export interface PayerRow {
  descriptionNorm: string;
  merchantId: number | null;
}

/**
 * Whether a payer can be remembered by a rule (answers always / no): the pattern is at least MIN_PATTERN_LENGTH long
 * and matches incoming bank rows of one payer only (one merchant; a row without a merchant is its own payer per
 * description), matched exactly as the rule will be, and something names the payer once the generic transfer words
 * are removed ("זיכוי מביט" alone is a channel, not a person).
 */
export function isSpecificPayer(pattern: string | null, incoming: readonly PayerRow[]): boolean {
  if (pattern === null || pattern.length < MIN_PATTERN_LENGTH) return false;
  if (payerWords(pattern).length === 0) return false;
  const payers = new Set<string>();
  for (const r of incoming) {
    if (!patternMatches(pattern, r.descriptionNorm, true)) continue;
    payers.add(r.merchantId !== null ? `m${r.merchantId}` : `d${r.descriptionNorm}`);
    if (payers.size > 1) return false;
  }
  return true;
}

export interface PaidBackItem {
  id: number;
  name: string;
  /** positive agorot */
  amount: number;
  date: string;
  /** a 'paid_back' counterparty rule matches it (answered "always" for this payer) */
  byRule: boolean;
}

export interface PaidBackSummary {
  /** positive agorot: the sum of the items */
  total: number;
  /** largest first */
  items: PaidBackItem[];
}

export function paidBackSummary(items: PaidBackItem[]): PaidBackSummary {
  const sorted = [...items].sort((a, b) => b.amount - a.amount || a.date.localeCompare(b.date) || a.id - b.id);
  return { total: sorted.reduce((a, i) => a + i.amount, 0), items: sorted };
}

/** The one descriptive line for the weekly summary, `finc month` and similar; null when nothing was paid back. */
export function paidBackLine(s: { total: number; items: readonly unknown[] }, money: (minor: number) => string, lang: 'he' | 'en' = 'en'): string | null {
  if (s.total <= 0) return null;
  const n = s.items.length;
  return lang === 'he'
    ? `הוחזר לך: ${money(s.total)} (${n === 1 ? 'תשלום אחד' : `${n} תשלומים`}), נספר כנגד ההוצאות היומיומיות`
    : `paid back to you: ${money(s.total)} (${n} payment${n === 1 ? '' : 's'}), counted against day-to-day spending`;
}
