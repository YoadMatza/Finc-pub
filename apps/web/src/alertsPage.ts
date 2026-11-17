/** Pure logic of the Alerts page (push-alerts.md step 5): recent alerts merged across channels, OTP countdown and code check. */
import type { AlertChannel, AlertsPayload } from './types';

export type RecentAlert = AlertsPayload['recent'][number];

export interface MergedAlert {
  /** the newest send's id (stable React key) */
  id: number;
  key: string;
  type: string;
  /** the plain text (tags stripped) of the newest send */
  text: string;
  /** the newest send time across channels */
  sentAt: string;
  /** one mark per channel, in first-seen order (newest first); ok = any send on that channel went out */
  channels: Array<{ channel: AlertChannel; ok: boolean; error: string | null }>;
  /** true when no channel delivered it */
  failed: boolean;
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

/** Plain text for display: simple HTML tags (<b>, <i>, <a href…>, <br>) dropped, the common entities decoded. */
export function stripTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[a-zA-Z][^<>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .trim();
}

const asChannel = (c: string): AlertChannel => (c === 'push' ? 'push' : 'telegram');

/** Newest first; the same `key` sent on Telegram and to the app becomes one row with both channel marks. */
export function mergeRecent(recent: readonly RecentAlert[]): MergedAlert[] {
  const sorted = [...recent].sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt) || b.id - a.id);
  const byKey = new Map<string, MergedAlert>();
  const out: MergedAlert[] = [];
  for (const a of sorted) {
    // an alert without a key cannot be matched to another: it stays its own row
    const k = a.key ? `k:${a.key}` : `id:${a.id}`;
    let m = byKey.get(k);
    if (!m) {
      m = { id: a.id, key: a.key, type: a.type, text: stripTags(a.text), sentAt: a.sentAt, channels: [], failed: true };
      byKey.set(k, m);
      out.push(m);
    }
    const ch = asChannel(a.channel);
    const mark = m.channels.find((c) => c.channel === ch);
    if (!mark) m.channels.push({ channel: ch, ok: a.ok, error: a.ok ? null : a.error });
    else if (a.ok && !mark.ok) {
      mark.ok = true;
      mark.error = null;
    }
    if (a.ok) m.failed = false;
  }
  return out;
}

/** A one-time code as the bank sends it: 4 to 8 digits (spaces the user typed are ignored). */
export function cleanCode(input: string): string {
  return input.replace(/\s+/g, '');
}

export function validCode(input: string): boolean {
  return /^\d{4,8}$/.test(cleanCode(input));
}

/** Time left until `expiresAt`: "m:ss" (or "h:mm:ss" past an hour); null once expired. */
export function countdown(expiresAt: string, now: number = Date.now()): string | null {
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Poll fast (5 s) while a sync waits for a code, else every 30 s. */
export function otpPollMs(pending: number): number {
  return pending > 0 ? 5_000 : 30_000;
}

/** The status line of the Push column: not set up / no device yet / N devices. */
export type PushStatus = { key: 'push_status_none' } | { key: 'push_status_nodevice' } | { key: 'push_status_devices'; n: number };

export function pushStatus(push: AlertsPayload['push']): PushStatus {
  if (!push?.configured) return { key: 'push_status_none' };
  if (push.devices <= 0) return { key: 'push_status_nodevice' };
  return { key: 'push_status_devices', n: push.devices };
}
