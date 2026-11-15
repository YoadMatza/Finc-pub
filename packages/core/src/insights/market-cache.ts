/**
 * The persistent side of third-party market-data caches (`market_data_cache`): one validated answer per source and
 * key, with the time it was fetched. Public data about tickers only. Callers keep a memory cache in front; this table
 * makes the last known answer survive a restart (and the vault being locked).
 */
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/db.js';
import { marketDataCache } from '../db/schema.js';

/** the stored JSON at most (a recommendation list is ~10 KB) */
export const MARKET_CACHE_MAX_JSON = 256 * 1024;

export interface MarketCacheEntry {
  /** ms */
  fetchedAt: number;
  value: unknown;
}

/** The stored entry, or null when there is none or it cannot be read (bad JSON or time). */
export function readMarketCache(db: Db, source: string, key: string): MarketCacheEntry | null {
  const row = db.select().from(marketDataCache).where(and(eq(marketDataCache.source, source), eq(marketDataCache.key, key))).get();
  if (!row) return null;
  const at = Date.parse(row.fetchedAt);
  if (!Number.isFinite(at)) return null;
  try {
    return { fetchedAt: at, value: JSON.parse(row.json) as unknown };
  } catch {
    return null;
  }
}

/** Stores (or replaces) one entry; refuses (false) a value whose JSON is larger than MARKET_CACHE_MAX_JSON. */
export function writeMarketCache(db: Db, source: string, key: string, fetchedAt: number, value: unknown): boolean {
  const json = JSON.stringify(value);
  if (json === undefined || json.length > MARKET_CACHE_MAX_JSON) return false;
  const row = { fetchedAt: new Date(fetchedAt).toISOString(), json };
  db.insert(marketDataCache)
    .values({ source, key, ...row })
    .onConflictDoUpdate({ target: [marketDataCache.source, marketDataCache.key], set: row })
    .run();
  return true;
}
