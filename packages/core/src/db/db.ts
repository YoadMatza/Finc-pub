import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { dbPath } from '../config/paths.js';
import { type DbClaim, assertDbAvailable, claimForOpen } from './owner.js';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));

/**
 * Open (creating if needed) and migrate. Pass ':memory:' for tests.
 * A file DB is refused while another host's worker owns it (P1-13); when nobody fresh owns it, this process claims
 * it as 'cli' until db.$client.close() or process exit. A fresh same-host owner (the worker in this container) is
 * left alone.
 */
export function openDb(file: string = dbPath()): Db {
  let claim: DbClaim | null = null;
  if (file !== ':memory:') {
    assertDbAvailable(file);
    claim = claimForOpen(file); // a claim, or a watcher behind a fresh same-host owner
  }
  try {
    const sqlite = new Database(file);
    if (claim) {
      const held = claim;
      const close = sqlite.close.bind(sqlite);
      sqlite.close = () => {
        const r = close();
        held.release();
        return r;
      };
    }
    if (file !== ':memory:') sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
    sqlite.pragma('busy_timeout = 5000');
    const db = drizzle(sqlite, { schema }) as Db;
    migrate(db, { migrationsFolder: MIGRATIONS });
    return db;
  } catch (e) {
    claim?.release();
    throw e;
  }
}

export const nowIso = (): string => new Date().toISOString();
export { schema };
