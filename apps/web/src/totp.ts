/**
 * Backup login (research_notes/proposals/totp-backup-login.md): PIN + a code from an authenticator app, for a browser
 * away from home that has no passkey. Pure helpers for the sign-in screen and Settings → Backup login; tested in
 * totp.test.ts. The worker checks everything again: these only shape what the user types and reads.
 */
import QRCode from 'qrcode';
import { ApiError, saveBrowserDevice, setServer } from './api';
import type { Key } from './i18n';
import { retryAtOf, retryWhen } from './limits';

/** The secret in groups of 4 for typing it into an authenticator app by hand ("ABCD EFGH IJ"). */
export function groupSecret(secret: string): string {
  const s = secret.replace(/[\s-]+/g, '').toUpperCase();
  return s.match(/.{1,4}/g)?.join(' ') ?? '';
}

export type CodeKind = 'totp' | 'recovery';

/** A typed code without spaces (a pasted "123 456" or " ABCDE-FGHIJ "). */
export function cleanCode(input: string): string {
  return input.replace(/\s+/g, '');
}

/** What a typed code looks like: 6 digits from the app, a recovery code (ABCDE-FGHIJ, dash optional), or neither. */
export function codeKind(input: string): CodeKind | null {
  const s = cleanCode(input);
  if (/^\d{6}$/.test(s)) return 'totp';
  if (/^[A-Za-z0-9]{5}-?[A-Za-z0-9]{5}$/.test(s)) return 'recovery';
  return null;
}

/** The confirm step during setup takes only a code from the app, never a recovery code. */
export function isAppCode(input: string): boolean {
  return codeKind(input) === 'totp';
}

type T = (key: Key, vars?: Record<string, string | number>) => string;

const WHEN_KEY = { today: 'limit_when_today', tomorrow: 'limit_when_tomorrow', day: 'limit_when_day' } as const satisfies Record<string, Key>;

/** "Locked after wrong tries; try again at 14:35" from a 429's retryAt (Israel time), or null for any other error. */
export function totpRetryText(e: unknown, t: T, locale: string, now: Date = new Date()): string | null {
  const at = retryAtOf(e);
  if (!at) return null;
  const w = retryWhen(at, now, locale);
  return t('totp_locked_until', { when: t(WHEN_KEY[w.kind], { t: w.time, d: w.day }) });
}

/** The line to show after a failed backup sign-in: wrong PIN or code (one message for both), locked, off, or the hub's own text. */
export function totpLoginError(e: unknown, t: T, locale: string, now: Date = new Date()): string {
  if (e instanceof ApiError) {
    if (e.status === 401) return t('totp_wrong');
    if (e.status === 429) return totpRetryText(e, t, locale, now) ?? t('totp_locked');
    if (e.status === 409) return t('totp_off_now');
  }
  return e instanceof Error ? e.message : String(e);
}

/** The line to show after a failed confirm during setup: a wrong code, an expired setup, or the hub's own text. */
export function totpConfirmError(e: unknown, t: T): string {
  if (e instanceof ApiError) {
    if (e.status === 400) return t('totp_confirm_wrong');
    if (e.status === 410) return t('totp_setup_expired');
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * Sign in with PIN + code. Same-origin with the cookie jar (never the paired-device token), like the passkey sign-in:
 * the worker answers with a session cookie, which then replaces a dead device token. A failure throws an ApiError
 * that keeps the whole body (a 429's retryAt).
 */
export async function signInWithTotp(pin: string, code: string): Promise<void> {
  const res = await fetch('/api/auth/totp/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin, code: cleanCode(code) }),
    credentials: 'same-origin',
  });
  const raw: unknown = await res.json().catch(() => ({}));
  const data = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  if (!res.ok) throw new ApiError(typeof data.error === 'string' ? data.error : `HTTP ${res.status}`, res.status, undefined, data);
  saveBrowserDevice(null);
  setServer(null);
}

/** A QR code as one SVG path (dark modules only), so it renders without innerHTML. `size` includes the quiet zone. */
export function qrPath(text: string, margin = 2): { size: number; d: string } {
  // the `qrcode` package the passkey card already uses: no second QR library
  const m = QRCode.create(text, { errorCorrectionLevel: 'M' }).modules;
  const n = m.size;
  const parts: string[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (m.get(r, c)) parts.push(`M${c + margin} ${r + margin}h1v1h-1z`);
    }
  }
  return { size: n + margin * 2, d: parts.join('') };
}
