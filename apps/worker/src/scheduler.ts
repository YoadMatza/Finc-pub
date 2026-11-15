/**
 * 1–2 syncs a day at configured local times, each delayed by a random jitter so the banks
 * never see us at the exact same second. Runs are sequential; one sync at a time.
 */
import { type Db, INSTITUTIONS, SCRAPED_INSTITUTIONS, type Vault, finishRunError, refreshForecast, runEngine, setNextRun, startRun } from '@finc/core';
import { Cron } from 'croner';
import { runDispatch, securityAlert, startAlertTicker, telegramOtp } from './alerts.js';
import { type BackupDeps, BackupJob, BackupLockedError, type BackupOutcome } from './backup.js';
import { pruneDebugFiles } from './retention.js';
import { sweepIdleDevices } from './lockdown.js';
import { type ScrapeRunResult, type ScrapedInstitutionId, runScrape } from './connectors/scrape.js';
import { log } from './logger.js';
import type { OffsiteRunResult } from './offsite.js';

/**
 * The institutions a sync really visits (P2-02 review): each known scraped institution at most once, in the order
 * given. Unknown ids are dropped, so ["max","max",…] from any caller is one login, not hundreds.
 */
export function syncTargets(targets: readonly string[] | 'all'): ScrapedInstitutionId[] {
  const known = SCRAPED_INSTITUTIONS.map((i) => i.id as ScrapedInstitutionId);
  if (targets === 'all') return known;
  return [...new Set(targets)].filter((t): t is ScrapedInstitutionId => (known as string[]).includes(t));
}

export interface SchedulerConfig {
  /** "HH:MM" local times, e.g. ["06:00", "18:00"]. */
  times: string[];
  jitterMinutes: number;
  timezone: string;
  monthsBack: number;
  /** "HH:MM" local time of the nightly encrypted backup. */
  backupTime: string;
}

const validHhmm = (t: string): boolean => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  return !!m && Number(m[1]) <= 23 && Number(m[2]) <= 59;
};

/** "HH:MM,HH:MM" → validated list. Unset or blank means the default; anything malformed fails the start
 *  with a clear message instead of being dropped silently or crashing croner later. */
export function parseSyncTimes(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return ['06:00', '18:00'];
  const times = raw.split(',').map((s) => s.trim());
  for (const t of times) {
    if (!validHhmm(t)) {
      throw new Error(`FINC_SYNC_TIMES: "${t}" is not a valid HH:MM time (00:00-23:59); expected e.g. "06:00,18:00"`);
    }
  }
  return times;
}

/** FINC_BACKUP_TIME: one "HH:MM", default 03:40 (after the 03:20 retention, well before the morning sync). */
export function parseBackupTime(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') return '03:40';
  const t = raw.trim();
  if (!validHhmm(t)) throw new Error(`FINC_BACKUP_TIME: "${raw}" is not a valid HH:MM time (00:00-23:59); expected e.g. "03:40"`);
  return t;
}

/** A whole number from the environment within [min, max]; unset or blank means the default. */
export function intFromEnv(name: string, raw: string | undefined, def: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return def;
  const s = raw.trim();
  const n = Number(s);
  if (!/^\d+$/.test(s) || !Number.isSafeInteger(n) || n < min || n > max) {
    throw new Error(`${name}: "${raw}" must be a whole number from ${min} to ${max}`);
  }
  return n;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): SchedulerConfig {
  return {
    times: parseSyncTimes(env.FINC_SYNC_TIMES),
    jitterMinutes: intFromEnv('FINC_SYNC_JITTER_MIN', env.FINC_SYNC_JITTER_MIN, 30, 0, 240),
    timezone: env.TZ ?? 'Asia/Jerusalem',
    monthsBack: intFromEnv('FINC_SYNC_MONTHS', env.FINC_SYNC_MONTHS, 3, 1, 24),
    backupTime: parseBackupTime(env.FINC_BACKUP_TIME),
  };
}

