/**
 * Counterparty rules: "this description is my savings / a transfer to myself / rent". The user
 * confirms these; two defaults seed the table (decided 2026-11-08): a pension standing order = savings,
 * "העברה מהחשבון" = transfer pending review.
 */
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../db/db.js';
import { nowIso } from '../db/db.js';
import { counterpartyRule, transactions } from '../db/schema.js';
import { setSetting } from '../ai/settings.js';
import { PAID_BACK, PREV_KIND_PREFIX, isExactRule } from './paidback.js';

export const DEFAULT_RULES: Array<{ pattern: string; kind: string; note: string }> = [
  { pattern: 'פנסיה', kind: 'savings', note: 'pension standing order (default rule)' },
  { pattern: 'העברה מהחשבון', kind: 'transfer', note: 'outgoing transfer; destination unknown, review (default rule)' },
];

export { PAID_BACK };

export const EXCLUDED_KINDS =new Set(['transfer', 'settlement', 'ignore', 'refund']);

export function seedDefaultRules(db: Db): number {
  const existing = db.select().from(counterpartyRule).all();
  if (existing.length) return 0;
  for (const r of DEFAULT_RULES) db.insert(counterpartyRule).values({ ...r, createdAt: nowIso() }).run();
  return DEFAULT_RULES.length;
}

/** LIKE escape character used for rule patterns (not a backslash, to keep SQL and TS literals plain). */
const LIKE_ESCAPE = '!';

/** A rule pattern as a literal substring for LIKE: `%`, `_` and the escape char itself match only themselves. */
export function likeContains(pattern: string): string {
  return `%${pattern.toLowerCase().replace(/[!%_]/g, (ch) => LIKE_ESCAPE + ch)}%`;
}

export interface RulesResult {
  rules: number;
  transactionsTagged: number;
}

/**
 * Apply every rule: set kind (and excluded for transfer-like kinds) on matching transactions.
 * Scope (security research P1-02): rules match the description as a literal substring and only
 * act on bank-side rows (never credit-card accounts) in the rule's direction: money going out,
 * except an 'income' or 'paid_back' rule, which acts on money coming in. Rows tagged before this scope existed are
 * left as they are: nothing records whether a kind came from a rule or from the user, and undoing a
 * user's own transfer mark on every engine run would be worse (independent review 2026-11-10).
 */
export function applyCounterpartyRules(db: Db): RulesResult {
  let tagged = 0;
  const rules = db.select().from(counterpartyRule).all();
  db.transaction((tx) => {
    for (const r of rules) {
      const pat = likeContains(r.pattern);
      const excluded = EXCLUDED_KINDS.has(r.kind);
      const notCard = sql`exists (select 1 from account a where a.id = ${transactions.accountId} and a.type <> 'credit_card')`;
      const incoming = r.kind === 'income' || r.kind === PAID_BACK;
      const direction = incoming ? sql`${transactions.amountIls} > 0` : sql`${transactions.amountIls} < 0`;
      const matches = and(
        // the payer rules of the paid-back flow match the whole description (engine/paidback.ts isExactRule); others a substring
        isExactRule(r) ? sql`lower(trim(${transactions.descriptionNorm})) = lower(${r.pattern})` : sql`${transactions.descriptionNorm} like ${pat} escape ${LIKE_ESCAPE}`,
        r.accountId === null ? sql`1=1` : eq(transactions.accountId, r.accountId),
        or(isNull(transactions.kind), sql`${transactions.kind} not in ('settlement')`),
        // An income rule only settles plain money in: never a row the owner or the engine took out of the month
        // (transfer, ignore, refund, settlement), savings, or a payment marked paid back.
        r.kind === 'income' ? and(eq(transactions.excluded, false), sql`coalesce(${transactions.kind}, 'income') in ('income', 'expense')`) : sql`1=1`,
        // A paid_back rule claims only what finc would ask about (engine/paidback.ts isAskCandidate): money counted as
        // income, in "other income" or no category, outside any confirmed income stream, not re-tagged regular.
        r.kind === PAID_BACK
          ? and(
              eq(transactions.excluded, false),
              sql`coalesce(${transactions.kind}, 'income') in ('income', ${PAID_BACK})`,
              sql`(${transactions.categoryId} is null or exists (select 1 from category c where c.id = ${transactions.categoryId} and c.key = 'income.other'))`,
              sql`(${transactions.recurringStreamId} is null or not exists (select 1 from recurring_stream rs where rs.id = ${transactions.recurringStreamId} and rs.state = 'confirmed' and rs.direction = 'income'))`,
              sql`coalesce(${transactions.incomeKindOverride}, '') <> 'regular'`,
            )
          : sql`1=1`,
      );
      const rows = tx
        .select({ id: transactions.id, kind: transactions.kind, excluded: transactions.excluded, override: transactions.incomeKindOverride })
        .from(transactions)
        .where(and(matches, notCard, direction))
        .all();
      for (const t of rows) {
        if (t.kind === r.kind && t.excluded === excluded) continue;
        // paid back is not income: it leaves any income re-tag and any recurring income stream, as the owner's answer does
        const extra = r.kind === PAID_BACK ? { incomeKindOverride: null, recurringStreamId: null } : {};
        // the re-tag it had is kept so an undo can restore it
        if (r.kind === PAID_BACK && t.override !== null) setSetting(tx as unknown as Db, `${PREV_KIND_PREFIX}${t.id}`, t.override);
        tx.update(transactions).set({ kind: r.kind, excluded, ...extra, updatedAt: nowIso() }).where(eq(transactions.id, t.id)).run();
        tagged++;
      }
    }
  });
  return { rules: rules.length, transactionsTagged: tagged };
}

/** Fill kind for rows nothing else claimed: by sign. */
export function classifyRemaining(db: Db): number {
  const r1 = db.update(transactions).set({ kind: 'expense' }).where(and(isNull(transactions.kind), sql`${transactions.amountIls} < 0`)).run();
  const r2 = db.update(transactions).set({ kind: 'income' }).where(and(isNull(transactions.kind), sql`${transactions.amountIls} >= 0`)).run();
  return r1.changes + r2.changes;
}
