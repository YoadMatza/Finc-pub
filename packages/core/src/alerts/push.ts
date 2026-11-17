/**
 * Push alerts (research_notes/proposals/push-alerts.md): a queue per phone-app device. The push service only carries
 * an empty wake-up; the app fetches its rows here (over its pinned connection, with its device token) and shows them.
 * Nothing financial leaves through the push service.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/db.js';

export const PUSH_KEEP_DAYS = 7;
const MAX_TEXT = 1000;
const MAX_PENDING = 200;

/** A push token as Firebase issues it (no spaces, bounded). */
export const validPushToken = (t: unknown): t is string => typeof t === 'string' && /^[A-Za-z0-9:_-]{20,4096}$/.test(t);

/** Stores (or clears) a device's push token. Only an active device can have one. */
export function setDevicePushToken(db: Db, deviceId: number, token: string | null): boolean {
  if (token !== null && !validPushToken(token)) return false;
  return db.$client.prepare('update device set push_token = ? where id = ? and revoked_at is null').run(token, deviceId).changes > 0;
}

export const PUSH_SECRET_PREFIX = 'finc_push_';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * A new push secret for a device (the old one stops working): what the app's background receiver uses to fetch this
 * device's queued alerts and to update its push token, nothing else. Only its hash is kept.
 */
export function issuePushSecret(db: Db, deviceId: number): string | null {
  const secret = PUSH_SECRET_PREFIX + randomBytes(32).toString('base64url');
  const ok = db.$client.prepare('update device set push_secret_hash = ? where id = ? and revoked_at is null').run(sha(secret), deviceId).changes > 0;
  return ok ? secret : null;
}

/** The active device a push secret belongs to, or null. */
export function deviceForPushSecret(db: Db, secret: string | undefined): number | null {
  if (typeof secret !== 'string' || !secret.startsWith(PUSH_SECRET_PREFIX) || secret.length !== PUSH_SECRET_PREFIX.length + 43) return null;
  const r = db.$client.prepare('select id from device where push_secret_hash = ? and revoked_at is null').get(sha(secret)) as { id: number } | undefined;
  return r?.id ?? null;
}

/** Active devices that can be woken. A revoked device has none: its token dies with it. */
export function pushTargets(db: Db): Array<{ deviceId: number; token: string }> {
  return (db.$client.prepare('select id, push_token from device where revoked_at is null and push_token is not null').all() as Array<{ id: number; push_token: string }>).map((r) => ({ deviceId: r.id, token: r.push_token }));
}

/** Telegram's HTML marks out; plain text for an Android notification. */
export const plainAlertText = (t: string): string =>
  t
    .replace(/<[^>]{0,100}>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .slice(0, MAX_TEXT);

export interface PushItem {
  type: string;
  key: string;
  text: string;
  urgent?: boolean;
  otpId?: string;
}

/** Queues items for every app device; returns the tokens to wake (none when no device has push). */
export function queuePush(db: Db, items: PushItem[], now: Date = new Date()): { tokens: string[]; devices: number } {
  const targets = pushTargets(db);
  if (!targets.length || !items.length) return { tokens: [], devices: 0 };
  const at = now.toISOString();
  const ins = db.$client.prepare('insert into push_queue (device_id, type, key, text, urgent, otp_id, created_at) values (?, ?, ?, ?, ?, ?, ?)');
  db.$client.transaction(() => {
    for (const t of targets) for (const i of items) ins.run(t.deviceId, i.type, i.key, plainAlertText(i.text), i.urgent ? 1 : 0, i.otpId ?? null, at);
    db.$client.prepare('delete from push_queue where created_at < ?').run(new Date(now.getTime() - PUSH_KEEP_DAYS * 86_400_000).toISOString());
  })();
  return { tokens: targets.map((t) => t.token), devices: targets.length };
}

export interface PendingPush {
  id: number;
  type: string;
  text: string;
  urgent: boolean;
  otpId: string | null;
  createdAt: string;
}

/** This device's undelivered rows, oldest first, marked delivered as they are handed out. */
export function takePendingPush(db: Db, deviceId: number, now: Date = new Date()): PendingPush[] {
  return db.$client.transaction(() => {
    const rows = db.$client
      .prepare('select id, type, text, urgent, otp_id, created_at from push_queue where device_id = ? and delivered_at is null order by id limit ?')
      .all(deviceId, MAX_PENDING) as Array<{ id: number; type: string; text: string; urgent: number; otp_id: string | null; created_at: string }>;
    if (rows.length) db.$client.prepare(`update push_queue set delivered_at = ? where id in (${rows.map(() => '?').join(',')})`).run(now.toISOString(), ...rows.map((r) => r.id));
    return rows.map((r) => ({ id: r.id, type: r.type, text: r.text, urgent: r.urgent === 1, otpId: r.otp_id, createdAt: r.created_at }));
  })();
}