/** Extras of a manual sync from the control port (`finc sync --dump / --dry-run` while the worker runs, P1-13). */
export interface SyncOptions {
  /** write the raw scraper result to data/dumps (gitignored) */
  dump?: boolean;
  /** scrape only: the database is not touched */
  dryRun?: boolean;
  /** FIBI connector design aid (dry runs only): record extra portal pages to data/dumps */
  explore?: boolean;
}

/** What a sync calls out to; tests replace these with fakes (no browser, no network). */
export interface SchedulerDeps {
  scrape: typeof runScrape;
  dispatch: typeof runDispatch;
  /** seams of the nightly backup (createBackup, the clock, the folder, the alert) */
  backup: Partial<BackupDeps>;
}

export class Scheduler {
  private jobs: Cron[] = [];
  private ticker: Cron | null = null;
  private retention: Cron | null = null;
  private deviceSweep: Cron | null = null;
  private pendingSince: Date | null = null;
  private pendingCheck: Cron | null = null;
  /** Tail of the sync queue: every syncNow chains onto it, so syncs run strictly one after another. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Syncs running or waiting their turn. */
  private pending = 0;
  private nextJittered: Date | null = null;
  private readonly deps: Omit<SchedulerDeps, 'backup'>;
  private nightlyBackup: Cron | null = null;
  private staleCheck: Cron | null = null;
  /** The nightly encrypted backup: one at a time, queued behind syncs (never alongside one). */
  readonly backup: BackupJob;
  lastResults: ScrapeRunResult[] = [];
  /** Called after a sync with at least one successful institution (the holding rules re-evaluate). Must not throw. */
  onSynced: (() => void) | null = null;

  constructor(
    private readonly db: Db,
    private readonly getVault: () => Vault | null,
    readonly config: SchedulerConfig,
    deps: Partial<SchedulerDeps> = {},
  ) {
    this.deps = { scrape: deps.scrape ?? runScrape, dispatch: deps.dispatch ?? runDispatch };
    this.backup = new BackupJob(db, getVault, config.timezone, deps.backup ?? {});
  }

  start(): void {
    for (const t of this.config.times) {
      const [h, m] = t.split(':').map(Number) as [number, number];
      const job = new Cron(`${m} ${h} * * *`, { timezone: this.config.timezone, name: `sync@${t}` }, () => void this.fire());
      this.jobs.push(job);
    }
    this.publishNextRun();
    this.ticker = startAlertTicker(this.db, this.getVault, this.config.timezone);
    pruneDebugFiles();
    this.retention = new Cron('20 3 * * *', { timezone: this.config.timezone, name: 'retention' }, () => void pruneDebugFiles());
    // P1-09: idle device tokens are revoked at start and daily, not only on their next use
    sweepIdleDevices(this.db, this.getVault());
    this.deviceSweep = new Cron('25 3 * * *', { timezone: this.config.timezone, name: 'device-expiry' }, () => void sweepIdleDevices(this.db, this.getVault()));
    this.pendingCheck = new Cron('*/10 * * * *', { timezone: this.config.timezone, name: 'pending-sync' }, () => this.onUnlocked());
    const [bh, bm] = this.config.backupTime.split(':').map(Number) as [number, number];
    this.nightlyBackup = new Cron(`${bm} ${bh} * * *`, { timezone: this.config.timezone, name: 'backup' }, () => this.fireBackup());
    this.staleCheck = new Cron('35 * * * *', { timezone: this.config.timezone, name: 'backup-stale' }, () => this.backup.checkAllStale());
    log.info({ times: this.config.times, jitterMinutes: this.config.jitterMinutes, tz: this.config.timezone, backupAt: this.config.backupTime, next: this.nextRun()?.toISOString() }, 'scheduler: started');
  }

  stop(): void {
    for (const j of this.jobs) j.stop();
    this.jobs = [];
    this.ticker?.stop();
    this.ticker = null;
    this.retention?.stop();
    this.retention = null;
    this.deviceSweep?.stop();
    this.deviceSweep = null;
    this.pendingCheck?.stop();
    this.pendingCheck = null;
    this.nightlyBackup?.stop();
    this.nightlyBackup = null;
    this.staleCheck?.stop();
    this.staleCheck = null;
  }

