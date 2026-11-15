/** Read-only health queries for `finc health` and the worker's /health endpoint. */
import { desc, eq, sql } from 'drizzle-orm';
import type { Db } from './db/db.js';
import { account, balanceSnapshot, connection, institution, syncRun, transactions } from './db/schema.js';
import { INSTITUTIONS } from './institutions.js';

export interface AccountHealth {
  id: number;
  displayName: string | null;
  type: string;
  txns: number;
  pending: number;
  oldestTxnDate: string | null;
  newestTxnDate: string | null;
  latestBalance: { balance: number; takenAt: string; source: string } | null;
}

export interface ConnectionHealth {
  institutionId: string;
  displayName: string;
  kind: string;
  enabled: boolean;
  lastOkAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  consecutiveFailures: number;
  nextRunAt: string | null;
  lastRun: { id: number; status: string; startedAt: string; endedAt: string | null; rowsSeen: number; rowsNew: number; errorType: string | null } | null;
  accounts: AccountHealth[];
}

export function connectionHealth(db: Db): ConnectionHealth[] {
  const insts = db.select().from(institution).all();
  const out: ConnectionHealth[] = [];
  for (const inst of insts) {
    const conn = db.select().from(connection).where(eq(connection.institutionId, inst.id)).get();
    const lastRun = db.select().from(syncRun).where(eq(syncRun.institutionId, inst.id)).orderBy(desc(syncRun.id)).limit(1).get();
    const accounts = db.select().from(account).where(eq(account.institutionId, inst.id)).all();
    out.push({
      institutionId: inst.id,
      displayName: inst.displayName,
      kind: inst.kind,
      enabled: conn?.enabled ?? true,
      lastOkAt: conn?.lastOkAt ?? null,
      lastError: conn?.lastError ?? null,
      lastErrorAt: conn?.lastErrorAt ?? null,
      consecutiveFailures: conn?.consecutiveFailures ?? 0,
      nextRunAt: conn?.nextRunAt ?? null,
      lastRun: lastRun
        ? { id: lastRun.id, status: lastRun.status, startedAt: lastRun.startedAt, endedAt: lastRun.endedAt, rowsSeen: lastRun.rowsSeen, rowsNew: lastRun.rowsNew, errorType: lastRun.errorType }
        : null,
      accounts: accounts.map((a) => accountHealth(db, a.id, a.displayName, a.type)),
    });
  }
  // Institutions we know about but have never touched still show up as "not configured".
  for (const spec of Object.values(INSTITUTIONS)) {
    if (!out.some((o) => o.institutionId === spec.id)) {
      out.push({ institutionId: spec.id, displayName: spec.displayName, kind: spec.kind, enabled: false, lastOkAt: null, lastError: null, lastErrorAt: null, consecutiveFailures: 0, nextRunAt: null, lastRun: null, accounts: [] });
    }
  }
  return out.sort((a, b) => a.institutionId.localeCompare(b.institutionId));
}

function accountHealth(db: Db, id: number, displayName: string | null, type: string): AccountHealth {
  const agg = db
    .select({
      txns: sql<number>`count(*)`,
      pending: sql<number>`sum(case when ${transactions.status} = 'pending' then 1 else 0 end)`,
      oldest: sql<string | null>`min(${transactions.txnDate})`,
      newest: sql<string | null>`max(${transactions.txnDate})`,
    })
    .from(transactions)
    .where(eq(transactions.accountId, id))
    .get();
  const bal = db.select().from(balanceSnapshot).where(eq(balanceSnapshot.accountId, id)).orderBy(desc(balanceSnapshot.takenAt)).limit(1).get();
  return {
    id,
    displayName,
    type,
    txns: Number(agg?.txns ?? 0),
    pending: Number(agg?.pending ?? 0),
    oldestTxnDate: agg?.oldest ?? null,
    newestTxnDate: agg?.newest ?? null,
    latestBalance: bal ? { balance: bal.balance, takenAt: bal.takenAt, source: bal.source } : null,
  };
}

export function recentRuns(db: Db, limit = 20): Array<typeof syncRun.$inferSelect> {
  return db.select().from(syncRun).orderBy(desc(syncRun.id)).limit(limit).all();
}

export function setNextRun(db: Db, institutionId: string, nextRunAt: string | null): void {
  db.update(connection).set({ nextRunAt }).where(eq(connection.institutionId, institutionId)).run();
}

export function setEnabled(db: Db, institutionId: string, enabled: boolean): void {
  db.update(connection).set({ enabled }).where(eq(connection.institutionId, institutionId)).run();
}
