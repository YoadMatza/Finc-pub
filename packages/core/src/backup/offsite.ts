/**
 * The off-PC copy of the encrypted backups (the NAS). A local backup on E: survives a dead D: disk but not the loss of
 * the PC itself (theft, fire, ransomware); a copy on another machine does. The files are already encrypted
 * (backup.ts), so the other machine only ever holds ciphertext.
 *
 * The transport is a small interface (the worker implements it with SFTP over SSH); this module only decides what to
 * copy and proves it arrived: after the upload the file is read back and its SHA-256 compared. It never deletes
 * anything remotely: a compromised worker must not be able to wipe the offsite history.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BACKUP_EXT } from './backup.js';

export interface OffsiteTarget {
  /** e.g. "finc-backup@192.168.1.50:/finc-backups" (no secrets) */
  describe(): string;
  /** Write `name` atomically (a temporary name, then a rename); never overwrites an existing file. */
  put(name: string, bytes: Buffer): Promise<void>;
  get(name: string): Promise<Buffer>;
  /** File names in the remote folder. */
  list(): Promise<string[]>;
  close(): Promise<void>;
}

export const OFFSITE_SETTINGS = {
  lastOkAt: 'offsite.lastOkAt',
  lastFile: 'offsite.lastFile',
  lastError: 'offsite.lastError',
  lastErrorAt: 'offsite.lastErrorAt',
  /** local day of the last "offsite copy failed / stale" alert */
  alertDay: 'offsite.alertDay',
} as const;

/** An offsite copy older than this (or none, once offsite is configured) is worth one alert a day. */
export const OFFSITE_STALE_DAYS = 3;

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

export interface OffsiteResult {
  name: string;
  bytes: number;
  sha256: string;
  /** false when the file was already on the target with the same content */
  uploaded: boolean;
}

/**
 * Copy one local backup file to the target and prove it: read it back and compare SHA-256. If the name already exists
 * remotely with the same content it is left alone; with different content the copy fails (never overwritten).
 */
export async function copyOffsite(target: OffsiteTarget, file: string): Promise<OffsiteResult> {
  const name = path.basename(file);
  if (!name.startsWith('finc-') || !name.endsWith(BACKUP_EXT)) throw new Error(`${name} is not a finc backup file`);
  const local = readFileSync(file);
  const want = sha256(local);
  const existing = (await target.list()).includes(name);
  if (existing) {
    const have = sha256(await target.get(name));
    if (have !== want) throw new Error(`${name} already exists on ${target.describe()} with different content; not overwritten`);
    return { name, bytes: local.length, sha256: want, uploaded: false };
  }
  await target.put(name, local);
  const back = await target.get(name);
  const got = sha256(back);
  if (got !== want || back.length !== local.length) throw new Error(`the copy of ${name} on ${target.describe()} does not match (sha256 ${got.slice(0, 12)} vs ${want.slice(0, 12)})`);
  return { name, bytes: local.length, sha256: want, uploaded: true };
}

/** Local backups (newest first) that are not on the target yet, so a missed night is caught up next time. */
export async function missingOffsite(target: OffsiteTarget, localNames: string[]): Promise<string[]> {
  const remote = new Set(await target.list());
  return localNames.filter((n) => n.startsWith('finc-') && n.endsWith(BACKUP_EXT) && !remote.has(n));
}
