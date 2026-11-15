/**
 * Paired devices (the Android app). A device holds a 256-bit token, shown once at pairing time;
 * the DB keeps only its SHA-256 so a copy of the database does not open the hub. Revocation is
 * a timestamp, so the row stays as an audit trail.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { getSetting, setSetting } from '../ai/settings.js';
import type { Db } from '../db/db.js';
import { device } from '../db/schema.js';

export const DEVICE_TOKEN_PREFIX = 'finc_dev_';

/** Why a device was revoked: by hand, idle too long (P1-09), or the panic switch. */
export type DeviceRevokedReason = 'removed' | 'expired' | 'panic';
const REASONS: readonly DeviceRevokedReason[] = ['removed', 'expired', 'panic'];

/**
 * Idle expiry (security research P1-09): a device not seen for this many days is revoked, on its next request and by
 * the worker's daily sweep. 0 turns it off. Changed from the hub at home only.
 */
export const DEVICE_IDLE_SETTING = 'devices.idleDays';
export const DEVICE_IDLE_DEFAULT = 30;
export const DEVICE_IDLE_MAX = 365;
const DAY_MS = 86_400_000;

export function deviceIdleDays(db: Db): number {
  const raw = getSetting(db, DEVICE_IDLE_SETTING);
  if (raw === null) return DEVICE_IDLE_DEFAULT;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= DEVICE_IDLE_MAX ? n : DEVICE_IDLE_DEFAULT;
}

export function setDeviceIdleDays(db: Db, days: number): void {
  if (!Number.isInteger(days) || days < 0 || days > DEVICE_IDLE_MAX) throw new Error(`idle days must be a whole number from 0 to ${DEVICE_IDLE_MAX}`);
  setSetting(db, DEVICE_IDLE_SETTING, String(days));
}

/** Whole days since the device was last seen (or paired, when never seen). */
function idleDaysOf(r: { lastSeenAt: string | null; createdAt: string }, now: number): number {
  const t = Date.parse(r.lastSeenAt ?? r.createdAt);
  return Number.isFinite(t) ? Math.floor((now - t) / DAY_MS) : 0;
}

/** Idle for at least `days` days (exactly N days counts as expired); never with days = 0. */
function isIdle(r: { lastSeenAt: string | null; createdAt: string }, days: number, now: number): boolean {
  if (days <= 0) return false;
  const t = Date.parse(r.lastSeenAt ?? r.createdAt);
  return Number.isFinite(t) && now - t >= days * DAY_MS;
}

export interface DeviceView {
  id: number;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
  lastAddress: string | null;
  revokedAt: string | null;
  revokedReason: DeviceRevokedReason | null;
  userAgent: string | null;
}

