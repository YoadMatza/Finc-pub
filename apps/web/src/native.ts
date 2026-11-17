/**
 * The Android shell's native bits, all lazy so the browser bundle never loads a plugin:
 * the vault for the paired hub (URL + device token), the QR scanner for pairing, and app lifecycle events.
 *
 * Security research P1-11: the pairing lives in the FincVault plugin, encrypted under an Android Keystore key
 * that needs the fingerprint or the screen lock for every use. Nothing is read before the lock screen. A phone
 * without a screen lock gets no vault at all.
 *
 * Security research P2-01: the device token never enters JavaScript. Unlocking (`unlockServer`) leaves the
 * decrypted pairing in native memory and hands JS only {url, deviceName}; every hub call is `vaultRequest`, which
 * native code sends with the token it holds; a pairing code is redeemed natively (`vaultPair`) and kept with
 * `keepPairing`. Relock (`lockVault`) drops the native session. The one exception is the one-time move of a
 * pre-vault pairing (`legacyServer`), which has to read that old copy, token included, once.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import { CLOSED_POLICY, checkHubUrl, type HubPolicy } from './hubhost';

export const isNative = Capacitor.isNativePlatform();

/** What JS knows about the unlocked pairing: never the token (P2-01). */
export interface PairedServer {
  url: string;
  deviceName: string;
}

/** A pre-vault pairing read from the old secure storage (the only token JS ever sees, once, to migrate it). */
interface LegacyPairing extends PairedServer {
  token: string;
}

export interface VaultStatus {
  /** The phone has a screen lock (PIN, pattern, password). Without one the vault refuses to work. */
  deviceSecure: boolean;
  strongBiometrics: boolean;
  hasSecret: boolean;
}

/** 'wrong-host': a release app refuses a hub that is not the one its pins are for (security research P1-10). */
export type StoreFailure = 'cancelled' | 'no-lock' | 'failed' | 'wrong-host';
export type LoadFailure = 'cancelled' | 'invalidated' | 'none' | 'no-lock' | 'failed' | 'wrong-host';

interface PromptTexts {
  title: string;
  subtitle?: string;
}

/** One hub API call, sent natively with the token native code holds (P2-01). */
export interface VaultRequest {
  /** "/api/..." plus an optional query; native builds the URL from the unlocked pairing's origin and this */
  path: string;
  method: string;
  /** JSON text */
  body?: string;
  /** only accept / accept-language / content-type pass; Authorization and Cookie are always dropped */
  headers?: Record<string, string>;
}

export interface VaultAnswer {
  status: number;
  /** parsed JSON, or the text when it is not JSON */
  data: unknown;
  headers?: Record<string, string>;
}

/** The redeem answer: on success the token stays in native memory; JS gets the hub address and the device. */
export type VaultPairAnswer =
  | { ok: true; url: string; device: { id: number; name: string } }
  | { ok: false; reason?: 'wrong-host'; status?: number; data?: unknown };

interface FincVaultPlugin {
  status(): Promise<VaultStatus>;
  /** only for moving a legacy pairing into the vault; success unlocks natively with it */
  store(o: PromptTexts & { value: string }): Promise<{ ok: boolean; reason?: StoreFailure }>;
  /** the pairing redeemed by pair() into the vault; success unlocks natively with it */
  storePairing(o: PromptTexts): Promise<{ ok: boolean; reason?: StoreFailure; url?: string; deviceName?: string }>;
  /** prompt, decrypt, unlock natively; answers the url and name, never the token */
  load(o: PromptTexts): Promise<{ ok: boolean; url?: string; deviceName?: string; reason?: LoadFailure }>;
  /** relock: the native session is dropped, the vault keeps the pairing */
  lock(): Promise<{ ok: boolean }>;
  /** forget the pairing: vault, key and native session */
  clear(): Promise<{ ok: true }>;
  /** rejects with code 'locked' | 'invalid' | 'network' */
  request(o: VaultRequest): Promise<VaultAnswer>;
  /** rejects with code 'invalid' | 'network' */
  pair(o: { url: string; code: string; name: string }): Promise<VaultPairAnswer>;
  /**
   * ms since the last pause (elapsedRealtime); reading consumes it; 0 when no pause is recorded (native also
   * resets it after a successful load / store). `epoch` names the pause count at the time of the read.
   */
  awayMs(): Promise<{ ms: number; epoch?: number }>;
  /** drop the opaque cover native code puts over the WebView; refused (ok: false) if a pause happened since `epoch` */
  uncover(o?: { epoch?: number }): Promise<{ ok: boolean }>;
  clearWebCache(): Promise<{ ok: true }>;
  /** The hub host built into the APK (BuildConfig.FINC_PUBLIC_HOST) and whether it is enforced (release builds). */
  pinnedHost(): Promise<{ host?: string; enforce?: boolean }>;
  /** an https://www.sec.gov/ link in the system browser (ACTION_VIEW); rejects with code 'invalid' | 'unavailable' */
  openExternal(o: { url: string }): Promise<{ ok: true }>;
  /** push alerts (push-alerts.md): registers this phone after an unlock; the push secret stays in native code */
  pushRegister(): Promise<{ ok: boolean; reason?: 'locked' | 'no-firebase' | 'refused' | 'network' }>;
  /** the hub path a tapped notification asked for, once */
  takeLaunchPath(): Promise<{ path: string | null }>;
}

