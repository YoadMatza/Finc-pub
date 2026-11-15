/**
 * TLS key watchdog (security research P1-10). The Android app pins the hub's TLS public key (the live key and an
 * offline backup key). Caddy keeps its key on renewal (reuse_private_keys), but if the key the LOCAL Caddy serves ever
 * drifts (a wiped volume, a config change, an issuer or key-type change) every phone stops connecting; this catches
 * that before the owner finds out from a dead app, and also a certificate that is failing to renew.
 *
 * What it does NOT see: a hijacked public DNS name (P1-10's attack). The impostor's server is elsewhere; the local
 * Caddy keeps serving the pinned key throughout, so this check stays ok. The phone's pin is what stops that attack.
 *
 * Every 6 hours (and once a minute after start) the worker opens a TLS connection to Caddy on the internal network,
 * verifies the chain as any client would, hashes the leaf's public key (base64 SHA-256 of the SPKI DER, the same pin
 * the phone checks) and compares it with FINC_TLS_PINS. A bad result goes out through the security alert path (the
 * alarm bot, data/alarm-bot.json, so it works while the vault is locked). Pins never reach a message or a log line in
 * full: only their first 8 characters.
 */
import { createHash, type X509Certificate } from 'node:crypto';
import tls from 'node:tls';
import { log } from './logger.js';

export type TlsProbeState = 'ok' | 'key_changed' | 'cert_invalid' | 'unreachable';
export type TlsState = TlsProbeState | 'disabled';

export interface TlsConfig {
  /** where to connect (Caddy on the compose network) */
  host: string;
  port: number;
  /** SNI and the name the certificate must carry: the public host name */
  servername: string;
  /** base64 SHA-256 SPKI hashes the phone app pins */
  pins: string[];
}

export interface TlsProbe {
  state: TlsProbeState;
  /** the served key's pin (full; kept in memory only, never logged or sent) */
  servedPin: string | null;
  daysLeft: number | null;
  /** a short reason: an error code, never a pin */
  reason: string | null;
}

/** What /health shows (authenticated callers only). */
export interface TlsStatus {
  state: TlsState;
  checkedAt: string | null;
  daysLeft: number | null;
  servedPinPrefix: string | null;
}

export const PIN_PREFIX_LEN = 8;
/** Warn when less than this share of the certificate's lifetime is left (Caddy renews at 1/3: a 90-day cert warns at
 * 15 days, a 45-day one at 7.5). */
