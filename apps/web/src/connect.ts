/**
 * The consent page (/connect?req=<id>, remote-mcp.md §4.3): the pure parts. The page is opened from a browser that
 * ChatGPT or Claude sent to finc, without a hub session; after Approve or Deny it sends the browser back to the app.
 * The worker builds that redirect, and this page checks it again before following it (defence in depth: a bug or a
 * tampered answer must not turn finc's page into an open redirect).
 */
import type { OAuthRequestCode } from './types';

/** The only hosts an approval or denial may send the browser to (ChatGPT's and Claude's callbacks, §4.2). */
export const CONNECT_REDIRECT_HOSTS: readonly string[] = ['chatgpt.com', 'claude.ai', 'claude.com'];

/**
 * The URL to navigate to, or null when it is not safe: only `https:`, a host exactly on the list (no subdomain, no
 * look-alike suffix, no trailing dot), no user info, no port (not even :443), no whitespace, control characters or
 * backslashes anywhere.
 */
export function safeConnectRedirect(url: unknown): string | null {
  if (typeof url !== 'string' || url.length === 0 || url.length > 4096) return null;
  if (/[\s\u0000-\u001f\u007f\\]/.test(url)) return null;
  if (!/^https:\/\//i.test(url)) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.port !== '') return null;
  if (!CONNECT_REDIRECT_HOSTS.includes(u.hostname)) return null;
  // the authority as written must be the bare host: this refuses an explicit default port and an empty "@"
  const authority = url.slice('https://'.length).split(/[/?#]/, 1)[0] ?? '';
  if (authority.toLowerCase() !== u.host) return null;
  return u.href;
}

/** A request id as the worker makes them (URL-safe random text); anything else is not looked up. */
export function validRequestId(id: string | null | undefined): id is string {
  return !!id && id.length <= 200 && /^[A-Za-z0-9_-]+$/.test(id);
}

/** The i18n key for why a request cannot be shown; null for an unknown code (the server's own text is shown then). */
export function connectErrorKey(code: unknown): 'connect_err_not_found' | 'connect_err_expired' | 'connect_err_window_closed' | 'connect_err_used' | null {
  const codes: Record<OAuthRequestCode, 'connect_err_not_found' | 'connect_err_expired' | 'connect_err_window_closed' | 'connect_err_used'> = {
    not_found: 'connect_err_not_found',
    expired: 'connect_err_expired',
    window_closed: 'connect_err_window_closed',
    used: 'connect_err_used',
  };
  return typeof code === 'string' && Object.hasOwn(codes, code) ? codes[code as OAuthRequestCode] : null;
}

/** The WebAuthn request options from POST .../options: the options themselves, or wrapped as `{ options }`. */
export function requestOptionsFrom<T extends object>(data: unknown): T | null {
  if (!data || typeof data !== 'object') return null;
  const o = data as Record<string, unknown>;
  const inner = o['options'];
  if (inner && typeof inner === 'object' && typeof (inner as Record<string, unknown>)['challenge'] === 'string') return inner as T;
  return typeof o['challenge'] === 'string' ? (o as T) : null;
}