let vaultPlugin: FincVaultPlugin | null = null;
const vault = (): FincVaultPlugin => (vaultPlugin ??= registerPlugin<FincVaultPlugin>('FincVault'));

const prompt = (title: string, subtitle?: string): PromptTexts => (subtitle ? { title, subtitle } : { title });

function asLegacy(v: unknown): LegacyPairing | null {
  if (!v || typeof v !== 'object' || Array.isArray(v) || v instanceof Date) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.url !== 'string' || typeof o.token !== 'string' || !o.url || !o.token) return null;
  return { url: o.url, token: o.token, deviceName: typeof o.deviceName === 'string' ? o.deviceName : 'phone' };
}

/** Never throws: a vault that cannot be asked (an old APK without the plugin) answers null. */
export async function vaultStatus(): Promise<VaultStatus | null> {
  if (!isNative) return null;
  try {
    const s = await vault().status();
    return { deviceSecure: s.deviceSecure === true, strongBiometrics: s.strongBiometrics === true, hasSecret: s.hasSecret === true };
  } catch {
    return null;
  }
}

/**
 * Time away from the native timer, consumed by the read. If the plugin cannot answer, the absence is treated as
 * long (fail closed: a lock, never an open door).
 */
export interface Away {
  ms: number;
  /** pass to uncover(): native refuses if the app was paused again since this read */
  epoch?: number;
}

export async function awayMs(): Promise<Away> {
  if (!isNative) return { ms: 0 };
  try {
    const { ms, epoch } = await vault().awayMs();
    const okMs = typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? ms : Number.POSITIVE_INFINITY;
    return typeof epoch === 'number' ? { ms: okMs, epoch } : { ms: okMs };
  } catch {
    return { ms: Number.POSITIVE_INFINITY };
  }
}

/**
 * Drop the native cover over the WebView. With an epoch it is refused (false) when the app was paused since;
 * without one (right after an unlock or pairing, the user is looking at the app) it always drops.
 */
export async function uncover(epoch?: number): Promise<boolean> {
  if (!isNative) return true;
  try {
    const r = await vault().uncover(epoch === undefined ? {} : { epoch });
    return r.ok === true;
  } catch {
    return false;
  }
}

/** Clear the WebView's HTTP cache (cached API answers) on relock. */
export async function clearWebCache(): Promise<void> {
  if (!isNative) return;
  await vault()
    .clearWebCache()
    .catch(() => undefined);
}

/**
 * The hub host this APK pins (P1-10). Never throws; if the plugin cannot answer, nothing is acceptable (fail closed).
 * Not cached, so a test (or a future reinstall) always sees the native answer.
 */
export async function hubPolicy(): Promise<HubPolicy> {
  if (!isNative) return { host: null, enforce: false };
  try {
    const r = await vault().pinnedHost();
    const host = typeof r.host === 'string' && r.host.trim() ? r.host.trim().toLowerCase() : null;
    return { host, enforce: r.enforce !== false };
  } catch {
    return CLOSED_POLICY;
  }
}

/** Whether a paired server may be used by this build (true in the browser, where no pairing exists). */
async function allowedServer(s: { url: string }): Promise<boolean> {
  if (!isNative) return true;
  return checkHubUrl(s.url, await hubPolicy()).ok;
}

// ---- the pre-vault pairing (@aparajita/capacitor-secure-storage, no user authentication): read once, then gone ----

const LEGACY_KEY = 'finc.server';

