/**
 * Encrypted backups (security research P1-12; architecture §9 "encrypted nightly backup of the DB").
 *
 * A backup is ONE file, `finc-<UTC stamp>.fincbak`: JSON with a plaintext but authenticated `meta` (when, sizes, row
 * counts) and one ciphertext holding the database snapshot followed by vault.json. It is sealed with a subkey of the
 * vault key (Vault.sealBackup), so opening it later needs only the master password of the day it was made. The database
 * snapshot comes from SQLite's online backup API, which is safe while the worker writes.
 *
 * Every backup is verified right after it is written: decrypted again, the database opened from a temporary file,
 * `PRAGMA integrity_check`, and the row counts compared with the ones recorded at backup time.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Db } from '../db/db.js';
import { type SealedBackup, Vault } from '../vault/vault.js';

export const BACKUP_EXT = '.fincbak';
/** Tables whose row counts are recorded in a backup and compared on verify. */
export const COUNTED_TABLES = ['transaction', 'raw_transaction', 'account', 'merchant', 'balance_snapshot', 'setting', 'passkey', 'device'] as const;

export interface BackupMeta {
  createdAt: string;
  /** applied schema migrations in the snapshot */
  migrations: number;
  dbBytes: number;
  vaultBytes: number;
  counts: Record<string, number>;
}

export interface BackupInfo {
  file: string;
  name: string;
  createdAt: string;
  sizeBytes: number;
  meta: BackupMeta | null;
}

export interface VerifyResult {
  ok: boolean;
  integrity: string;
  counts: Record<string, number>;
  /** tables whose count differs from the one recorded at backup time */
  mismatches: string[];
  meta: BackupMeta;
}

const stamp = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

function countRows(sqlite: Database.Database): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of COUNTED_TABLES) {
    try {
      out[t] = (sqlite.prepare(`select count(*) n from "${t}"`).get() as { n: number }).n;
    } catch {
      out[t] = -1; // table missing in an older schema
    }
  }
  return out;
}

function migrationCount(sqlite: Database.Database): number {
  try {
    return (sqlite.prepare('select count(*) n from __drizzle_migrations').get() as { n: number }).n;
  } catch {
    return -1;
  }
}

/**
 * The snapshot as a plain rollback-journal database: bytes 18/19 of the SQLite header say 2 (WAL) for the live DB,
 * which would make every read-only open of the copy create -wal/-shm files next to it. 1/1 is the legacy format;
 * the pages themselves are identical (independent review 2026-11-10).
 */
function asRollbackJournal(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 19 && bytes[18] === 2 && bytes[19] === 2) {
    bytes[18] = 1;
    bytes[19] = 1;
  }
  return bytes;
}

