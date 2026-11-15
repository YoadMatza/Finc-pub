/**
 * "Paid back to me" (research_notes/proposals/now-screen-and-limit.md §1, build step 3): who finc asks about, the
 * month's paid-back payments, and the owner's answers. The arithmetic is in engine/paidback.ts; the counting is in
 * engine/summary.ts (a 'paid_back' row lands in the variable bucket with its positive amount).
 *
 * Answers (POST /api/transactions/:id/paid-back):
 *   always   a counterparty rule {pattern: description_norm, kind 'paid_back'} for the payer, applied at once
 *   once     this payment only (kind 'paid_back')
 *   no       a counterparty rule {pattern, kind 'income'} so finc stops asking; the payment counts as income
 *   no_once  this payment counts as income and is not asked about again (setting paidBack.notAsked.<id>), no rule
 *   undo     this payment back to income (asked again); a 'paid_back' rule that matches it is removed and its
 *            payments go back too
 * always and no need a payer-specific description (engine/paidback.ts isSpecificPayer), else 400 generic_payer.
 * Marking a payment paid back clears its income re-tag and keeps it in paidBack.prevKind.<id>; going back restores it.
 */
import { and, eq } from 'drizzle-orm';
import { getSetting, setSetting } from '../ai/settings.js';
import type { Db } from '../db/db.js';
import { nowIso } from '../db/db.js';
import { counterpartyRule, transactions } from '../db/schema.js';
import { incomeKindOf, isIncomeKind } from '../engine/income.js';
import {
  NOT_ASKED_PREFIX,
  NO_RULE_NOTE,
  PAID_BACK,
  PREV_KIND_PREFIX,
  type PaidBackAnswer,
  type PaidBackItem,
  type PaidBackSummary,
  type PayerRow,
  type RuleLite,
  isAskCandidate,
  isSpecificPayer,
  matchingRules,
  paidBackSummary,
  rulePatternOf,
} from '../engine/paidback.js';
import { applyCounterpartyRules } from '../engine/rules.js';
import type { ClassifiedRow } from '../engine/summary.js';
import { explicitIncomeKindKeys, incomeKinds, streamIncomeCategoryKeys } from './now.js';

export interface RuleRow extends RuleLite {
  id: number;
}

/** The counterparty rules that answer the question for a payer ('income' and 'paid_back'). */
export function answerRules(db: Db): RuleRow[] {
  return db.$client.prepare(`select id, pattern, kind, account_id accountId, note from counterparty_rule where kind in ('income', ?)`).all(PAID_BACK) as RuleRow[];
}

/** Every incoming bank row's description and merchant (the specificity check's universe). */
export function incomingPayers(db: Db): PayerRow[] {
  return db.$client
    .prepare(`select t.description_norm descriptionNorm, t.merchant_id merchantId from "transaction" t join account a on a.id = t.account_id where t.amount_ils > 0 and a.type <> 'credit_card'`)
    .all() as PayerRow[];
}

/** Ids of payments the owner answered "no" for, this one only. */
export function notAskedIds(db: Db): Set<number> {
  const rows = db.$client.prepare(`select key from setting where substr(key, 1, ?) = ?`).all(NOT_ASKED_PREFIX.length, NOT_ASKED_PREFIX) as Array<{ key: string }>;
  return new Set(rows.map((r) => Number(r.key.slice(NOT_ASKED_PREFIX.length))).filter((n) => Number.isInteger(n)));
}

/** A row as the ask needs it (from classifyMonthRows or the transactions list). */
export interface AskInput {
  id: number;
  kind: string | null;
  bucket: string;
  amount: number;
  accountId: number;
  categoryId: number | null;
  incomeKindOverride: string | null;
  recurringStreamId: number | null;
  descriptionNorm: string;
}

export interface PaidBackContext {
  /** finc asks whether this payment is paying the owner back */
  ask(row: AskInput): boolean;
  /** a 'paid_back' rule matches this row */
  byRule(row: { descriptionNorm: string; accountId: number }): boolean;
  /** "always" and "no" may remember this row's payer: an incoming bank payment counted as income or paid back, with a
   *  payer-specific description */
  canRemember(row: { kind: string | null; excluded: boolean; amount: number; accountId: number; descriptionNorm: string }): boolean;
}

