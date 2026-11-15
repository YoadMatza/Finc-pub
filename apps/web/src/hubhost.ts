/**
 * Which hub the Android app may talk to (security research P1-10). The release APK pins the public key of ONE host,
 * its own hub (Gradle property fincPublicHost, BuildConfig.FINC_PUBLIC_HOST). A hub URL for any other host would get
 * no pin, so a release app refuses it: when pairing, and when it finds such a pairing in its vault. Debug builds may
 * pair with other hosts (still https only). The browser (PWA) never uses this: it talks to its own origin.
 */

export interface HubPolicy {
  /** The one host the app was built for, lower case; null when the native side could not say (then nothing passes). */
  host: string | null;
  /** true in a release build: the host must match. false in a debug build: any https host. */
  enforce: boolean;
}

export type HubCheck = { ok: true; origin: string } | { ok: false; reason: 'invalid' | 'https' | 'host' };

/** Fail closed: no plugin answer means no host is acceptable. */
export const CLOSED_POLICY: HubPolicy = { host: null, enforce: true };

/** Lower case, and at most ONE trailing dot removed ("host." is the same name; "host.." is not, and is refused). */
export function normalHost(h: string): string {
  const s = h.toLowerCase();
  return s.endsWith('.') ? s.slice(0, -1) : s;
}

/**
 * The hub URL must be https, carry no user:password, and (release) name exactly the built-in host. Any port on that
 * host is fine (the hub listens on 7443). Returns the origin to use: in a release build it is built from the pinned
 * host and the URL's port, never echoed from what the user (or a QR, or a link) supplied.
 */
export function checkHubUrl(url: string, policy: HubPolicy): HubCheck {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (u.protocol !== 'https:') return { ok: false, reason: 'https' };
  if (u.username || u.password || !u.hostname) return { ok: false, reason: 'invalid' };
  if (policy.enforce) {
    const want = policy.host ? normalHost(policy.host) : '';
    if (!want || want.endsWith('.') || normalHost(u.hostname) !== want) return { ok: false, reason: 'host' };
    return { ok: true, origin: `https://${want}${u.port ? `:${u.port}` : ''}` };
  }
  return { ok: true, origin: u.origin };
}

/**
 * After a pairing code is redeemed at `checkedOrigin`, the hub names its public address (`url` in the answer). It is
 * kept only if it passes the same check; otherwise the checked origin stays (security research P2-05). In a release
 * build that means the host can never change (the origin is rebuilt from the pinned host), only the port.
 */
export function pairedOrigin(returnedUrl: string, checkedOrigin: string, policy: HubPolicy): string {
  const back = checkHubUrl(returnedUrl, policy);
  return back.ok ? back.origin : checkedOrigin;
}