/** The pairing an older version kept outside the vault. Returned to the caller only; never cached here. */
export async function legacyServer(): Promise<LegacyPairing | null> {
  if (!isNative) return null;
  try {
    const { SecureStorage } = await import('@aparajita/capacitor-secure-storage');
    return asLegacy(await SecureStorage.get(LEGACY_KEY).catch(() => null));
  } catch {
    return null;
  }
}

/** Whether a legacy pairing exists, from the key list only: the value (the token) is not read or decoded. */
export async function hasLegacyServer(): Promise<boolean> {
  if (!isNative) return false;
  try {
    const { SecureStorage } = await import('@aparajita/capacitor-secure-storage');
    const keys = await SecureStorage.keys().catch(() => [] as string[]);
    return keys.includes(LEGACY_KEY);
  } catch {
    return false;
  }
}

async function removeLegacy(): Promise<void> {
  try {
    const { SecureStorage } = await import('@aparajita/capacitor-secure-storage');
    await SecureStorage.remove(LEGACY_KEY).catch(() => false);
  } catch {
    /* plugin missing: nothing to remove */
  }
}

/** Unpair / revoked / "Forget this pairing": the vault, its key and the native session go, and the legacy copy. */
export async function forgetPairing(): Promise<void> {
  if (!isNative) return;
  await vault()
    .clear()
    .catch(() => undefined);
  await removeLegacy();
}

/**
 * Keep the pairing that `vaultPair` just redeemed (its token waits in native memory) in the vault: shows the
 * fingerprint / screen-lock prompt. On success native is unlocked with it, and the legacy copy is deleted.
 */
export async function keepPairing(texts?: PromptTexts): Promise<{ ok: boolean; reason?: StoreFailure }> {
  if (!isNative) return { ok: true };
  try {
    const r = await vault().storePairing(prompt(texts?.title ?? 'finc', texts?.subtitle));
    if (!r.ok) return { ok: false, reason: r.reason ?? 'failed' };
  } catch {
    return { ok: false, reason: 'failed' };
  }
  await removeLegacy();
  return { ok: true };
}

/** The one-time move of a legacy pairing into the vault (the prompt); success unlocks natively with it. */
async function migrateLegacy(s: LegacyPairing, texts: PromptTexts): Promise<{ ok: boolean; reason?: StoreFailure }> {
  if (!(await allowedServer(s))) return { ok: false, reason: 'wrong-host' };
  try {
    const r = await vault().store({ ...texts, value: JSON.stringify({ url: s.url, token: s.token, deviceName: s.deviceName }) });
    if (!r.ok) return { ok: false, reason: r.reason ?? 'failed' };
  } catch {
    return { ok: false, reason: 'failed' };
  }
  await removeLegacy();
  return { ok: true };
}

/** Relock: the native session (the decrypted pairing) leaves memory. Never throws. */
export async function lockVault(): Promise<void> {
  if (!isNative) return;
  await vault()
    .lock()
    .catch(() => undefined);
}

/** One hub API call through the vault (native adds the token). Rejects like the plugin: code locked / invalid / network. */
export function vaultRequest(o: VaultRequest): Promise<VaultAnswer> {
  return vault().request(o);
}

/** Redeem a pairing code natively; the token never comes back to JS. */
export function vaultPair(o: { url: string; code: string; name: string }): Promise<VaultPairAnswer> {
  return vault().pair(o);
}

export interface UnlockTexts {
  title: string;
  subtitle?: string;
  /** The one-time prompt that moves a legacy pairing into the vault. */
  migrateSubtitle?: string;
}

export type UnlockResult = { server: PairedServer } | { reason: LoadFailure };

/**
 * Unlock: prompt, and native code decrypts the pairing into its own memory; JS gets {url, deviceName} only.
 * A legacy pairing with no vault secret is moved into the vault first (that store is the prompt), then deleted.
 */
