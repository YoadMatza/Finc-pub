import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Db, Vault, ensureAccount, getSetting, openDb, setSetting, weeklySummaryText } from '@finc/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './api/app.js';
import { BackupBusyError, type BackupDeps, BackupJob, BackupLockedError } from './backup.js';
import type { ScrapeRunResult } from './connectors/scrape.js';
import { Scheduler, type SchedulerDeps } from './scheduler.js';
import type { WorkerState } from './server.js';

const cfg = { times: ['06:00'], jitterMinutes: 0, timezone: 'UTC', monthsBack: 3, backupTime: '03:40' };
const dispatch: SchedulerDeps['dispatch'] = async () => undefined;
const failed = (institutionId: string): ScrapeRunResult => ({ institutionId, runId: null, success: false, errorType: 'X', accounts: [], stats: { seen: 0, new: 0, updated: 0, completed: 0, voided: 0, annotated: 0 }, durationMs: 0 }) as unknown as ScrapeRunResult;
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};
const fakeVault = (locked: boolean) => ({ locked, has: () => true, get: () => ({ kind: 'scraper', fields: { username: 'u', password: 'p' }, updatedAt: '' }) }) as unknown as Vault & { locked: boolean };
/** a createBackup that writes nothing */
const fakeCreate =
  (order?: string[], counts: Record<string, number> = { transaction: 5 }): BackupDeps['create'] =>
  async (_db, _v, o) => {
    order?.push('backup');
    return { file: path.join(o.dir, `finc-${(o.now ?? new Date()).toISOString().replace(/[-:]/g, '').slice(0, 15)}Z.fincbak`), result: { ok: true, integrity: 'ok', counts, mismatches: [], meta: {} as never } };
  };

let db: Db;
let tmp: string;
beforeEach(() => {
  db = openDb(':memory:');
  tmp = mkdtempSync(path.join(os.tmpdir(), 'finc-backup-test-'));
});
afterEach(() => {
  db.$client.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('backup job: the real createBackup', () => {
  it('writes a verified backup, records it in the settings and applies retention', async () => {
    const fileDb = openDb(path.join(tmp, 'finc.db'));
    const vaultFile = path.join(tmp, 'vault.json');
    const vault = await Vault.create(vaultFile, 'correct-horse-9', { ops: 1, mem: 1024 * 1024 });
    const dir = path.join(tmp, 'backups');
    try {
      ensureAccount(fileDb, { institutionId: 'max', institutionKind: 'card', institutionDisplayName: 'Max', scraperId: 'max', source: 'scraper:max', externalId: 'm', type: 'credit_card' });
      // two old backups on the same day: retention keeps only the newer one of that day
      const { mkdirSync } = await import('node:fs');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'finc-20260101T010000Z.fincbak'), '{}');
      writeFileSync(path.join(dir, 'finc-20260101T020000Z.fincbak'), '{}');
      const alerts: string[] = [];
      const s = new Scheduler(fileDb, () => vault, cfg, { dispatch, backup: { dir: () => dir, vaultFile: () => vaultFile, alert: (_d, _v, t) => void alerts.push(t) } });
      const r = await s.backupNow();
      expect(r.ok).toBe(true);
      expect(r.file).toMatch(/^finc-\d{8}T\d{6}Z\.fincbak$/);
      expect(r.counts.account).toBe(1);
      expect(r.removed).toEqual(['finc-20260101T010000Z.fincbak']);
      expect(readdirSync(dir).sort()).toEqual(['finc-20260101T020000Z.fincbak', r.file].sort());
      expect(getSetting(fileDb, 'backup.lastFile')).toBe(r.file);
      expect(Date.now() - Date.parse(getSetting(fileDb, 'backup.lastOkAt')!)).toBeLessThan(60_000);
      expect(JSON.parse(getSetting(fileDb, 'backup.lastCounts')!)).toMatchObject({ account: 1, transaction: 0 });
      expect(getSetting(fileDb, 'backup.lastError')).toBeNull();
      expect(s.backup.status()).toMatchObject({ lastFile: r.file, pending: false, running: false, count: 2, dir });
      expect(alerts).toEqual([]);
    } finally {
      vault.lock();
      fileDb.$client.close(); // Windows: an open handle makes the temp folder undeletable (EPERM)
    }
  });
});

