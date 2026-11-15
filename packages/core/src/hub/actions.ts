/** User decisions taken from the hub. Each one is small, explicit and reversible. */
import { eq } from 'drizzle-orm';
import type { Db } from '../db/db.js';
import { nowIso } from '../db/db.js';
import { link, rule, transactions } from '../db/schema.js';

export function decideLink(db: Db, id: number, verdict: 'confirm' | 'reject'): { id: number; decision: string } {
  const l = db.select().from(link).where(eq(link.id, id)).get();
  if (!l) throw new Error(`no link #${id}`);
  const decision = verdict === 'confirm' ? 'confirmed' : 'rejected';
  db.transaction((tx) => {
    tx.update(link)
      .set({ decision, zone: verdict === 'confirm' ? 'auto' : l.zone, source: 'user' })
      .where(eq(link.id, l.id))
      .run();
    if (l.type === 'refund' || l.type === 'cancellation') {
      tx.update(transactions)
        .set({ kind: verdict === 'confirm' ? 'refund' : 'income', excluded: verdict === 'confirm', ...(verdict === 'confirm' ? { incomeKindOverride: null } : {}), updatedAt: nowIso() })
        .where(eq(transactions.id, l.fromTxnId))
        .run();
    }
  });
  return { id, decision };
}

export function setExcluded(db: Db, id: number, excluded: boolean, note?: string): void {
  const t = db.select().from(transactions).where(eq(transactions.id, id)).get();
  if (!t) throw new Error(`no transaction #${id}`);
  db.update(transactions)
    .set(excluded ? { excluded: true, kind: 'ignore', incomeKindOverride: null, ...(note !== undefined ? { note } : {}), updatedAt: nowIso() } : { excluded: false, kind: t.amountIls < 0 ? 'expense' : 'income', updatedAt: nowIso() })
    .where(eq(transactions.id, id))
    .run();
}

export function setNote(db: Db, id: number, note: string | null): void {
  const r = db.update(transactions).set({ note, updatedAt: nowIso() }).where(eq(transactions.id, id)).run();
  if (!r.changes) throw new Error(`no transaction #${id}`);
}

export function listRules(db: Db): Array<{ id: number; priority: number; enabled: boolean; conditions: Record<string, unknown>; actions: Record<string, unknown>; note: string | null; merchantName: string | null; categoryKey: string | null; createdAt: string }> {
  return (
    db.$client
      .prepare(
        `select r.*, m.name merchant_name, c.key category_key from rule r
         left join merchant m on m.id = json_extract(r.conditions_json, '$.merchantId')
         left join category c on c.id = json_extract(r.actions_json, '$.categoryId') order by r.priority, r.id`,
      )
      .all() as Array<Record<string, unknown>>
  ).map((r) => ({
    id: r.id as number,
    priority: r.priority as number,
    enabled: (r.enabled as number) === 1,
    conditions: JSON.parse(r.conditions_json as string) as Record<string, unknown>,
    actions: JSON.parse(r.actions_json as string) as Record<string, unknown>,
    note: (r.note as string | null) ?? null,
    merchantName: (r.merchant_name as string | null) ?? null,
    categoryKey: (r.category_key as string | null) ?? null,
    createdAt: r.created_at as string,
  }));
}

export function setRuleEnabled(db: Db, id: number, enabled: boolean): void {
  const r = db.update(rule).set({ enabled }).where(eq(rule.id, id)).run();
  if (!r.changes) throw new Error(`no rule #${id}`);
}

export function deleteRule(db: Db, id: number): void {
  const r = db.delete(rule).where(eq(rule.id, id)).run();
  if (!r.changes) throw new Error(`no rule #${id}`);
}

/** A row the user says is a transfer between own accounts: excluded from the cashflow as kind transfer. */
export function markTransfer(db: Db, id: number, isTransfer: boolean): void {
  const t = db.select().from(transactions).where(eq(transactions.id, id)).get();
  if (!t) throw new Error(`no transaction #${id}`);
  db.update(transactions)
    .set(isTransfer ? { kind: 'transfer', excluded: true, incomeKindOverride: null, updatedAt: nowIso() } : { kind: t.amountIls < 0 ? 'expense' : 'income', excluded: false, updatedAt: nowIso() })
    .where(eq(transactions.id, id))
    .run();
}