export const EXPIRY_WARN_FRACTION = 1 / 6;
export const UNREACHABLE_ALERT_AFTER = 3;
export const REMIND_EVERY_MS = 24 * 60 * 60 * 1000;
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
export const FIRST_CHECK_MS = 60 * 1000;
export const PROBE_TIMEOUT_MS = 10_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Accepts plain base64 (Android network_security_config) or OkHttp's `sha256/` form. */
export const normalizePin = (pin: string): string => pin.trim().replace(/^sha256\//i, '');

export const pinPrefix = (pin: string | null | undefined): string | null => (pin ? `${pin.slice(0, PIN_PREFIX_LEN)}…` : null);

/** The pin of a certificate: base64 SHA-256 of its SubjectPublicKeyInfo (DER). */
export function spkiPin(cert: X509Certificate): string {
  const der = cert.publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('base64');
}

/** True when less than 1/6 of the certificate's lifetime is left (renewal should have happened at 1/3). */
export function expiringSoon(validFrom: number, validTo: number, now: number): boolean {
  const lifetime = validTo - validFrom;
  return validTo - now < lifetime * EXPIRY_WARN_FRACTION;
}

/** null (disabled) when FINC_TLS_PINS or FINC_PUBLIC_HOST is empty. */
export function tlsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TlsConfig | null {
  const servername = (env.FINC_PUBLIC_HOST ?? '').trim();
  const pins = (env.FINC_TLS_PINS ?? '').split(',').map(normalizePin).filter(Boolean);
  if (!servername || pins.length === 0) return null;
  // a typo'd pin would raise a daily false "possible attack" alarm: any malformed pin disables the watch instead
  if (pins.some((p) => !PIN_FORMAT.test(p))) return null;
  const port = Number(env.FINC_PUBLIC_PORT || '7443');
  return { host: (env.FINC_TLS_CHECK_HOST ?? '').trim() || 'caddy', port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 7443, servername, pins };
}

/** base64 of a 32-byte SHA-256 digest */
const PIN_FORMAT = /^[A-Za-z0-9+/]{43}=$/;

/** Node's certificate verification failures (as opposed to a refused or dropped connection). */
const CERT_ERROR = /^(ERR_TLS_CERT_|CERT_|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|INVALID_CA$|INVALID_PURPOSE$|PATH_LENGTH_EXCEEDED$|HOSTNAME_MISMATCH$|ERR_SSL_.*CERTIFICATE|ERR_SSL_.*ALERT)/;

export interface ProbeOptions {
  /** extra trusted CA (tests); production uses the system store */
  ca?: string | Buffer;
  timeoutMs?: number;
  /** clock for daysLeft (tests) */
  now?: () => number;
}

/** One check. Never throws. */
export function probeTls(cfg: TlsConfig, opts: ProbeOptions = {}): Promise<TlsProbe> {
  const now = opts.now ?? Date.now;
  return new Promise((resolve) => {
    let done = false;
    const finish = (p: TlsProbe): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(p);
    };
    const socket = tls.connect({
      host: cfg.host,
      port: cfg.port,
      servername: cfg.servername,
      rejectUnauthorized: true,
      ...(opts.ca ? { ca: opts.ca } : {}),
    });
    const timer = setTimeout(() => finish({ state: 'unreachable', servedPin: null, daysLeft: null, reason: 'timeout' }), opts.timeoutMs ?? PROBE_TIMEOUT_MS);
    timer.unref();
    socket.once('secureConnect', () => {
      try {
        const cert = socket.getPeerX509Certificate();
        if (!cert) return finish({ state: 'cert_invalid', servedPin: null, daysLeft: null, reason: 'no certificate' });
        const servedPin = spkiPin(cert);
        const daysLeft = Math.floor((Date.parse(cert.validTo) - now()) / DAY_MS);
        if (!cfg.pins.includes(servedPin)) return finish({ state: 'key_changed', servedPin, daysLeft, reason: 'key not pinned' });
        if (expiringSoon(Date.parse(cert.validFrom), Date.parse(cert.validTo), now())) return finish({ state: 'cert_invalid', servedPin, daysLeft, reason: 'expires soon' });
        finish({ state: 'ok', servedPin, daysLeft, reason: null });
      } catch (e) {
        finish({ state: 'cert_invalid', servedPin: null, daysLeft: null, reason: e instanceof Error ? e.name : 'error' });
      }
    });
    // on, not once: a second error after the first must not become an uncaught exception (finish() runs once)
    socket.on('error', (e: NodeJS.ErrnoException) => {
      const code = typeof e.code === 'string' ? e.code : 'error';
      finish({ state: CERT_ERROR.test(code) ? 'cert_invalid' : 'unreachable', servedPin: null, daysLeft: null, reason: code });
    });
  });
}

// --- the alert state machine (pure)

export interface WatchMemory {
  /** the state the alerts are about (an unreachable streak below the threshold does not change it) */
  state: TlsProbeState | null;
  /** when the last bad-state alert went out (null: none in this episode) */
  lastAlertAt: number | null;
  unreachableStreak: number;
}

export const initialMemory = (): WatchMemory => ({ state: null, lastAlertAt: null, unreachableStreak: 0 });

export type AlertKind = { kind: 'bad'; state: Exclude<TlsProbeState, 'ok'>; reminder: boolean } | { kind: 'recovered' };

/**
 * Alert on entering a bad state (or moving to another bad state), again at most once per 24 h while it lasts, and once
 * "recovered" when it is ok again after an alert. Unreachable counts only after 3 failures in a row (Caddy restarts).
 */