/** Everything the ask reads, loaded once per request. */
export function paidBackContext(db: Db): PaidBackContext {
  const c = db.$client;
  const cats = new Map((c.prepare('select id, key from category').all() as Array<{ id: number; key: string }>).map((r) => [r.id, r.key]));
  const catKey = (id: number | null) => (id === null ? null : (cats.get(id) ?? null));
  const cards = new Set((c.prepare(`select id from account where type = 'credit_card'`).all() as Array<{ id: number }>).map((r) => r.id));
  const confirmed = new Set((c.prepare(`select id from recurring_stream where state = 'confirmed'`).all() as Array<{ id: number }>).map((r) => r.id));
  const incomeStreams = new Set((c.prepare(`select id from recurring_stream where state = 'confirmed' and direction = 'income'`).all() as Array<{ id: number }>).map((r) => r.id));
  const streamKeys = streamIncomeCategoryKeys(db);
  const explicit = explicitIncomeKindKeys(db);
  const kinds = incomeKinds(db, [...cats.values()]);
  const rules = answerRules(db);
  const notAsked = notAskedIds(db);
  let payers: PayerRow[] | null = null;
  const specific = new Map<string, boolean>();
  return {
    ask(row) {
      const categoryKey = catKey(row.categoryId);
      const stream = row.recurringStreamId !== null && confirmed.has(row.recurringStreamId);
      const incomeKind = incomeKindOf(
        { categoryKey, override: isIncomeKind(row.incomeKindOverride) ? row.incomeKindOverride : null, stream: row.recurringStreamId !== null && incomeStreams.has(row.recurringStreamId) },
        kinds,
        streamKeys,
        explicit,
      );
      return isAskCandidate(
        { kind: row.kind, bucket: row.bucket, amount: row.amount, isCard: cards.has(row.accountId), incomeKind, categoryKey, inConfirmedStream: stream, descriptionNorm: row.descriptionNorm, accountId: row.accountId, notAsked: notAsked.has(row.id) },
        rules,
      );
    },
    byRule(row) {
      return matchingRules(rules, row, [PAID_BACK]).length > 0;
    },
    canRemember(row) {
      if (row.excluded || row.amount <= 0 || cards.has(row.accountId)) return false;
      const k = row.kind ?? 'income';
      if (k !== 'income' && k !== PAID_BACK) return false;
      const pattern = rulePatternOf(row.descriptionNorm);
      if (pattern === null) return false;
      if (!specific.has(pattern)) specific.set(pattern, isSpecificPayer(pattern, (payers ??= incomingPayers(db))));
      return specific.get(pattern)!;
    },
  };
}

/** The month's paid-back payments (rows of classifyMonthRows), largest first; amounts positive. */
export function paidBackForMonth(db: Db, rows: readonly ClassifiedRow[], ctx: PaidBackContext = paidBackContext(db)): PaidBackSummary {
  const nameStmt = db.$client.prepare('select name from merchant where id = ?');
  const items: PaidBackItem[] = rows
    .filter((r) => r.bucket === 'variable' && r.t.kind === PAID_BACK)
    .map((r) => ({
      id: r.t.id,
      name: (r.t.merchantId !== null ? (nameStmt.get(r.t.merchantId) as { name: string } | undefined)?.name : undefined) ?? r.t.descriptionRaw,
      amount: r.amount,
      date: r.t.txnDate,
      byRule: ctx.byRule({ descriptionNorm: r.t.descriptionNorm, accountId: r.t.accountId }),
    }));
  return paidBackSummary(items);
}

export type PaidBackErrorCode = 'not_found' | 'not_eligible' | 'generic_payer';

