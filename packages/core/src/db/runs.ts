import { and, eq, sql } from 'drizzle-orm';
import type { Db } from './db.js';
import { nowIso } from './db.js';
import { balanceSnapshot, connection, syncRun } from './schema.js';
import type { IngestStats } from '../ingest/types.js';
import { INSTITUTIONS } from '../institutions.js';
import { ensureInstitution } from './accounts.js';
import { cleanErrorText, cleanErrorType } from '../errors.js';
import { setSetting } from '../ai/settings.js';

/**
 * The institution's connection row must exist before a run, or finishRunError has nowhere to record the
 * failure and no sync-error alert can fire (an institution that never synced successfully was silent).
 */
function ensureConnectionFor(db: Db, institutionId: string): void {
  const spec = (INSTITUTIONS as Record<string, (typeof INSTITUTIONS)[keyof typeof INSTITUTIONS] | undefined>)[institutionId];
  if (spec) ensureInstitution(db, { id: spec.id, kind: spec.kind, displayName: spec.displayName, ...(spec.scraperId ? { scraperId: spec.scraperId } : {}) });
}

export function startRun(db: Db, p: { institutionId: string; source: string; trigger: 'scheduled' | 'manual' | 'import' }): number {
  ensureConnectionFor(db, p.institutionId);
  const ins = db
    .insert(syncRun)
    .values({ institutionId: p.institutionId, source: p.source, trigger: p.trigger, startedAt: nowIso(), status: 'running' })
    .run();
  return Number(ins.lastInsertRowid);
}

export function finishRunOk(db: Db, runId: number, stats: IngestStats, meta?: unknown): void {
  const now = nowIso();
  const run = db.select().from(syncRun).where(eq(syncRun.id, runId)).get();
  db.update(syncRun)
    .set({
      endedAt: now,
      status: 'ok',
      rowsSeen: stats.seen,
      rowsNew: stats.new,
      rowsUpdated: stats.updated,
      rowsCompleted: stats.completed,
      rowsVoided: stats.voided,
      rowsAnnotated: stats.annotated,
      metaJson: meta === undefined ? null : JSON.stringify(meta),
    })
    .where(eq(syncRun.id, runId))
    .run();
  if (run) {
    db.update(connection)
      .set({ lastOkAt: now, lastError: null, lastErrorAt: null, consecutiveFailures: 0, lastRunId: runId })
      .where(eq(connection.institutionId, run.institutionId))
      .run();
  }
}

/** The error text is cleaned before it is stored (P2-09): no URL query strings, account/card numbers or e-mails. */
export function finishRunError(db: Db, runId: number, rawErrorType: string, rawMessage: string, status: 'error' | 'otp_required' = 'error'): void {
  const now = nowIso();
  const errorType = cleanErrorType(rawErrorType);
  const message = cleanErrorText(rawMessage);
  const run = db.select().from(syncRun).where(eq(syncRun.id, runId)).get();
  db.update(syncRun).set({ endedAt: now, status, errorType, error: message }).where(eq(syncRun.id, runId)).run();
  if (run) {
    db.update(connection)
      .set({
        lastError: `${errorType}: ${message}`.slice(0, 500),
        lastErrorAt: now,
        consecutiveFailures: sql`${connection.consecutiveFailures} + 1`,
        lastRunId: runId,
      })
      .where(eq(connection.institutionId, run.institutionId))
      .run();
  }
}

/** Idempotent: the same (account, source, takenAt, balance) is recorded once, so re-ingesting a dump adds nothing. */
export function recordBalance(db: Db, p: { accountId: number; runId: number | null; balanceMinor: number; source: string; takenAt?: string }): boolean {
  const takenAt = p.takenAt ?? nowIso();
  const dup = db
    .select({ id: balanceSnapshot.id })
    .from(balanceSnapshot)
    .where(and(eq(balanceSnapshot.accountId, p.accountId), eq(balanceSnapshot.source, p.source), eq(balanceSnapshot.takenAt, takenAt), eq(balanceSnapshot.balance, p.balanceMinor)))
    .get();
  if (dup) return false;
  db.insert(balanceSnapshot).values({ accountId: p.accountId, syncRunId: p.runId, takenAt, balance: p.balanceMinor, source: p.source }).run();
  return true;
}

/** Bumped when cleanErrorText learns new rules, so text stored before them is cleaned once more. */
export const ERROR_CLEANUP_VERSION = '2';
export const ERROR_CLEANUP_SETTING = 'maintenance.errorTextCleaned';
const ERROR_SETTINGS = ['backup.lastError', 'offsite.lastError', 'alerts.securityLastError'];

/**
 * One-time cleanup (P2-09): error text stored before cleanErrorText existed goes through it now. Idempotent (cleaning
 * clean text changes nothing, and only changed rows are written); skipped once done for this version.
 * Returns how many values changed.
 */
export function cleanStoredErrors(db: Db, opts: { force?: boolean } = {}): number {
  const c = db.$client;
  const done = (c.prepare(`select value from setting where key = ?`).get(ERROR_CLEANUP_SETTING) as { value: string } | undefined)?.value;
  if (done === ERROR_CLEANUP_VERSION && !opts.force) return 0;
  let changed = 0;
  const tx = c.transaction(() => {
    const runs = c.prepare(`select id, error from sync_run where error is not null`).all() as Array<{ id: number; error: string }>;
    const updRun = c.prepare(`update sync_run set error = ? where id = ?`);
    for (const r of runs) {
      const v = cleanErrorText(r.error);
      if (v !== r.error) (updRun.run(v, r.id), changed++);
    }
    const conns = c.prepare(`select institution_id, last_error from connection where last_error is not null`).all() as Array<{ institution_id: string; last_error: string }>;
    const updConn = c.prepare(`update connection set last_error = ? where institution_id = ?`);
    for (const r of conns) {
      const v = cleanErrorText(r.last_error);
      if (v !== r.last_error) (updConn.run(v, r.institution_id), changed++);
    }
    const updSet = c.prepare(`update setting set value = ? where key = ?`);
    for (const k of ERROR_SETTINGS) {
      const cur = (c.prepare(`select value from setting where key = ?`).get(k) as { value: string | null } | undefined)?.value;
      if (typeof cur !== 'string') continue;
      const v = cleanErrorText(cur);
      if (v !== cur) (updSet.run(v, k), changed++);
    }
  });
  tx();
  setSetting(db, ERROR_CLEANUP_SETTING, ERROR_CLEANUP_VERSION);
  return changed;
}
