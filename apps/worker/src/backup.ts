/**
 * The nightly encrypted backup, the worker side (security research P1-12): run createBackup + retention, record the
 * outcome in the settings, alert on failure (at most once a day) and when no verified backup is younger than 48 hours.
 * The timing and the queueing behind syncs live in the scheduler; this class only runs one backup at a time.
 */
import { readdirSync } from 'node:fs';
import { BACKUP_EXT, type Db, type Vault, VaultError, applyRetention, backupDir, classifyError, cleanErrorText, createBackup, errorPhrase, getSetting, recordSecurityEvent, setSetting, vaultPath } from '@finc/core';
import { type SecurityAlertFn, securityAlert } from './alerts.js';
import { log } from './logger.js';
import { type OffsiteDeps, OffsiteJob } from './offsite.js';

export const BACKUP_SETTINGS = {
  lastOkAt: 'backup.lastOkAt',
  lastFile: 'backup.lastFile',
  lastError: 'backup.lastError',
  lastErrorAt: 'backup.lastErrorAt',
  lastCounts: 'backup.lastCounts',
  /** local day (YYYY-MM-DD) of the last "backup failed" alert */
  failAlertDay: 'backup.failAlertDay',
  /** local day of the last "no verified backup" alert */
  staleAlertDay: 'backup.staleAlertDay',
} as const;

const STALE_MS = 48 * 3_600_000;

export class BackupLockedError extends Error {
  constructor() {
    super('vault is locked');
  }
}
export class BackupBusyError extends Error {
  constructor() {
    super('a backup is already running');
  }
}

/** What a backup calls out to; tests replace these (no real Argon2, IO or Telegram). */
export interface BackupDeps {
  create: typeof createBackup;
  retention: (dir: string) => string[];
  dir: () => string;
  vaultFile: () => string;
  now: () => Date;
  alert: SecurityAlertFn;
  /** seams of the offsite copy (the SFTP connection); dir, now and alert default to the ones above */
  offsite: Partial<OffsiteDeps>;
}

export interface BackupOutcome {
  ok: true;
  file: string;
  counts: Record<string, number>;
  removed: string[];
  /** the offsite copy right after it: null when not configured (or locked), else its outcome (never fails the backup) */
  offsite: { ok: true; copied: string[] } | { ok: false; error: string } | null;
}

export interface BackupStatus {
  lastOkAt: string | null;
  lastFile: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  pending: boolean;
  running: boolean;
  count: number;
  dir: string | null;
}

export class BackupJob {
  /** Set when the nightly backup found the vault locked; it runs right after the next unlock. */
  pendingSince: Date | null = null;
  private busy = false;
  private readonly deps: BackupDeps;
  private readonly upSince: Date;
  /** The off-PC copy (NAS) made right after every good backup, when configured. */
  readonly offsite: OffsiteJob;

  constructor(
    private readonly db: Db,
    private readonly getVault: () => Vault | null,
    private readonly timezone: string,
    deps: Partial<BackupDeps> = {},
  ) {
    this.deps = {
      create: deps.create ?? createBackup,
      retention: deps.retention ?? ((dir) => applyRetention(dir)),
      dir: deps.dir ?? backupDir,
      vaultFile: deps.vaultFile ?? vaultPath,
      now: deps.now ?? (() => new Date()),
      alert: deps.alert ?? securityAlert,
      offsite: deps.offsite ?? {},
    };
    this.upSince = this.deps.now();
    this.offsite = new OffsiteJob(db, getVault, timezone, { dir: this.deps.dir, now: this.deps.now, alert: this.deps.alert, ...this.deps.offsite });
  }

  /** True from the moment a backup is reserved (possibly still waiting behind a sync) until it ends. */
  get isRunning(): boolean {
    return this.busy;
  }

  /** Take the single slot synchronously, so a second request is refused at once. */
  reserve(): void {
    if (this.busy) throw new BackupBusyError();
    this.busy = true;
  }