describe('backup job: scheduling', () => {
  it('a locked vault holds the nightly backup; it runs after the unlock, after the pending sync', async () => {
    const order: string[] = [];
    const vault = fakeVault(true);
    const s = new Scheduler(db, () => vault, cfg, {
      scrape: async (_d, o) => {
        order.push(`scrape ${o.institutionId}`);
        return failed(o.institutionId);
      },
      dispatch,
      backup: { create: fakeCreate(order), retention: () => [], dir: () => tmp, alert: () => undefined },
    });
    await (s as unknown as { fire(): Promise<void> }).fire(); // the scheduled sync finds the vault locked
    s.fireBackup();
    expect(s.syncPendingSince).not.toBeNull();
    expect(s.backupPendingSince).not.toBeNull();
    expect(s.backup.status().pending).toBe(true);
    s.onUnlocked(); // still locked: nothing happens
    await settle();
    expect(order).toEqual([]);
    vault.locked = false;
    s.onUnlocked();
    await settle();
    expect(order.at(-1)).toBe('backup');
    expect(order.filter((o) => o === 'backup')).toHaveLength(1);
    expect(order.slice(0, -1).every((o) => o.startsWith('scrape '))).toBe(true);
    expect(order.length).toBeGreaterThan(1);
    expect(s.backupPendingSince).toBeNull();
    expect(s.syncPendingSince).toBeNull();
    expect(getSetting(db, 'backup.lastOkAt')).not.toBeNull();
    s.onUnlocked(); // nothing pending any more
    await settle();
    expect(order.filter((o) => o === 'backup')).toHaveLength(1);
  });

  it('waits for a running sync, and a second backup while one is queued is refused', async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const s = new Scheduler(db, () => fakeVault(false), cfg, {
      scrape: async (_d, o) => {
        order.push('scrape');
        if (order.length === 1) await new Promise<void>((r) => (release = r));
        return failed(o.institutionId);
      },
      dispatch,
      backup: { create: fakeCreate(order), retention: () => [], dir: () => tmp, alert: () => undefined },
    });
    const sync = s.syncNow(['max'], 'manual');
    await settle();
    const b = s.backupNow();
    await expect(s.backupNow()).rejects.toBeInstanceOf(BackupBusyError);
    await settle();
    expect(order).toEqual(['scrape']); // the backup has not started while the sync holds
    release();
    await sync;
    await b;
    expect(order).toEqual(['scrape', 'backup']);
    expect(s.backup.isRunning).toBe(false);
  });

  it('refuses at once while the vault is locked', async () => {
    const s = new Scheduler(db, () => null, cfg, { dispatch, backup: { create: fakeCreate(), dir: () => tmp } });
    await expect(s.backupNow()).rejects.toBeInstanceOf(BackupLockedError);
    expect(s.backup.isRunning).toBe(false);
  });
});