export function decide(mem: WatchMemory, probe: Pick<TlsProbe, 'state'>, now: number): { mem: WatchMemory; alert: AlertKind | null } {
  let state: TlsProbeState = probe.state;
  let streak = 0;
  if (probe.state === 'unreachable') {
    streak = mem.unreachableStreak + 1;
    if (streak < UNREACHABLE_ALERT_AFTER) return { mem: { ...mem, unreachableStreak: streak }, alert: null };
    state = 'unreachable';
  }
  if (state === 'ok') {
    const alert: AlertKind | null = mem.lastAlertAt !== null ? { kind: 'recovered' } : null;
    return { mem: { state: 'ok', lastAlertAt: null, unreachableStreak: 0 }, alert };
  }
  const entering = mem.state !== state || mem.lastAlertAt === null;
  if (entering || now - (mem.lastAlertAt ?? 0) >= REMIND_EVERY_MS) {
    return { mem: { state, lastAlertAt: now, unreachableStreak: streak }, alert: { kind: 'bad', state, reminder: !entering } };
  }
  return { mem: { ...mem, state, unreachableStreak: streak }, alert: null };
}

/**
 * After the send: a delivered alert keeps what decide() recorded; an undelivered one is rolled back (the state and the
 * last-alert time it was about), so the next check sends it again instead of waiting 24 h. The unreachable streak stays.
 */
export function settle(prev: WatchMemory, next: WatchMemory, delivered: boolean): WatchMemory {
  return delivered ? next : { ...next, state: prev.state, lastAlertAt: prev.lastAlertAt };
}

// --- messages

export function alertText(alert: AlertKind, probe: TlsProbe, cfg: Pick<TlsConfig, 'host' | 'port' | 'pins'>, he: boolean): string {
  const see = he ? 'מה לעשות: ראה README, Phone pinning.' : 'What to do: see README: Phone pinning.';
  const again = alert.kind === 'bad' && alert.reminder ? (he ? ' (עדיין)' : ' (still)') : '';
  // a reason is a short code (ECONNREFUSED, 'expires soon'); anything else is left out of the message (P2-09)
  const reason = probe.reason && /^[A-Za-z0-9_ .-]{1,40}$/.test(probe.reason) ? ` (${probe.reason})` : '';
  if (alert.kind === 'recovered') {
    return he
      ? `finc: מפתח ה-TLS של השרת שוב תקין ומוצמד${probe.daysLeft !== null ? ` (התעודה בתוקף עוד ${probe.daysLeft} ימים)` : ''}; אפליקציית הטלפון יכולה להתחבר.`
      : `finc: the hub's TLS key is the pinned one again${probe.daysLeft !== null ? ` (certificate valid for ${probe.daysLeft} more days)` : ''}; the phone app can connect.`;
  }
  const served = pinPrefix(probe.servedPin) ?? '?';
  switch (alert.state) {
    case 'key_changed':
      return he
        ? `finc${again}: השרת מציג מפתח TLS שאינו מוצמד (מפתח ${served}, לא אחד מ-${cfg.pins.length} המפתחות המוצמדים). אפליקציית הטלפון תסרב להתחבר. אם לא החלפת את המפתח בכוונה, זה עלול להיות סימן לתקיפה. ${see}`
        : `finc${again}: the hub is serving a TLS key that is not pinned (key ${served}, not one of the ${cfg.pins.length} pinned keys). The phone app will refuse to connect. If you did not change the key on purpose, treat this as a possible attack. ${see}`;
    case 'cert_invalid':
      if (probe.daysLeft !== null && probe.reason === 'expires soon') {
        return he
          ? `finc${again}: תעודת ה-TLS של השרת פגה בעוד ${probe.daysLeft} ימים ולא חודשה. כשתפוג, אפליקציית הטלפון תסרב להתחבר. בדוק את הלוג של Caddy (docker compose logs caddy). ${see}`
          : `finc${again}: the hub's TLS certificate expires in ${probe.daysLeft} days and was not renewed. Once it expires, the phone app will refuse to connect. Check Caddy's log (docker compose logs caddy). ${see}`;
      }
      return he
        ? `finc${again}: תעודת ה-TLS של השרת נכשלה באימות${reason}. אפליקציית הטלפון תסרב להתחבר. ${see}`
        : `finc${again}: the hub's TLS certificate failed verification${reason}. The phone app will refuse to connect. ${see}`;
    case 'unreachable':
      return he
        ? `finc${again}: ה-worker לא מצליח להגיע לבדיקת ה-TLS של השרת ב-${UNREACHABLE_ALERT_AFTER} בדיקות ברצף${reason}. אם Caddy למטה, גם אפליקציית הטלפון לא תתחבר. בדוק docker compose ps ו-docker compose logs caddy. ${see}`
        : `finc${again}: the hub's TLS check cannot reach the hub in ${UNREACHABLE_ALERT_AFTER} checks in a row${reason}. If Caddy is down, the phone app cannot connect either. Check docker compose ps and docker compose logs caddy. ${see}`;
  }
}

