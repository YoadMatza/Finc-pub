/**
 * Bank-connector hygiene (security research P2-06): the browser profile never stores a bank password, page
 * captures are owner-only, the Isracard "signed in" check compares the hostname, explore mode stays on the
 * bank's origin, and logged URLs carry no query string or fragment.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Chrome preferences that switch off saving passwords, the password manager and form autofill. */
const NO_SAVED_SECRETS = {
  credentials_enable_service: false,
  credentials_enable_autosignin: false,
  profile: { password_manager_enabled: false, password_manager_leak_detection: false },
  autofill: { enabled: false, profile_enabled: false, credit_card_enabled: false },
} as const;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function merge(into: Json, from: Json): Json {
  for (const [k, v] of Object.entries(from)) into[k] = isObj(v) ? merge(isObj(into[k]) ? (into[k] as Json) : {}, v) : v;
  return into;
}

/** Write the no-saved-secrets preferences into a profile before Chrome starts, keeping everything else in it. */
export function hardenBrowserProfile(profileDir: string): void {
  const file = path.join(profileDir, 'Default', 'Preferences');
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let prefs: Json = {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (isObj(parsed)) prefs = parsed;
  } catch {
    /* no profile yet, or a broken one: start from the hardened settings alone */
  }
  writeFileSync(file, JSON.stringify(merge(prefs, NO_SAVED_SECRETS)), { mode: 0o600 });
}

/** Signed in to Isracard: an https page on isracard.co.il (or a subdomain) that is not a login page. */
export function isIsracardSignedIn(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return u.protocol === 'https:' && (host === 'isracard.co.il' || host.endsWith('.isracard.co.il')) && !/login/i.test(u.pathname + u.hash);
  } catch {
    return false;
  }
}

/** Whether `url` (absolute or relative to `base`) stays on `base`'s origin. */
export function sameOrigin(url: string, base: string): boolean {
  try {
    return new URL(url, base).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

/** A URL fit for a log line: scheme, host and path only (session ids and tokens ride in queries and fragments). */
export function urlForLog(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '[unparsable url]';
  }
}

/** Write a page capture readable by the owner only. */
export function writePrivate(file: string, data: string | Uint8Array): void {
  writeFileSync(file, data, { mode: 0o600 });
}
