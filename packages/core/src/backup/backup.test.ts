import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureAccount } from '../db/accounts.js';
import { openDb } from '../db/db.js';
import { ingestBatch } from '../ingest/ingest.js';
import type { NormalizedRow } from '../ingest/types.js';
import { Vault, VaultError } from '../vault/vault.js';
import { createBackup, listBackups, readSealed, restoreBackup, retentionPlan, verifyBackupWithPassword } from './backup.js';

const PASSWORD = 'correct horse battery';
const FAST = { ops: 1, mem: 1024 * 1024 }; // Argon2id cheap enough for tests

const dirs: string[] = [];
const closers: Array<() => void> = [];
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'finc-backup-test-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  // Windows cannot delete a folder while a database file in it is open
  for (const close of closers.splice(0)) {
    try {
      close();
    } catch {
      /* already closed */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const row = (i: number): NormalizedRow => ({ externalAccountId: 'x', date: '2026-11-01', amount: -1000 - i, description: `SHOP ${i}`, status: 'completed', type: 'normal', identifier: `id-${i}`, payload: {} });

async function setup() {
  const data = tmp();
  const backups = tmp();
  const dbFile = path.join(data, 'finc.db');
  const vaultFile = path.join(data, 'vault.json');
  const db = openDb(dbFile);
  closers.push(() => db.$client.close());
  const acc = ensureAccount(db, { institutionId: 'max', institutionKind: 'card', institutionDisplayName: 'Max', source: 'scraper:max', externalId: 'm', type: 'credit_card' }).accountId;
  ingestBatch(db, { source: 'scraper:max', runId: null, accountId: acc, rows: [1, 2, 3].map(row) });
  const vault = await Vault.create(vaultFile, PASSWORD, FAST);
  vault.set('max', 'scraper', { username: 'u', password: 'p' });
  return { db, vault, dbFile, vaultFile, backups, acc };
}

describe('encrypted backups (security research P1-12)', () => {
  it('makes a backup that verifies, holds no plaintext, and opens only with the master password', async () => {
    const s = await setup();
    const { file, result } = await createBackup(s.db, s.vault, { dir: s.backups, vaultFile: s.vaultFile, now: new Date('2026-11-10T01:40:00Z') });
    expect(path.basename(file)).toBe('finc-20261110T014000Z.fincbak');
    expect(result).toMatchObject({ ok: true, integrity: 'ok', mismatches: [] });
    expect(result.counts.transaction).toBe(3);
    // nothing readable on disk: no SQLite header, no merchant names, no temp snapshot left behind
    const onDisk = readFileSync(file, 'utf8');
    expect(onDisk).not.toContain('SQLite format');
    expect(onDisk).not.toContain('SHOP 1');
    expect(readdirSync(s.backups)).toEqual(['finc-20261110T014000Z.fincbak']);
    // with the password, from a fresh process' point of view
    expect((await verifyBackupWithPassword(file, PASSWORD)).ok).toBe(true);
    await expect(verifyBackupWithPassword(file, 'wrong password!')).rejects.toBeInstanceOf(VaultError);
  });

  it('detects a changed ciphertext and changed metadata', async () => {
    const s = await setup();
    const { file } = await createBackup(s.db, s.vault, { dir: s.backups, vaultFile: s.vaultFile });
    const sealed = readSealed(file);
    const flip = (c: string) => (c === 'A' ? 'B' : 'A');
    writeFileSync(file, JSON.stringify({ ...sealed, ct: flip(sealed.ct[0]!) + sealed.ct.slice(1) }));
    await expect(verifyBackupWithPassword(file, PASSWORD)).rejects.toThrow(/damaged or was changed|wrong master password/);
    writeFileSync(file, JSON.stringify({ ...sealed, meta: { ...sealed.meta, counts: { transaction: 999 } } }));
    await expect(verifyBackupWithPassword(file, PASSWORD)).rejects.toThrow(/damaged or was changed|wrong master password/);
  });

  it('a backup made before a master-password change still opens with the old password', async () => {
    const s = await setup();
    const { file } = await createBackup(s.db, s.vault, { dir: s.backups, vaultFile: s.vaultFile });
    await s.vault.rekey('a brand new password');
    expect(() => s.vault.openBackup(readSealed(file))).toThrow(/earlier master password/);
    expect((await verifyBackupWithPassword(file, PASSWORD)).ok).toBe(true);
    await expect(verifyBackupWithPassword(file, 'a brand new password')).rejects.toBeInstanceOf(VaultError);
  });

  it('restores over the live database: current files moved aside, data back, money alerts start now', async () => {
    const s = await setup();
    const { file } = await createBackup(s.db, s.vault, { dir: s.backups, vaultFile: s.vaultFile });
    // after the backup: more rows, then the "disaster"
    ingestBatch(s.db, { source: 'scraper:max', runId: null, accountId: s.acc, rows: [4, 5].map(row) });
    s.db.$client.close();
    const now = new Date('2026-11-12T09:00:00Z');
    const { result, movedAside } = await restoreBackup(file, PASSWORD, { dbFile: s.dbFile, vaultFile: s.vaultFile, now });
    expect(result.ok).toBe(true);
    expect(movedAside.some((f) => f.startsWith(`${s.dbFile}.before-restore-`))).toBe(true);
    const back = new Database(s.dbFile, { readonly: true });
    expect((back.prepare('select count(*) n from "transaction"').get() as { n: number }).n).toBe(3);
    expect((back.prepare(`select value from setting where key = 'alerts.moneySince'`).get() as { value: string }).value).toBe(now.toISOString());
    // the restored database's security log says so (P1-08)
    const restored = back.prepare(`select at, kind, actor, detail from security_event where kind = 'backup.restored'`).all() as { at: string; actor: string; detail: string }[];
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ at: now.toISOString(), actor: 'cli' });
    expect(JSON.parse(restored[0]!.detail)).toMatchObject({ file: file.split(/[/\\]/).pop(), withVault: false });
    back.close();
    // the vault is left alone unless asked
    expect(existsSync(s.vaultFile)).toBe(true);
    expect(movedAside.some((f) => f.includes('vault.json'))).toBe(false);
  });

  it('a wrong password restores nothing', async () => {
    const s = await setup();
    const { file } = await createBackup(s.db, s.vault, { dir: s.backups, vaultFile: s.vaultFile });
    s.db.$client.close();
    const before = readFileSync(s.dbFile);
    await expect(restoreBackup(file, 'nope nope nope', { dbFile: s.dbFile, vaultFile: s.vaultFile })).rejects.toBeInstanceOf(VaultError);
    expect(readFileSync(s.dbFile).equals(before)).toBe(true);
  });

  it('lists backups newest first', async () => {
    const s = await setup();
    await createBackup(s.db, s.vault, { dir: s.backups, vaultFile: s.vaultFile, now: new Date('2026-11-09T01:40:00Z') });
    await createBackup(s.db, s.vault, { dir: s.backups, vaultFile: s.vaultFile, now: new Date('2026-11-10T01:40:00Z') });
    expect(listBackups(s.backups).map((b) => b.name)).toEqual(['finc-20261110T014000Z.fincbak', 'finc-20261109T014000Z.fincbak']);
    expect(listBackups(s.backups)[0]?.meta?.counts.transaction).toBe(3);
  });
});

