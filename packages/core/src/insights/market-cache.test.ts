import { describe, expect, it } from 'vitest';
import { openDb } from '../db/index.js';
import { MARKET_CACHE_MAX_JSON, readMarketCache, writeMarketCache } from './market-cache.js';

// Fictional tickers and rows.
const T = Date.parse('2026-11-11T08:00:00Z');

describe('market_data_cache migration', () => {
  it('creates the table with the (source, key) primary key', () => {
    const db = openDb(':memory:');
    const cols = db.$client.prepare('pragma table_info(market_data_cache)').all() as Array<{ name: string; pk: number; notnull: number; type: string }>;
    expect(cols.map((c) => [c.name, c.type, c.pk, c.notnull])).toEqual([
      ['source', 'TEXT', 1, 1],
      ['key', 'TEXT', 2, 1],
      ['fetched_at', 'TEXT', 0, 1],
      ['json', 'TEXT', 0, 1],
    ]);
  });
});

describe('readMarketCache / writeMarketCache', () => {
  it('stores, replaces and reads back an entry with its time; per source and key', () => {
    const db = openDb(':memory:');
    expect(readMarketCache(db, 'finnhub', 'recommendation:TSTA')).toBeNull();
    expect(writeMarketCache(db, 'finnhub', 'recommendation:TSTA', T, [{ period: '2026-11-01', buy: 3 }])).toBe(true);
    expect(writeMarketCache(db, 'finnhub', 'earnings:TSTA', T, [])).toBe(true);
    expect(readMarketCache(db, 'finnhub', 'recommendation:TSTA')).toEqual({ fetchedAt: T, value: [{ period: '2026-11-01', buy: 3 }] });
    expect(writeMarketCache(db, 'finnhub', 'recommendation:TSTA', T + 1000, [])).toBe(true);
    expect(readMarketCache(db, 'finnhub', 'recommendation:TSTA')).toEqual({ fetchedAt: T + 1000, value: [] });
    expect(readMarketCache(db, 'other', 'recommendation:TSTA')).toBeNull();
    expect(db.$client.prepare('select count(*) n from market_data_cache').get()).toEqual({ n: 2 });
    expect(db.$client.prepare(`select fetched_at f from market_data_cache where key = 'earnings:TSTA'`).get()).toEqual({ f: '2026-11-11T08:00:00.000Z' });
  });

  it('refuses an oversized value; a broken row reads as nothing', () => {
    const db = openDb(':memory:');
    expect(writeMarketCache(db, 'finnhub', 'big', T, 'x'.repeat(MARKET_CACHE_MAX_JSON))).toBe(false);
    expect(readMarketCache(db, 'finnhub', 'big')).toBeNull();
    db.$client.prepare(`insert into market_data_cache values ('finnhub', 'bad', '2026-11-11T08:00:00.000Z', '{not json')`).run();
    db.$client.prepare(`insert into market_data_cache values ('finnhub', 'badtime', 'yesterday', '[]')`).run();
    expect(readMarketCache(db, 'finnhub', 'bad')).toBeNull();
    expect(readMarketCache(db, 'finnhub', 'badtime')).toBeNull();
  });
});
