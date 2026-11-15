/**
 * Thin client for the worker's /api. In the browser the hub is same-origin and a cookie session carries the PIN
 * login (or, for a browser paired away from home, a device token kept in this browser). In the Android app every
 * call goes through the FincVault plugin; a 401 there means the device may have been revoked. Either way a 401
 * flips the app back to its sign-in screen.
 *
 * Security research P2-01: in the app the device token never enters JavaScript. FincVault.request() (native,
 * HttpsURLConnection) adds it itself, to a URL it builds from the unlocked pairing's origin plus an "/api/..." path;
 * JS names only the path (checked here too, `checkApiPath`, the same rule as HubRequestRules.validApiPath).
 * Security research P1-10 still holds: only Android's own stack applies the network security config that pins
 * the hub's public key, and the WebView's networking (fetch) is never used for the hub.
 */
import { Capacitor } from '@capacitor/core';
import { vaultPair, vaultRequest, type VaultAnswer, type VaultPairAnswer } from './native';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues?: string[],
    /** the hub's whole JSON error body (e.g. a 429's `retryAt`, P2-02); {} when there was none */
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/**
 * The hub this app talks to. Browser: url '' (same origin), and a token only for a browser paired away from home.
 * App: the paired hub's url only; the token stays in native memory (P2-01).
 */
export interface Server {
  url: string;
  token?: string;
}

let server: Server | null = null;
export function setServer(s: Server | null): void {
  // P2-01: in the app whatever is passed, only the url is kept
  server = s ? (Capacitor.isNativePlatform() ? { url: s.url } : { ...s }) : null;
}
export function getServer(): Server | null {
  return server;
}