describe('independent review 2026-11-10', () => {
  it('leaves nothing behind: no plaintext snapshot in the backup folder, no temp databases in the OS temp dir', async () => {
    const s = await setup();
    const tempsBefore = readdirSync(os.tmpdir()).filter((n) => n.startsWith('finc-verify-')).length;
    await createBackup(s.db, s.vault, { dir: s.backups, vaultFile: s.vaultFile });
    expect(readdirSync(s.backups).every((n) => n.endsWith('.fincbak'))).toBe(true);
    expect(readdirSync(os.tmpdir()).filter((n) => n.startsWith('finc-verify-')).length).toBe(tempsBefore);
    // leftovers from an interrupted run are swept, finished backups never
    writeFileSync(path.join(s.backups, '.snapshot-20261110T014000Z-abcd.db'), 'x');
    writeFileSync(path.join(s.backups, 'finc-20261110T014000Z.fincbak.tmp'), 'x');
    const { sweepLeftovers } = await import('./backup.js');
    expect(sweepLeftovers(s.backups).sort()).toEqual(['.snapshot-20261110T014000Z-abcd.db', 'finc-20261110T014000Z.fincbak.tmp']);
    expect(readdirSync(s.backups).filter((n) => n.endsWith('.fincbak'))).toHaveLength(1);
  });

  it('a restore that is stopped right before the swap changes nothing', async () => {
    const s = await setup();
    const { file } = await createBackup(s.db, s.vault, { dir: s.backups, vaultFile: s.vaultFile });
    s.db.$client.close();
    const before = readFileSync(s.dbFile);
    const filesBefore = readdirSync(path.dirname(s.dbFile)).sort();
    await expect(
      restoreBackup(file, PASSWORD, {
        dbFile: s.dbFile,
        vaultFile: s.vaultFile,
        assertSafe: () => {
          throw new Error('the worker is running');
        },
      }),
    ).rejects.toThrow(/worker is running/);
    expect(readFileSync(s.dbFile).equals(before)).toBe(true);
    expect(readdirSync(path.dirname(s.dbFile)).sort()).toEqual(filesBefore); // no .restoring, nothing moved aside
  });

  it('after a restore, the first sync brings old charges back without replaying them to Telegram: one summary instead', async () => {
    const { RESTORED_AT_SETTING } = await import('./backup.js');
    const { collectAlerts } = await import('../alerts/index.js');
    const { setSetting } = await import('../ai/settings.js');
    const { runEngine } = await import('../engine/run.js');
    const s = await setup();
    setSetting(s.db, 'alerts.moneySince', '2000-01-01T00:00:00.000Z');
    const { file } = await createBackup(s.db, s.vault, { dir: s.backups, vaultFile: s.vaultFile });
    s.db.$client.close();
    await restoreBackup(file, PASSWORD, { dbFile: s.dbFile, vaultFile: s.vaultFile, now: new Date(Date.now() - 1000) });
    const db = openDb(s.dbFile);
    closers.push(() => db.$client.close());
    const acc = ensureAccount(db, { institutionId: 'max', institutionKind: 'card', institutionDisplayName: 'Max', source: 'scraper:max', externalId: 'm', type: 'credit_card' }).accountId;
    // before any engine run after the restore: nothing about money
    expect(collectAlerts(db, { lang: 'en' }).filter((a) => a.money)).toEqual([]);
    // the first sync re-inserts the charges made after the backup (big ones), then the engine runs
    // (distinct merchants: five "SHOP n" rows on one day would rightly count as card testing too)
    ingestBatch(db, { source: 'scraper:max', runId: null, accountId: acc, rows: [{ ...row(10), description: 'ELECTRA', amount: -250000 }, { ...row(11), description: 'IKEA', amount: -250000 }] });
    runEngine(db);
    const first = collectAlerts(db, { lang: 'en' }).filter((a) => a.money);
    expect(first.map((a) => a.key)).toHaveLength(1);
    expect(first[0]?.key.startsWith('restored:')).toBe(true);
    expect(first[0]?.text).toContain('2 charges');
    expect(collectAlerts(db, { lang: 'en' }).filter((a) => a.money)).toEqual([]); // and never again
    expect(db.$client.prepare('select value from setting where key = ?').get(RESTORED_AT_SETTING)).toBeUndefined();
  });
});

