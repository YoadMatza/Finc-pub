/**
 * Passkeys: a thin wrapper around @simplewebauthn/browser and the worker's /api/auth/passkey/* routes.
 * A passkey session works away from home for 12 hours but never for admin actions.
 *
 * These calls always go same-origin with the cookie jar (never the paired-device token): the worker
 * answers a successful ceremony with a session cookie, and a fetch with credentials 'omit' would drop it.
 */
import { browserSupportsWebAuthn, startAuthentication, startRegistration, WebAuthnError } from '@simplewebauthn/browser';
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { ApiError, saveBrowserDevice, setServer } from './api';

export function passkeysSupported(): boolean {
  try {
    return browserSupportsWebAuthn();
  } catch {
    return false;
  }
}

/** The passkey is bound to the public host name; it only works on a page opened at that host. */
export function onRpHost(rpId: string | null | undefined): boolean {
  return !!rpId && window.location.hostname === rpId;
}

export type PasskeyFailure = 'cancelled' | 'already' | 'other';

/** Map a thrown error to what the user should be told. The user closing the prompt is not an error. */
export function passkeyFailure(e: unknown): PasskeyFailure {
  if (e instanceof WebAuthnError && e.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') return 'already';
  if (e instanceof WebAuthnError && e.code === 'ERROR_CEREMONY_ABORTED') return 'cancelled';
  const name = e instanceof Error ? e.name : '';
  if (name === 'NotAllowedError' || name === 'AbortError') return 'cancelled';
  return 'other';
}

async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
  const data = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) throw new ApiError(data.error ?? `HTTP ${res.status}`, res.status);
  return data;
}

/** After a passkey SIGN-IN (only reachable when this browser was not signed in) the cookie replaces a dead device token. */
function switchToCookieSession(): void {
  saveBrowserDevice(null);
  setServer(null);
}

export async function signInWithPasskey(): Promise<void> {
  const { challengeId, options } = await post<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }>('/api/auth/passkey/login-options');
  const response = await startAuthentication({ optionsJSON: options });
  await post<{ ok: boolean }>('/api/auth/passkey/login', { challengeId, response });
  switchToCookieSession();
}

export async function registerPasskey(code: string, name?: string): Promise<{ id: number | string; name: string }> {
  const { options } = await post<{ options: PublicKeyCredentialCreationOptionsJSON }>('/api/auth/passkey/register-options', { code });
  const response = await startRegistration({ optionsJSON: options });
  const r = await post<{ ok: boolean; passkey: { id: number | string; name: string } }>('/api/auth/passkey/register', { code, response, ...(name ? { name } : {}) });
  // A browser paired as a device keeps its (permanent) device token: adding a passkey must not downgrade it to a
  // 12-hour session or orphan its device row (review 2026-11-10). A stale token is dropped by the 401 handler anyway.
  return r.passkey;
}
