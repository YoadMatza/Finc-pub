/**
 * UI access PIN, for browsers on the home network or Tailscale (the internet uses paired-device tokens).
 * The PIN is stored as an Argon2id hash in the settings table (never the PIN itself). Browser sessions
 * live in the worker (persisted hashed in `ui.sessions`) and each carries the `pinStamp` of the PIN it was
 * opened with, so changing or clearing the PIN, from the hub or the CLI, ends every session at once.
 */
import { createHash } from 'node:crypto';
import sodium from 'libsodium-wrappers-sumo';
import { getSetting, setSetting } from '../ai/settings.js';
import type { Db } from '../db/db.js';

export const PIN_SETTING = 'ui.pinHash';

export function pinIsSet(db: Db): boolean {
  return getSetting(db, PIN_SETTING) !== null;
}

export function validatePin(pin: string): string | null {
  if (typeof pin !== 'string') return 'pin required';
  if (pin.length < 6) return 'at least 6 characters';
  if (pin.length > 64) return 'at most 64 characters';
  if (/^(\d)\1+$/.test(pin) || pin === '1234' || pin === '0000' || pin === '123456') return 'too easy to guess';
  return null;
}

export async function setPin(db: Db, pin: string): Promise<void> {
  const problem = validatePin(pin);
  if (problem) throw new Error(problem);
  await sodium.ready;
  const hash = sodium.crypto_pwhash_str(pin, sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE, sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE);
  setSetting(db, PIN_SETTING, hash);
}

export async function verifyPin(db: Db, pin: string): Promise<boolean> {
  const hash = getSetting(db, PIN_SETTING);
  if (!hash || typeof pin !== 'string') return false;
  await sodium.ready;
  return sodium.crypto_pwhash_str_verify(hash, pin);
}

/**
 * A short fingerprint of the current PIN hash (null when no PIN is set). A fresh salt makes every setPin
 * produce a new stamp, even for the same PIN. Not secret on its own; it only ties sessions to one PIN.
 */
export function pinStamp(db: Db): string | null {
  const hash = getSetting(db, PIN_SETTING);
  return hash ? createHash('sha256').update(hash).digest('hex').slice(0, 32) : null;
}

export function clearPin(db: Db): void {
  setSetting(db, PIN_SETTING, null);
}