// --- the watcher

export interface TlsWatchDeps {
  /** sends one security alert (the alarm bot path): true when it was delivered; a rejection counts as not delivered */
  send: (text: string) => Promise<boolean>;
  /** true for Hebrew messages */
  hebrew: () => boolean;
  /** the security log (P1-08): called once per change of the watched state (an unreachable streak below the threshold is not one) */
  record?: (change: { from: TlsProbeState | null; to: TlsProbeState; reason: string | null }) => void;
  probe?: (cfg: TlsConfig) => Promise<TlsProbe>;
  now?: () => number;
  firstCheckMs?: number;
  intervalMs?: number;
}

export class TlsWatch {
  private mem = initialMemory();
  /** the state last written to the security log */
  private recorded: TlsProbeState | null = null;
  private last: { probe: TlsProbe; at: number } | null = null;
  private first: NodeJS.Timeout | null = null;
  private every: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly cfg: TlsConfig | null,
    private readonly deps: TlsWatchDeps,
  ) {}

  start(): void {
    if (!this.cfg) {
      log.info('tls watch: disabled (FINC_TLS_PINS or FINC_PUBLIC_HOST is empty)');
      return;
    }
    log.info({ host: this.cfg.host, port: this.cfg.port, pins: this.cfg.pins.map(pinPrefix) }, 'tls watch: started');
    this.stopped = false;
    // timers are unref'd: the watchdog never keeps the process alive on shutdown
    this.first = setTimeout(() => void this.check(), this.deps.firstCheckMs ?? FIRST_CHECK_MS);
    this.first.unref();
    this.every = setInterval(() => void this.check(), this.deps.intervalMs ?? CHECK_EVERY_MS);
    this.every.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.first) clearTimeout(this.first);
    if (this.every) clearInterval(this.every);
    this.first = this.every = null;
  }

  /** The last check (null before the first one). */
  status(): TlsStatus | null {
    if (!this.cfg) return { state: 'disabled', checkedAt: null, daysLeft: null, servedPinPrefix: null };
    if (!this.last) return null;
    return { state: this.last.probe.state, checkedAt: new Date(this.last.at).toISOString(), daysLeft: this.last.probe.daysLeft, servedPinPrefix: pinPrefix(this.last.probe.servedPin) };
  }

  /** One check now (the timers call this). Never throws. */
  async check(): Promise<TlsProbe | null> {
    const cfg = this.cfg;
    if (!cfg || this.running || this.stopped) return null;
    this.running = true;
    try {
      const probe = await (this.deps.probe ?? probeTls)(cfg);
      if (this.stopped) return probe;
      const now = (this.deps.now ?? Date.now)();
      this.last = { probe, at: now };
      const prev = this.mem;
      const { mem, alert } = decide(prev, probe, now);
      this.mem = mem;
      if (mem.state !== null && mem.state !== this.recorded) {
        const from = this.recorded;
        this.recorded = mem.state;
        try {
          this.deps.record?.({ from, to: mem.state, reason: probe.reason });
        } catch (e) {
          log.warn({ err: e instanceof Error ? e.message : String(e) }, 'tls watch: the security log write failed');
        }
      }
      const fields = { state: probe.state, daysLeft: probe.daysLeft, served: pinPrefix(probe.servedPin), reason: probe.reason };
      if (probe.state === 'ok') log.info(fields, 'tls watch: ok');
      else log.warn(fields, 'tls watch: problem');
      if (alert) {
        const text = alertText(alert, probe, cfg, this.deps.hebrew());
        log.warn({ text }, 'security');
        const delivered = await this.deps.send(text).catch(() => false);
        if (!this.stopped) this.mem = settle(prev, mem, delivered === true);
        if (!delivered) log.warn({ state: probe.state }, 'tls watch: the alert was not delivered; retrying at the next check');
      }
      return probe;
    } catch (e) {
      log.error({ err: e instanceof Error ? e.message : String(e) }, 'tls watch: check failed');
      return null;
    } finally {
      this.running = false;
    }
  }
}