describe('retention', () => {
  const name = (d: Date) => `finc-${d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}.fincbak`;

  it('keeps 7 daily, 4 weekly and 6 monthly from a year of nightly backups', () => {
    const names: string[] = [];
    for (let i = 0; i < 365; i++) names.push(name(new Date(Date.UTC(2026, 10, 10, 1, 40) - i * 86_400_000)));
    const { keep, remove } = retentionPlan(names);
    expect(keep.length).toBeLessThanOrEqual(7 + 4 + 6);
    expect(keep.length).toBeGreaterThanOrEqual(12); // the buckets overlap a little
    expect(keep[0]).toBe(name(new Date(Date.UTC(2026, 10, 10, 1, 40))));
    expect(keep.length + remove.length).toBe(365);
    // the oldest kept is about six months back
    const oldest = keep.at(-1)!;
    expect(oldest >= 'finc-20260501').toBe(true);
    expect(oldest < 'finc-20260701').toBe(true);
  });

  it('never deletes the only backup, and ignores files that are not backups', () => {
    expect(retentionPlan(['finc-20261110T014000Z.fincbak'])).toEqual({ keep: ['finc-20261110T014000Z.fincbak'], remove: [] });
    expect(retentionPlan(['notes.txt', 'finc-old.db']).remove).toEqual([]);
  });

  it('two backups on one day: the newer one of that day is the daily keeper', () => {
    const { keep, remove } = retentionPlan(['finc-20261110T014000Z.fincbak', 'finc-20261110T120000Z.fincbak', 'finc-20261109T014000Z.fincbak']);
    expect(keep).toContain('finc-20261110T120000Z.fincbak');
    expect(keep).toContain('finc-20261109T014000Z.fincbak');
    expect(remove).toEqual(['finc-20261110T014000Z.fincbak']);
  });
});
