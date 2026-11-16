/**
 * Settings → Security log: pure helpers for GET /api/security-events. The worker owns the list of kinds and may add
 * new ones at any time, so nothing here depends on an exact list: labels fall back to the raw kind, the tone comes
 * from words inside the kind, and the filter chips match by prefix/word on the client.
 */
import type { Key } from './i18n';
import type { SecurityEvent } from './types';

export const SECURITY_PAGE_SIZE = 30;
export const SECURITY_TIME_ZONE = 'Asia/Jerusalem';

/** The worker's kinds (dotted: family.event) that have their own label in i18n.tsx. Anything else shows raw. */
export const KNOWN_KINDS = [
  // sign-ins
  'auth.pin_ok',
  'auth.pin_failed',
  'auth.pin_locked',
  'auth.pin_set',
  'auth.pin_changed',
  'auth.pin_cleared',
  'auth.logout',
  'auth.refused_untrusted',
  'passkey.login_ok',
  'passkey.login_failed',
  // devices & passkeys
  'passkey.enrol_code_created',
  'passkey.enrolled',
  'passkey.enrol_failed',
  'passkey.removed',
  'device.pairing_code_created',
  'device.paired',
  'device.pair_failed',
  'device.renamed',
  'device.removed',
  'device.expired',
  'device.expiry_warning',
  'device.token_rejected',
  'device.used',
  'passkey.used',
  // vault
  'vault.unlock_ok',
  'vault.unlock_failed',
  'vault.lock',
  // lockdown
  'lockdown.run',
  'lockdown.requested',
  'lockdown.wrong_code',
  'lockdown.blocked',
  // other (shown under All only)
  'settings.changed',
  'alerts.settings_changed',
  'alerts.chat_code_created',
  'alerts.chat_bound',
  'alarm.set_up',
  'alarm.removed',
  'tls.state_changed',
  'worker.started',
  'http.body_too_large',
  'worker.db_owner_conflict',
  'backup.failed',
  'backup.shrank',
  'backup.stale',
  'backup.offsite_failed',
  'backup.offsite_stale',
  'sync.waiting_for_unlock',
  'backup.offsite_set',
  'backup.offsite_removed',
  'backup.offsite_hostkey_changed',
  'backup.restored',
  'data.retention',
] as const;
export type KnownKind = (typeof KNOWN_KINDS)[number];
/** 'auth.pin_ok' → 'sec_k_auth_pin_ok' (type-level), so a kind without an i18n entry fails the typecheck. */
type Dotless<S extends string> = S extends `${infer A}.${infer B}` ? `${A}_${Dotless<B>}` : S;
type KindKey = `sec_k_${Dotless<KnownKind>}`;
const _kindKeysExist: KindKey extends Key ? true : never = true;
void _kindKeysExist;

const known = new Set<string>(KNOWN_KINDS);

/** The i18n key for a kind, or null for a kind this app does not know yet. */
export function kindLabelKey(kind: string): Key | null {
  if (!known.has(kind)) return null;
  return `sec_k_${kind.replaceAll('.', '_')}` as KindKey;
}

/** Fallback for unknown kinds: the raw kind, made readable ('foo.bar_ok' → 'foo bar ok'). */
export function rawKindLabel(kind: string): string {
  return kind.replace(/[_.:-]+/g, ' ').trim() || kind;
}

export function kindLabel(kind: string, t: (k: Key) => string): string {
  const k = kindLabelKey(kind);
  return k ? t(k) : rawKindLabel(kind);
}

export type Tone = 'neg' | 'warn' | 'normal';
/** Red: something failed, was refused or was blocked. Matched on the event part (after the family dot) too. */
const NEG = /(^|[._])(failed|rejected|locked|blocked|wrong_code|db_owner_conflict|hostkey_changed)$|(^|[._])refused_/;
/** Amber: worth a look (expiry, any lockdown, removals, changes, backup trouble, TLS). */
const WARN = /^lockdown\.|(^|[._])(expired|expiry_warning|removed|changed|stale|shrank|restored)$|^backup\.offsite_set$|^tls\.state_changed$/;

export function kindTone(kind: string): Tone {
  const k = kind.toLowerCase();
  if (NEG.test(k)) return 'neg';
  if (WARN.test(k)) return 'warn';
  return 'normal';
}

/** Routine use of a paired device or passkey: the most common rows, drawn muted and compact. */
export function isRoutine(kind: string): boolean {
  return /\.used$/.test(kind.toLowerCase());
}

export const toneClass = (tone: Tone): string => (tone === 'neg' ? 'text-neg' : tone === 'warn' ? 'text-warn' : '');