export async function unlockServer(texts: UnlockTexts): Promise<UnlockResult> {
  const st = await vaultStatus();
  if (!st) return { reason: 'failed' };
  if (!st.deviceSecure) return { reason: 'no-lock' };
  if (!st.hasSecret) {
    const legacy = await legacyServer();
    if (!legacy) return { reason: 'none' };
    // a pairing to a host this build does not pin is never moved into the vault or used (P1-10)
    if (!(await allowedServer(legacy))) return { reason: 'wrong-host' };
    const saved = await migrateLegacy(legacy, prompt(texts.title, texts.migrateSubtitle ?? texts.subtitle));
    if (!saved.ok) return { reason: saved.reason ?? 'failed' };
    return { server: { url: legacy.url, deviceName: legacy.deviceName } };
  }
  let r: Awaited<ReturnType<FincVaultPlugin['load']>>;
  try {
    r = await vault().load(prompt(texts.title, texts.subtitle));
  } catch {
    return { reason: 'failed' };
  }
  if (!r || r.ok !== true) return { reason: r?.reason ?? 'failed' };
  if (typeof r.url !== 'string' || !r.url) {
    await lockVault();
    return { reason: 'failed' };
  }
  const server: PairedServer = { url: r.url, deviceName: typeof r.deviceName === 'string' && r.deviceName ? r.deviceName : 'phone' };
  // paired before P1-10 with a host this build does not pin (native refuses it as well): not used, and relocked
  if (!(await allowedServer(server))) {
    await lockVault();
    return { reason: 'wrong-host' };
  }
  void removeLegacy(); // a copy left behind by an interrupted migration
  void registerPush(); // push alerts: the phone (re)registers on every unlock; a build without Firebase just says so
  return { server };
}

/** Registers for push alerts (native does it all; a failure only means no push). */
export async function registerPush(): Promise<boolean> {
  try {
    return (await vault().pushRegister()).ok === true;
  } catch {
    return false;
  }
}

/** The path a tapped push notification asked for ("/alerts" or "/alerts?otp=…"), once; null otherwise. */
export async function takeLaunchPath(): Promise<string | null> {
  if (!isNative) return null;
  try {
    const p = (await vault().takeLaunchPath()).path;
    return typeof p === 'string' && /^\/alerts(\?otp=[A-Za-z0-9_-]{1,64})?$/.test(p) ? p : null;
  } catch {
    return null;
  }
}

/** Opens an SEC link in the phone's browser through the vault plugin (native checks the URL again). */
export async function openExternalNative(url: string): Promise<boolean> {
  try {
    await vault().openExternal({ url });
    return true;
  } catch {
    return false;
  }
}

/** Opens Google's code scanner (no camera permission needed) and returns the QR text, or null if cancelled. */
export async function scanQr(): Promise<string | null> {
  const { BarcodeScanner, BarcodeFormat } = await import('@capacitor-mlkit/barcode-scanning');
  const { available } = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable();
  if (!available) await BarcodeScanner.installGoogleBarcodeScannerModule();
  const r = await BarcodeScanner.scan({ formats: [BarcodeFormat.QrCode] });
  return r.barcodes[0]?.rawValue ?? null;
}

/** The QR carries `https://hub/pair?code=…`; a typed code may come alone. */
export function parsePairingText(text: string, fallbackUrl?: string): { url: string; code: string } | null {
  const t = text.trim();
  if (!t) return null;
  try {
    const u = new URL(t);
    const code = u.searchParams.get('code') ?? u.hash.replace(/^#code=/, '');
    if (code && code.length >= 8) return { url: u.origin, code };
  } catch {
    /* not a url */
  }
  if (/^[A-Za-z0-9_-]{8,64}$/.test(t) && fallbackUrl) return { url: fallbackUrl.replace(/\/+$/, ''), code: t };
  return null;
}

export function onAppState(fn: (active: boolean) => void): () => void {
  if (!isNative) return () => undefined;
  let handle: { remove(): Promise<void> } | null = null;
  void import('@capacitor/app').then(({ App }) => App.addListener('appStateChange', (s) => fn(s.isActive))).then((h) => (handle = h));
  return () => void handle?.remove();
}

/** finc://pair?code=… opened from a camera app or the hub's /pair page. */
export function onAppUrl(fn: (url: string) => void): () => void {
  if (!isNative) return () => undefined;
  let handle: { remove(): Promise<void> } | null = null;
  void import('@capacitor/app')
    .then(async ({ App }) => {
      const launch = await App.getLaunchUrl().catch(() => null);
      if (launch?.url) fn(launch.url);
      return App.addListener('appUrlOpen', (e) => fn(e.url));
    })
    .then((h) => (handle = h));
  return () => void handle?.remove();
}

/** The phone's model name from the WebView's user agent, so the paired device gets a recognisable name. */
export function deviceModel(): string {
  const m = navigator.userAgent.match(/;\s*([^;)]+?)\s+Build\//);
  return m?.[1]?.trim() || 'Android';
}