describe('backup job: independent review 2026-11-10', () => {
  it('a database that shrank by more than 10% keeps every older backup (retention skipped) and alerts', async () => {
    const alerts: string[] = [];
    let retentionRuns = 0;
    let counts = { transaction: 3785 };
    const job = new BackupJob(db, () => fakeVault(false), 'UTC', {
      create: async (d, v, o) => fakeCreate(undefined, counts)(d, v, o),
      retention: () => {
        retentionRuns++;
        return [];
      },
      dir: () => tmp,
      alert: (_d, _v, t) => void alerts.push(t),
    });
    job.reserve();
    await job.runReserved();
    expect(retentionRuns).toBe(1);
    counts = { transaction: 0 }; // e.g. a DB recreated empty after corruption
    job.reserve();
    await job.runReserved();
    expect(retentionRuns).toBe(1);
    expect(alerts.join()).toMatch(/shrank from 3785 to 0 transactions/);
    counts = { transaction: 3700 }; // small changes (a dedupe) are normal
    job.reserve();
    await job.runReserved();
    expect(retentionRuns).toBe(2); // the shrunk night is the new baseline
    counts = { transaction: 3690 };
    job.reserve();
    await job.runReserved();
    expect(retentionRuns).toBe(3);
  });

  it('a vault locked in the middle of a backup is not a failure: the backup waits for the unlock', async () => {
    const { VaultError } = await import('@finc/core');
    const alerts: string[] = [];
    const job = new BackupJob(db, () => fakeVault(false), 'UTC', {
      create: async () => {
        throw new VaultError('vault is locked', 'LOCKED');
      },
      dir: () => tmp,
      alert: (_d, _v, t) => void alerts.push(t),
    });
    job.reserve();
    await expect(job.runReserved()).rejects.toBeInstanceOf(BackupLockedError);
    expect(job.pendingSince).not.toBeNull();
    expect(alerts).toEqual([]);
    expect(getSetting(db, 'backup.lastError')).toBeNull();
  });
});

describe('backup job: alerts', () => {
  it('a failure records lastError and alerts at most once a day', async () => {
    let now = new Date('2026-11-10T01:40:00Z');
    const alerts: string[] = [];
    const job = new BackupJob(db, () => fakeVault(false), 'UTC', {
      create: async () => {
        throw new Error('ENOSPC: no space left\non device');
      },
      dir: () => tmp,
      now: () => now,
      alert: (_d, _v, t) => void alerts.push(t),
    });
    const attempt = async () => {
      job.reserve();
      await expect(job.runReserved()).rejects.toThrow(/ENOSPC/);
    };
    await attempt();
    await attempt();
    // P2-09: the alert carries the kind and a fixed phrase, never the error's own text
    expect(alerts).toEqual(['backup failed: the disk is full (disk_full); details in the worker log at home']);
    expect(getSetting(db, 'backup.lastError')).toBe('ENOSPC: no space left on device');
    expect(getSetting(db, 'backup.lastErrorAt')).toBe('2026-11-10T01:40:00.000Z');
    expect(getSetting(db, 'backup.lastOkAt')).toBeNull();
    expect(job.isRunning).toBe(false);
    now = new Date('2026-11-11T01:40:00Z');
    await attempt();
    expect(alerts).toHaveLength(2);
  });

  it('no verified backup for 48 hours: one alert a day, only while the vault is unlocked', () => {
    const t0 = Date.parse('2026-11-10T08:00:00Z');
    let now = new Date(t0);
    const alerts: string[] = [];
    let vault: Vault | null = fakeVault(false);
    const job = new BackupJob(db, () => vault, 'UTC', { dir: () => tmp, now: () => now, alert: (_d, _v, t) => void alerts.push(t) });
    now = new Date(t0 + 47 * 3_600_000);
    job.checkStale(); // never backed up, but the worker is up for less than 48 hours
    expect(alerts).toEqual([]);
    now = new Date(t0 + 49 * 3_600_000);
    vault = null;
    job.checkStale(); // locked: nothing could be done about it anyway, and Telegram is silent
    expect(alerts).toEqual([]);
    vault = fakeVault(false);
    job.checkStale();
    job.checkStale();
    expect(alerts).toEqual(['no verified backup for 2 days']);
    // a backup 3 days old, checked on another day
    now = new Date(t0 + 4 * 86_400_000);
    setSetting(db, 'backup.lastOkAt', new Date(now.getTime() - 3 * 86_400_000 - 60_000).toISOString());
    job.checkStale();
    expect(alerts).toEqual(['no verified backup for 2 days', 'no verified backup for 3 days']);
    // a fresh one: quiet again
    now = new Date(t0 + 5 * 86_400_000);
    setSetting(db, 'backup.lastOkAt', new Date(now.getTime() - 3_600_000).toISOString());
    job.checkStale();
    expect(alerts).toHaveLength(2);
  });
});