const listeners = new Set<() => void>();
export function onUnauthorized(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** App only: native says there is no unlocked session (relocked natively, or never unlocked): go to the lock screen. */
const lockedListeners = new Set<() => void>();
export function onLocked(fn: () => void): () => void {
  lockedListeners.add(fn);
  return () => lockedListeners.delete(fn);
}

interface Raw {
  status: number;
  /** the parsed JSON body; {} when there is none or it is not JSON */
  data: Record<string, unknown>;
}

/** an object or an array (some endpoints answer a list); anything else is {} */
const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/**
 * The path a native request may name, or null; mirrors HubRequestRules.validApiPath (FincVault): "/api/..." plus an
 * optional query, printable ASCII only, no backslash or "#", and before "?": no "//", "..", "." segment, and no "%"
 * at all (the hub decodes escapes before routing: "/api/devices/%70air" is the pair route). Query values come from
 * qs() (URLSearchParams), which encodes them; the app's paths never need an escape.
 */
export function checkApiPath(p: string): string | null {
  if (p.length > 8192 || !p.startsWith('/api/') || p.length === 5) return null;
  if (/[^\x21-\x7e]|[\\#]/.test(p)) return null;
  const q = p.indexOf('?');
  const before = q < 0 ? p : p.slice(0, q);
  if (before.includes('%')) return null;
  if (before.includes('//') || before.includes('..') || before.includes('/./') || before.endsWith('/.')) return null;
  return p;
}

/** Paths only native pair() may call (redeeming a code mints a token); mirrors HubRequestRules.nativeOnlyPath. */
export function nativeOnlyPath(path: string): boolean {
  const q = path.indexOf('?');
  return (q < 0 ? path : path.slice(0, q)).toLowerCase().replace(/\/+$/, '') === '/api/devices/pair';
}

/** A native error text never names the hub (the native side does not either; this is the second layer). */
function hideHub(msg: string, ...urls: (string | undefined)[]): string {
  let m = msg;
  for (const u of urls) {
    if (!u) continue;
    let origin = u;
    try {
      origin = new URL(u).origin;
    } catch {
      /* not a url */
    }
    m = m.split(u).join('hub').split(origin).join('hub');
  }
  return m;
}

const nativeMessage = (e: unknown): string => (e instanceof Error ? e.message : typeof (e as { message?: unknown })?.message === 'string' ? (e as { message: string }).message : String(e));

function parsed(data: unknown): Record<string, unknown> {
  // a JSON answer arrives parsed by the native side; anything else as text
  if (typeof data === 'string') {
    try {
      return asObject(JSON.parse(data));
    } catch {
      return {};
    }
  }
  return asObject(data);
}

/** App: one hub call through FincVault.request (the token is added natively). A transport failure rejects. */
async function sendNative(path: string, method: string, body: string | undefined): Promise<Raw> {
  const p = checkApiPath(path);
  if (!p || nativeOnlyPath(p)) throw new Error('refused: not a hub API path');
  if (!server) {
    for (const l of lockedListeners) l();
    throw new Error('finc is locked');
  }
  let r: VaultAnswer;
  try {
    r = await vaultRequest({ path: p, method, ...(body !== undefined ? { body } : {}) });
  } catch (e) {
    if ((e as { code?: unknown } | null)?.code === 'locked') {
      for (const l of lockedListeners) l();
      throw new Error('finc is locked');
    }
    throw new Error(hideHub(nativeMessage(e), server?.url) || 'no answer from the hub');
  }
  return { status: r.status, data: parsed(r.data) };
}

/** Browser: fetch. A transport failure rejects; an HTTP status, including an error, resolves. */
async function send(url: string, method: string, headers: Record<string, string>, body: string | undefined, credentials: RequestCredentials): Promise<Raw> {
  const res = await fetch(url, { method, headers, body: body ?? null, credentials });
  return { status: res.status, data: asObject(await res.json().catch(() => ({}))) };
}

const ok = (status: number): boolean => status >= 200 && status < 300;

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const json = body !== undefined ? JSON.stringify(body) : undefined;
  let res: Raw;
  if (Capacitor.isNativePlatform()) {
    res = await sendNative(path, method, json);
  } else {
    const headers: Record<string, string> = {};
    if (json !== undefined) headers['content-type'] = 'application/json';
    if (server?.token) headers.authorization = `Bearer ${server.token}`;
    res = await send(server ? server.url + path : path, method, headers, json, server ? 'omit' : 'same-origin');
  }
  if (res.status === 401 && !path.startsWith('/api/auth/')) for (const l of listeners) l();
  const data = res.data as { error?: string; issues?: string[] } & T;
  if (!ok(res.status)) throw new ApiError(data.error ?? `HTTP ${res.status}`, res.status, data.issues, res.data);
  return data;
}

export const api = {
  get: <T>(path: string) => call<T>('GET', path),
  post: <T>(path: string, body?: unknown) => call<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body: unknown) => call<T>('PATCH', path, body),
  del: <T>(path: string) => call<T>('DELETE', path),
};

/** A redeemed pairing. `token` only in the browser; in the app it stays in native memory (P2-01). */
export interface Paired {
  url: string;
  device: { id: number; name: string };
  token?: string;
}

/**
 * Redeem a pairing code at a hub this client is not yet paired with: no token, no cookie. App: natively
 * (FincVault.pair, which checks the pinned host and keeps the new token; then `keepPairing`). Browser: fetch.
 */
export async function pairDevice(url: string, code: string, name: string): Promise<Paired> {
  const base = url.replace(/\/+$/, '');
  if (Capacitor.isNativePlatform()) {
    let r: VaultPairAnswer;
    try {
      r = await vaultPair({ url: base, code, name });
    } catch (e) {
      throw new Error(hideHub(nativeMessage(e), base) || 'no answer from the hub');
    }
    if (r.ok) return { url: r.url.replace(/\/+$/, ''), device: r.device };
    if (r.reason === 'wrong-host') throw new ApiError('this app pairs only with its own hub', 0);
    const data = asObject(r.data) as { error?: string };
    throw new ApiError(data.error ?? `HTTP ${r.status ?? 0}`, r.status ?? 0);
  }
  const res = await send(`${base}/api/devices/pair`, 'POST', { 'content-type': 'application/json' }, JSON.stringify({ code, name }), 'omit');
  const data = res.data as { error?: string; token?: string; url?: string; device?: { id: number; name: string } };
  if (!ok(res.status) || !data.token || !data.device) throw new ApiError(data.error ?? `HTTP ${res.status}`, res.status);
  return { token: data.token, url: (data.url ?? base).replace(/\/+$/, ''), device: data.device };
}

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}

/**
 * A browser away from home has no cookie session (the PIN is refused from the internet) but can hold a
 * device token like the phone does: redeem a pairing code made at home, keep the token in this browser
 * only, and every call carries it. Revoking the device in Settings ends it.
 */
const BROWSER_DEVICE_KEY = 'finc.browserDevice';

export function loadBrowserDevice(): { token: string } | null {
  try {
    const raw = localStorage.getItem(BROWSER_DEVICE_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as { token?: string };
    return d.token ? { token: d.token } : null;
  } catch {
    return null;
  }
}

export function saveBrowserDevice(d: { token: string } | null): void {
  try {
    if (d) localStorage.setItem(BROWSER_DEVICE_KEY, JSON.stringify(d));
    else localStorage.removeItem(BROWSER_DEVICE_KEY);
  } catch {
    /* storage unavailable: the pairing lasts for this page load only */
  }
}

export function browserLabel(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

/** Redeem a pairing code at this origin and make this browser a paired device. */
export async function pairThisBrowser(code: string): Promise<void> {
  const r = await pairDevice(window.location.origin, code, browserLabel());
  if (!r.token) throw new ApiError('pairing failed', 0);
  saveBrowserDevice({ token: r.token });
  setServer({ url: '', token: r.token });
}