/** Open database bytes from a private temporary file, run `fn`, and always remove the file and any -wal/-shm. */
function withTempDb<T>(bytes: Uint8Array, fn: (sqlite: Database.Database) => T): T {
  const tmp = path.join(os.tmpdir(), `finc-verify-${randomBytes(8).toString('hex')}.db`);
  writeFileSync(tmp, bytes, { mode: 0o600 });
  let sqlite: Database.Database | null = null;
  try {
    sqlite = new Database(tmp, { readonly: true, fileMustExist: true });
    return fn(sqlite);
  } finally {
    sqlite?.close();
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`, `${tmp}-journal`]) rmSync(f, { force: true });
  }
}

/** Split a decrypted payload into the database and vault.json bytes. */
export function splitPayload(plain: Uint8Array, meta: BackupMeta): { db: Uint8Array; vault: Uint8Array } {
  if (plain.length !== meta.dbBytes + meta.vaultBytes) throw new Error('backup payload has the wrong size');
  return { db: plain.subarray(0, meta.dbBytes), vault: plain.subarray(meta.dbBytes) };
}

/** Check database bytes against the meta recorded at backup time. */
export function verifyPayload(plain: Uint8Array, meta: BackupMeta): VerifyResult {
  const { db } = splitPayload(plain, meta);
  return withTempDb(db, (sqlite) => {
    const integrity = (sqlite.pragma('integrity_check', { simple: true }) as string) ?? 'unknown';
    const counts = countRows(sqlite);
    const mismatches = Object.keys(meta.counts).filter((t) => meta.counts[t] !== counts[t]);
    return { ok: integrity === 'ok' && mismatches.length === 0, integrity, counts, mismatches, meta };
  });
}

export function readSealed(file: string): SealedBackup {
  const s = JSON.parse(readFileSync(file, 'utf8')) as SealedBackup;
  if (s?.v !== 1 || s.kind !== 'finc-backup') throw new Error(`${path.basename(file)} is not a finc backup`);
  return s;
}

/**
 * Make one encrypted backup in `dir` and verify it. Throws when anything fails (the caller alerts); a backup that does
 * not verify is deleted rather than kept as if it were good.
 */
export async function createBackup(db: Db, vault: Vault, opts: { dir: string; vaultFile: string; now?: Date }): Promise<{ file: string; result: VerifyResult }> {
  const now = opts.now ?? new Date();
  // In memory, never as a plaintext file on the backup disk (a crash mid-backup would leave one behind): serialize()
  // reads a consistent image through SQLite's pager, WAL frames included (independent review 2026-11-10).
  const dbBytes = asRollbackJournal(new Uint8Array(db.$client.serialize()));
  const vaultBytes = existsSync(opts.vaultFile) ? new Uint8Array(readFileSync(opts.vaultFile)) : new Uint8Array(0);
  const plain = new Uint8Array(dbBytes.length + vaultBytes.length);
  try {
    const { counts, migrations } = withTempDb(dbBytes, (sqlite) => ({ counts: countRows(sqlite), migrations: migrationCount(sqlite) }));
    const meta: BackupMeta = { createdAt: now.toISOString(), migrations, dbBytes: dbBytes.length, vaultBytes: vaultBytes.length, counts };
    plain.set(dbBytes, 0);
    plain.set(vaultBytes, dbBytes.length);
    const sealed = vault.sealBackup(plain, meta as unknown as Record<string, unknown>);
    const file = path.join(opts.dir, `finc-${stamp(now)}${BACKUP_EXT}`);
    try {
      writeFileSync(`${file}.tmp`, JSON.stringify(sealed), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    } finally {
      rmSync(`${file}.tmp`, { force: true });
    }
    // verify what is on disk, not what is in memory
    const again = readSealed(file);
    const opened = vault.openBackup(again);
    let result: VerifyResult;
    try {
      result = verifyPayload(opened, again.meta as unknown as BackupMeta);
    } finally {
      opened.fill(0);
    }
    if (!result.ok) {
      rmSync(file, { force: true });
      throw new Error(`backup did not verify (integrity: ${result.integrity}; count mismatches: ${result.mismatches.join(', ') || 'none'})`);
    }
    return { file, result };
  } finally {
    plain.fill(0);
    dbBytes.fill(0);
    vaultBytes.fill(0);
  }
}

/** Remove what an interrupted backup or restore can leave in the backup folder (never a finished backup). */
export function sweepLeftovers(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const gone: string[] = [];
  for (const n of readdirSync(dir)) {
    if (n.startsWith('.snapshot-') || (n.startsWith('finc-') && n.endsWith(`${BACKUP_EXT}.tmp`))) {
      rmSync(path.join(dir, n), { force: true });
      gone.push(n);
    }
  }
  return gone;
}

/** Verify a backup file with the master password of the day it was made (no vault or worker needed). */
export async function verifyBackupWithPassword(file: string, password: string): Promise<VerifyResult> {
  const sealed = readSealed(file);
  const plain = await Vault.openBackupWithPassword(sealed, password);
  try {
    return verifyPayload(plain, sealed.meta as unknown as BackupMeta);
  } finally {
    plain.fill(0);
  }
}

/** Every backup in `dir`, newest first, with its plaintext meta (unreadable files listed with meta null). */
export function listBackups(dir: string): BackupInfo[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.startsWith('finc-') && n.endsWith(BACKUP_EXT))
    .map((name) => {
      const file = path.join(dir, name);
      let meta: BackupMeta | null = null;
      try {
        meta = readSealed(file).meta as unknown as BackupMeta;
      } catch {
        /* listed as unreadable */
      }
      return { file, name, createdAt: meta?.createdAt ?? '', sizeBytes: statSync(file).size, meta };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

export interface RetentionRule {
  daily: number;
  weekly: number;
  monthly: number;
}
export const DEFAULT_RETENTION: RetentionRule = { daily: 7, weekly: 4, monthly: 6 };

/**
 * Which backups to keep: the newest of each of the last `daily` days, of the last `weekly` ISO weeks and of the last
 * `monthly` months (UTC). Everything else may be deleted. The newest backup is always kept. Pure; `names` are file names.
 */
export function retentionPlan(names: string[], rule: RetentionRule = DEFAULT_RETENTION): { keep: string[]; remove: string[] } {
  const dated = names
    .map((n) => ({ n, m: /^finc-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(n) }))
    .filter((x): x is { n: string; m: RegExpExecArray } => x.m !== null)
    .map(({ n, m }) => ({ n, d: new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!)) }))
    .sort((a, b) => b.d.getTime() - a.d.getTime());
  const keep = new Set<string>();
  if (dated[0]) keep.add(dated[0].n);
  const pick = (bucket: (d: Date) => string, count: number) => {
    const seen = new Set<string>();
    for (const x of dated) {
      const b = bucket(x.d);
      if (seen.has(b)) continue;
      if (seen.size >= count) break;
      seen.add(b);
      keep.add(x.n);
    }
  };
  pick((d) => d.toISOString().slice(0, 10), rule.daily);
  pick(isoWeek, rule.weekly);
  pick((d) => d.toISOString().slice(0, 7), rule.monthly);
  return { keep: dated.filter((x) => keep.has(x.n)).map((x) => x.n), remove: dated.filter((x) => !keep.has(x.n)).map((x) => x.n) };
}

function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** Setting a restore leaves for the alert dispatcher: the next engine run after it re-bases the money alerts. */
export const RESTORED_AT_SETTING = 'alerts.restoredAt';

/**
 * Restore a backup over the live database (the worker must be stopped: the one-writer rule). Decrypts with the master
 * password of the day the backup was made and verifies it. The snapshot is written to `<db>.restoring` and prepared
 * there first (money alerts re-based, see RESTORED_AT_SETTING); only then are the live files moved aside (never
 * deleted) and the new file swapped in. `assertSafe` runs right before the swap (the CLI checks the worker container is
 * really stopped); any error after the first rename puts the original files back (independent review 2026-11-10).
 * With `withVault`, vault.json is restored the same way.
 */
export async function restoreBackup(
  file: string,
  password: string,
  opts: { dbFile: string; vaultFile: string; withVault?: boolean; now?: Date; assertSafe?: () => Promise<void> | void },
): Promise<{ result: VerifyResult; movedAside: string[] }> {
  const now = opts.now ?? new Date();
  const sealed = readSealed(file);
  const meta = sealed.meta as unknown as BackupMeta;
  const plain = await Vault.openBackupWithPassword(sealed, password);
  const staged = `${opts.dbFile}.restoring`;
  const stagedVault = `${opts.vaultFile}.restoring`;
  try {
    const result = verifyPayload(plain, meta);
    if (!result.ok) throw new Error(`backup does not verify (integrity: ${result.integrity}); nothing was changed`);
    const { db, vault } = splitPayload(plain, meta);

    // 1. stage: write and prepare the new database next to the live one; nothing live is touched yet
    writeFileSync(staged, db, { mode: 0o600 });
    const restored = new Database(staged);
    try {
      const put = restored.prepare(
        `insert into setting (key, value, updated_at) values (?, ?, ?) on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
      );
      put.run('alerts.moneySince', now.toISOString(), now.toISOString());
      put.run(RESTORED_AT_SETTING, now.toISOString(), now.toISOString());
      // the security log (P1-08) of the restored database says that it was restored; a snapshot from before
      // migration 0013 has no such table yet (the next open creates it), so then there is nothing to write into
      const hasLog = restored.prepare("select 1 from sqlite_master where type = 'table' and name = 'security_event'").get();
      if (hasLog) {
        restored
          .prepare('insert into security_event (at, kind, actor, actor_name, address, detail) values (?, ?, ?, null, null, ?)')
          .run(now.toISOString(), 'backup.restored', 'cli', JSON.stringify({ file: path.basename(file), backupCreatedAt: meta.createdAt ?? null, withVault: !!opts.withVault }));
      }
    } finally {
      restored.close();
    }
    for (const f of [`${staged}-wal`, `${staged}-shm`, `${staged}-journal`]) rmSync(f, { force: true });
    const withVault = !!opts.withVault && vault.length > 0;
    if (withVault) writeFileSync(stagedVault, vault, { mode: 0o600 });

    // 2. last check, right before anything live changes
    await opts.assertSafe?.();

    // 3. swap, with a way back
    const suffix = `.before-restore-${stamp(now)}`;
    const moves: Array<[string, string]> = [];
    const live = [opts.dbFile, `${opts.dbFile}-wal`, `${opts.dbFile}-shm`, ...(withVault ? [opts.vaultFile] : [])];
    try {
      for (const f of live) {
        if (existsSync(f)) {
          renameSync(f, f + suffix);
          moves.push([f, f + suffix]);
        }
      }
      renameSync(staged, opts.dbFile);
      if (withVault) renameSync(stagedVault, opts.vaultFile);
    } catch (e) {
      // put everything back as it was
      if (existsSync(opts.dbFile) && moves.some(([orig]) => orig === opts.dbFile)) rmSync(opts.dbFile, { force: true });
      for (const [orig, aside] of moves.reverse()) if (existsSync(aside) && !existsSync(orig)) renameSync(aside, orig);
      throw new Error(`restore failed and was rolled back: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { result, movedAside: moves.map(([, aside]) => aside) };
  } finally {
    plain.fill(0);
    rmSync(staged, { force: true });
    rmSync(stagedVault, { force: true });
  }
}

/** Delete the backups the retention rule does not keep. Returns the deleted names. */
export function applyRetention(dir: string, rule: RetentionRule = DEFAULT_RETENTION): string[] {
  const { remove } = retentionPlan(
    listBackups(dir).map((b) => b.name),
    rule,
  );
  for (const n of remove) rmSync(path.join(dir, n), { force: true });
  sweepLeftovers(dir);
  return remove;
}