export function isDeviceToken(token: string | undefined): token is string {
  return typeof token === 'string' && token.startsWith(DEVICE_TOKEN_PREFIX) && token.length === DEVICE_TOKEN_PREFIX.length + 43;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function registerDevice(db: Db, input: { name: string; userAgent?: string | null; address?: string | null }): { id: number; token: string } {
  const token = DEVICE_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const now = new Date().toISOString();
  const [row] = db
    .insert(device)
    .values({ name: input.name.trim().slice(0, 60) || 'phone', tokenHash: hashToken(token), userAgent: input.userAgent?.slice(0, 160) ?? null, createdAt: now, lastSeenAt: now, lastAddress: input.address ?? null })
    .returning({ id: device.id })
    .all();
  return { id: row!.id, token };
}

/**
 * Why a token that did not authenticate was refused: `revoked` (the row exists and was revoked) or
 * `unknown` (no such device). The app unpairs itself only on these, never on a throttled or failed request.
 */
export function deviceTokenStatus(db: Db, token: string): 'ok' | 'revoked' | 'unknown' {
  if (!isDeviceToken(token)) return 'unknown';
  const row = db.select({ revokedAt: device.revokedAt }).from(device).where(eq(device.tokenHash, hashToken(token))).get();
  if (!row) return 'unknown';
  return row.revokedAt ? 'revoked' : 'ok';
}

export interface AuthenticateOptions {
  /** the clock, for tests */
  now?: Date;
  /** called once when this request found the device idle too long and revoked it ('expired') */
  onExpired?: (d: DeviceView, idleDays: number) => void;
}

/**
 * Returns the device when the token is valid and not revoked; also records last seen. A device idle for
 * `devices.idleDays` or more is revoked here with reason 'expired' (P1-09) and refused, so the app sees 'revoked'.
 */
export function authenticateDevice(db: Db, token: string, address: string | null, opts: AuthenticateOptions = {}): DeviceView | null {
  if (!isDeviceToken(token)) return null;
  const row = db.select().from(device).where(eq(device.tokenHash, hashToken(token))).get();
  if (!row || row.revokedAt) return null;
  const nowDate = opts.now ?? new Date();
  const nowMs = nowDate.getTime();
  if (isIdle(row, deviceIdleDays(db), nowMs)) {
    const at = nowDate.toISOString();
    const r = db.update(device).set({ revokedAt: at, revokedReason: 'expired' }).where(and(eq(device.id, row.id), isNull(device.revokedAt))).run();
    if (r.changes > 0) opts.onExpired?.(view({ ...row, revokedAt: at, revokedReason: 'expired' }), idleDaysOf(row, nowMs));
    return null;
  }
  const now = nowDate.toISOString();
  if (!row.lastSeenAt || now.slice(0, 16) !== row.lastSeenAt.slice(0, 16) || row.lastAddress !== address) {
    db.update(device).set({ lastSeenAt: now, lastAddress: address }).where(eq(device.id, row.id)).run();
  }
  return view({ ...row, lastSeenAt: now, lastAddress: address });
}

/**
 * The daily sweep (P1-09): revokes every active device idle for `devices.idleDays` or more (reason 'expired'), so an
 * idle token does not sit valid until its next use. Returns what it expired, with the days each was unused.
 */
export function expireIdleDevices(db: Db, now: Date = new Date()): { device: DeviceView; idleDays: number }[] {
  const days = deviceIdleDays(db);
  if (days <= 0) return [];
  const nowMs = now.getTime();
  const at = now.toISOString();
  const out: { device: DeviceView; idleDays: number }[] = [];
  for (const row of db.select().from(device).where(isNull(device.revokedAt)).all()) {
    if (!isIdle(row, days, nowMs)) continue;
    const r = db.update(device).set({ revokedAt: at, revokedReason: 'expired' }).where(and(eq(device.id, row.id), isNull(device.revokedAt))).run();
    if (r.changes > 0) out.push({ device: view({ ...row, revokedAt: at, revokedReason: 'expired' }), idleDays: idleDaysOf(row, nowMs) });
  }
  return out;
}

/** Where the expiry warnings already sent are remembered: device id → the last-seen time they were sent for. */
export const DEVICE_WARNED_SETTING = 'devices.expiryWarned';
export const DEVICE_WARN_DAYS = 3;

/**
 * Devices that will expire within DEVICE_WARN_DAYS (P1-09 review), each returned ONCE per expiry window: the marker is
 * the device's last-seen time, so using the device starts a new window (and a new warning when it goes idle again).
 * Nothing is returned for a device idle less than a day, or when expiry is off. Records what it returns.
 */
export function takeExpiryWarnings(db: Db, now: Date = new Date()): { device: DeviceView; daysLeft: number }[] {
  const days = deviceIdleDays(db);
  let warned: Record<string, string> = {};
  try {
    const raw = JSON.parse(getSetting(db, DEVICE_WARNED_SETTING) ?? '{}') as unknown;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) warned = raw as Record<string, string>;
  } catch {
    // a damaged marker only means a warning may repeat
  }
  const nowMs = now.getTime();
  const active = days > 0 ? db.select().from(device).where(isNull(device.revokedAt)).all() : [];
  const next: Record<string, string> = {};
  const out: { device: DeviceView; daysLeft: number }[] = [];
  for (const row of active) {
    const seen = row.lastSeenAt ?? row.createdAt;
    const t = Date.parse(seen);
    if (!Number.isFinite(t)) continue;
    const left = t + days * DAY_MS - nowMs;
    const idle = nowMs - t;
    if (warned[String(row.id)] === seen) next[String(row.id)] = seen; // already warned for this window
    else if (left > 0 && left <= DEVICE_WARN_DAYS * DAY_MS && idle >= DAY_MS) {
      out.push({ device: view(row), daysLeft: Math.ceil(left / DAY_MS) });
      next[String(row.id)] = seen;
    }
  }
  // only active devices are kept, so the marker never grows
  if (JSON.stringify(next) !== JSON.stringify(warned)) setSetting(db, DEVICE_WARNED_SETTING, Object.keys(next).length ? JSON.stringify(next) : null);
  return out;
}

