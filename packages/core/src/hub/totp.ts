/**
 * The backup login from outside (research_notes/proposals/totp-backup-login.md): PIN + a code from an authenticator
 * app. RFC 6238 TOTP (HMAC-SHA-1, 6 digits, 30-second steps, one step either side), a code used once, and 8
 * single-use recovery codes (only their hashes are kept). The secret has to work while the vault is locked, so it is
 * kept in the database next to the PIN's hash (a documented limit, SECURITY.md).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getSetting, setSetting } from '../ai/settings.js';
import type { Db } from '../db/db.js';

export const TOTP_SETTING = 'auth.totp';
const STEP_S = 30;
const DIGITS = 6;
const WINDOW = 1;
export const RECOVERY_CODES = 8;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('not base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 4226 HOTP for one counter value. */
export function hotp(secret: Buffer, counter: number, digits = DIGITS): string {
  const c = Buffer.alloc(8);
  c.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(c).digest();
  const off = h[h.length - 1]! & 0x0f;
  const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const totpStep = (nowMs: number): number => Math.floor(nowMs / 1000 / STEP_S);

/** The step a code matches within ±1 step, or null. Constant-time per comparison. */
export function matchTotp(secret: Buffer, code: string, nowMs: number): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = totpStep(nowMs);
  let hit: number | null = null;
  for (let d = -WINDOW; d <= WINDOW; d++) {
    const want = Buffer.from(hotp(secret, now + d));
    if (timingSafeEqual(want, Buffer.from(code)) && hit === null) hit = now + d;
  }
  return hit;
}

interface Stored {
  secret: string; // base32
  lastStep: number;
  recovery: string[]; // sha256 hex of each unused recovery code
  enabledAt: string;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const normRecovery = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

function load(db: Db): Stored | null {
  const v = getSetting(db, TOTP_SETTING);
  if (!v) return null;
  try {
    const j = JSON.parse(v) as Stored;
    return typeof j.secret === 'string' && Array.isArray(j.recovery) ? j : null;
  } catch {
    return null;
  }
}

export const totpEnabled = (db: Db): boolean => load(db) !== null;

/** A new secret and its otpauth:// link (for the QR code). Nothing is stored until `enableTotp` with a valid code. */
export function newTotpSecret(label = 'finc'): { secret: string; uri: string } {
  const secret = base32Encode(randomBytes(20));
  const uri = `otpauth://totp/${encodeURIComponent(`finc:${label}`)}?secret=${secret}&issuer=finc&algorithm=SHA1&digits=${DIGITS}&period=${STEP_S}`;
  return { secret, uri };
}

/** Turns the backup login on when `code` proves the app has the secret; returns the recovery codes (shown once). */
export function enableTotp(db: Db, secret: string, code: string, now: number): { ok: true; recoveryCodes: string[] } | { ok: false } {
  let key: Buffer;
  try {
    key = base32Decode(secret);
  } catch {
    return { ok: false };
  }
  const step = matchTotp(key, code, now);
  if (step === null || key.length < 16) return { ok: false };
  const recoveryCodes = Array.from({ length: RECOVERY_CODES }, () => {
    const c = base32Encode(randomBytes(7)).slice(0, 10);
    return `${c.slice(0, 5)}-${c.slice(5)}`;
  });
  const stored: Stored = { secret, lastStep: step, recovery: recoveryCodes.map((c) => sha(normRecovery(c))), enabledAt: new Date(now).toISOString() };
  setSetting(db, TOTP_SETTING, JSON.stringify(stored));
  return { ok: true, recoveryCodes };
}

export const disableTotp = (db: Db): void => setSetting(db, TOTP_SETTING, null);

/**
 * Checks a code: an authenticator code (once per step: a code at or before the last used step is refused) or an
 * unused recovery code (used up). Updates the stored state on success.
 */
export function useTotpCode(db: Db, code: string, now: number): { ok: true; via: 'app' | 'recovery'; recoveryLeft: number } | { ok: false } {
  const s = load(db);
  if (!s) return { ok: false };
  const c = code.trim();
  if (/^\d{6}$/.test(c)) {
    const step = matchTotp(base32Decode(s.secret), c, now);
    if (step === null || step <= s.lastStep) return { ok: false };
    setSetting(db, TOTP_SETTING, JSON.stringify({ ...s, lastStep: step }));
    return { ok: true, via: 'app', recoveryLeft: s.recovery.length };
  }
  const h = sha(normRecovery(c));
  if (normRecovery(c).length !== 10 || !s.recovery.includes(h)) return { ok: false };
  const recovery = s.recovery.filter((x) => x !== h);
  setSetting(db, TOTP_SETTING, JSON.stringify({ ...s, recovery }));
  return { ok: true, via: 'recovery', recoveryLeft: recovery.length };
}

/** When the backup login was turned on, or null. */
export const totpEnabledAt = (db: Db): string | null => load(db)?.enabledAt ?? null;

/** How many recovery codes are left (for Settings), or null when the backup login is off. */
export const totpRecoveryLeft = (db: Db): number | null => load(db)?.recovery.length ?? null;