/** Who did it: an i18n key plus an optional name/id to fill in, or the raw actor for one this app does not know. */
export type ActorLabel = { key: Key; name?: string } | { raw: string };

export function actorLabel(actor: string, actorName: string | null): ActorLabel {
  const [type, ...rest] = actor.split(':');
  const id = rest.join(':');
  const name = actorName?.trim() || (id ? `#${id}` : '');
  switch (type) {
    case 'pc':
      return { key: 'sec_actor_pc' };
    case 'device':
      return name ? { key: 'sec_actor_device', name } : { key: 'sec_actor_device_anon' };
    case 'passkey':
      return name ? { key: 'sec_actor_passkey', name } : { key: 'sec_actor_passkey_anon' };
    case 'telegram':
      return { key: 'sec_actor_telegram' };
    case 'cli':
      return { key: 'sec_actor_cli' };
    case 'control':
      return { key: 'sec_actor_control' };
    case 'public':
      return { key: 'sec_actor_public' };
    case 'system':
      return { key: 'sec_actor_system' };
    default:
      return { raw: actorName ? `${actor} (${actorName})` : actor };
  }
}

export function formatActor(actor: string, actorName: string | null, t: (k: Key, vars?: Record<string, string>) => string): string {
  const a = actorLabel(actor, actorName);
  if ('raw' in a) return a.raw;
  return a.name !== undefined ? t(a.key, { name: a.name }) : t(a.key);
}

/** The filter chips. Matching is by prefix/word, so new kinds of the same family land in the right group. */
export const SECURITY_FILTERS = ['all', 'signin', 'devices', 'vault', 'lockdown'] as const;
export type SecurityFilter = (typeof SECURITY_FILTERS)[number];

export function filterLabelKey(f: SecurityFilter): Key {
  return `sec_filter_${f}`;
}

/** By family: sign-ins are auth.* and passkey.login*; devices are device.* and the other passkey.*; the rest is All only. */
export function matchesFilter(kind: string, f: SecurityFilter): boolean {
  const k = kind.toLowerCase();
  const passkeyLogin = k.startsWith('passkey.login');
  switch (f) {
    case 'all':
      return true;
    case 'signin':
      return k.startsWith('auth.') || passkeyLogin;
    case 'devices':
      return k.startsWith('device.') || (k.startsWith('passkey.') && !passkeyLogin);
    case 'vault':
      return k.startsWith('vault.');
    case 'lockdown':
      return k.startsWith('lockdown.');
  }
}

export function filterEvents(events: SecurityEvent[], f: SecurityFilter): SecurityEvent[] {
  return f === 'all' ? events : events.filter((e) => matchesFilter(e.kind, f));
}

/** The query string for one page; `before` is the previous page's nextBefore. The filter is applied on the client. */
export function securityEventsPath(before: number | null, limit = SECURITY_PAGE_SIZE): string {
  return `/api/security-events?limit=${limit}${before !== null ? `&before=${before}` : ''}`;
}

/** Absolute local time in Israel, e.g. "11.11.2026, 14:05:09". */
export function absTime(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { timeZone: SECURITY_TIME_ZONE, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d);
}

/**
 * The detail as one readable line. The worker often sends a small JSON object ({"repeats": 5}, {"keys": [...]}):
 * shown as "key: value · key: value", with repeats as "×5" first. Anything not JSON is shown as it is.
 */
export function formatDetail(detail: string | null, t?: (k: Key) => string): string | null {
  if (detail === null) return null;
  const d = detail.trim();
  if (!d) return null;
  if (!/^[[{]/.test(d)) return d;
  let v: unknown;
  try {
    v = JSON.parse(d);
  } catch {
    return d;
  }
  if (Array.isArray(v)) return v.map(scalar).join(', ');
  if (!v || typeof v !== 'object') return d;
  const parts: string[] = [];
  let repeats: string | null = null;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val === null || val === undefined || val === '') continue;
    if (k === 'repeats' && (typeof val === 'number' || typeof val === 'string')) repeats = `×${val}`;
    else if (k === 'changed' && t && Array.isArray(val) && val.length && val.every((x) => x === 'address' || x === 'agent'))
      // device.used: what is new about this device since last time
      parts.push(val.map((x) => t(x === 'address' ? 'sec_changed_address' : 'sec_changed_agent')).join(', '));
    else parts.push(`${k.replaceAll('_', ' ')}: ${Array.isArray(val) ? val.map(scalar).join(', ') : scalar(val)}`);
  }
  if (repeats) parts.unshift(repeats);
  return parts.length ? parts.join(' · ') : null;
}

function scalar(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
