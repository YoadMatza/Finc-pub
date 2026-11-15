import { and, eq } from 'drizzle-orm';
import type { Db } from './db.js';
import { nowIso } from './db.js';
import { account, accountAlias, connection, institution } from './schema.js';

export interface EnsureAccountInput {
  institutionId: string;
  institutionKind: 'bank' | 'card' | 'aggregator' | 'manual';
  institutionDisplayName: string;
  scraperId?: string;
  source: string;
  externalId: string;
  type: 'checking' | 'credit_card' | 'savings' | 'loan' | 'cash' | 'foreign_currency' | 'securities';
  displayName?: string;
  last4?: string;
  currency?: string;
}

export function ensureInstitution(db: Db, inst: { id: string; kind: string; displayName: string; scraperId?: string }): void {
  db.insert(institution)
    .values({ id: inst.id, kind: inst.kind, displayName: inst.displayName, scraperId: inst.scraperId ?? null })
    .onConflictDoNothing()
    .run();
  db.insert(connection).values({ institutionId: inst.id }).onConflictDoNothing().run();
}

/** Find the account a source's external id maps to, creating account + alias on first sight. */
export function ensureAccount(db: Db, input: EnsureAccountInput): { accountId: number; created: boolean } {
  ensureInstitution(db, {
    id: input.institutionId,
    kind: input.institutionKind,
    displayName: input.institutionDisplayName,
    ...(input.scraperId ? { scraperId: input.scraperId } : {}),
  });
  const alias = db
    .select()
    .from(accountAlias)
    .where(and(eq(accountAlias.source, input.source), eq(accountAlias.externalId, input.externalId)))
    .get();
  if (alias) return { accountId: alias.accountId, created: false };

  // Adopt the single existing account of this institution+type that no other id from the same
  // source kind already claims (e.g. RiseUp imported Isracard before the scraper ever ran).
  const kind = input.source.split(':')[0];
  const candidates = db
    .select()
    .from(account)
    .where(and(eq(account.institutionId, input.institutionId), eq(account.type, input.type)))
    .all()
    .filter((a) => !db.select().from(accountAlias).where(eq(accountAlias.accountId, a.id)).all().some((al) => al.source.split(':')[0] === kind));
  if (candidates.length === 1) {
    const accountId = candidates[0]!.id;
    db.insert(accountAlias).values({ accountId, source: input.source, externalId: input.externalId }).run();
    const patch: Partial<typeof account.$inferInsert> = {};
    if (input.last4 && !candidates[0]!.last4) patch.last4 = input.last4;
    if (input.displayName && !candidates[0]!.displayName) patch.displayName = input.displayName;
    if (Object.keys(patch).length) db.update(account).set(patch).where(eq(account.id, accountId)).run();
    return { accountId, created: false };
  }

  const ins = db
    .insert(account)
    .values({
      institutionId: input.institutionId,
      type: input.type,
      displayName: input.displayName ?? null,
      last4: input.last4 ?? null,
      currency: input.currency ?? 'ILS',
      createdAt: nowIso(),
    })
    .run();
  const accountId = Number(ins.lastInsertRowid);
  db.insert(accountAlias).values({ accountId, source: input.source, externalId: input.externalId }).run();
  return { accountId, created: true };
}

/** Point an external id at an existing account (used to merge RiseUp's hash onto a scraped account). */
export function addAccountAlias(db: Db, accountId: number, source: string, externalId: string): void {
  db.insert(accountAlias).values({ accountId, source, externalId }).onConflictDoNothing().run();
}
