import { describe, expect, it } from 'vitest';
import { openDb } from '../db/db.js';
import { SECURITY_AGGREGATE_MS, SECURITY_DETAIL_MAX, flushSecurityEvents, listSecurityEvents, recordSecurityEvent } from './security-log.js';

const T0 = Date.parse('2026-11-11T10:00:00.000Z');

describe('security log (P1-08)', () => {
  it('migration 0013 creates the table, its index and the append-only triggers on a fresh database', () => {
    const db = openDb(':memory:');
    const cols = (db.$client.prepare('pragma table_info(security_event)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(['id', 'at', 'kind', 'actor', 'actor_name', 'address', 'detail']);
    const triggers = (db.$client.prepare("select name from sqlite_master where type = 'trigger' and tbl_name = 'security_event' order by name").all() as { name: string }[]).map((t) => t.name);
    expect(triggers).toEqual(['security_event_no_delete', 'security_event_no_update']);
  });

  it('refuses UPDATE and DELETE (append-only)', () => {
    const db = openDb(':memory:');
    recordSecurityEvent(db, { kind: 'auth.pin_ok', actor: 'pc', address: '127.0.0.1' });
    expect(() => db.$client.prepare("update security_event set kind = 'x'").run()).toThrow(/append-only/);
    expect(() => db.$client.prepare('delete from security_event').run()).toThrow(/append-only/);
    expect(listSecurityEvents(db).events).toHaveLength(1);
    expect(listSecurityEvents(db).events[0]!.kind).toBe('auth.pin_ok');
  });

  it('records, trims and masks; never throws', () => {
    const db = openDb(':memory:');
    recordSecurityEvent(db, { kind: 'device.paired', actor: 'public', actorName: 'Phone A', address: '203.0.113.7', detail: { device: 3 }, at: T0 });
    recordSecurityEvent(db, { kind: 'x', actor: 'system', detail: 'y'.repeat(2000) });
    recordSecurityEvent(db, { kind: 'x', actor: 'system', detail: `leaked finc_dev_${'a'.repeat(43)} and 123456789:${'B'.repeat(35)} Bearer abc.def` });
    const [masked, long, first] = listSecurityEvents(db).events;
    expect(first).toEqual({ id: 1, at: '2026-11-11T10:00:00.000Z', kind: 'device.paired', actor: 'public', actorName: 'Phone A', address: '203.0.113.7', detail: '{"device":3}' });
    expect(long!.detail!.length).toBe(SECURITY_DETAIL_MAX);
    expect(masked!.detail).not.toMatch(/aaaa|BBBB|abc\.def/);
    // a closed database: logged, not thrown
    db.$client.close();
    expect(() => recordSecurityEvent(db, { kind: 'x', actor: 'system' })).not.toThrow();
  });

  it('lists newest first, pages with beforeId, filters by kind, caps the limit at 200', () => {
    const db = openDb(':memory:');
    for (let i = 0; i < 7; i++) recordSecurityEvent(db, { kind: i % 2 ? 'vault.lock' : 'auth.pin_ok', actor: 'pc' });
    const p1 = listSecurityEvents(db, { limit: 3 });
    expect(p1.events.map((e) => e.id)).toEqual([7, 6, 5]);
    expect(p1.nextBefore).toBe(5);
    const p2 = listSecurityEvents(db, { limit: 3, beforeId: p1.nextBefore! });
    expect(p2.events.map((e) => e.id)).toEqual([4, 3, 2]);
    const p3 = listSecurityEvents(db, { limit: 3, beforeId: p2.nextBefore! });
    expect(p3.events.map((e) => e.id)).toEqual([1]);
    expect(p3.nextBefore).toBeNull();
    expect(listSecurityEvents(db, { kind: 'vault.lock' }).events.map((e) => e.id)).toEqual([6, 4, 2]);
    expect(listSecurityEvents(db, { limit: 3 }).nextBefore).not.toBeNull();
    expect(listSecurityEvents(db, { limit: 7 }).nextBefore).toBeNull();
    for (let i = 0; i < 250; i++) recordSecurityEvent(db, { kind: 'k', actor: 'system' });
    expect(listSecurityEvents(db, { limit: 999 }).events).toHaveLength(200);
  });

  it('aggregates a flood: at most one row per kind+address per minute, with the count', () => {
    const db = openDb(':memory:');
    const fail = (addr: string, at: number) => recordSecurityEvent(db, { kind: 'auth.pin_failed', actor: 'pc', address: addr, aggregate: true, at });
    // 100 wrong PINs in the first minute from one address: one row
    for (let i = 0; i < 100; i++) fail('10.0.0.9', T0 + i * 500);
    // another address is its own key
    fail('10.0.0.8', T0 + 1000);
    expect(listSecurityEvents(db, { kind: 'auth.pin_failed' }).events).toHaveLength(2);
    // the flood goes on: the next occurrence after the window carries the 99 repeats
    fail('10.0.0.9', T0 + SECURITY_AGGREGATE_MS + 10);
    let rows = listSecurityEvents(db, { kind: 'auth.pin_failed' }).events;
    expect(rows).toHaveLength(3);
    expect(JSON.parse(rows[0]!.detail!)).toMatchObject({ repeats: 99 });
    // two more in that window, then silence: the flush writes the summary once the window is two minutes old
    fail('10.0.0.9', T0 + SECURITY_AGGREGATE_MS + 20);
    fail('10.0.0.9', T0 + SECURITY_AGGREGATE_MS + 30);
    flushSecurityEvents(db, T0 + SECURITY_AGGREGATE_MS + 90_000);
    expect(listSecurityEvents(db, { kind: 'auth.pin_failed' }).events).toHaveLength(3);
    flushSecurityEvents(db, T0 + 4 * SECURITY_AGGREGATE_MS);
    rows = listSecurityEvents(db, { kind: 'auth.pin_failed' }).events;
    expect(rows).toHaveLength(4);
    expect(JSON.parse(rows[0]!.detail!)).toMatchObject({ repeats: 2, summary: true });
    // a window without repeats leaves no summary
    flushSecurityEvents(db, T0 + 10 * SECURITY_AGGREGATE_MS, true);
    expect(listSecurityEvents(db, { kind: 'auth.pin_failed' }).events).toHaveLength(4);
    // not aggregated: every event is a row
    for (let i = 0; i < 5; i++) recordSecurityEvent(db, { kind: 'auth.pin_ok', actor: 'pc', address: '10.0.0.9', at: T0 + i });
    expect(listSecurityEvents(db, { kind: 'auth.pin_ok' }).events).toHaveLength(5);
  });

  it('aggregates every event of a device or passkey actor per kind+address a minute, even without the flag', () => {
    const db = openDb(':memory:');
    for (let i = 0; i < 50; i++) recordSecurityEvent(db, { kind: 'settings.changed', actor: 'device:7', address: '203.0.113.5', detail: { keys: ['language'] }, at: T0 + i });
    for (let i = 0; i < 50; i++) recordSecurityEvent(db, { kind: 'settings.changed', actor: 'passkey:2', address: '203.0.113.5', at: T0 + i });
    // a new address is written at once
    recordSecurityEvent(db, { kind: 'settings.changed', actor: 'device:7', address: '198.51.100.1', at: T0 + 100 });
    // the PC is never aggregated
    for (let i = 0; i < 5; i++) recordSecurityEvent(db, { kind: 'settings.changed', actor: 'pc', address: '127.0.0.1', at: T0 + i });
    const rows = listSecurityEvents(db, { kind: 'settings.changed' }).events;
    expect(rows.filter((r) => r.actor === 'device:7')).toHaveLength(2);
    expect(rows.filter((r) => r.actor === 'passkey:2')).toHaveLength(1);
    expect(rows.filter((r) => r.actor === 'pc')).toHaveLength(5);
    flushSecurityEvents(db, T0 + 10 * SECURITY_AGGREGATE_MS);
    const summary = listSecurityEvents(db, { kind: 'settings.changed' }).events.filter((r) => r.detail?.includes('"summary":true'));
    expect(summary.map((r) => [r.actor, JSON.parse(r.detail!).repeats]).sort()).toEqual([
      ['device:7', 49],
      ['passkey:2', 49],
    ]);
  });

  it('folds an address-hopping flood into one key per kind', () => {
    const db = openDb(':memory:');
    for (let i = 0; i < 2000; i++) recordSecurityEvent(db, { kind: 'device.token_rejected', actor: 'public', address: `198.51.${i >> 8}.${i & 255}`, aggregate: true, at: T0 + i });
    const n = (db.$client.prepare("select count(*) n from security_event where kind = 'device.token_rejected'").get() as { n: number }).n;
    expect(n).toBe(501); // 500 distinct addresses, then one folded row
    expect(listSecurityEvents(db, { kind: 'device.token_rejected', limit: 1 }).events[0]!.address).toBe('*');
  });
});
