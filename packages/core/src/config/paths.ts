import { mkdirSync } from 'node:fs';
import path from 'node:path';

/** Root for everything finc writes: DB, vault, browser profiles, imports. Gitignored. */
export function dataDir(): string {
  const dir = process.env.FINC_DATA_DIR?.trim() || path.resolve(process.cwd(), 'data');
  mkdirSync(dir, { recursive: true, mode: 0o700 }); // owner only on Linux and the Pi (security research P2-10)
  return path.resolve(dir);
}

function sub(name: string): string {
  const p = path.join(dataDir(), name);
  mkdirSync(p, { recursive: true, mode: 0o700 });
  return p;
}

export const vaultPath = (): string => path.join(dataDir(), 'vault.json');
export const dbPath = (): string => path.join(dataDir(), 'finc.db');
/** Random token the worker writes at start; the CLI presents it on the control endpoints. */
export const controlTokenPath = (): string => path.join(dataDir(), 'control.token');
export const profilesDir = (): string => sub('browser-profiles');
export const importsDir = (): string => sub('imports');
export const screenshotsDir = (): string => sub('screenshots');
export const dumpsDir = (): string => sub('dumps');
/**
 * Where encrypted backups go: FINC_BACKUP_DIR (in Docker a mount on another physical disk, e.g. E:\finc-backup → /backup),
 * else data/backups. Not a secret, so an environment variable is fine here.
 */
export function backupDir(): string {
  const dir = process.env.FINC_BACKUP_DIR?.trim() || path.join(dataDir(), 'backups');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.resolve(dir);
}