  /** Run a backup in the slot taken by reserve(); always frees the slot. Throws on failure (recorded and alerted). */
  async runReserved(): Promise<BackupOutcome> {
    try {
      const vault = this.getVault();
      if (!vault || vault.locked) {
        // the vault was locked while the backup waited its turn: it waits for the unlock like the nightly one
        this.pendingSince ??= this.deps.now();
        throw new BackupLockedError();
      }
      this.pendingSince = null;
      try {
        const dir = this.deps.dir();
        const now = this.deps.now();
        const { file, result } = await this.deps.create(this.db, vault, { dir, vaultFile: this.deps.vaultFile(), now });
        const name = file.split(/[/\\]/).pop() ?? file;
        // A database that suddenly shrank (emptied, or recreated after corruption) still makes a "verified" backup;
        // rotating the good ones out then would lose the history. Keep everything this time and say so
        // (independent review 2026-11-10). The new size becomes the baseline for the next night.
        const shrink = this.shrinkage(result.counts);
        setSetting(this.db, BACKUP_SETTINGS.lastOkAt, now.toISOString());
        setSetting(this.db, BACKUP_SETTINGS.lastFile, name);
        setSetting(this.db, BACKUP_SETTINGS.lastCounts, JSON.stringify(result.counts));
        let removed: string[] = [];
        if (shrink) {
          log.warn(shrink, 'backup: the database shrank; retention skipped');
          this.deps.alert(this.db, vault, `the database shrank from ${shrink.before} to ${shrink.after} transactions since the last backup; all older backups are kept. If this is unexpected, stop and restore (README "Backups").`, { kind: 'backup.shrank', actor: 'system', detail: { transactionsBefore: shrink.before, transactionsAfter: shrink.after } });
        } else {
          try {
            removed = this.deps.retention(dir);
          } catch (e) {
            // the backup itself is good; a retention problem only means more files are kept
            log.error({ err: e instanceof Error ? e.message : String(e) }, 'backup: retention failed');
          }
        }
        log.info({ file: name, transactions: result.counts.transaction, removed: removed.length }, 'backup: written and verified');
        // the off-PC copy: afterBackup never throws, so nothing here can turn the good local backup into a failure
        const offsite = await this.offsite.afterBackup().catch(() => null);
        return { ok: true, file: name, counts: result.counts, removed, offsite };
      } catch (e) {
        // locked in the middle (finc lock, /api/vault/lock): not a failure, it waits for the unlock like the nightly one
        if (e instanceof VaultError && e.code === 'LOCKED') {
          this.pendingSince ??= this.deps.now();
          throw new BackupLockedError();
        }
        this.recordFailure(vault, e);
        throw e;
      }
    } finally {
      this.busy = false;
    }
  }

  /** More than 10% fewer transactions than at the last backup, or none at all: suspicious. */
  private shrinkage(counts: Record<string, number>): { before: number; after: number } | null {
    try {
      const prev = JSON.parse(getSetting(this.db, BACKUP_SETTINGS.lastCounts) ?? '{}') as Record<string, number>;
      const before = prev.transaction ?? 0;
      const after = counts.transaction ?? 0;
      return before > 0 && (after === 0 || after < before * 0.9) ? { before, after } : null;
    } catch {
      return null;
    }
  }

  private recordFailure(vault: Vault, e: unknown): void {
    // stored and logged cleaned; the alert says only the kind and a fixed phrase (P2-09: paths stay home)
    const msg = cleanErrorText(e, 200);
    const kind = classifyError(e);
    const now = this.deps.now();
    log.error({ err: msg, kind }, 'backup: failed');
    // every failure is in the security log (P1-08); the alert stays once a day
    recordSecurityEvent(this.db, { kind: 'backup.failed', actor: 'system', detail: { error: msg, kind } });
    try {
      setSetting(this.db, BACKUP_SETTINGS.lastError, msg);
      setSetting(this.db, BACKUP_SETTINGS.lastErrorAt, now.toISOString());
      const day = this.localDay(now);
      if (getSetting(this.db, BACKUP_SETTINGS.failAlertDay) !== day) {
        setSetting(this.db, BACKUP_SETTINGS.failAlertDay, day);
        this.deps.alert(this.db, vault, `backup failed: ${errorPhrase(kind, 'en')} (${kind}); details in the worker log at home`, null);
      }
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'backup: the failure could not be recorded');
    }
  }

  /** Hourly: one alert a day while the vault is unlocked and no verified backup is younger than 48 hours. */
  checkStale(): void {
    const vault = this.getVault();
    if (!vault || vault.locked) return;
    const now = this.deps.now();
    const last = getSetting(this.db, BACKUP_SETTINGS.lastOkAt);
    const since = last ? new Date(last) : this.upSince;
    if (!(now.getTime() - since.getTime() > STALE_MS)) return;
    const day = this.localDay(now);
    if (getSetting(this.db, BACKUP_SETTINGS.staleAlertDay) === day) return;
    setSetting(this.db, BACKUP_SETTINGS.staleAlertDay, day);
    const days = Math.floor((now.getTime() - since.getTime()) / 86_400_000);
    this.deps.alert(this.db, vault, `no verified backup for ${days} days`, { kind: 'backup.stale', actor: 'system', detail: { days } });
  }

  /** The hourly check: the local backups, then the offsite copy (each with its own once-a-day alert). */
  checkAllStale(): void {
    try {
      this.checkStale();
    } finally {
      this.offsite.checkStale();
    }
  }

  status(): BackupStatus {
    let dir: string | null = null;
    let count = 0;
    try {
      dir = this.deps.dir();
      count = readdirSync(dir).filter((n) => n.startsWith('finc-') && n.endsWith(BACKUP_EXT)).length;
    } catch {
      /* folder missing or unreadable: count 0; the failure shows on the next backup */
    }
    return {
      lastOkAt: getSetting(this.db, BACKUP_SETTINGS.lastOkAt),
      lastFile: getSetting(this.db, BACKUP_SETTINGS.lastFile),
      lastError: getSetting(this.db, BACKUP_SETTINGS.lastError),
      lastErrorAt: getSetting(this.db, BACKUP_SETTINGS.lastErrorAt),
      pending: this.pendingSince !== null,
      running: this.busy,
      count,
      dir,
    };
  }

  private localDay(d: Date): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: this.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  }
}