/** The panic switch's first step (P1-09): revokes every active device at once; returns how many. */
export function revokeAllDevices(db: Db, reason: DeviceRevokedReason = 'panic'): number {
  return db.update(device).set({ revokedAt: new Date().toISOString(), revokedReason: reason }).where(isNull(device.revokedAt)).run().changes;
}

export function listDevices(db: Db, includeRevoked = false): DeviceView[] {
  const rows = includeRevoked ? db.select().from(device).orderBy(desc(device.createdAt)).all() : db.select().from(device).where(isNull(device.revokedAt)).orderBy(desc(device.createdAt)).all();
  return rows.map(view);
}

export function revokeDevice(db: Db, id: number, reason: DeviceRevokedReason = 'removed'): boolean {
  const r = db
    .update(device)
    .set({ revokedAt: new Date().toISOString(), revokedReason: reason })
    .where(and(eq(device.id, id), isNull(device.revokedAt)))
    .run();
  return r.changes > 0;
}

export function renameDevice(db: Db, id: number, name: string): void {
  db.update(device).set({ name: name.trim().slice(0, 60) || 'phone' }).where(eq(device.id, id)).run();
}

function view(r: typeof device.$inferSelect): DeviceView {
  return { id: r.id, name: r.name, createdAt: r.createdAt, lastSeenAt: r.lastSeenAt, lastAddress: r.lastAddress, revokedAt: r.revokedAt, revokedReason: REASONS.includes(r.revokedReason as DeviceRevokedReason) ? (r.revokedReason as DeviceRevokedReason) : null, userAgent: r.userAgent };
}

/**
 * Which client addresses may use the PIN: loopback, RFC 1918, link-local, Tailscale's 100.64/10 and
 * IPv6 unique-local (Tailscale's fd7a:115c:a1e0::/48 lives there). Everything else is "the internet".
 */
export function isTrustedAddress(addr: string | null | undefined): boolean {
  if (!addr) return false;
  let a = addr.trim().toLowerCase();
  if (a.startsWith('[')) a = a.slice(1, a.indexOf(']'));
  if (a.startsWith('::ffff:')) a = a.slice(7);
  if (a === '::1' || a === 'localhost') return true;
  const v4 = a.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const o1 = Number(v4[1]);
    const o2 = Number(v4[2]);
    if (o1 === 127 || o1 === 10) return true;
    if (o1 === 192 && o2 === 168) return true;
    if (o1 === 172 && o2 >= 16 && o2 <= 31) return true;
    if (o1 === 169 && o2 === 254) return true;
    if (o1 === 100 && o2 >= 64 && o2 <= 127) return true; // Tailscale / CGNAT range
    return false;
  }
  if (/^f[cd][0-9a-f]{2}:/.test(a)) return true; // fc00::/7 unique local
  if (/^fe[89ab][0-9a-f]:/.test(a)) return true; // link local
  return false;
}