  /** The nightly slot: a locked vault holds the backup until the next unlock (like the scheduled sync). */
  fireBackup(): void {
    const v = this.getVault();
    if (!v || v.locked) {
      this.backup.pendingSince ??= new Date();
      log.warn('backup: vault locked, the nightly backup waits for the unlock');
      return;
    }
    if (this.backup.isRunning) return; // one is already running or queued
    this.backupNow().catch((e: unknown) => {
      if (!(e instanceof BackupLockedError)) log.error({ err: e instanceof Error ? e.message : String(e) }, 'nightly backup failed');
    });
  }

  /**
   * Run a backup now (nightly slot, after an unlock, or POST /api/backup/run). It chains onto the sync queue, so it
   * starts only when every sync before it has finished, and a sync asked for meanwhile waits for it. Refuses at once
   * (BackupLockedError / BackupBusyError) when the vault is locked or a backup is already running or queued.
   */
  backupNow(): Promise<BackupOutcome> {
    const v = this.getVault();
    if (!v || v.locked) return Promise.reject(new BackupLockedError());
    try {
      this.backup.reserve();
    } catch (e) {
      return Promise.reject(e);
    }
    const run = this.queue.then(() => this.backup.runReserved());
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Copy to the NAS now (POST /api/backup/offsite/run): the newest local backup plus the catch-up. Queued like a backup
   * (never alongside a sync or a backup); refuses at once when locked, not configured or already copying.
   */
  offsiteNow(): Promise<OffsiteRunResult> {
    const job = this.backup.offsite;
    try {
      job.precheck();
    } catch (e) {
      return Promise.reject(e);
    }
    const run = this.queue.then(() => job.run());
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Next base time (before jitter). */
  nextRun(): Date | null {
    const nexts = this.jobs.map((j) => j.nextRun()).filter((d): d is Date => d instanceof Date);
    if (this.nextJittered) nexts.push(this.nextJittered);
    return nexts.length ? new Date(Math.min(...nexts.map((d) => d.getTime()))) : null;
  }

  /** True while a sync runs or waits its turn. */
  get isRunning(): boolean {
    return this.pending > 0;
  }

  private async fire(): Promise<void> {
    const jitterMs = Math.floor(Math.random() * this.config.jitterMinutes * 60_000);
    this.nextJittered = new Date(Date.now() + jitterMs);
    this.publishNextRun();
    log.info({ jitterMinutes: +(jitterMs / 60_000).toFixed(1) }, 'scheduler: tick, waiting out the jitter');
    await new Promise((r) => setTimeout(r, jitterMs));
    this.nextJittered = null;
    const vault = this.getVault();
    if (!vault || vault.locked) {
      // The key lives in memory only, by decision (2026-11-09): a locked vault is not a failure, the sync
      // waits. The owner hears about it once, and the sync runs the moment the vault is unlocked.
      if (!this.pendingSince) {
        this.pendingSince = new Date();
        const he = this.lang() === 'he';
        securityAlert(this.db, vault, he ? 'הכספת נעולה, הסנכרון המתוזמן ממתין. פתח אותה מהמחשב: finc unlock' : 'the vault is locked; the scheduled sync is waiting. Unlock from the PC: finc unlock', { kind: 'sync.waiting_for_unlock', actor: 'system' });
      }
      log.warn('scheduler: vault locked, sync waits for the unlock');
      this.publishNextRun();
      return;
    }
    await this.syncNow('all', 'scheduled');
    this.publishNextRun();
  }

  /** When a scheduled sync was held back by a locked vault: the ISO time it first waited, else null. */
  get syncPendingSince(): string | null {
    return this.pendingSince?.toISOString() ?? null;
  }

  /** When the nightly backup was held back by a locked vault: the ISO time it first waited, else null. */
  get backupPendingSince(): string | null {
    return this.backup.pendingSince?.toISOString() ?? null;
  }

  /** Called right after an unlock: a waiting sync runs now, then a waiting backup (queued behind it). */
  onUnlocked(): void {
    const v = this.getVault();
    if (!v || v.locked) return;
    if (this.pendingSince) {
      this.pendingSince = null;
      log.info('scheduler: vault unlocked, running the sync that was waiting');
      void this.syncNow('all', 'scheduled')
        .then(() => this.publishNextRun())
        .catch((e: unknown) => log.error({ err: e instanceof Error ? e.message : String(e) }, 'pending sync failed'));
    }
    if (this.backup.pendingSince && !this.backup.isRunning) {
      log.info('scheduler: vault unlocked, running the backup that was waiting');
      // pendingSince is cleared by the backup itself once it actually starts with an open vault
      this.backupNow().catch((e: unknown) => {
        if (!(e instanceof BackupLockedError)) log.error({ err: e instanceof Error ? e.message : String(e) }, 'pending backup failed');
      });
    }
  }

  private lang(): 'he' | 'en' {
    const v = (this.db.$client.prepare(`select value from setting where key = 'ui.language'`).get() as { value: string } | undefined)?.value;
    return v === 'en' ? 'en' : 'he';
  }

  /**
   * Run a sync now (also used by the control port). Strictly serial: each call queues behind every
   * earlier one (a promise chain), so two waiters can never start together.
   * `opts.dump` writes the raw scraper result to data/dumps; `opts.dryRun` scrapes without touching the database
   * (no run recorded, no engine, no alerts). Only the control port (`finc sync --dump/--dry-run`) passes them (P1-13).
   */
  syncNow(targets: ScrapedInstitutionId[] | 'all', trigger: 'scheduled' | 'manual', monthsBack?: number, opts: SyncOptions = {}): Promise<ScrapeRunResult[]> {
    this.pending++;
    const run = this.queue.then(() => (opts.dryRun ? this.runDrySync(targets, monthsBack, opts.dump ?? false, opts.explore ?? false) : this.runSync(targets, trigger, monthsBack, opts.dump ?? false))).finally(() => {
      this.pending--;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Highest sync_run id so far for an institution (0 when none). */
  private lastRunId(institutionId: string): number {
    const r = this.db.$client.prepare(`select max(id) as id from sync_run where institution_id = ?`).get(institutionId) as { id: number | null } | undefined;
    return r?.id ?? 0;
  }

  /**
   * runScrape threw instead of returning a result: make sure the failure is on record, so the connection
   * shows it and the alert fires (P1-04). Runs it opened and left 'running' are closed as errors; when it
   * never got as far as opening one, a failed run is recorded on its own.
   */
  private recordCrash(institutionId: ScrapedInstitutionId, trigger: 'scheduled' | 'manual', runIdBefore: number | null, message: string): number | null {
    try {
      // runIdBefore null: we could not even read where the runs stood, so do not guess which are ours.
      const after =
        runIdBefore === null
          ? []
          : (this.db.$client.prepare(`select id, status from sync_run where institution_id = ? and id > ? order by id`).all(institutionId, runIdBefore) as Array<{ id: number; status: string }>);
      for (const r of after) if (r.status === 'running') finishRunError(this.db, r.id, 'CRASH', message);
      if (after.length) return after[after.length - 1]!.id;
      const runId = startRun(this.db, { institutionId, source: `scraper:${INSTITUTIONS[institutionId].scraperId}`, trigger });
      finishRunError(this.db, runId, 'CRASH', message);
      return runId;
    } catch (e) {
      log.error({ institution: institutionId, err: e instanceof Error ? e.message : String(e) }, 'sync crash could not be recorded');
      return null;
    }
  }

  /**
   * A dry run: scrape only. runScrape gets no database, nothing is recorded (not even a crash or a locked vault),
   * the engine and the alerts do not run and lastResults is left alone. A crash is returned as a failed result.
   */
  private async runDrySync(targets: ScrapedInstitutionId[] | 'all', monthsBack: number | undefined, dump: boolean, explore = false): Promise<ScrapeRunResult[]> {
    const ids = syncTargets(targets);
    const results: ScrapeRunResult[] = [];
    const vault = this.getVault();
    for (const institutionId of ids) {
      const t0 = Date.now();
      const failure = (errorType: string, errorMessage: string): ScrapeRunResult => ({ institutionId, runId: null, success: false, errorType, errorMessage, accounts: [], stats: { seen: 0, new: 0, updated: 0, completed: 0, voided: 0, annotated: 0 }, durationMs: Date.now() - t0 });
      if (!vault || vault.locked) {
        results.push(failure('LOCKED', 'vault is locked; run `finc unlock`'));
        continue;
      }
      if (!vault.has(institutionId)) {
        log.info({ institution: institutionId }, 'dry run skipped: no credentials in vault');
        continue;
      }
      try {
        results.push(await this.deps.scrape(null, { institutionId, vault, monthsBack: monthsBack ?? this.config.monthsBack, showBrowser: false, dump, dryRun: true, trigger: 'manual', otp: telegramOtp(this.db, this.getVault), ...(explore ? { explore: true } : {}) }));
      } catch (e) {
        const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
        log.error({ institution: institutionId, err: msg }, 'dry run crashed');
        results.push(failure('CRASH', msg));
      }
    }
    return results;
  }

  private async runSync(targets: ScrapedInstitutionId[] | 'all', trigger: 'scheduled' | 'manual', monthsBack: number | undefined, dump: boolean): Promise<ScrapeRunResult[]> {
    const ids = syncTargets(targets);
    const results: ScrapeRunResult[] = [];
    const vault = this.getVault();
    for (const institutionId of ids) {
      if (!vault || vault.locked) {
        const runId = startRun(this.db, { institutionId, source: `scraper:${INSTITUTIONS[institutionId].scraperId}`, trigger });
        finishRunError(this.db, runId, 'LOCKED', 'vault is locked; run `finc unlock`', 'error');
        log.warn({ institution: institutionId }, 'sync skipped: vault locked');
        continue;
      }
      if (!vault.has(institutionId)) {
        log.info({ institution: institutionId }, 'sync skipped: no credentials in vault');
        continue;
      }
      const t0 = Date.now();
      let before: number | null = null;
      try {
        before = this.lastRunId(institutionId);
        results.push(await this.deps.scrape(this.db, { institutionId, vault, monthsBack: monthsBack ?? this.config.monthsBack, showBrowser: false, dump, trigger, otp: telegramOtp(this.db, this.getVault) }));
      } catch (e) {
        const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
        log.error({ institution: institutionId, err: msg }, 'sync crashed');
        const runId = this.recordCrash(institutionId, trigger, before, msg);
        results.push({ institutionId, runId, success: false, errorType: 'CRASH', errorMessage: msg, accounts: [], stats: { seen: 0, new: 0, updated: 0, completed: 0, voided: 0, annotated: 0 }, durationMs: Date.now() - t0 });
      }
    }
    this.lastResults = results;
    // Every sync is followed by the truth engine, so links and buckets never lag behind the data (§5).
    if (results.some((r) => r.success)) {
      try {
        const e = runEngine(this.db);
        log.info({ settlementsUnmatched: e.settlements.unmatched.length, refundsAuto: e.refunds.auto, refundsSuggested: e.refunds.suggest, ms: e.ms }, 'engine: ran after sync');
        // The forecast judges itself: refresh the error band from finished months and log what Now says today.
        const f = refreshForecast(this.db);
        log.info({ bandMonths: f.band.monthsUsed, bandStored: f.band.stored }, 'forecast: band refreshed and today logged');
      } catch (err) {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'engine: failed after sync');
      }
    }
    // Alerts go out after every sync (failures included: a failed connection is itself an alert).
    await this.deps.dispatch(this.db, this.getVault(), trigger);
    // the owner's holding rules follow the new holdings (holding-rules.ts); it runs on its own, never failing the sync
    if (results.some((r) => r.success)) {
      try {
        this.onSynced?.();
      } catch (err) {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'holding rules: after-sync hook failed');
      }
    }
    return results;
  }

  private publishNextRun(): void {
    const next = this.nextRun()?.toISOString() ?? null;
    for (const inst of SCRAPED_INSTITUTIONS) setNextRun(this.db, inst.id, next);
  }
}