describe('POST /api/backup/run and /api/health', () => {
  const TOKEN = 'c'.repeat(64);
  const bearer = { authorization: `Bearer ${TOKEN}` };
  const setup = (create: BackupDeps['create']) => {
    const state: WorkerState = { db, vault: null, scheduler: null as unknown as Scheduler, startedAt: Date.now() };
    state.scheduler = new Scheduler(db, () => state.vault, cfg, { dispatch, backup: { create, retention: () => [], dir: () => tmp, alert: () => undefined } });
    const { app } = createApp(state, { controlToken: TOKEN, webDist: '/nonexistent' });
    const call = async (p: string, init: RequestInit = {}) => {
      const res = await app.request(p, { ...init, headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) } });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    };
    return { state, call };
  };

  it('home only, 409 when locked or busy, 200 with the file and counts', async () => {
    let gate: (() => void) | null = null;
    const inner = fakeCreate(undefined, { transaction: 42 });
    const { state, call } = setup(async (...a) => {
      if (gate === null) await new Promise<void>((r) => (gate = r));
      return inner(...a);
    });
    expect((await call('/api/backup/run', { method: 'POST' })).status).toBe(401);
    expect((await call('/api/backup/run', { method: 'POST', headers: { ...bearer, 'x-finc-edge': 'public', 'x-forwarded-for': '172.18.0.1' } })).status).toBe(403);
    expect((await call('/api/backup/run', { method: 'POST', headers: bearer })).status).toBe(409); // vault locked
    state.vault = fakeVault(false);
    const first = call('/api/backup/run', { method: 'POST', headers: bearer });
    await settle();
    const busy = await call('/api/backup/run', { method: 'POST', headers: bearer });
    expect(busy).toMatchObject({ status: 409, body: { error: 'a backup is already running' } });
    (gate as unknown as () => void)();
    const ok = await first;
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, counts: { transaction: 42 } });
    expect(ok.body.file).toMatch(/^finc-.*\.fincbak$/);
    const health = await call('/api/health', { headers: bearer });
    expect(health.body.backup).toMatchObject({ lastFile: ok.body.file, lastError: null, pending: false, count: 0, dir: tmp });
    expect(typeof (health.body.backup as { lastOkAt: string }).lastOkAt).toBe('string');
    // the anonymous health answer still says nothing
    expect(Object.keys((await call('/health')).body).sort()).toEqual(['ok', 'version']);
  });

  it('a failed backup is a 500 without the detail; the detail is in the health payload', async () => {
    const { state, call } = setup(async () => {
      throw new Error('EACCES: permission denied, open /backup/x');
    });
    state.vault = fakeVault(false);
    const r = await call('/api/backup/run', { method: 'POST', headers: bearer });
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toMatch(/EACCES/);
    expect(((await call('/api/health', { headers: bearer })).body.backup as { lastError: string }).lastError).toMatch(/EACCES/);
  });
});

describe('weekly summary: the backup line', () => {
  it('shows the last verified backup, or warns when it is older than 7 days', () => {
    expect(weeklySummaryText(db, { lang: 'en', today: '2026-11-10' }).text).not.toMatch(/backup/i);
    setSetting(db, 'backup.lastOkAt', '2026-11-09T01:40:00.000Z');
    expect(weeklySummaryText(db, { lang: 'en', today: '2026-11-10' }).text).toContain('Last verified backup: 2026-11-09');
    expect(weeklySummaryText(db, { lang: 'he', today: '2026-11-10' }).text).toContain('✓ גיבוי אחרון נבדק: 09.11');
    setSetting(db, 'backup.lastOkAt', '2026-11-02T01:40:00.000Z');
    expect(weeklySummaryText(db, { lang: 'en', today: '2026-11-10' }).text).toContain('⚠️ No verified backup since 2026-11-02');
    expect(weeklySummaryText(db, { lang: 'he', today: '2026-11-10' }).text).toContain('⚠️ אין גיבוי מאומת מאז 02.11');
  });
});