export class PaidBackError extends Error {
  constructor(
    readonly status: 400 | 404,
    readonly code: PaidBackErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Set a payment's kind to paid_back (keeping its re-tag aside) or back to income (restoring it). 1 when it changed. */
function setPaidBackKind(db: Db, txnId: number, k: 'income' | typeof PAID_BACK): number {
  const t = db.select({ kind: transactions.kind, override: transactions.incomeKindOverride }).from(transactions).where(eq(transactions.id, txnId)).get();
  if (!t || (t.kind ?? 'income') === k) return 0;
  const prevKey = `${PREV_KIND_PREFIX}${txnId}`;
  if (k === PAID_BACK) {
    if (t.override !== null) setSetting(db, prevKey, t.override);
    db.update(transactions).set({ kind: k, incomeKindOverride: null, recurringStreamId: null, updatedAt: nowIso() }).where(eq(transactions.id, txnId)).run();
  } else {
    const prev = getSetting(db, prevKey);
    db.update(transactions)
      .set({ kind: k, ...(t.override === null && isIncomeKind(prev) ? { incomeKindOverride: prev } : {}), updatedAt: nowIso() })
      .where(eq(transactions.id, txnId))
      .run();
    setSetting(db, prevKey, null);
  }
  return 1;
}

/**
 * Apply the owner's answer about one payment. Checked before anything is written (a refused answer writes nothing);
 * the writes run in one transaction. `changed` counts the payments whose kind changed, the rules added or removed and
 * a "not asked" mark set or cleared.
 */
export function answerPaidBack(db: Db, id: number, answer: PaidBackAnswer): { changed: number } {
  const t = db.select().from(transactions).where(eq(transactions.id, id)).get();
  if (!t) throw new PaidBackError(404, 'not_found', 'no such transaction');
  const acc = db.$client.prepare('select type from account where id = ?').get(t.accountId) as { type: string } | undefined;
  if (t.amountIls <= 0 || !acc || acc.type === 'credit_card') throw new PaidBackError(400, 'not_eligible', 'only money coming in to a bank account can be marked as paid back');
  const kind = t.kind ?? 'income';
  if (t.excluded || (kind !== 'income' && kind !== PAID_BACK)) throw new PaidBackError(400, 'not_eligible', 'only a payment counted as income or as paid back can be answered');
  const pattern = rulePatternOf(t.descriptionNorm);
  if ((answer === 'always' || answer === 'no') && !isSpecificPayer(pattern, incomingPayers(db)))
    throw new PaidBackError(400, 'generic_payer', 'this description is shared by several payers (or too short) to remember; answer for this payment only');

  const kindsNow = () => new Map((db.$client.prepare(`select t.id, t.kind from "transaction" t join account a on a.id = t.account_id where t.amount_ils > 0 and a.type <> 'credit_card'`).all() as Array<{ id: number; kind: string | null }>).map((r) => [r.id, r.kind]));
  const kindsBefore = kindsNow();
  const rulesNow = () => db.select().from(counterpartyRule).all();
  let ruleChanges = 0;
  const notAskedKey = `${NOT_ASKED_PREFIX}${t.id}`;
  const setNotAsked = (on: boolean): void => {
    const was = getSetting(db, notAskedKey) !== null;
    if (was === on) return;
    setSetting(db, notAskedKey, on ? 'true' : null);
    ruleChanges++;
  };
  /** remove the paid_back rules matching this row; their payments return to income unless another remaining paid_back rule still matches them */
  const forget = (): void => {
    const all = rulesNow();
    const gone = matchingRules(all, t, [PAID_BACK]);
    if (!gone.length) return;
    const goneIds = new Set(gone.map((r) => r.id));
    const remaining = all.filter((r) => r.kind === PAID_BACK && !goneIds.has(r.id));
    for (const r of gone) {
      db.delete(counterpartyRule).where(eq(counterpartyRule.id, r.id)).run();
      ruleChanges++;
    }
    const rows = db.$client
      .prepare(`select t.id, t.description_norm descriptionNorm, t.account_id accountId from "transaction" t join account a on a.id = t.account_id where t.kind = ? and t.amount_ils > 0 and a.type <> 'credit_card'`)
      .all(PAID_BACK) as Array<{ id: number; descriptionNorm: string; accountId: number }>;
    for (const r of rows) {
      if (!matchingRules(gone, r, [PAID_BACK]).length) continue;
      if (r.id !== t.id && matchingRules(remaining, r, [PAID_BACK]).length) continue;
      setPaidBackKind(db, r.id, 'income');
    }
  };
  const addRule = (k: 'income' | typeof PAID_BACK): void => {
    if (rulesNow().some((r) => r.kind === k && r.pattern === pattern && r.accountId === null)) return;
    db.insert(counterpartyRule).values({ pattern: pattern!, kind: k, accountId: null, note: k === PAID_BACK ? 'paid back to me (owner, always)' : NO_RULE_NOTE, createdAt: nowIso() }).run();
    ruleChanges++;
  };
  /** remove 'income' rules with exactly this pattern (an earlier "no" for the same payer) */
  const dropIncomeRule = (): void => {
    for (const r of rulesNow()) {
      if (r.kind === 'income' && r.pattern === pattern && r.accountId === null) {
        db.delete(counterpartyRule).where(eq(counterpartyRule.id, r.id)).run();
        ruleChanges++;
      }
    }
  };

  db.transaction(() => {
    if (answer === 'once') {
      setNotAsked(false);
      setPaidBackKind(db, t.id, PAID_BACK);
    } else if (answer === 'always') {
      setNotAsked(false);
      dropIncomeRule();
      addRule(PAID_BACK);
      // the answered payment itself, even where the rule would not claim it (e.g. it belongs to an income stream)
      setPaidBackKind(db, t.id, PAID_BACK);
    } else if (answer === 'no') {
      forget();
      setPaidBackKind(db, t.id, 'income');
      addRule('income');
    } else if (answer === 'no_once') {
      setPaidBackKind(db, t.id, 'income');
      setNotAsked(true);
    } else {
      forget();
      setPaidBackKind(db, t.id, 'income');
      setNotAsked(false);
    }
  });
  if (answer === 'always') applyCounterpartyRules(db);
  const kindsAfter = kindsNow();
  let rowChanges = 0;
  for (const [rid, k] of kindsAfter) if (kindsBefore.get(rid) !== k) rowChanges++;
  return { changed: rowChanges + ruleChanges };
}
