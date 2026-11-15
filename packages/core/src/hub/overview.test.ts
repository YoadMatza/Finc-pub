import { beforeEach, describe, expect, it } from 'vitest';
import { ensureAccount } from '../db/accounts.js';
import { type Db, openDb } from '../db/db.js';
import { runEngine } from '../engine/run.js';
import { ingestBatch } from '../ingest/ingest.js';
import type { NormalizedRow } from '../ingest/types.js';
import { STALE_SYNC_HOURS, hubOverview } from './overview.js';
import { setGroupTarget } from './targets.js';

const row = (date: string, amount: number, description: string): NormalizedRow => ({ externalAccountId: 'x', date, amount, description, status: 'completed', type: 'normal', identifier: `${description}${date}${amount}`, payload: {} });
const NOW = new Date('2026-11-10T10:00:00Z');

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
  ensureAccount(db, { institutionId: 'beinleumi', institutionKind: 'bank', institutionDisplayName: 'FIBI', source: 'scraper:beinleumi', externalId: 'b', type: 'checking' });
  ensureAccount(db, { institutionId: 'isracard', institutionKind: 'card', institutionDisplayName: 'Isracard', source: 'scraper:isracard', externalId: 'i', type: 'credit_card' });
  const max = ensureAccount(db, { institutionId: 'max', institutionKind: 'card', institutionDisplayName: 'Max', source: 'scraper:max', externalId: 'm', type: 'credit_card' }).accountId;
  ingestBatch(db, { source: 'scraper:max', runId: null, accountId: max, rows: [row('2026-11-03', -40000, 'SUPERMARKET'), row('2026-11-05', -12000, 'SUPERMARKET')] });
  runEngine(db);
  // pin both rows to one variable category so the test does not depend on the categorizer
  const cat = db.$client.prepare(`select id from category where section = 'variable' and group_key is not null order by id limit 1`).get() as { id: number };
  db.$client.prepare(`update "transaction" set category_id = ? where description_raw = 'SUPERMARKET'`).run(cat.id);
});

const groupOfSupermarket = () => (db.$client.prepare(`select c.group_key g from "transaction" t join category c on c.id = t.category_id where t.description_raw = 'SUPERMARKET' limit 1`).get() as { g: string } | undefined)?.g;
const connection = (inst: string, cols: { last_ok_at?: string | null; last_error?: string | null; last_error_at?: string | null; consecutive_failures?: number; enabled?: number }) =>
  db.$client
    .prepare(`insert or replace into connection (institution_id, enabled, last_ok_at, last_error, last_error_at, consecutive_failures) values (?, ?, ?, ?, ?, ?)`)
    .run(inst, cols.enabled ?? 1, cols.last_ok_at ?? null, cols.last_error ?? null, cols.last_error_at ?? null, cols.consecutive_failures ?? 0);
const insights = (now = NOW) => hubOverview(db, '2026-11', 'purchase', { now }).attention;

describe('over_target insight', () => {
  it('fires when a targeted variable group spent past its target', () => {
    const g = groupOfSupermarket();
    expect(g).toBeTruthy();
    setGroupTarget(db, g!, 30000); // ₪300 target, ₪520 spent
    const h = hubOverview(db, '2026-11', 'purchase', { now: NOW });
    const line = h.breakdown.find((b) => b.group === g)!;
    expect(line).toMatchObject({ basis: 'targets', spent: -52000, expected: -30000 });
    expect(h.attention.find((i) => i.kind === 'over_target')).toMatchObject({ key: `over:${g}:2026-11`, amount: -52000, reference: -30000, name: g });
  });

  it('does not fire under the target', () => {
    const g = groupOfSupermarket()!;
    setGroupTarget(db, g, 100000);
    const h = hubOverview(db, '2026-11', 'purchase', { now: NOW });
    expect(h.breakdown.find((b) => b.group === g)).toMatchObject({ basis: 'targets', spent: -52000, expected: -100000 });
    expect(h.attention.some((i) => i.kind === 'over_target')).toBe(false);
  });
});

describe('sync_error insight', () => {
  it('keeps one key for the whole outage and a new one after a recovery', () => {
    connection('max', { last_ok_at: '2026-11-09T20:00:00.000Z', last_error: 'login failed', last_error_at: '2026-11-10T08:00:00.000Z', consecutive_failures: 1 });
    const k1 = insights().find((i) => i.kind === 'sync_error')?.key;
    expect(k1).toBe('sync:max:2026-11-09T20:00:00.000Z');
    connection('max', { last_ok_at: '2026-11-09T20:00:00.000Z', last_error: 'login failed', last_error_at: '2026-11-10T09:00:00.000Z', consecutive_failures: 2 });
    expect(insights().find((i) => i.kind === 'sync_error')?.key).toBe(k1);
    // recovered, then failed again: a new outage
    connection('max', { last_ok_at: '2026-11-10T09:30:00.000Z', last_error: 'timeout', last_error_at: '2026-11-10T09:50:00.000Z', consecutive_failures: 1 });
    expect(insights().find((i) => i.kind === 'sync_error')?.key).toBe('sync:max:2026-11-10T09:30:00.000Z');
  });

  it('uses never when the connection never succeeded', () => {
    connection('isracard', { last_error: 'bad password', last_error_at: '2026-11-10T08:00:00.000Z', consecutive_failures: 3 });
    expect(insights().find((i) => i.kind === 'sync_error')?.key).toBe('sync:isracard:never');
  });
});

describe('stale_sync insight', () => {
  it('flags an enabled scraped institution with no success for more than 36h', () => {
    expect(STALE_SYNC_HOURS).toBe(36);
    connection('beinleumi', { last_ok_at: '2026-11-08T20:00:00.000Z' }); // 38h before NOW
    connection('max', { last_ok_at: '2026-11-09T12:00:00.000Z' }); // 22h: fresh
    connection('isracard', { last_ok_at: '2026-11-01T12:00:00.000Z', enabled: 0 }); // disabled
    const stale = insights().filter((i) => i.kind === 'stale_sync');
    expect(stale).toEqual([{ key: 'stale:beinleumi:2026-11-08T20:00:00.000Z', kind: 'stale_sync', severity: 'warn', institutionId: 'beinleumi', date: '2026-11-08', count: 38 }]);
  });

  it('keeps the same key as time passes and clears after a fresh success', () => {
    connection('max', { last_ok_at: '2026-11-08T20:00:00.000Z' });
    const later = new Date('2026-11-11T10:00:00Z');
    expect(insights(later).find((i) => i.kind === 'stale_sync')?.key).toBe('stale:max:2026-11-08T20:00:00.000Z');
    connection('max', { last_ok_at: '2026-11-11T09:00:00.000Z' });
    expect(insights(later).some((i) => i.kind === 'stale_sync')).toBe(false);
  });

  it('a connection that never succeeded is stale once its first attempt is older than 36h; never attempted is not', () => {
    connection('isracard', {});
    expect(insights().some((i) => i.kind === 'stale_sync')).toBe(false);
    db.$client.prepare(`insert into sync_run (institution_id, source, trigger, started_at, status) values ('isracard', 'scraper:isracard', 'scheduled', '2026-11-07T10:00:00.000Z', 'error')`).run();
    expect(insights().find((i) => i.kind === 'stale_sync')).toMatchObject({ key: 'stale:isracard:never', institutionId: 'isracard', count: 72 });
  });
});
