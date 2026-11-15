import { describe, expect, it } from 'vitest';
import { openDb } from '../db/db.js';
import { device } from '../db/schema.js';
import { getSetting } from '../ai/settings.js';
import { DEVICE_IDLE_DEFAULT, DEVICE_WARNED_SETTING, takeExpiryWarnings, authenticateDevice, deviceIdleDays, deviceTokenStatus, expireIdleDevices, isDeviceToken, isTrustedAddress, listDevices, registerDevice, revokeAllDevices, revokeDevice, setDeviceIdleDays } from './devices.js';

const DAY = 86_400_000;
/** a device last seen at `seen` */
function pairedAt(db: ReturnType<typeof openDb>, name: string, seen: Date) {
  const d = registerDevice(db, { name, address: '10.0.0.2' });
  db.$client.prepare('update device set last_seen_at = ?, created_at = ? where id = ?').run(seen.toISOString(), seen.toISOString(), d.id);
  return d;
}

describe('devices', () => {
  it('registers, authenticates, revokes', () => {
    const db = openDb(':memory:');
    const { id, token } = registerDevice(db, { name: 'Galaxy', userAgent: 'ua', address: '1.2.3.4' });
    expect(isDeviceToken(token)).toBe(true);
    expect(token.startsWith('finc_dev_')).toBe(true);
    expect(authenticateDevice(db, token, '5.6.7.8')?.id).toBe(id);
    expect(listDevices(db)[0]).toMatchObject({ id, name: 'Galaxy', lastAddress: '5.6.7.8' });
    expect(authenticateDevice(db, `${token.slice(0, -1)}x`, null)).toBeNull();
    expect(authenticateDevice(db, 'finc_dev_short', null)).toBeNull();
    expect(revokeDevice(db, id)).toBe(true);
    expect(revokeDevice(db, id)).toBe(false);
    expect(authenticateDevice(db, token, null)).toBeNull();
    expect(listDevices(db)).toHaveLength(0);
    expect(listDevices(db, true)).toHaveLength(1);
  });

  it('knows the trusted networks', () => {
    for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '192.168.1.50', '10.0.0.5', '172.16.0.1', '172.31.255.255', '100.101.102.103', 'fd7a:115c:a1e0::1234:5678', '[::1]']) expect(isTrustedAddress(a), a).toBe(true);
    for (const a of ['8.8.8.8', '203.0.113.7', '172.32.0.1', '100.128.0.1', '2001:db8:8d7::1', '', undefined, null]) expect(isTrustedAddress(a), String(a)).toBe(false);
  });

  it('migrates a fresh database with the revoked_reason column (migration 0012)', () => {
    const db = openDb(':memory:');
    const cols = (db.$client.prepare('pragma table_info(device)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('revoked_reason');
  });

  it('records why a device was revoked', () => {
    const db = openDb(':memory:');
    const a = registerDevice(db, { name: 'Phone A' });
    const b = registerDevice(db, { name: 'Phone B' });
    expect(listDevices(db)[0]!.revokedReason).toBeNull();
    revokeDevice(db, a.id);
    revokeDevice(db, b.id, 'panic');
    const all = listDevices(db, true);
    expect(all.find((d) => d.id === a.id)!.revokedReason).toBe('removed');
    expect(all.find((d) => d.id === b.id)!.revokedReason).toBe('panic');
    // an old row revoked before the column existed has no reason
    db.$client.prepare("update device set revoked_reason = null where id = ?").run(a.id);
    expect(listDevices(db, true).find((d) => d.id === a.id)!.revokedReason).toBeNull();
  });

  it('expires an idle device on its next request, at exactly N days', () => {
    const db = openDb(':memory:');
    expect(deviceIdleDays(db)).toBe(DEVICE_IDLE_DEFAULT);
    const now = new Date('2026-06-30T12:00:00Z');
    const fresh = pairedAt(db, 'Fresh', new Date(now.getTime() - 30 * DAY + 1));
    const stale = pairedAt(db, 'Stale', new Date(now.getTime() - 30 * DAY));
    const expired: { name: string; days: number }[] = [];
    const onExpired = (d: { name: string }, days: number) => expired.push({ name: d.name, days });
    expect(authenticateDevice(db, fresh.token, null, { now, onExpired })?.name).toBe('Fresh');
    expect(authenticateDevice(db, stale.token, null, { now, onExpired })).toBeNull();
    expect(expired).toEqual([{ name: 'Stale', days: 30 }]);
    // the app sees 'revoked' and unpairs; the row says why
    expect(deviceTokenStatus(db, stale.token)).toBe('revoked');
    expect(listDevices(db, true).find((d) => d.id === stale.id)!.revokedReason).toBe('expired');
    // a second request does not report it again
    expect(authenticateDevice(db, stale.token, null, { now, onExpired })).toBeNull();
    expect(expired).toHaveLength(1);
    // use refreshes last seen: 29 days later it is still fine
    expect(authenticateDevice(db, fresh.token, null, { now: new Date(now.getTime() + 29 * DAY), onExpired })?.name).toBe('Fresh');
  });

  it('never expires with idleDays 0, and honours a changed setting', () => {
    const db = openDb(':memory:');
    const now = new Date('2026-06-30T12:00:00Z');
    const old = pairedAt(db, 'Old', new Date(now.getTime() - 400 * DAY));
    setDeviceIdleDays(db, 0);
    expect(authenticateDevice(db, old.token, null, { now })?.name).toBe('Old');
    db.$client.prepare('update device set last_seen_at = ? where id = ?').run(new Date(now.getTime() - 8 * DAY).toISOString(), old.id);
    setDeviceIdleDays(db, 7);
    expect(authenticateDevice(db, old.token, null, { now })).toBeNull();
    expect(() => setDeviceIdleDays(db, 366)).toThrow();
    expect(() => setDeviceIdleDays(db, -1)).toThrow();
    expect(() => setDeviceIdleDays(db, 1.5)).toThrow();
    db.$client.prepare("update setting set value = 'junk' where key = 'devices.idleDays'").run();
    expect(deviceIdleDays(db)).toBe(DEVICE_IDLE_DEFAULT);
  });

  it('sweeps idle devices daily', () => {
    const db = openDb(':memory:');
    const now = new Date('2026-06-30T12:00:00Z');
    pairedAt(db, 'Active', new Date(now.getTime() - 2 * DAY));
    pairedAt(db, 'Idle A', new Date(now.getTime() - 31 * DAY));
    pairedAt(db, 'Idle B', new Date(now.getTime() - 90 * DAY));
    const gone = pairedAt(db, 'Gone', new Date(now.getTime() - 90 * DAY));
    revokeDevice(db, gone.id);
    const r = expireIdleDevices(db, now);
    expect(r.map((x) => [x.device.name, x.idleDays]).sort()).toEqual([['Idle A', 31], ['Idle B', 90]]);
    expect(listDevices(db).map((d) => d.name)).toEqual(['Active']);
    expect(listDevices(db, true).find((d) => d.id === gone.id)!.revokedReason).toBe('removed');
    expect(expireIdleDevices(db, now)).toEqual([]);
    setDeviceIdleDays(db, 0);
    pairedAt(db, 'Ancient', new Date(now.getTime() - 300 * DAY));
    expect(expireIdleDevices(db, now)).toEqual([]);
  });

  it('hands out each expiry warning once per window and keeps the marker small', () => {
    const db = openDb(':memory:');
    const now = new Date('2026-06-30T12:00:00Z');
    const a = pairedAt(db, 'Phone A', new Date(now.getTime() - 27 * DAY - 1)); // just under 3 days left
    pairedAt(db, 'Fresh', new Date(now.getTime() - 2 * DAY));
    expect(takeExpiryWarnings(db, now).map((w) => [w.device.name, w.daysLeft])).toEqual([['Phone A', 3]]);
    expect(takeExpiryWarnings(db, now)).toEqual([]);
    expect(Object.keys(JSON.parse(getSetting(db, DEVICE_WARNED_SETTING)!))).toEqual([String(a.id)]);
    // a revoked device leaves the marker
    revokeDevice(db, a.id);
    expect(takeExpiryWarnings(db, now)).toEqual([]);
    expect(getSetting(db, DEVICE_WARNED_SETTING)).toBeNull();
    // with a short expiry, a device idle under a day is never warned
    setDeviceIdleDays(db, 2);
    pairedAt(db, 'New', new Date(now.getTime() - 3600_000));
    expect(takeExpiryWarnings(db, now)).toEqual([]);
  });

  it('revokes every active device for the panic switch', () => {
    const db = openDb(':memory:');
    const a = registerDevice(db, { name: 'Phone A' });
    registerDevice(db, { name: 'Tablet B' });
    revokeDevice(db, a.id);
    expect(revokeAllDevices(db)).toBe(1);
    expect(revokeAllDevices(db)).toBe(0);
    const rows = db.select().from(device).all();
    expect(rows.map((r) => r.revokedReason).sort()).toEqual(['panic', 'removed']);
  });
});
