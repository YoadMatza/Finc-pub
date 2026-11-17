/**
 * The hub's JSON API (and the control endpoints the CLI uses), one Hono app.
 *
 *   /api/auth/*                 PIN setup / login / logout / status (no session needed; PIN only from trusted networks)
 *   /api/devices/pair           the phone redeems a pairing code for a device token (public, rate limited)
 *   /api/auth/passkey/*         passkey enrolment (link made at home) and sign-in (public; a 12-hour session)
 *   /api/...                    everything else needs a session cookie or the control token
 *   /health /runs /unlock       the pre-Phase-4 control endpoints, kept for `finc health|unlock|sync`
 *   /alarm                      the alarm bot (P1-05), control token from home only: `finc alerts alarm ...`
 *   /lock /sync                 (control token or session)
 *   /api/panic                  "lock everything" (P1-09): any signed-in caller, body {confirm: "LOCK"}
 *   /*                          the built web app, SPA fallback
 *
 * Nothing here reads secrets from the request except the vault password on /unlock, which goes
 * straight into Vault.open and is never logged.
 */
import {
  AI_DEFAULTS,
  AiError,
  CHAT_MODELS,
  chatModelAllowed,
  chatModelOf,
  FINC_VERSION,
  PINNED,
  Vault,
  VaultError,
  OFFSITE_SETTINGS,
  accountsOverview,
  accountLiveHoldings,
  emptyPriceCache,
  alertConfig,
  authenticateDevice,
  deviceTokenStatus,
  deviceIdleDays,
  setDeviceIdleDays,
  revokeAllDevices,
  MCP_PER_DAY,
  createMcpToken,
  CIMD_ALLOWED,
  OAUTH_SCOPE,
  OAuthCodes,
  REQUEST_TTL_MS,
  acceptClientMetadata,
  appForRedirect,
  closeConnectWindow,
  connectWindowUntil,
  createGrant,
  getOAuthClient,
  listGrants,
  mcpRemoteEnabled,
  openConnectWindow,
  refreshGrant,
  registerOAuthClient,
  revokeAllGrants,
  revokeGrant,
  setMcpRemoteEnabled,
  useAccessToken,
  validChallenge,
  type OAuthClient,
  MCP_PER_MINUTE,
  listMcpTokens,
  mcpEnabled,
  mcpToolList,
  MCP_INSTRUCTIONS,
  revokeAllMcpTokens,
  revokeMcpToken,
  runMcpTool,
  setMcpEnabled,
  useMcpToken,
  revokeAllPasskeys,
  categoriesOverview,
  connectionHealth,
  decideLink,
  deleteRule,
  dismissInsight,
  forecastAccuracy,
  forecastChange,
  getAiSettings,
  getSetting,
  getLimits,
  SCRAPED_INSTITUTIONS,
  setLimits,
  checkOutsideSync,
  recordOutsideSync,
  RateCounter,
  LIMIT_RANGES,
  hubOverview,
  holdingsOverview,
  type InsightsRow,
  HoldingRuleError,
  TEMPLATE_IDS,
  createHoldingRule,
  deleteHoldingRule,
  getHoldingRule,
  heldSymbols,
  listHoldingRules,
  normSymbol,
  PORTFOLIO_DEFINITION,
  rulesApplyingBySymbol,
  templateList,
  updateHoldingRule,
  validateParams,
  trendsOverview,
  yearlyReport,
  todayLocal,
  listEvents,
  createEvent,
  eventView,
  updateEvent,
  deleteEvent,
  setEventTxns,
  netWorthOverview,
  chat,
  createProvider,
  MANUAL_KINDS,
  createManual,
  updateManual,
  setManualValue,
  deleteManual,
  inQuietHours,
  isDeviceToken,
  isTrustedAddress,
  listDevices,
  listRules,
  listTransactions,
  markTransfer,
  pinIsSet,
  pinStamp,
  recentRuns,
  recentAlerts,
  recurringOverview,
  billCalendar,
  setSplit,
  signalsBoard,
  selectHeadlines,
  newsFacts,
  newsSummaryPrompt,
  checkNewsSummary,
  readMarketCache,
  writeMarketCache,
  type NewsHeadline,
  type NewsTone,
  removeSplit,
  SplitError,
  SPLIT_MAX_PARTS,
  registerDevice,
  renameDevice,
  resolveCategory,
  revokeDevice,
  reviewInbox,
  runEngine,
  setCategory,
  setAlertConfig,
  setExcluded,
  setGroupTarget,
  setNote,
  IncomeKindError,
  incomeKinds,
  LimitError,
  checkSpendLimit,
  cleanErrorText,
  getSpendLimit,
  setSpendLimit,
  currentMonth as limitMonthNow,
  setIncomeKinds,
  setSpreadExtra,
  setIncomeKindOverride,
  incomeKindAllowed,
  answerPaidBack,
  PaidBackError,
  setPin,
  setRuleEnabled,
  setSetting,
  setStreamState,
  telegramFindChatByCode,
  telegramMe,
  telegramSend,
  transactionDetail,
  updateCategory,
  weeklySummaryText,
  validatePin,
  vaultPath,
  verifyPin,
  activePasskeys,
  addPasskey,
  findPasskey,
  listPasskeys,
  revokePasskey,
  touchPasskey,
  listSecurityEvents,
  recordSecurityEvent,
  type SecurityEventInput,
} from '@finc/core';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { DeviceView } from '@finc/core';
import { getConnInfo } from '@hono/node-server/conninfo';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { ScrapedInstitutionId } from '../connectors/scrape.js';
import { AlarmSetupError, readAlarmBot, removeAlarmBot, setupAlarmBot } from '../alarm.js';
import { canSendSecurityAlerts, runDispatch, securityAlert, securityAlertStatus, sendSecurityAlert, telegramToken } from '../alerts.js';
import { BackupBusyError, BackupLockedError } from '../backup.js';
import { type PanicResult, runPanic } from '../lockdown.js';
import { log } from '../logger.js';
import { HostKeyChangedError, NAS_ENTRY, OffsiteBusyError, OffsiteLockedError, OffsiteNotConfiguredError, OffsiteSetup, OffsiteSetupError, type OffsiteStatus, type SetupDeps } from '../offsite.js';
import { rulesForPanel } from '../holding-rules.js';
import { buildPanel, withinMs } from '../insights-panel.js';
import type { WorkerState } from '../server.js';
import { ChatMemory } from './chat-memory.js';
import { Attempts, BUSY, LockedFailures, OneAtATime, Pairings, PinGuard, type SessionEntry, Sessions, tokenMatches } from './auth.js';
import { McpBridge } from '../mcp/bridge.js';
import { EnrolmentCodes, LoginChallenges, passkeyNameFromAgent, passkeyRp, passkeyUserId, realWebAuthn, type WebAuthnFns } from './passkeys.js';
import { defaultWebDist, serveStatic } from './static.js';

const COOKIE = 'finc_session';
/** P2-02 review: what one chat request from outside may carry */
/** decision aids C: the summary's on/off setting, its cache (market_data_cache source), freshness and wait */
export const NEWS_SUMMARY_SETTING = 'ai.newsSummary';
export const NEWS_AI_SOURCE = 'ai-news';
export const NEWS_SUMMARY_TTL_MS = 12 * 60 * 60 * 1000;
export const NEWS_TONES_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const NEWS_SUMMARY_DEADLINE_MS = 45_000;
const LATE_ANSWER = '\u0000late';
export const CHAT_OUTSIDE_MESSAGES = 12;
/** From outside the home network, earlier lookups carried into one question: at most this many characters (P2-02). */
export const CHAT_OUTSIDE_LOOKUP_CHARS = 8_000;
/** The web's id for one conversation (chat v2 lookup memory): 8–64 of [A-Za-z0-9_-]. */
const CHAT_ID = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
export const CHAT_OUTSIDE_CHARS = 2000;
/** stock insights: panel opens an hour per outside actor */
export const INSIGHTS_OUTSIDE_PER_HOUR = 60;
/** the owner's holding rules: edits (create, change, delete) an hour per outside actor */
export const HOLDING_RULES_OUTSIDE_PER_HOUR = 30;
/** paid-back answers (they can write counterparty rules) per hour from a phone or the internet; home is not limited */
export const PAID_BACK_OUTSIDE_PER_HOUR = 30;
/** how long a rule edit waits for the evaluation of the symbols it covers (the panel's own deadline) */
export const RULES_EDIT_WAIT_MS = 8000;

/**
 * Request bodies (security research P2-12): anything larger is refused with 413 before a route reads it, so one huge
 * body to the public /api/devices/pair cannot exhaust memory, restart the worker and lock the vault. The largest
 * legitimate bodies are a passkey registration response (attestation + certificate chain, a few KB to ~20 KB), the
 * vault password, settings/alerts/rules patches and tag lists (500 ids): all far under 256 KiB.
 */
export const BODY_LIMIT = 256 * 1024;
/**
 * POST /api/chat sends the whole conversation: up to 40 messages of 4000 characters, which is ~480 KB of UTF-8 when the
 * text is three-byte characters (Hebrew is two, ₪ three) plus JSON escapes. It gets 1 MiB, still nothing for memory.
 */
export const CHAT_BODY_LIMIT = 1024 * 1024;
const BODY_LIMITS: Record<string, number> = { '/api/chat': CHAT_BODY_LIMIT };

/** Who did something, for the security log (P1-08). */
export type SecurityActor = Pick<SecurityEventInput, 'actor' | 'actorName' | 'address'>;
/** The panic switch; `actor` is recorded in the security log (default 'system'). */
export type PanicFn = (who: string, actor?: SecurityActor) => Promise<PanicResult>;

export interface ApiOptions {
  controlToken: string;
  webDist?: string;
  /** The WebAuthn library calls; tests replace them (there is no authenticator in a test). */
  webauthn?: Partial<WebAuthnFns>;
  /** The clock for sessions, enrolment codes and sign-in challenges; tests move it forward. */
  now?: () => number;
  /** Fetches an allow-listed OAuth client metadata document (remote MCP); tests pass a fake. */
  oauthFetch?: typeof fetch;
  /** The NAS pairing's probe, key generation and connection; tests point them at a local fake SFTP server. */
  offsite?: Partial<SetupDeps>;
  /** Extra host names to answer to, on top of the PC's own, FINC_PUBLIC_HOST/FINC_ALLOWED_HOSTS and the public URL's. */
  allowedHosts?: string[];
  /**
   * Pauses the alarm bot's Telegram poller (P1-09) while the alarm bot is set up or removed; returns the resume
   * function. getUpdates has one consumer per bot, so nothing else may read that bot's updates while it polls.
   */
  alarmPause?: () => () => void;
  /** Whether /lockdown on the alarm bot is live (configured, bound, poller running); for GET /api/settings. */
  lockdownTelegram?: () => boolean;
  /** The PIN check and the vault open (both slow); tests replace them to run a panic in the middle. */
  verifyPin?: typeof verifyPin;
  openVault?: (file: string, password: string) => Promise<Vault>;
  /** The chat's model provider; tests pass a scripted one (default: createProvider). */
  chatProvider?: typeof createProvider;
}

type Auth = 'session' | 'passkey' | 'token' | 'device' | 'none';

/** Origins the Android app's WebView uses; cookies are never sent cross-origin, only device tokens. */
const APP_ORIGINS = ['https://localhost', 'capacitor://localhost']; // the Android WebView; plain http://localhost dropped (audit L3)
const LOOPBACK = /^(::1|127\.\d+\.\d+\.\d+|::ffff:127\.\d+\.\d+\.\d+|localhost)$/i;
/**
 * Extra reverse-proxy peers whose X-Forwarded-For / X-Forwarded-Host we believe: a list of addresses (compose names
 * Caddy's fixed one), or `private` for every RFC 1918 peer (the old, looser setting). Read when the app is made.
 */
const trustedProxies = (): string[] => (process.env.FINC_TRUSTED_PROXIES ?? '').split(',').map((s) => s.trim().replace(/^::ffff:/i, '')).filter(Boolean);
const PRIVATE_PEER = /^(::ffff:)?(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/;

/**
 * Host names the worker answers to (security research P1-06/P1-07, DNS rebinding): the PC itself, the public name
 * (FINC_PUBLIC_HOST, which Caddy passes through unchanged), any extra names in FINC_ALLOWED_HOSTS, and the
 * hostname of the configured public URL. A page on evil.example that rebinds its name to 127.0.0.1 still sends
 * Host: evil.example, so it never reaches a route. `worker` (the compose service name) is left out on purpose:
 * only a sibling container would use it, and Caddy keeps the public Host.
 */
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const envHosts = (): string[] => [process.env.FINC_PUBLIC_HOST ?? '', ...(process.env.FINC_ALLOWED_HOSTS ?? '').split(',')].map((s) => hostnameOf(s)).filter(Boolean);
/** A Host value a browser could send: no list, no spaces, no userinfo (review: duplicate Host headers arrive joined by ","). */
const HOST_SHAPE = /^(\[[0-9a-f:.]+\]|[a-z0-9.\-_]+)(:\d{1,5})?$/i;

/** "FINC-EXAMPLE.duckdns.org:7443" → "finc-example.duckdns.org", "[::1]:7733" → "[::1]", "localhost." → "localhost". */
export function hostnameOf(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end < 0 ? h : h.slice(0, end + 1);
  }
  const i = h.indexOf(':');
  return (i >= 0 ? h.slice(0, i) : h).replace(/\.$/, '');
}

/** Drop undefined keys so zod output satisfies exactOptionalPropertyTypes. */
function defined<T extends object>(o: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as never;
}

/** POST /sync on the control port (the CLI). dump / dryRun exist here only, never on the UI's /api/sync (P1-13). */
/**
 * Which institutions a manual sync visits (P2-02 review): known scraped ids only, each at most once, so one allowed
 * sync cannot repeat a bank login hundreds of times. The scheduler also dedupes (syncTargets), for every caller.
 */
const SCRAPED_IDS = SCRAPED_INSTITUTIONS.map((i) => i.id) as [string, ...string[]];
export const syncInstitutions = z.union([
  z.literal('all'),
  z
    .array(z.enum(SCRAPED_IDS))
    .max(SCRAPED_IDS.length)
    .refine((a) => new Set(a).size === a.length, { message: 'each institution at most once' }),
]);

/**
 * An error message fit for the caller (security research P3-03): cleaned like stored errors, and replaced by a plain
 * phrase when it names a file path ("no vault at /data/vault.json"), which is for the worker log only.
 */
export function callerSafe(msg: string, fallback: string): string {
  if (/(^|[\s'"(])(\/[\w.-]+){2,}|\b[A-Za-z]:[\\/]/.test(msg)) return fallback;
  return cleanErrorText(msg, 200) || fallback;
}

/** The worker's answer to a CLI challenge: HMAC-SHA256 keyed by the control token (security research P3-01). */
export function controlProof(token: string, challenge: string): string {
  return createHmac('sha256', token).update(`finc-control:${challenge}`).digest('hex');
}

/** A yes/no query flag: "1"/"true" or "0"/"false" only; coercing made "false" true (security research P3-03). */
export const queryFlag = z.enum(['1', 'true', '0', 'false']).transform((v) => v === '1' || v === 'true');

export const controlSyncBody = z.object({
  institutions: syncInstitutions.optional(),
  months: z.number().int().min(1).max(36).optional(),
  dump: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  /** with dryRun only: also record FIBI portal pages to data/dumps (connector design aid) */
  explore: z.boolean().optional(),
});

export function createApp(state: WorkerState, opts: ApiOptions): { app: Hono; sessions: Sessions; panic: PanicFn } {
  const app = new Hono();
  const now = opts.now ?? Date.now;
  const webauthn: WebAuthnFns = { ...realWebAuthn, ...opts.webauthn };
  // Sessions persist in the settings table (hashed), so a redeploy does not log every browser out.
  const sessions = new Sessions({
    load: () => {
      try {
        return JSON.parse(getSetting(state.db, 'ui.sessions') ?? '{}') as Record<string, SessionEntry>;
      } catch {
        return {};
      }
    },
    save: (entries) => setSetting(state.db, 'ui.sessions', JSON.stringify(entries)),
  }, now);
  const pairings = new Pairings();
  const offsiteSetup = new OffsiteSetup({ now: () => now(), ...opts.offsite });
  const enrolments = new EnrolmentCodes(now);
  const loginChallenges = new LoginChallenges(now);
  /** The pending one-time code that binds the Telegram alert chat (P0-02); in memory, single use. */
  let telegramBinding: { code: string; sinceUnix: number; expires: number } | null = null;
  const pinAttempts = new Attempts();
  const pinGuard = new PinGuard();
  const unlockAttempts = new Attempts();
  /** P1-01: one PIN / master-password check at a time; a global escalating lock and alerts for the master password */
  const passwordGate = new OneAtATime();
  const unlockGuard = new PinGuard();
  const lockedFailures = new LockedFailures();
  const deviceAttempts = new Attempts(20);
  const webDist = opts.webDist ?? defaultWebDist();
  const devicesSeen = new WeakMap<Request, DeviceView>();
  /** Requests whose device token already failed (counted once, however often auth is asked). */
  const deviceFailed = new WeakSet<Request>();
  /** chat v2: the lookups of earlier turns per chat id, in memory only; emptied whenever the vault locks */
  const chatMemory = new ChatMemory(now);
  /**
   * The panic switch (P1-09), for POST /api/panic, `finc panic` and /lockdown on the alarm bot. The main bot's token is
   * read before the vault is locked, so without an alarm bot the main bot can still say that it happened.
   */
  /**
   * Bumped by every panic (independent review 2026-11-11). A sign-in, passkey enrolment or vault unlock that was
   * waiting on a slow check (Argon2, WebAuthn) when the panic ran captured the old value and is refused afterwards,
   * so nothing it would grant survives the lockdown.
   */
  let lockdownGen = 0;
  const lockedDownSince = (gen: number): boolean => gen !== lockdownGen;
  const panic: PanicFn = async (who, actor = { actor: 'system' }) => {
    lockdownGen++;
    let mainToken: string | null = null;
    try {
      mainToken = telegramToken(state.vault);
    } catch {
      // a broken vault must not stop the lockdown
    }
    const r = await runPanic(
      {
        revokeDevices: () => revokeAllDevices(state.db, 'panic'),
        revokePasskeys: () => revokeAllPasskeys(state.db),
        endSessions: () => {
          // codes that would let a new device or passkey in are gone too
          pairings.clear();
          enrolments.clear();
          return sessions.revokeAll();
        },
        lockVault: () => {
          const v = state.vault;
          state.vault = null; // out of the worker first, so a failing lock() still leaves nothing usable behind
          chatMemory.clear();
          v?.lock();
          return true;
        },
        alert: async (text) => (await sendSecurityAlert(state.db, null, text, { retryDelayMs: 1000, mainToken })).ok,
      },
      who,
    );
    // AI apps lose access too (MCP design §5.4); a failure here must not stop the lockdown record
    let mcpTokens = 0;
    try {
      mcpTokens = revokeAllMcpTokens(state.db) + revokeAllGrants(state.db, now());
      closeConnectWindow(state.db);
      // codes and requests still in flight die too, and remote MCP is off until turned on again at home (review 2026-11-17)
      setMcpRemoteEnabled(state.db, false);
      oauthCodes.clear();
      pendingAuth.clear();
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e) }, 'lockdown: revoking MCP tokens failed');
    }
    recordSecurityEvent(state.db, {
      ...actor,
      kind: 'lockdown.run',
      detail: { by: who, ok: r.ok, mcpTokens, devices: r.devices, passkeys: r.passkeys, sessions: r.sessions, vaultLocked: r.vaultLocked, alerted: r.alerted, ...(r.errors ? { errors: r.errors.length } : {}) },
      at: now(),
    });
    return r;
  };

  // --- which name the request was meant for (DNS rebinding, P1-06/P1-07): before every route, the web page included
  const extraHosts = new Set([...LOCAL_HOSTS, ...envHosts(), ...(opts.allowedHosts ?? []).map((h) => hostnameOf(h))]);
  const refusedHosts = new Set<string>();
  let refusedCount = 0;
  const hostAllowed = (raw: string): boolean => {
    if (!HOST_SHAPE.test(raw)) return false;
    const h = hostnameOf(raw);
    if (extraHosts.has(h)) return true;
    const configured = getSetting(state.db, 'ui.publicUrl');
    if (!configured) return false;
    try {
      return new URL(configured).hostname.toLowerCase() === h;
    } catch {
      return false;
    }
  };
  // --- request body size (P2-12): the first middleware, for every route (public API, control routes, the web app).
  // hono's bodyLimit refuses by Content-Length without reading anything; a chunked body is counted while it is read
  // and cut off once it passes the limit (the rest is never buffered). `Connection: close` makes Node drop the socket
  // after the 413 instead of keeping it for another request with half a body still on the wire. A client that is still
  // sending when the socket closes may see a connection reset instead of the 413 (TCP discards the answer); only an
  // oversize body is affected. Anonymous on purpose: nothing about the caller's token is looked at before the body is
  // known to be sane. Aggregated, like the other failures from the internet.
  const tooLarge = (limit: number) => (c: Context): Response => {
    const declared = Number(c.req.header('content-length'));
    recordSecurityEvent(state.db, {
      kind: 'http.body_too_large',
      actor: anonActor(c),
      address: clientAddress(c),
      // never the body: the path, the declared size (absent for a chunked body) and the limit it broke
      detail: { path: c.req.path.slice(0, 80), size: Number.isFinite(declared) && c.req.header('transfer-encoding') === undefined ? declared : null, limit },
      aggregate: true,
      at: now(),
    });
    log.warn({ path: c.req.path.slice(0, 80), limit }, 'api: request body too large');
    return c.json({ error: 'request body too large' }, 413, { connection: 'close' });
  };
  const limiters = new Map<number, ReturnType<typeof bodyLimit>>();
  for (const max of new Set([BODY_LIMIT, ...Object.values(BODY_LIMITS)])) limiters.set(max, bodyLimit({ maxSize: max, onError: tooLarge(max) }));
  app.use('*', (c, next) => limiters.get(BODY_LIMITS[c.req.path] ?? BODY_LIMIT)!(c, next));

  app.use('*', async (c, next) => {
    // Node answers 400 to an HTTP/1.1 request without Host; app.request() in tests has none, its URL says localhost
    const raw = c.req.header('host') ?? new URL(c.req.url).host;
    if (hostAllowed(raw)) return next();
    refusedCount++;
    if (refusedHosts.size < 20 && !refusedHosts.has(raw)) {
      refusedHosts.add(raw);
      log.warn({ host: raw.slice(0, 100), path: c.req.path, refused: refusedCount }, 'api: refused a request for a host name finc does not serve');
    } else if (refusedCount % 100 === 0) {
      log.warn({ refused: refusedCount }, 'api: still refusing requests for host names finc does not serve');
    }
    return c.json({ error: 'wrong host' }, 421);
  });
  // before the write guard, so the Android app gets a readable refusal instead of an opaque network error
  app.use('/api/*', cors({ origin: APP_ORIGINS, allowHeaders: ['authorization', 'content-type'], allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], credentials: false, maxAge: 600 }));
  // No API answer (balances, transactions) may be kept in a browser's or the phone WebView's HTTP disk cache, where
  // it would sit unencrypted outside the app lock (security research P1-11 review). Control routes too.
  const noStore = async (c: Context, next: () => Promise<void>): Promise<void> => {
    await next();
    c.res.headers.set('Cache-Control', 'no-store');
  };
  for (const p of ['/api/*', '/mcp', '/mcp/*', '/oauth/*', '/.well-known/oauth-*', '/health', '/whoami', '/runs', '/unlock', '/lock', '/sync', '/alarm', '/alarm/*']) app.use(p, noStore);
  /**
   * Writes from another site are refused for everyone, signed in or not (review of P1-06/P1-07): a page on evil.example
   * can POST blind to http://127.0.0.1:7733/api/auth/login without rebinding (Host is then allowed) and lock the PIN.
   * A browser always sends Origin on such a request; it must be this host itself or the Android app. Non-browser
   * callers (the CLI, curl) send no Origin. A body must be JSON, so a form or a no-cors text/plain post never parses.
   */
  app.use('*', async (c, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return next();
    const origin = c.req.header('origin');
    const site = c.req.header('sec-fetch-site');
    // the Android WebView talks to the public name only; https://localhost aimed at the PC's own port is some other local page
    const fromApp = origin !== undefined && APP_ORIGINS.includes(origin) && !LOCAL_HOSTS.includes(hostnameOf(requestHost(c)));
    let ok = fromApp || (origin === undefined && (site === undefined || site === 'same-origin' || site === 'none'));
    if (!ok && origin !== undefined && origin !== 'null') {
      try {
        ok = new URL(origin).host.toLowerCase() === requestHost(c).toLowerCase() && (site === undefined || site === 'same-origin' || site === 'none');
      } catch {
        ok = false;
      }
    }
    if (!ok) {
      log.warn({ origin: origin?.slice(0, 100), site, path: c.req.path }, 'api: cross-site write refused');
      return c.json({ error: 'cross-site request refused' }, 403);
    }
    const type = c.req.header('content-type');
    // OAuth's token endpoint takes a form by its standard (RFC 6749 §4.1.3); it reads no cookie, so a cross-site form
    // gains nothing there (remote MCP)
    const formOk = c.req.path === '/oauth/token' && type !== undefined && /^application\/x-www-form-urlencoded\s*(;|$)/i.test(type);
    if (type !== undefined && !formOk && !/^application\/json\s*(;|$)/i.test(type)) return c.json({ error: 'send JSON' }, 415);
    return next();
  });

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    if (err instanceof z.ZodError) return c.json({ error: 'invalid request', issues: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }, 400);
    const msg = err instanceof Error ? err.message : String(err);
    if (/^no /i.test(msg) || / is unknown/.test(msg)) return c.json({ error: callerSafe(msg, 'not found') }, 404);
    if (/ is ambiguous/.test(msg)) return c.json({ error: callerSafe(msg, 'ambiguous request') }, 400);
    // the detail goes to the log only (audit L2): paths, SQL and library internals are not for the caller
    log.error({ err: msg, stack: err instanceof Error ? err.stack : undefined, path: c.req.path }, 'api error');
    return c.json({ error: 'internal error; see the worker log' }, 500);
  });

  // --- where the request comes from
  const peerOf = (c: Context): string | null => {
    try {
      return getConnInfo(c).remote.address ?? null;
    } catch {
      return null; // app.request() in tests has no socket
    }
  };
  const proxies = trustedProxies();
  const trustPrivateProxies = proxies.includes('private');
  /** The TCP peer is Caddy (its fixed address, P1-07), a process inside this container, or a test without a socket. */
  const peerIsProxy = (peer: string | null): boolean =>
    peer === null || LOOPBACK.test(peer) || proxies.includes(peer.replace(/^::ffff:/i, '')) || (trustPrivateProxies && PRIVATE_PEER.test(peer));
  /** The real client: X-Forwarded-For only when the TCP peer is a trusted proxy. */
  const clientAddress = (c: Context): string => {
    const peer = peerOf(c);
    const xff = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (peerIsProxy(peer) && xff) return xff;
    return peer ?? '127.0.0.1';
  };
  /** The host the client asked for: X-Forwarded-Host only from a trusted proxy (review: any caller could set it). */
  const requestHost = (c: Context): string => {
    const xfh = peerIsProxy(peerOf(c)) ? c.req.header('x-forwarded-host')?.split(',')[0]?.trim() : undefined;
    return xfh || c.req.header('host') || '';
  };
  /**
   * Home network or Tailscale, never the internet. Behind Docker Desktop every client arrives with the bridge
   * gateway's address, so the address alone cannot tell; Caddy therefore stamps everything it proxies with
   * X-Finc-Edge: public (security audit 2026-11-09, C1) and such requests are never trusted, whatever
   * address they carry. Trusted traffic is a direct connection to the worker port.
   */
  const trusted = (c: Context): boolean => c.req.header('x-finc-edge') === undefined && isTrustedAddress(clientAddress(c));
  const overHttps = (c: Context): boolean => c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase() === 'https';
  const cookieOpts = (c: Context) => ({ httpOnly: true, sameSite: 'Lax' as const, path: '/', maxAge: 30 * 86_400, secure: overHttps(c) });
  const clientKey = (c: Context): string => clientAddress(c);

  /** An anonymous caller in the security log: at home (direct to the worker) or from the internet (through Caddy). */
  const anonActor = (c: Context): string => (trusted(c) ? 'pc' : 'public');

  /**
   * P1-08: a `device.used` / `passkey.used` row for the first authenticated request of each device or passkey in an
   * hour, and at once when its address or user agent changes: the trace of a stolen token being used. In memory.
   */
  const usedSeen = new Map<string, { at: number; address: string; ua: string }>();
  const recordUse = (c: Context, kind: 'device.used' | 'passkey.used', actor: string, actorName: string | null): void => {
    try {
      const address = clientAddress(c);
      const ua = (c.req.header('user-agent') ?? '').slice(0, 80);
      const t = now();
      const last = usedSeen.get(actor);
      if (last && t - last.at < 3_600_000 && last.address === address && last.ua === ua) return;
      if (usedSeen.size >= 2000) usedSeen.clear();
      usedSeen.set(actor, { at: t, address, ua });
      const changed = last ? [...(last.address !== address ? ['address'] : []), ...(last.ua !== ua ? ['agent'] : [])] : [];
      recordSecurityEvent(state.db, { kind, actor, actorName, address, detail: { ua: ua || null, ...(changed.length ? { changed } : {}) }, at: t });
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e) }, 'security log: recording a use failed');
    }
  };

  // --- who is asking
  const authOf = (c: Context): Auth => {
    const bearer = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
    if (bearer && tokenMatches(bearer, opts.controlToken)) return 'token';
    if (isDeviceToken(bearer)) {
      const seen = devicesSeen.get(c.req.raw);
      if (seen) return 'device';
      const addr = clientAddress(c);
      // Security research P0-03: the token is checked BEFORE the failure counter. Behind Docker Desktop every
      // internet client shares one address, so a counter that refused valid tokens let anyone lock the owner's
      // phone out with ~20 junk requests. A 256-bit token cannot be guessed; the counter only throttles failures.
      // P1-09: a device idle for devices.idleDays is revoked here ('expired') and announced; the app then unpairs
      let expiredNow = false;
      const d = authenticateDevice(state.db, bearer, addr, {
        onExpired: (x, days) => {
          expiredNow = true; // recorded as device.expired only, not also as a rejected token
          log.info({ device: x.id, days }, 'api: idle device token expired');
          securityAlert(state.db, state.vault, `device "${x.name}" expired after ${days} days unused`, {
            kind: 'device.expired',
            actor: `device:${x.id}`,
            actorName: x.name,
            address: addr,
            detail: { device: x.id, name: x.name, idleDays: days, via: 'on use' },
            at: now(),
          });
        },
      });
      if (!d) {
        if (!deviceFailed.has(c.req.raw)) {
          deviceFailed.add(c.req.raw);
          if (deviceAttempts.allowed(addr)) log.warn({ client: addr }, 'api: unknown or revoked device token');
          deviceAttempts.record(addr);
          // aggregated: a flood of junk tokens from the internet is one row a minute (P1-08)
          if (!expiredNow) {
            try {
              recordSecurityEvent(state.db, { kind: 'device.token_rejected', actor: anonActor(c), address: addr, detail: { status: deviceTokenStatus(state.db, bearer) }, aggregate: true, at: now() });
            } catch (e) {
              log.warn({ err: e instanceof Error ? e.message : String(e) }, 'security log: recording a rejected token failed');
            }
          }
        }
        return 'none';
      }
      devicesSeen.set(c.req.raw, d);
      recordUse(c, 'device.used', `device:${d.id}`, d.name);
      return 'device';
    }
    // Security research P0-04: a cookie session is a home-network thing (PC, Tailscale); through the public site
    // only device tokens count, so a leaked cookie is useless from the internet. It also has to belong to the
    // current PIN: changing or clearing the PIN (hub or CLI) ends every session.
    // A passkey session is the exception: a fixed 12-hour lifetime, opened by a WebAuthn signature that is bound to
    // the public origin, so it counts from the internet too (it is still tied to the PIN and to its passkey).
    const s = sessions.check(getCookie(c, COOKIE), pinStamp(state.db));
    if (s?.kind === 'passkey') {
      // the passkey must still be active: removing it ends its sessions at once, even one opened in the same moment
      const pk = s.passkeyId === undefined ? undefined : (state.db.$client.prepare('select revoked_at, name from passkey where id = ?').get(s.passkeyId) as { revoked_at: string | null; name: string } | undefined);
      if (!pk || pk.revoked_at !== null) return 'none';
      recordUse(c, 'passkey.used', `passkey:${s.passkeyId}`, pk.name);
      return 'passkey';
    }
    if (s && trusted(c)) return 'session';
    return 'none';
  };
  /** A cookie-authenticated write must come from our own page: Origin (or Sec-Fetch-Site) has to match the host (audit L3). */
  const sameOrigin = (c: Context): boolean => {
    const host = requestHost(c);
    const origin = c.req.header('origin');
    if (origin) {
      try {
        return new URL(origin).host === host;
      } catch {
        return false;
      }
    }
    const site = c.req.header('sec-fetch-site');
    return site === undefined || site === 'same-origin' || site === 'none';
  };
  const requireAuth = async (c: Context, next: () => Promise<void>): Promise<void> => {
    const via = authOf(c);
    if (via === 'none') {
      if (!deviceAttempts.allowed(clientAddress(c))) throw new HTTPException(429, { message: 'too many attempts; wait 10 minutes' });
      throw new HTTPException(401, { message: trusted(c) ? (pinIsSet(state.db) ? 'sign in with your PIN' : 'set a PIN first') : 'pair this device from Settings on the home network' });
    }
    if ((via === 'session' || via === 'passkey') && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && !sameOrigin(c)) {
      log.warn({ origin: c.req.header('origin'), path: c.req.path }, 'api: cross-site write refused');
      throw new HTTPException(403, { message: 'cross-site request refused' });
    }
    await next();
  };
  /** PIN sign-in is for the home network and Tailscale only; the internet gets device tokens. */
  const requireTrusted = (c: Context): void => {
    if (!trusted(c)) {
      log.warn({ client: clientAddress(c), path: c.req.path }, 'api: PIN flow refused from an untrusted address');
      record(c, 'auth.refused_untrusted', { path: c.req.path.slice(0, 80) }, { aggregate: true });
      throw new HTTPException(403, { message: 'the PIN works only on the home network or Tailscale; pair this device from Settings instead' });
    }
    // a passkey session is never an admin, not even when its cookie reaches the worker directly (review 2026-11-10)
    if (authOf(c) === 'passkey') throw new HTTPException(403, { message: 'not with a passkey sign-in; use the PC at home' });
  };
  /**
   * Operating the worker (vault unlock/lock, bank syncs, sending alerts) is not for a passkey session: a stolen 12-hour
   * browser session must not be able to lock the vault (which silences Telegram) or guess the master password.
   */
  const requireNotPasskey = (c: Context): void => {
    if (authOf(c) === 'passkey') throw new HTTPException(403, { message: 'not with a passkey sign-in; use the PC or the phone app' });
  };

  // --- the security log (P1-08): who did it, as the worker sees it. Never a secret, token, PIN, password or code.
  /** Never throws: a failing lookup must not turn a request that worked into a 500; the row then has a minimal actor. */
  const whoOf = (c: Context): Required<SecurityActor> => {
    try {
      return whoOfUnsafe(c);
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e) }, 'security log: who made the request could not be read');
      return { actor: 'unknown', actorName: null, address: null };
    }
  };
  const whoOfUnsafe = (c: Context): Required<SecurityActor> => {
    const address = clientAddress(c);
    const via = authOf(c);
    if (via === 'token') return { actor: 'control', actorName: null, address };
    if (via === 'device') {
      const d = devicesSeen.get(c.req.raw);
      return { actor: d ? `device:${d.id}` : 'device:?', actorName: d?.name ?? null, address };
    }
    if (via === 'passkey') {
      const id = sessions.check(getCookie(c, COOKIE), pinStamp(state.db))?.passkeyId;
      const name = id === undefined ? null : ((state.db.$client.prepare('select name from passkey where id = ?').get(id) as { name: string } | undefined)?.name ?? null);
      return { actor: id === undefined ? 'passkey:?' : `passkey:${id}`, actorName: name, address };
    }
    if (via === 'session') return { actor: 'pc', actorName: null, address };
    return { actor: anonActor(c), actorName: null, address };
  };
  /** The event for a request; `who` when it was taken before the action changed it (a sign-out, a self-removal, a panic). */
  const ev = (c: Context, kind: string, detail: Record<string, unknown> | null = null, x: { aggregate?: boolean; who?: SecurityActor } = {}): SecurityEventInput => ({
    ...(x.who ?? whoOf(c)),
    kind,
    detail,
    aggregate: x.aggregate ?? false,
    at: now(),
  });
  const record = (c: Context, kind: string, detail: Record<string, unknown> | null = null, x: { aggregate?: boolean; who?: SecurityActor } = {}): void => recordSecurityEvent(state.db, ev(c, kind, detail, x));

  // --- abuse limits for outside callers (security research P2-02); the values are in getLimits / settings
  /**
   * At home (PC, LAN, Tailscale): never limited. Only the address counts: the control token arriving through the
   * public site is not home (the CLI on the PC is a trusted address anyway).
   */
  const atHome = (c: Context): boolean => trusted(c);
  const chatCounter = new RateCounter();
  const alertsCounter = new RateCounter();
  /** stock insights from outside (each open may cost two Yahoo fetches): 60 an hour per actor */
  const insightsCounter = new RateCounter();
  /** holding-rule edits from outside: 30 an hour per actor */
  const holdingRulesCounter = new RateCounter();
  const paidBackCounter = new RateCounter();
  /** 429 {error, retryAt} with Retry-After, and an aggregated security event */
  const limited = (c: Context, kind: string, error: string, retryAt: number, detail: Record<string, unknown> = {}): Response => {
    const iso = new Date(retryAt).toISOString();
    record(c, kind, { ...detail, retryAt: iso }, { aggregate: true });
    log.warn({ kind, client: clientAddress(c), retryAt: iso }, 'api: rate limit');
    return c.json({ error, retryAt: iso }, 429, { 'retry-after': String(Math.max(1, Math.ceil((retryAt - now()) / 1000))) });
  };
  /**
   * The bank-login limit for a manual sync (/api/sync and the control-port /sync). Outside callers: at most
   * syncMaxMonthsOutside months, one sync per cooldown, syncDailyCap a day; null when the sync may start. The start is
   * written (persisted) by the caller only once the sync really starts, so a refusal (vault locked, already running)
   * does not use up the allowance. Home and the CLI are not limited and do not start the outside cooldown.
   */
  const syncRefusal = (c: Context, months: number | undefined): Response | null => {
    if (atHome(c)) return null;
    const r = checkOutsideSync(state.db, now(), months);
    if (r.ok) return null;
    if (r.reason === 'months') {
      record(c, 'sync.limited', { reason: 'months', months: months ?? null, max: r.max, retryAt: null }, { aggregate: true });
      throw new HTTPException(400, { message: `from outside the home network a sync can fetch at most ${r.max} months; sync more from the PC at home` });
    }
    const until = new Date(r.retryAt).toISOString();
    return limited(c, 'sync.limited', r.reason === 'cooldown' ? `a sync from outside the home network was started recently; the next one is allowed at ${until}` : `the daily limit of syncs from outside the home network was reached; the next one is allowed at ${until}`, r.retryAt, { reason: r.reason });
  };
  /**
   * The months a manual sync fetches. A request without months is never refused: from outside it fetches the
   * scheduler's default capped at syncMaxMonthsOutside; home keeps passing undefined (the scheduler's default).
   */
  const outsideMonths = (c: Context, months: number | undefined): number | undefined => {
    if (months !== undefined || atHome(c)) return months;
    const def = state.scheduler.config.monthsBack;
    const max = getLimits(state.db).syncMaxMonthsOutside;
    return typeof def === 'number' && def <= max ? undefined : max;
  };
  /** per-actor rolling-hour (and calendar-day) limit; null when allowed (and counted) */
  const actorRefusal = (c: Context, counter: RateCounter, scope: string, kind: string, what: string, perHour: number, perDay?: number): Response | null => {
    if (atHome(c)) return null;
    const actor = whoOf(c).actor;
    const t = now();
    const retryAt = counter.take(`${scope}|${actor}`, t, perHour, perDay);
    if (retryAt === null) return null;
    return limited(c, kind, `too many ${what} from this device; try again at ${new Date(retryAt).toISOString()}`, retryAt, { scope });
  };

  // --- auth
  app.get('/api/auth/status', (c) => {
    const via = authOf(c);
    const d = devicesSeen.get(c.req.raw);
    const bearer = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
    // only when a device token was presented: 'ok', or why it was refused (the app unpairs on 'revoked'/'unknown' only)
    const deviceStatus = isDeviceToken(bearer) ? (d ? 'ok' : deviceTokenStatus(state.db, bearer)) : undefined;
    const rp = passkeyRp(state.db);
    const passkeys = { available: !!rp && activePasskeys(state.db, rp.rpId).length > 0, rpId: rp?.rpId ?? null };
    return c.json({ pinSet: pinIsSet(state.db), authenticated: via !== 'none', via, trusted: trusted(c), device: d ? { id: d.id, name: d.name } : null, passkeys, ...(deviceStatus ? { deviceStatus } : {}) });
  });
  app.post('/api/auth/setup', async (c) => {
    requireTrusted(c);
    if (pinIsSet(state.db)) throw new HTTPException(409, { message: 'a PIN is already set; change it with `finc ui pin`' });
    const { pin } = z.object({ pin: z.string() }).parse(await c.req.json());
    const problem = validatePin(pin);
    if (problem) throw new HTTPException(400, { message: problem });
    const gen = lockdownGen;
    await setPin(state.db, pin);
    if (lockedDownSince(gen)) throw new HTTPException(409, { message: 'everything was locked meanwhile (lockdown); sign in again' });
    const token = sessions.create(c.req.header('user-agent') ?? '', pinStamp(state.db)!);
    setCookie(c, COOKIE, token, cookieOpts(c));
    log.info('ui: PIN set and first session opened');
    record(c, 'auth.pin_set');
    return c.json({ ok: true });
  });
  app.post('/api/auth/login', async (c) => {
    requireTrusted(c);
    const key = clientKey(c);
    const wait = pinGuard.retryAfterMs();
    if (wait > 0) throw new HTTPException(429, { message: `too many wrong PINs; wait ${Math.ceil(wait / 60_000)} minutes` });
    // counted before anything is awaited (P1-01); a correct PIN gives it back
    if (!pinAttempts.take(key)) throw new HTTPException(429, { message: 'too many attempts; wait 10 minutes' });
    const gen = lockdownGen;
    const { pin } = z.object({ pin: z.string().max(64) }).parse(await c.req.json()); // outside the gate (review 2026-11-10)
    const ok = await passwordGate.run(() => (opts.verifyPin ?? verifyPin)(state.db, pin));
    if (ok === BUSY) throw new HTTPException(429, { message: 'another sign-in is being checked; try again in a few seconds' });
    if (!ok) {
      const g = pinGuard.record();
      log.warn({ client: key, failures: g.failures }, 'ui: wrong PIN');
      const lockedMin = g.lockMs ? Math.round(g.lockMs / 60_000) : 0;
      // aggregated (one row per address a minute); the PIN lock itself is its own row, with the alert
      record(c, 'auth.pin_failed', { failures: g.failures, ...(lockedMin ? { lockedMin } : {}) }, { aggregate: true });
      if (g.failures >= 3) securityAlert(state.db, state.vault, `${g.failures} wrong PIN attempts in a row${g.lockMs ? `; PIN locked for ${lockedMin} min` : ''}`, g.lockMs ? ev(c, 'auth.pin_locked', { failures: g.failures, lockedMin }) : null);
      throw new HTTPException(401, { message: 'wrong PIN' });
    }
    if (lockedDownSince(gen)) {
      log.warn({ client: key }, 'ui: a PIN sign-in finished after a lockdown; refused');
      throw new HTTPException(409, { message: 'everything was locked meanwhile (lockdown); sign in again' });
    }
    pinAttempts.reset(key);
    pinGuard.reset();
    const token = sessions.create(c.req.header('user-agent') ?? '', pinStamp(state.db)!);
    setCookie(c, COOKIE, token, cookieOpts(c));
    // every successful sign-in leaves a trace (P0-04: before, only failures did)
    log.info({ client: key, sessions: sessions.count }, 'ui: signed in with the PIN');
    securityAlert(state.db, state.vault, 'a browser signed in to finc with the PIN', ev(c, 'auth.pin_ok', { sessions: sessions.count }));
    return c.json({ ok: true });
  });
  app.post('/api/auth/logout', (c) => {
    // who and how, before the session (or device) is gone
    const via = authOf(c);
    const who = via === 'none' ? null : whoOf(c);
    sessions.revoke(getCookie(c, COOKIE));
    deleteCookie(c, COOKIE, { path: '/' });
    let deviceRevoked = false;
    if (via === 'device') {
      const d = devicesSeen.get(c.req.raw);
      if (d) deviceRevoked = revokeDevice(state.db, d.id);
    }
    if (who) record(c, 'auth.logout', { via, ...(deviceRevoked ? { deviceRevoked } : {}) }, { who });
    return c.json({ ok: true });
  });
  const publicUrl = (c: Context): string => {
    const configured = getSetting(state.db, 'ui.publicUrl');
    if (configured) return configured.replace(/\/$/, '');
    const host = requestHost(c) || '127.0.0.1:7733';
    return `${overHttps(c) ? 'https' : 'http'}://${host}`;
  };
  /**
   * The phone redeems the code it scanned. Public, single use; the code expires in 5 minutes. A valid code always
   * works (P0-03: a full failure counter on the shared Docker address must not block the owner's re-pairing); the
   * counter throttles wrong codes only. Codes are 128-bit random with at most 5 pending, so guessing is hopeless.
   */
  app.post('/api/devices/pair', async (c) => {
    const addr = clientAddress(c);
    const body = z.object({ code: z.string().min(8).max(64), name: z.string().max(60).optional() }).parse(await c.req.json());
    const p = pairings.redeem(body.code);
    if (!p) {
      const throttled = !deviceAttempts.allowed(addr);
      deviceAttempts.record(addr);
      record(c, 'device.pair_failed', null, { aggregate: true });
      if (throttled) throw new HTTPException(429, { message: 'too many attempts; wait 10 minutes' });
      log.warn({ client: addr }, 'api: bad or expired pairing code');
      throw new HTTPException(401, { message: 'pairing code is wrong or expired; make a new one in Settings' });
    }
    const name = body.name?.trim() || p.name;
    const dev = registerDevice(state.db, { name, userAgent: c.req.header('user-agent') ?? null, address: addr });
    log.info({ device: dev.id, client: addr }, 'api: device paired');
    securityAlert(state.db, state.vault, `a new device was paired: "${name}"`, { kind: 'device.paired', actor: `device:${dev.id}`, actorName: name, address: addr, detail: { device: dev.id }, at: now() });
    return c.json({ token: dev.token, device: { id: dev.id, name }, url: publicUrl(c) });
  });

  // --- passkeys (QUESTIONS 17): sign-in from outside without pairing an app
  /** The relying party, or a 409 when no public address is set (the passkey is bound to that host). */
  const requireRp = (): { rpId: string; origin: string } => {
    const rp = passkeyRp(state.db);
    if (!rp) throw new HTTPException(409, { message: 'set the public address first' });
    return rp;
  };
  /**
   * A failed public passkey step. Like pairing (P0-03), only failures are counted on the shared address, and only
   * after the credential was checked, so a flood from the Docker address never refuses a valid passkey.
   */
  const passkeyFailure = (c: Context, status: 400 | 401, message: string, why: string): never => {
    const addr = clientAddress(c);
    const throttled = !deviceAttempts.allowed(addr);
    deviceAttempts.record(addr);
    log.warn({ client: addr, path: c.req.path, why }, 'api: passkey step refused');
    record(c, c.req.path.endsWith('/login') ? 'passkey.login_failed' : 'passkey.enrol_failed', { why }, { aggregate: true });
    if (throttled) throw new HTTPException(429, { message: 'too many attempts; wait 10 minutes' });
    throw new HTTPException(status, { message });
  };
  const openPasskeySession = (c: Context, passkeyId: number): void => {
    const stamp = pinStamp(state.db);
    if (!stamp) throw new HTTPException(409, { message: 'set a PIN first' });
    const { token, expiresAt } = sessions.createPasskey(c.req.header('user-agent') ?? '', stamp, passkeyId);
    setCookie(c, COOKIE, token, { ...cookieOpts(c), maxAge: Math.max(1, Math.floor((expiresAt - now()) / 1000)) });
  };
  const BAD_ENROL = 'enrolment link is wrong or expired; make a new one in Settings at home';

  app.post('/api/auth/passkey/enroll-code', requireAuth, async (c) => {
    requireTrusted(c);
    const rp = requireRp();
    const body = z.object({ name: z.string().max(60).optional() }).parse(await c.req.json().catch(() => ({})));
    const name = body.name?.trim() || '';
    const code = enrolments.create(name);
    log.info({ client: clientAddress(c) }, 'api: passkey enrolment code created');
    securityAlert(state.db, state.vault, `a passkey enrolment link was created${name ? ` for "${name}"` : ''} (valid 5 minutes)`, ev(c, 'passkey.enrol_code_created', name ? { name } : null));
    const base = getSetting(state.db, 'ui.publicUrl')!.replace(/\/$/, '');
    return c.json({ code, url: `${base}/passkey?code=${encodeURIComponent(code)}`, expiresInMin: 5, rpId: rp.rpId });
  });
  app.post('/api/auth/passkey/register-options', async (c) => {
    const rp = requireRp();
    const { code } = z.object({ code: z.string().min(8).max(64) }).parse(await c.req.json());
    if (!enrolments.get(code)) return passkeyFailure(c, 401, BAD_ENROL, 'bad enrolment code');
    const options = await webauthn.generateRegistrationOptions({
      rpName: 'finc',
      rpID: rp.rpId,
      userID: passkeyUserId(state.db),
      userName: 'finc',
      userDisplayName: 'finc',
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      excludeCredentials: activePasskeys(state.db, rp.rpId).map((p) => ({ id: p.credentialId, transports: p.transports })),
    });
    enrolments.setChallenge(code, options.challenge);
    return c.json({ options });
  });
  app.post('/api/auth/passkey/register', async (c) => {
    const rp = requireRp();
    const body = z.object({ code: z.string().min(8).max(64), response: z.looseObject({ id: z.string().min(1).max(1024) }), name: z.string().max(60).optional() }).parse(await c.req.json());
    const entry = enrolments.get(body.code);
    if (!entry) return passkeyFailure(c, 401, BAD_ENROL, 'bad enrolment code');
    if (!entry.challenge) return passkeyFailure(c, 400, 'ask for the registration options first', 'no challenge on the code');
    const gen = lockdownGen;
    let info;
    try {
      const v = await webauthn.verifyRegistrationResponse({ response: body.response as unknown as RegistrationResponseJSON, expectedChallenge: entry.challenge, expectedOrigin: rp.origin, expectedRPID: rp.rpId, requireUserVerification: true });
      info = v.verified ? v.registrationInfo : null;
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e) }, 'api: passkey registration did not verify');
      info = null;
    }
    if (!info) return passkeyFailure(c, 400, 'the passkey could not be verified; try again', 'registration not verified');
    if (lockedDownSince(gen)) {
      log.warn({ client: clientAddress(c) }, 'api: a passkey enrolment finished after a lockdown; refused');
      throw new HTTPException(409, { message: 'everything was locked meanwhile (lockdown); make a new enrolment link at home' });
    }
    if (!pinStamp(state.db)) throw new HTTPException(409, { message: 'set a PIN first' });
    const name = body.name?.trim() || entry.name || passkeyNameFromAgent(c.req.header('user-agent'));
    let pk;
    try {
      pk = addPasskey(state.db, {
        credentialId: info.credential.id,
        publicKey: Buffer.from(info.credential.publicKey).toString('base64url'),
        counter: info.credential.counter,
        transports: info.credential.transports ?? [],
        rpId: rp.rpId,
        name,
        deviceType: info.credentialDeviceType,
        backedUp: info.credentialBackedUp,
      });
    } catch (e) {
      if (/UNIQUE/i.test(e instanceof Error ? e.message : String(e))) throw new HTTPException(409, { message: 'this passkey is already registered' });
      throw e;
    }
    enrolments.consume(body.code);
    log.info({ passkey: pk.id, client: clientAddress(c) }, 'api: passkey added');
    securityAlert(state.db, state.vault, `a passkey was added: "${pk.name}"`, { kind: 'passkey.enrolled', actor: `passkey:${pk.id}`, actorName: pk.name, address: clientAddress(c), detail: { passkey: pk.id }, at: now() });
    openPasskeySession(c, pk.id);
    return c.json({ ok: true, passkey: { id: pk.id, name: pk.name } });
  });
  /**
   * The allow list is left EMPTY: the browser offers the discoverable passkeys it holds for this host (they are
   * registered with residentKey 'required'), so the public page does not hand out the credential ids and transports
   * of every passkey to anyone who asks; the response's credential id is looked up afterwards.
   */
  app.post('/api/auth/passkey/login-options', async (c) => {
    const rp = requireRp();
    // stateless signed challenge: nothing is stored here, so this public endpoint cannot be flooded (review 2026-11-10)
    const options = await webauthn.generateAuthenticationOptions({ rpID: rp.rpId, userVerification: 'required', allowCredentials: [], challenge: loginChallenges.create() });
    return c.json({ challengeId: options.challenge, options });
  });
  app.post('/api/auth/passkey/login', async (c) => {
    const rp = requireRp();
    if (!pinStamp(state.db)) throw new HTTPException(409, { message: 'set a PIN first' });
    const FAILED = 'passkey sign-in failed';
    // challengeId is accepted for the web client's sake; the challenge that counts is the signed one in the client data
    const body = z.object({ challengeId: z.string().max(200).optional(), response: z.looseObject({ id: z.string().min(1).max(1024) }) }).parse(await c.req.json());
    const pk = findPasskey(state.db, body.response.id, rp.rpId);
    if (!pk) return passkeyFailure(c, 401, FAILED, 'unknown or revoked passkey');
    const gen = lockdownGen;
    let newCounter: number | null = null;
    let signed: string | null = null;
    try {
      const v = await webauthn.verifyAuthenticationResponse({
        response: body.response as unknown as AuthenticationResponseJSON,
        expectedChallenge: (ch: string) => {
          signed = ch;
          return loginChallenges.isValid(ch);
        },
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpId,
        credential: { id: pk.credentialId, publicKey: new Uint8Array(Buffer.from(pk.publicKey, 'base64url')), counter: pk.counter, transports: pk.transports },
        requireUserVerification: true,
      });
      if (v.verified) newCounter = v.authenticationInfo.newCounter;
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e), passkey: pk.id }, 'api: passkey sign-in did not verify');
    }
    if (newCounter === null || signed === null) return passkeyFailure(c, 401, FAILED, 'signature not verified');
    if (lockedDownSince(gen)) throw new HTTPException(401, { message: FAILED }); // its passkey was revoked meanwhile
    loginChallenges.consume(signed); // single use from now on (only successes are remembered)
    touchPasskey(state.db, pk.id, newCounter);
    openPasskeySession(c, pk.id);
    log.info({ passkey: pk.id, client: clientAddress(c) }, 'ui: signed in with a passkey');
    securityAlert(state.db, state.vault, `signed in with a passkey: "${pk.name}"`, { kind: 'passkey.login_ok', actor: `passkey:${pk.id}`, actorName: pk.name, address: clientAddress(c), at: now() });
    return c.json({ ok: true });
  });

  // --- remote MCP (research_notes/proposals/remote-mcp.md): finc as a one-owner OAuth authorization server for ChatGPT
  // and Claude, and /mcp over Streamable HTTP. Everything here answers 404 while "Remote AI apps" is off.
  /** The issuer: the public address without a trailing slash, or null when none is set. */
  const oauthBase = (): string | null => {
    const v = getSetting(state.db, 'ui.publicUrl');
    if (!v) return null;
    try {
      const u = new URL(v);
      return u.protocol === 'https:' ? `${u.protocol}//${u.host}` : null;
    } catch {
      return null;
    }
  };
  const mcpResource = (base: string): string => `${base}/mcp`;
  const remoteOff = (c: Context): Response | null => (mcpRemoteEnabled(state.db) && oauthBase() ? null : c.json({ error: 'not found' }, 404));
  const oauthErr = (c: Context, status: 400 | 401 | 403 | 429, error: string, description: string): Response => c.json({ error, error_description: description }, status, { 'Cache-Control': 'no-store' });
  /**
   * A global budget of FAILED OAuth requests a minute: Docker Desktop hides callers' addresses, so it cannot be per
   * address, and (like P0-03) only failures count, so junk from the internet never refuses a valid refresh or code.
   */
  const budget = () => {
    const b = { start: 0, n: 0 };
    const cur = () => {
      const t = now();
      if (t - b.start > 60_000) {
        b.start = t;
        b.n = 0;
      }
      return b;
    };
    return { limited: () => cur().n >= 60, failed: () => void cur().n++ };
  };
  // two budgets: failed token requests cannot hold up a new connection, and refusals outside the window cost nothing
  const tokenBudget = budget();
  const connectBudget = budget();
  const oauthLimited = connectBudget.limited;
  const oauthFailed = connectBudget.failed;
  const oauthCodes = new OAuthCodes();
  /** Authorization requests waiting for the owner's passkey, in memory (10 minutes, at most 20). */
  type PendingAuth = { client: OAuthClient; redirectUri: string; state: string | null; challenge: string; resource: string; expires: number; used: boolean; webauthnChallenge: string | null; window: string };
  /** at most this many requests per connection window: the owner's app needs one */
  const PENDING_PER_WINDOW = 3;
  const pendingAuth = new Map<string, PendingAuth>();
  const cimdCache = new Map<string, { doc: unknown; at: number }>();
  const oauthFetch = opts.oauthFetch ?? fetch;
  /** Fetches an allow-listed client metadata document: https only, no redirects, 5 seconds, 64 KB. Never any other URL. */
  const fetchClientMetadata = async (url: string): Promise<unknown> => {
    if (!Object.prototype.hasOwnProperty.call(CIMD_ALLOWED, url)) return null;
    const hit = cimdCache.get(url);
    if (hit && now() - hit.at < 3_600_000) return hit.doc;
    const res = await oauthFetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length > 65_536) return null;
    const doc = JSON.parse(text) as unknown;
    cimdCache.set(url, { doc, at: now() });
    return doc;
  };
  const withParams = (uri: string, params: Record<string, string | null>): string => {
    const u = new URL(uri);
    for (const [k, v] of Object.entries(params)) if (v !== null) u.searchParams.set(k, v);
    return u.toString();
  };

  app.get('/.well-known/oauth-protected-resource', (c) => {
    const off = remoteOff(c);
    if (off) return off;
    const base = oauthBase()!;
    return c.json({ resource: mcpResource(base), authorization_servers: [base], scopes_supported: [OAUTH_SCOPE], bearer_methods_supported: ['header'], resource_name: 'finc' });
  });
  app.get('/.well-known/oauth-protected-resource/mcp', (c) => {
    const off = remoteOff(c);
    if (off) return off;
    const base = oauthBase()!;
    return c.json({ resource: mcpResource(base), authorization_servers: [base], scopes_supported: [OAUTH_SCOPE], bearer_methods_supported: ['header'], resource_name: 'finc' });
  });
  app.get('/.well-known/oauth-authorization-server', (c) => {
    const off = remoteOff(c);
    if (off) return off;
    const base = oauthBase()!;
    return c.json({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [OAUTH_SCOPE],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  });

  // Dynamic Client Registration (Claude): only while the owner's connection window is open, only Claude's callbacks
  app.post('/oauth/register', async (c) => {
    const off = remoteOff(c);
    if (off) return off;
    if (oauthLimited()) return oauthErr(c, 429, 'temporarily_unavailable', 'too many requests; try again in a minute');
    if (!connectWindowUntil(state.db, now())) {
      record(c, 'mcp.remote_refused', { step: 'register', reason: 'window_closed' }, { aggregate: true });
      return oauthErr(c, 400, 'invalid_client_metadata', "open 'Connect an app' in finc's Settings at home first");
    }
    const body = await c.req.json().catch(() => null);
    const r = registerOAuthClient(state.db, body, now());
    if (!r.ok) {
      oauthFailed();
      record(c, 'mcp.remote_refused', { step: 'register', reason: r.error }, { aggregate: true });
      return oauthErr(c, 400, r.error, r.description);
    }
    record(c, 'mcp.remote_client', { app: r.client.app, kind: 'dcr' });
    return c.json(
      { client_id: r.client.clientId, client_id_issued_at: Math.floor(now() / 1000), redirect_uris: r.client.redirectUris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], client_name: r.client.app },
      201,
      { 'Cache-Control': 'no-store' },
    );
  });

  // The authorization request: checked here, then the owner's browser goes to the consent page (/connect)
  app.get('/oauth/authorize', async (c) => {
    const off = remoteOff(c);
    if (off) return off;
    if (oauthLimited()) return c.text('too many requests; try again in a minute', 429);
    const base = oauthBase()!;
    // design §4.1: no request may even start outside the owner's window (review 2026-11-17: requests prepared in
    // advance could be phished during a later window, and could fill the slots)
    const windowUntil = connectWindowUntil(state.db, now());
    if (!windowUntil) {
      record(c, 'mcp.remote_refused', { step: 'authorize', reason: 'window_closed' }, { aggregate: true });
      return c.text("finc is not accepting a new connection now. Open 'Connect an app' in finc's Settings at home, then add finc again in the app.", 400);
    }
    const q = c.req.query();
    const clientId = q.client_id ?? '';
    let client: OAuthClient | null = null;
    try {
      if (Object.prototype.hasOwnProperty.call(CIMD_ALLOWED, clientId)) {
        const doc = await fetchClientMetadata(clientId);
        const r = doc ? acceptClientMetadata(state.db, clientId, doc, now()) : null;
        client = r && r.ok ? r.client : null;
      } else if (clientId.length <= 200) client = getOAuthClient(state.db, clientId);
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e) }, 'oauth: the client metadata document could not be read');
    }
    const redirectUri = q.redirect_uri ?? '';
    // never redirect to an address finc has not checked: an unknown client or callback gets a plain page
    if (!client || !client.redirectUris.includes(redirectUri) || !appForRedirect(redirectUri)) {
      oauthFailed();
      record(c, 'mcp.remote_refused', { step: 'authorize', reason: client ? 'redirect_uri' : 'client' }, { aggregate: true });
      return c.text('finc does not know this app or its return address. Only ChatGPT and Claude can connect.', 400);
    }
    const back = (error: string, description: string) => c.redirect(withParams(redirectUri, { error, error_description: description, state: q.state ?? null, iss: base }), 302);
    if (q.response_type !== 'code') return back('unsupported_response_type', 'response_type must be code');
    if (q.code_challenge_method !== 'S256' || !validChallenge(q.code_challenge)) return back('invalid_request', 'PKCE with S256 is required');
    const resource = (q.resource ?? '').replace(/\/$/, '');
    if (resource.toLowerCase() !== mcpResource(base).toLowerCase()) return back('invalid_target', `resource must be ${mcpResource(base)}`);
    const scopes = (q.scope ?? '').split(' ').filter(Boolean);
    if (scopes.some((x) => x !== OAUTH_SCOPE && x !== 'offline_access')) return back('invalid_scope', `the only scope is ${OAUTH_SCOPE}`);
    if (q.state !== undefined && q.state.length > 500) return back('invalid_request', 'state is too long');
    const t = now();
    for (const [k, v] of pendingAuth) if (v.expires <= t || v.used || v.window !== windowUntil) pendingAuth.delete(k);
    if (pendingAuth.size >= PENDING_PER_WINDOW) {
      oauthFailed();
      return back('temporarily_unavailable', "too many requests in this window; close it in finc's Settings and open a new one");
    }
    const id = randomBytes(32).toString('base64url');
    pendingAuth.set(id, { client, redirectUri, state: q.state ?? null, challenge: q.code_challenge!, resource: mcpResource(base), expires: t + REQUEST_TTL_MS, used: false, webauthnChallenge: null, window: windowUntil });
    record(c, 'mcp.remote_request', { app: client.app });
    return c.redirect(`${base}/connect?req=${id}`, 302);
  });

  /** The pending request for the consent page, or an error code the page explains. */
  const pendingFor = (id: string): { ok: true; p: PendingAuth } | { ok: false; status: 404 | 409 | 410; code: 'not_found' | 'expired' | 'window_closed' | 'used' } => {
    const p = pendingAuth.get(id);
    if (!p) return { ok: false, status: 404, code: 'not_found' };
    if (p.used) return { ok: false, status: 410, code: 'used' };
    if (p.expires <= now()) return { ok: false, status: 410, code: 'expired' };
    if (!mcpRemoteEnabled(state.db)) return { ok: false, status: 404, code: 'not_found' };
    const open = connectWindowUntil(state.db, now());
    if (!open || open !== p.window) return { ok: false, status: 409, code: 'window_closed' };
    return { ok: true, p };
  };
  const pendingError = (c: Context, r: { status: 404 | 409 | 410; code: string }) =>
    c.json({ error: r.code === 'window_closed' ? "Open 'Connect an app' in finc's Settings at home first, then add finc again in the app." : r.code === 'used' ? 'This request was already answered.' : r.code === 'expired' ? 'This request expired; add finc again in the app.' : 'Unknown request.', code: r.code }, r.status);
  app.get('/api/oauth/requests/:id', (c) => {
    const r = pendingFor(c.req.param('id'));
    if (!r.ok) return pendingError(c, r);
    return c.json({ app: r.p.client.app, redirectHost: new URL(r.p.redirectUri).host, scope: OAUTH_SCOPE, expiresAt: new Date(r.p.expires).toISOString() });
  });
  app.post('/api/oauth/requests/:id/options', async (c) => {
    if (!sameOrigin(c)) return c.json({ error: 'cross-site request refused' }, 403);
    const r = pendingFor(c.req.param('id'));
    if (!r.ok) return pendingError(c, r);
    const rp = requireRp();
    const challenge = randomBytes(32).toString('base64url');
    r.p.webauthnChallenge = challenge;
    const options = await webauthn.generateAuthenticationOptions({ rpID: rp.rpId, userVerification: 'required', allowCredentials: [], challenge });
    return c.json(options);
  });
  app.post('/api/oauth/requests/:id/approve', async (c) => {
    if (!sameOrigin(c)) return c.json({ error: 'cross-site request refused' }, 403);
    const id = c.req.param('id');
    const r = pendingFor(id);
    if (!r.ok) return pendingError(c, r);
    const p = r.p;
    const rp = requireRp();
    const FAILED = 'the passkey did not verify; try again';
    const body = z.object({ response: z.looseObject({ id: z.string().min(1).max(1024) }) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success || !p.webauthnChallenge) return c.json({ error: FAILED }, 400);
    const pk = findPasskey(state.db, body.data.response.id, rp.rpId);
    if (!pk) return passkeyFailure(c, 401, FAILED, 'unknown or revoked passkey');
    const gen = lockdownGen;
    const expected = p.webauthnChallenge;
    let newCounter: number | null = null;
    try {
      const v = await webauthn.verifyAuthenticationResponse({
        response: body.data.response as unknown as AuthenticationResponseJSON,
        expectedChallenge: expected,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpId,
        credential: { id: pk.credentialId, publicKey: new Uint8Array(Buffer.from(pk.publicKey, 'base64url')), counter: pk.counter, transports: pk.transports },
        requireUserVerification: true,
      });
      if (v.verified) newCounter = v.authenticationInfo.newCounter;
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e), passkey: pk.id }, 'oauth: the approval passkey did not verify');
    }
    p.webauthnChallenge = null; // one signature per challenge
    if (newCounter === null) return passkeyFailure(c, 401, FAILED, 'signature not verified');
    // re-check after the slow verification: a panic, the switch, the window or another approval may have happened
    const again = pendingFor(id);
    if (lockedDownSince(gen) || !again.ok) return again.ok ? c.json({ error: 'finc was locked down meanwhile' }, 409) : pendingError(c, again);
    const others = [...pendingAuth.values()].filter((x) => x !== p && !x.used && x.expires > now() && x.window === p.window).length;
    if (others > 0) {
      record(c, 'mcp.remote_refused', { step: 'approve', reason: 'ambiguous' });
      return c.json({ error: "More than one app asked to connect in this window, so finc approves none. Close the window in Settings, open a new one, and add finc again in your app only.", code: 'ambiguous' }, 409);
    }
    touchPasskey(state.db, pk.id, newCounter);
    p.used = true;
    closeConnectWindow(state.db); // one approval per window
    const code = oauthCodes.issue({ clientId: p.client.clientId, app: p.client.app, redirectUri: p.redirectUri, challenge: p.challenge, resource: p.resource }, now());
    securityAlert(state.db, state.vault, `${p.client.app} was allowed to read finc (approved with passkey "${pk.name}")`, { kind: 'mcp.remote_approved', actor: `passkey:${pk.id}`, actorName: pk.name, address: clientAddress(c), detail: { app: p.client.app }, at: now() });
    return c.json({ redirect: withParams(p.redirectUri, { code, state: p.state, iss: oauthBase() }) });
  });
  app.post('/api/oauth/requests/:id/deny', (c) => {
    if (!sameOrigin(c)) return c.json({ error: 'cross-site request refused' }, 403);
    const p = pendingAuth.get(c.req.param('id'));
    if (!p || p.used) return c.json({ error: 'Unknown request.', code: 'not_found' }, 404);
    p.used = true;
    record(c, 'mcp.remote_denied', { app: p.client.app });
    return c.json({ redirect: withParams(p.redirectUri, { error: 'access_denied', error_description: 'the owner said no', state: p.state, iss: oauthBase() }) });
  });

  // The token endpoint: public clients with PKCE; refresh tokens rotate, a reused one revokes its connection
  app.post('/oauth/token', async (c) => {
    const off = remoteOff(c);
    if (off) return off;
    const type = c.req.header('content-type') ?? '';
    const form: Record<string, string> = {};
    if (type.includes('application/x-www-form-urlencoded')) for (const [k, v] of new URLSearchParams(await c.req.text())) form[k] = v;
    else if (type.includes('application/json')) {
      const j = (await c.req.json().catch(() => null)) as unknown;
      if (j && typeof j === 'object' && !Array.isArray(j)) for (const [k, v] of Object.entries(j as Record<string, unknown>)) if (typeof v === 'string') form[k] = v;
    }
    // a failure past the budget waits; a valid code or refresh token always goes through (P0-03)
    const fail = (status: 400 | 401, error: string, description: string): Response => {
      tokenBudget.failed();
      return tokenBudget.limited() ? oauthErr(c, 429, 'temporarily_unavailable', 'too many failed requests; try again in a minute') : oauthErr(c, status, error, description);
    };
    if (form.client_secret !== undefined) return fail(401, 'invalid_client', 'finc clients are public (no secret)');
    const base = oauthBase()!;
    const resource = form.resource === undefined ? undefined : form.resource.replace(/\/$/, '').toLowerCase() === mcpResource(base).toLowerCase() ? mcpResource(base) : form.resource;
    const t = now();
    if (form.grant_type === 'authorization_code') {
      const r = oauthCodes.redeem(form.code, { clientId: form.client_id, redirectUri: form.redirect_uri, verifier: form.code_verifier, resource }, t);
      if (!r.ok) {
        record(c, 'mcp.remote_refused', { step: 'token', reason: r.description }, { aggregate: true });
        return fail(400, r.error, r.description);
      }
      const g = createGrant(state.db, r.grant, t);
      record(c, 'mcp.remote_token', { app: r.grant.app, grant: g.grantId, kind: 'first' });
      return c.json(g.tokens, 200, { 'Cache-Control': 'no-store', Pragma: 'no-cache' });
    }
    if (form.grant_type === 'refresh_token') {
      const r = refreshGrant(state.db, form.refresh_token, form.client_id, resource, t);
      if (!r.ok) {
        if (r.reused) securityAlert(state.db, state.vault, 'an AI app connection was revoked: one of its refresh tokens was used twice (possible theft)', { kind: 'mcp.remote_refresh_reuse', actor: 'oauth', address: clientAddress(c), detail: { grant: r.reused.grantId }, at: t });
        else record(c, 'mcp.remote_refused', { step: 'refresh', reason: r.description }, { aggregate: true });
        return fail(400, r.error, r.description);
      }
      return c.json(r.tokens, 200, { 'Cache-Control': 'no-store', Pragma: 'no-cache' });
    }
    return fail(400, 'unsupported_grant_type', 'authorization_code or refresh_token');
  });

  // /mcp over Streamable HTTP: an access token for this resource, the privacy-checked tools, JSON answers only
  const remoteMinute = new Map<number, { start: number; n: number }>();
  const remoteBridge = (grant: { grantId: number; app: string }, c: Context) =>
    new McpBridge(
      {
        tools: async () => ({ status: 200, body: { instructions: MCP_INSTRUCTIONS, tools: mcpToolList() } }),
        call: async (name, args) => {
          const out = runMcpTool(state.db, name, args, todayLocal(new Date(now())));
          if (out.dropped.length) log.warn({ tool: name, dropped: out.dropped.slice(0, 10) }, 'mcp: the allow-list dropped fields');
          record(c, 'mcp.call', { tool: name.slice(0, 40), args: Object.keys(args).slice(0, 10), error: out.isError, remote: true }, { aggregate: true, who: { actor: `oauth:${grant.grantId}`, actorName: grant.app } });
          return { status: 200, body: { structured: out.structured, isError: out.isError } };
        },
      },
      FINC_VERSION,
    );
  app.on(['GET', 'DELETE', 'PUT', 'PATCH'], '/mcp', (c) => {
    const off = remoteOff(c);
    if (off) return off;
    return c.json({ error: 'POST only' }, 405, { Allow: 'POST' });
  });
  app.post('/mcp', async (c) => {
    const off = remoteOff(c);
    if (off) return off;
    const base = oauthBase()!;
    // the providers call from their servers; a browser page (any Origin) may not (DNS rebinding, Streamable HTTP §Security)
    if (c.req.header('origin') !== undefined) return c.json({ error: 'not for browsers' }, 403);
    const challenge = (error?: string) => `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="${OAUTH_SCOPE}"${error ? `, error="${error}"` : ''}`;
    const bearer = c.req.header('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!bearer) return c.json({ error: 'sign in through OAuth' }, 401, { 'WWW-Authenticate': challenge() });
    const t = now();
    const a = useAccessToken(state.db, bearer, mcpResource(base), t);
    if (!a.ok) {
      record(c, 'mcp.remote_refused', { step: 'mcp', reason: a.reason }, { aggregate: true });
      if (a.reason === 'daily_limit') return c.json({ error: `this app reached its ${MCP_PER_DAY} calls for today` }, 429);
      return c.json({ error: 'invalid or expired token' }, 401, { 'WWW-Authenticate': challenge('invalid_token') });
    }
    const w = remoteMinute.get(a.grantId);
    if (w && t - w.start < 60_000) {
      if (++w.n > MCP_PER_MINUTE) return c.json({ error: `at most ${MCP_PER_MINUTE} calls a minute` }, 429);
    } else {
      if (remoteMinute.size > 200) remoteMinute.clear();
      remoteMinute.set(a.grantId, { start: t, n: 1 });
    }
    const msg = await c.req.json().catch(() => undefined);
    if (msg === undefined) return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 400);
    const out = await remoteBridge(a, c).handle(msg, { protocolVersion: c.req.header('mcp-protocol-version'), method: c.req.header('mcp-method'), name: c.req.header('mcp-name') });
    if (!out.reply) return c.body(null, 202);
    return c.json(out.reply, out.status);
  });

  // --- read models
  const api = new Hono();
  api.use('*', requireAuth);
  const monthQ = z.string().regex(/^\d{4}-\d{2}$/).optional();
  const viewQ = z.enum(['purchase', 'billing']).optional();

  api.get('/hub', (c) => {
    const q = z.object({ month: monthQ, view: viewQ }).parse(c.req.query());
    const overview = hubOverview(state.db, q.month, q.view ?? 'purchase');
    return c.json({ ...overview, accuracy: forecastAccuracy(state.db), change: forecastChange(state.db, { overview }) });
  });
  api.get('/transactions', (c) => {
    const q = z
      .object({
        month: monthQ,
        view: viewQ,
        from: z.string().optional(),
        to: z.string().optional(),
        accountId: z.coerce.number().int().optional(),
        categoryId: z.coerce.number().int().optional(),
        group: z.string().optional(),
        bucket: z.enum(['income', 'fixed', 'variable', 'installments', 'savings', 'settlements', 'transfers', 'refunds', 'excluded', 'uncategorised', 'pending', 'cancelled']).optional(),
        status: z.enum(['pending', 'completed', 'voided']).optional(),
        merchantId: z.coerce.number().int().optional(),
        streamId: z.coerce.number().int().optional(),
        planId: z.coerce.number().int().optional(),
        q: z.string().max(80).optional(),
        eventId: z.coerce.number().int().optional(),
        includeExcluded: queryFlag.optional(),
        limit: z.coerce.number().int().min(1).max(1000).optional(),
        offset: z.coerce.number().int().min(0).optional(),
        sort: z.enum(['date', 'amount']).optional(),
      })
      .parse(c.req.query());
    return c.json(listTransactions(state.db, defined(q)));
  });
  api.get('/transactions/:id', (c) => {
    const t = transactionDetail(state.db, Number(c.req.param('id')));
    if (!t) throw new HTTPException(404, { message: 'no such transaction' });
    return c.json(t);
  });
  api.get('/review', (c) => c.json(reviewInbox(state.db)));
  api.get('/recurring', (c) => {
    const q = z.object({ month: monthQ, states: z.string().optional() }).parse(c.req.query());
    return c.json(recurringOverview(state.db, q.month, q.states ? q.states.split(',') : undefined));
  });
  // bill calendar (wave 5): the month's fixed money by day, with the bank balance line for the current month
  api.get('/calendar', (c) => {
    const q = z.object({ month: monthQ }).parse(c.req.query());
    return c.json(billCalendar(state.db, q.month ?? limitMonthNow()));
  });
  api.get('/categories', (c) => {
    const q = z.object({ month: monthQ }).parse(c.req.query());
    return c.json(categoriesOverview(state.db, q.month));
  });
  // --- events (design §7): tag transactions across months, see what they cost
  const eventBody = z.object({ name: z.string().min(1).max(80), note: z.string().max(500).nullable().optional(), fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional() });
  api.get('/events', (c) => {
    const q = z.object({ archived: queryFlag.optional() }).parse(c.req.query());
    return c.json(listEvents(state.db, { includeArchived: q.archived ?? false }));
  });
  api.post('/events', async (c) => c.json(createEvent(state.db, defined(eventBody.parse(await c.req.json())))));
  api.get('/events/:id', (c) => {
    const e = eventView(state.db, Number(c.req.param('id')));
    if (!e) throw new HTTPException(404, { message: 'no such event' });
    return c.json(e);
  });
  api.patch('/events/:id', async (c) => {
    const body = eventBody.partial().extend({ archived: z.boolean().optional() }).parse(await c.req.json());
    return c.json(updateEvent(state.db, Number(c.req.param('id')), defined(body)));
  });
  api.delete('/events/:id', (c) => {
    deleteEvent(state.db, Number(c.req.param('id')));
    return c.json({ ok: true });
  });
  api.post('/events/:id/txns', async (c) => {
    const body = z.object({ add: z.array(z.number().int()).max(500).optional(), remove: z.array(z.number().int()).max(500).optional() }).parse(await c.req.json());
    return c.json(setEventTxns(state.db, Number(c.req.param('id')), defined(body)));
  });
  // --- "ask my money" (design §8): the model picks from fixed local aggregations; the key comes from the vault only
  const aiKey = (provider: 'anthropic' | 'openai' | 'local'): { key: string | null; inVault: boolean } => {
    if (provider === 'local') return { key: null, inVault: true };
    const v = state.vault;
    if (!v || v.locked) return { key: null, inVault: false };
    const entry = v.get(`ai_${provider}`);
    const values = entry ? Object.values(entry.fields) : [];
    const key = entry?.fields.apiKey ?? entry?.fields.token ?? (values.length === 1 ? values[0] : undefined);
    return { key: key ?? null, inVault: !!key };
  };
  /** A chat's memory belongs to one caller: another device or session cannot read it by guessing the id. */
  const chatKey = (c: Context, chatId: string): string => `${whoOf(c).actor}|${chatId}`;
  /** Changes whenever the transactions do (a sync, an engine run, an edit): earlier lookups are then stale. */
  const dataStamp = (): string => {
    const r = state.db.$client.prepare('select count(*) n, max(updated_at) u from "transaction"').get() as { n: number; u: string | null };
    return `${r.n}|${r.u ?? ''}`;
  };
  /** "New chat" on the web: the old conversation's lookups are dropped at once instead of expiring. */
  api.delete('/chat/:chatId', (c) => {
    const id = CHAT_ID.safeParse(c.req.param('chatId'));
    if (!id.success) throw new HTTPException(400, { message: 'bad chat id' });
    chatMemory.forget(chatKey(c, id.data));
    return c.json({ ok: true });
  });
  api.get('/chat/status', (c) => {
    const ai = getAiSettings(state.db);
    const vaultLocked = !state.vault || state.vault.locked;
    const k = ai.provider ? aiKey(ai.provider) : { key: null, inVault: false };
    // the model the chat will actually use (ai.chatModel when set)
    const model = chatModelOf(ai);
    return c.json({ provider: ai.provider, model, baseUrl: ai.baseUrl ?? (ai.provider ? AI_DEFAULTS[ai.provider].baseUrl : null), vaultLocked, keyInVault: k.inVault, ready: !!ai.provider && (ai.provider === 'local' || !!k.key) });
  });
  api.post('/chat', async (c) => {
    const body = z.object({ messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(4000) })).min(1).max(40), chatId: CHAT_ID.optional() }).parse(await c.req.json());
    // P2-02 review: from outside, one question must not carry a huge history to the paid model. The new question
    // (the last message) over CHAT_OUTSIDE_CHARS is a 400, since only the caller can shorten it; the history is trimmed
    // here instead (the last CHAT_OUTSIDE_MESSAGES messages, starting with a question, each earlier message cut to
    // CHAT_OUTSIDE_CHARS), so a long conversation keeps working with less context.
    let messages = body.messages;
    if (!atHome(c)) {
      const last = messages[messages.length - 1]!;
      if (last.content.length > CHAT_OUTSIDE_CHARS) throw new HTTPException(400, { message: `from outside the home network a question can be at most ${CHAT_OUTSIDE_CHARS} characters` });
      messages = messages.slice(-CHAT_OUTSIDE_MESSAGES);
      while (messages.length > 1 && messages[0]!.role !== 'user') messages = messages.slice(1);
      messages = messages.map((m) => (m.content.length > CHAT_OUTSIDE_CHARS ? { ...m, content: m.content.slice(0, CHAT_OUTSIDE_CHARS) } : m));
    }
    const ai = getAiSettings(state.db);
    if (!ai.provider) throw new HTTPException(409, { message: 'no model provider configured' });
    const k = aiKey(ai.provider);
    if (ai.provider !== 'local' && !k.key) throw new HTTPException(409, { message: !state.vault || state.vault.locked ? 'vault is locked' : `no API key in the vault (finc vault set ai_${ai.provider})` });
    // P2-02: each question costs money; counted here, once it would reach the model
    const lim = getLimits(state.db);
    const refused = actorRefusal(c, chatCounter, 'chat', 'chat.limited', 'questions', lim.chatPerHour, lim.chatPerDay);
    if (refused) return refused;
    // chat v2 step 4: the chat's own model when one is chosen; categorisation keeps ai.model
    const provider = (opts.chatProvider ?? createProvider)({ provider: ai.provider, model: chatModelOf(ai) ?? AI_DEFAULTS[ai.provider].model, ...(ai.baseUrl ? { baseUrl: ai.baseUrl } : {}), ...(k.key ? { apiKey: k.key } : {}) });
    try {
      // chat v2: a follow-up continues from the lookups of earlier turns (already sent to the model, kept in memory
      // only). Bound to the vault and memory generation of this moment: a lock or panic while the model answers means
      // nothing is stored. From outside, P2-02's bound per question holds: at most CHAT_OUTSIDE_LOOKUP_CHARS of them.
      const turn = body.chatId ? chatMemory.begin(chatKey(c, body.chatId), state.vault, dataStamp(), atHome(c) ? undefined : CHAT_OUTSIDE_LOOKUP_CHARS) : null;
      const { lookups, ...result } = await chat(state.db, provider, messages, { previousLookups: turn?.previous ?? [] });
      turn?.finish(lookups);
      return c.json(result);
    } catch (e) {
      // the provider's own response text stays in the worker log; the browser gets the status only
      console.error(`chat: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`);
      const status = e instanceof AiError && e.status ? ` (${e.status})` : '';
      throw new HTTPException(502, { message: `the model provider returned an error${status}` });
    }
  });

  // --- net worth (design §6): balances minus card debt, plus hand-entered holdings
  // Live prices (prices.ts): the holdings route adds `live`; accounts and net worth add liveValueIls/liveAsOf on the
  // securities and FX lines only, every existing field and total stays on the bank's values.
  // Only the holdings view waits for a refresh (and only when the cache is stale for it); the others never wait.
  const liveOpt = async (wait = false): Promise<{ live?: { cache: ReturnType<typeof emptyPriceCache>; now: number } }> => {
    if (!state.prices) return {};
    await state.prices.demand({ wait });
    return { live: { cache: state.prices.cache(), now: now() } };
  };
  api.get('/networth', async (c) => c.json(netWorthOverview(state.db, await liveOpt())));
  const manualBody = z.object({ name: z.string().min(1).max(80), kind: z.enum(MANUAL_KINDS), side: z.enum(['asset', 'liability']).optional(), currency: z.string().length(3).optional(), note: z.string().max(500).nullable().optional(), value: z.number().int().min(0), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
  api.post('/networth/manual', async (c) => c.json(createManual(state.db, defined(manualBody.parse(await c.req.json())))));
  api.patch('/networth/manual/:id', async (c) => {
    const body = z.object({ name: z.string().min(1).max(80).optional(), kind: z.enum(MANUAL_KINDS).optional(), side: z.enum(['asset', 'liability']).optional(), note: z.string().max(500).nullable().optional(), archived: z.boolean().optional() }).parse(await c.req.json());
    return c.json(updateManual(state.db, Number(c.req.param('id')), defined(body)));
  });
  api.post('/networth/manual/:id/values', async (c) => {
    const body = z.object({ value: z.number().int().min(0), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(await c.req.json());
    return c.json(setManualValue(state.db, Number(c.req.param('id')), body));
  });
  api.delete('/networth/manual/:id', (c) => {
    deleteManual(state.db, Number(c.req.param('id')));
    return c.json({ ok: true });
  });
  api.get('/trends', (c) => {
    const q = z.object({ months: z.coerce.number().int().min(3).max(36).optional(), sankey: monthQ, view: viewQ }).parse(c.req.query());
    return c.json(trendsOverview(state.db, { ...(q.months !== undefined ? { months: q.months } : {}), ...(q.sankey !== undefined ? { sankeyMonth: q.sankey } : {}), ...(q.view !== undefined ? { view: q.view } : {}) }));
  });
  // --- yearly report (wave 5): research_notes/proposals/yearly-report.md; static, built from the month summaries
  api.get('/trends/year', (c) => {
    const q = z.object({ year: z.coerce.number().int().min(2000).max(2100).optional(), view: viewQ }).parse(c.req.query());
    return c.json(yearlyReport(state.db, q.year ?? Number(todayLocal().slice(0, 4)), { ...(q.view !== undefined ? { view: q.view } : {}) }));
  });
  api.get('/accounts', async (c) => c.json(accountsOverview(state.db, await liveOpt())));
  api.get('/accounts/:id/holdings', async (c) => {
    const id = Number(c.req.param('id'));
    const { live } = await liveOpt(true);
    const overview = holdingsOverview(state.db, id);
    // the owner's rules that apply to each position now (stored states, holding-rules.ts); 0 when none
    const applying = rulesApplyingBySymbol(state.db);
    const positions = overview.positions.map((p) => ({ ...p, rulesApplying: p.kind === 'security' ? (applying.get(normSymbol(p.symbol)) ?? 0) : 0 }));
    return c.json({ ...overview, positions, live: accountLiveHoldings(state.db, id, live?.cache ?? emptyPriceCache(), live?.now ?? now()) });
  });
  // --- stock insights (research_notes/proposals/stock-insights.md, steps 1 and 2): price analytics, the bank
  // cross-check, the sector fund, the company's numbers and filings, for one holding row of an account's LATEST snapshot
  // (404 for an older row, a currency row or none). Only ticker symbols go to Yahoo and only the CIK to SEC; the answer
  // carries the bank's price per unit, never a quantity or amount.
  api.get('/holdings/:id/insights', async (c) => {
    const refused = actorRefusal(c, insightsCounter, 'insights', 'insights.limited', 'insight requests', INSIGHTS_OUTSIDE_PER_HOUR);
    if (refused) return refused;
    const id = Number(c.req.param('id'));
    if (!Number.isSafeInteger(id) || id <= 0) throw new HTTPException(404, { message: 'no such holding' });
    const row = state.db.$client
      .prepare(
        `select h.id, h.kind, h.symbol, h.name, h.currency, h.price, h.taken_at takenAt from holding_snapshot h
           where h.id = ? and h.taken_at = (select max(taken_at) from holding_snapshot x where x.account_id = h.account_id)`,
      )
      .get(id) as { id: number; kind: string; symbol: string; name: string; currency: string; price: number | null; takenAt: string } | undefined;
    if (!row || row.kind !== 'security') throw new HTTPException(404, { message: 'no such holding in the latest snapshot' });
    const r: InsightsRow = { id: row.id, symbol: row.symbol, name: row.name, currency: row.currency, price: typeof row.price === 'number' && Number.isFinite(row.price) && row.price > 0 ? row.price : null, takenAt: row.takenAt };
    const out = await buildPanel({ insights: state.insights, sec: state.sec, finnhub: state.finnhub, deadlines: state.panelDeadlines }, r, now);
    // the owner's rules for this symbol, evaluated now against this panel and the holdings (and stored)
    const rules = rulesForPanel(state.db, row.symbol, out, state.prices?.cache() ?? emptyPriceCache(), now());
    // decision aids E: one documented reading per source and where they agree (core insights/signals.ts)
    return c.json({ ...out, rules, signals: signalsBoard(out, rules, cachedNewsTones(row.symbol)) });
  });
  // --- decision aids C (research_notes/proposals/stock-decision-aids.md): a held stock's news and an AI summary of it.
  // Headlines from Finnhub (the same key and limits as analysts); the summary from the chat's provider, checked by code
  // (core insights/news.ts) before it is shown, cached 12 hours per stock and set of headlines, counted under the chat
  // limits for callers away from home (P2-02). What leaves the PC: the ticker to Finnhub; public headlines and the
  // panel's public market facts to the AI provider. Never a quantity, cost, gain or account.
  const newsTonesKey = (sym: string) => `tones:${sym.toUpperCase()}`;
  const cachedNewsTones = (sym: string): Array<{ tone: NewsTone | null }> | null => {
    try {
      const hit = readMarketCache(state.db, NEWS_AI_SOURCE, newsTonesKey(sym));
      const tones = (hit?.value as { tones?: unknown } | null)?.tones;
      if (!hit || !Array.isArray(tones) || now() - hit.fetchedAt > NEWS_TONES_MAX_AGE_MS) return null;
      return tones.map((t) => ({ tone: t === 'positive' || t === 'neutral' || t === 'negative' ? t : null }));
    } catch {
      return null;
    }
  };
  api.get('/holdings/:id/news', async (c) => {
    const refused = actorRefusal(c, insightsCounter, 'insights', 'insights.limited', 'insight requests', INSIGHTS_OUTSIDE_PER_HOUR);
    if (refused) return refused;
    const id = Number(c.req.param('id'));
    if (!Number.isSafeInteger(id) || id <= 0) throw new HTTPException(404, { message: 'no such holding' });
    const row = state.db.$client
      .prepare(
        `select h.id, h.kind, h.symbol, h.name, h.currency, h.price, h.taken_at takenAt from holding_snapshot h
           where h.id = ? and h.taken_at = (select max(taken_at) from holding_snapshot x where x.account_id = h.account_id)`,
      )
      .get(id) as { id: number; kind: string; symbol: string; name: string; currency: string; price: number | null; takenAt: string } | undefined;
    if (!row || row.kind !== 'security') throw new HTTPException(404, { message: 'no such holding in the latest snapshot' });
    const t = now();
    const base = { symbol: row.symbol, fetchedAt: new Date(t).toISOString(), stale: false, headlines: [] as NewsHeadline[], summary: null as null | { sentences: Array<{ text: string; cites: string[] }>; model: string; generatedAt: string } };
    if (!state.finnhub) return c.json({ ...base, headlinesUnavailableCode: 'off', summaryUnavailableCode: 'off' });
    const got = await state.finnhub.news(row.symbol);
    if (!got.ok) return c.json({ ...base, headlinesUnavailableCode: got.code, summaryUnavailableCode: 'too_few' });
    const headlines = selectHeadlines(got.rows, t);
    const out = { ...base, fetchedAt: new Date(got.fetchedAt).toISOString(), stale: got.stale, headlines };
    if (!headlines.length) return c.json({ ...out, headlinesUnavailableCode: 'none', summaryUnavailableCode: 'too_few' });
    const withTones = (tones: Record<string, NewsTone>) => headlines.map((h) => ({ ...h, tone: tones[h.id] ?? null }));
    const sym = row.symbol.toUpperCase();
    // the summary (and the tones) for exactly this set of headlines, when cached
    const set = createHash('sha256').update(headlines.map((h) => `${h.url}|${h.title}`).join('\n')).digest('hex').slice(0, 16);
    const sumKey = `sum:${sym}:${set}`;
    const cached = (() => {
      try {
        const hit = readMarketCache(state.db, NEWS_AI_SOURCE, sumKey);
        return hit && now() - hit.fetchedAt < NEWS_SUMMARY_TTL_MS ? (hit.value as { tones: Record<string, NewsTone>; summary: NonNullable<typeof base.summary> }) : null;
      } catch {
        return null;
      }
    })();
    if (cached) return c.json({ ...out, headlines: withTones(cached.tones), summary: cached.summary });
    if (getSetting(state.db, NEWS_SUMMARY_SETTING) === 'off') return c.json({ ...out, summaryUnavailableCode: 'off' });
    if (headlines.length < 2) return c.json({ ...out, summaryUnavailableCode: 'too_few' });
    const ai = getAiSettings(state.db);
    if (!ai.provider) return c.json({ ...out, summaryUnavailableCode: 'no_provider' });
    const k = aiKey(ai.provider);
    if (ai.provider !== 'local' && !k.key) return c.json({ ...out, summaryUnavailableCode: !state.vault || state.vault.locked ? 'vault_locked' : 'no_provider' });
    const lim = getLimits(state.db);
    if (actorRefusal(c, chatCounter, 'chat', 'chat.limited', 'questions', lim.chatPerHour, lim.chatPerDay)) return c.json({ ...out, summaryUnavailableCode: 'limited' });
    // the panel's public facts (built from its caches; the same deadlines as the insights route)
    const r: InsightsRow = { id: row.id, symbol: row.symbol, name: row.name, currency: row.currency, price: typeof row.price === 'number' && Number.isFinite(row.price) && row.price > 0 ? row.price : null, takenAt: row.takenAt };
    const panel = await buildPanel({ insights: state.insights, sec: state.sec, finnhub: state.finnhub, deadlines: state.panelDeadlines }, r, now);
    const facts = panel.unavailable ? [] : newsFacts(panel, t);
    const prompt = newsSummaryPrompt(sym, row.name, headlines, facts);
    const model = chatModelOf(ai) ?? AI_DEFAULTS[ai.provider].model;
    const provider = (opts.chatProvider ?? createProvider)({ provider: ai.provider, model, ...(ai.baseUrl ? { baseUrl: ai.baseUrl } : {}), ...(k.key ? { apiKey: k.key } : {}) });
    let text: string;
    try {
      text = await withinMs(provider.complete(prompt), NEWS_SUMMARY_DEADLINE_MS, LATE_ANSWER);
    } catch (e) {
      log.info({ err: e instanceof AiError ? e.message.slice(0, 80) : e instanceof Error ? e.name : 'error' }, 'news summary: provider failed');
      return c.json({ ...out, summaryUnavailableCode: 'unreachable' });
    }
    if (text === LATE_ANSWER) return c.json({ ...out, summaryUnavailableCode: 'busy' });
    const checked = checkNewsSummary(text, prompt, { headlines: headlines.map((h) => h.id), facts: facts.map((f) => f.id) });
    if (!checked.ok) {
      // the check's name only, never the model's text (it may echo a crafted headline)
      log.info({ check: checked.check, ...(checked.pattern ? { pattern: checked.pattern } : {}) }, 'news summary: answer refused by the checks');
      return c.json({ ...out, summaryUnavailableCode: 'rejected' });
    }
    const tones = Object.fromEntries(checked.tones);
    const summary = { sentences: checked.sentences, model, generatedAt: new Date(now()).toISOString() };
    try {
      writeMarketCache(state.db, NEWS_AI_SOURCE, sumKey, now(), { tones, summary });
      writeMarketCache(state.db, NEWS_AI_SOURCE, newsTonesKey(sym), now(), { tones: headlines.map((h) => tones[h.id] ?? null) });
    } catch {
      /* shown now; summarised again next time */
    }
    return c.json({ ...out, headlines: withTones(tones), summary });
  });
  // --- the owner's own rules for holdings (research_notes/proposals/stock-decision-aids.md, Part A): fixed templates
  // with validated numbers, no free text. Any signed-in caller; edits from outside 30 an hour per actor; each edit is
  // in the security log ('holding_rules.changed', the action and template only). `/api/rules` is the categorisation rules.
  const ruleBase = {
    params: z.record(z.string().max(20), z.number()),
    scopeSymbol: z.string().trim().min(1).max(20).nullable().optional(),
    notify: z.boolean().optional(),
    enabled: z.boolean().optional(),
  };
  const ruleCreate = z.object({ template: z.enum(TEMPLATE_IDS), ...ruleBase }).strict();
  const rulePatch = z.object({ template: z.enum(TEMPLATE_IDS).optional(), ...ruleBase, params: ruleBase.params.optional() }).strict();
  const ruleId = (c: Context): number => {
    const id = Number(c.req.param('id'));
    if (!Number.isSafeInteger(id) || id <= 0) throw new HTTPException(404, { message: 'no such rule' });
    return id;
  };
  /** 400 unless the params are exactly the template's keys within range */
  const checkParams = (template: string, params: unknown): void => {
    const v = validateParams(template, params);
    if (!v.ok) throw new HTTPException(400, { message: v.error });
  };
  /** 400 unless null/absent or a security held now */
  const checkScope = (scope: string | null | undefined): void => {
    if (scope === null || scope === undefined) return;
    if (!heldSymbols(state.db).includes(normSymbol(scope))) throw new HTTPException(400, { message: 'scopeSymbol must be a security held now, or null for every holding' });
  };
  const ruleError = (e: unknown): never => {
    if (e instanceof HoldingRuleError) throw new HTTPException(e.code === 'not_found' ? 404 : e.code === 'too_many' ? 409 : 400, { message: e.message });
    throw e;
  };
  const rulesEdit = (c: Context): Response | null => actorRefusal(c, holdingRulesCounter, 'holding-rules', 'holding_rules.limited', 'rule changes', HOLDING_RULES_OUTSIDE_PER_HOUR);
  /**
   * After a create or change: evaluate the symbols the rule covers now, so the next holdings fetch shows the counts;
   * waits at most the panel's deadline (the evaluation goes on and fills the caches)
   */
  const evaluateAfterEdit = async (scopeSymbol: string | null): Promise<void> => {
    if (!state.holdingRules) return;
    await withinMs(state.holdingRules.evaluateSymbols(scopeSymbol === null ? null : [scopeSymbol]), RULES_EDIT_WAIT_MS, 0);
  };
  api.get('/holding-rules', (c) => c.json({ rules: listHoldingRules(state.db), templates: templateList(), symbols: heldSymbols(state.db), portfolioDefinition: PORTFOLIO_DEFINITION }));
  api.post('/holding-rules', async (c) => {
    const refused = rulesEdit(c);
    if (refused) return refused;
    const body = ruleCreate.parse(await c.req.json());
    checkParams(body.template, body.params);
    checkScope(body.scopeSymbol);
    let rule;
    try {
      rule = createHoldingRule(state.db, defined(body), now());
    } catch (e) {
      return ruleError(e);
    }
    record(c, 'holding_rules.changed', { action: 'create', template: rule.template });
    if (rule.enabled) await evaluateAfterEdit(rule.scopeSymbol);
    return c.json(rule);
  });
  api.patch('/holding-rules/:id', async (c) => {
    const refused = rulesEdit(c);
    if (refused) return refused;
    const id = ruleId(c);
    const body = rulePatch.parse(await c.req.json());
    if (!Object.values(body).some((v) => v !== undefined)) throw new HTTPException(400, { message: 'nothing to change' });
    const cur = getHoldingRule(state.db, id);
    if (!cur) throw new HTTPException(404, { message: 'no such rule' });
    if (body.template !== undefined && body.template !== cur.template && body.params === undefined) throw new HTTPException(400, { message: 'a new template needs its params' });
    if (body.params !== undefined) checkParams(body.template ?? cur.template, body.params);
    if (body.scopeSymbol !== undefined && body.scopeSymbol !== null && normSymbol(body.scopeSymbol) !== cur.scopeSymbol) checkScope(body.scopeSymbol);
    let rule;
    try {
      rule = updateHoldingRule(state.db, id, defined(body), now());
    } catch (e) {
      return ruleError(e);
    }
    record(c, 'holding_rules.changed', { action: 'update', template: rule.template });
    if (rule.enabled) await evaluateAfterEdit(rule.scopeSymbol);
    return c.json(rule);
  });
  api.delete('/holding-rules/:id', (c) => {
    const refused = rulesEdit(c);
    if (refused) return refused;
    const id = ruleId(c);
    const cur = getHoldingRule(state.db, id);
    if (!cur || !deleteHoldingRule(state.db, id)) throw new HTTPException(404, { message: 'no such rule' });
    record(c, 'holding_rules.changed', { action: 'delete', template: cur.template });
    return c.json({ ok: true });
  });
  api.get('/rules', (c) => c.json(listRules(state.db)));
  api.get('/health', (c) => c.json(healthPayload(state)));
  // --- alerts (§7d)
  api.get('/alerts', async (c) => {
    const cfg = alertConfig(state.db);
    const token = telegramToken(state.vault);
    const me = token ? await telegramMe(token) : null;
    return c.json({
      config: cfg,
      telegram: { tokenInVault: !!state.vault && !state.vault.locked && state.vault.has('telegram'), tokenValid: me?.ok ?? null, bot: me?.username ?? null, chatId: cfg.telegramChatId, vaultLocked: !state.vault || state.vault.locked },
      quietNow: inQuietHours(cfg.quiet, new Date(), state.scheduler.config.timezone),
      recent: recentAlerts(state.db, 30),
      // changing anything here is for the home network only (P0-02); the screen hides the controls elsewhere
      canEdit: trusted(c),
    });
  });
  // Security research P0-02: Telegram is finc's only fraud and intrusion warning, so who receives it and what it
  // stays silent about are decided at home only, like the public address and the AI settings.
  api.patch('/alerts', async (c) => {
    requireTrusted(c);
    const body = z
      .object({
        matrix: z.record(z.string(), z.object({ telegram: z.boolean().optional() })).optional(),
        quiet: z.union([z.literal('off'), z.object({ from: z.string().regex(/^\d{2}:\d{2}$/), to: z.string().regex(/^\d{2}:\d{2}$/) })]).optional(),
        weekly: z.object({ day: z.number().int().min(0).max(6).optional(), hour: z.number().int().min(0).max(23).optional() }).optional(),
        // whole shekels: money out from `big` is alerted, from `urgent` it goes out even in quiet hours
        amounts: z.object({ big: z.number().int().positive().max(10_000_000).optional(), urgent: z.number().int().positive().max(10_000_000).optional() }).optional(),
        // unusual-charge alert: a charge more than this many times the merchant's usual
        unusualFactor: z.number().int().min(2).max(10).optional(),
      })
      .parse(await c.req.json());
    const { amounts, ...rest } = defined(body) as Parameters<typeof setAlertConfig>[1];
    // amounts first, so an invalid pair (urgent below big) is a 400 and changes nothing else in the same patch
    if (amounts) {
      try {
        setAlertConfig(state.db, { amounts: defined(amounts) as typeof amounts });
      } catch (e) {
        throw new HTTPException(400, { message: e instanceof Error ? e.message : String(e) });
      }
    }
    const out = setAlertConfig(state.db, rest);
    // which parts changed, never the values (the amounts are money)
    record(c, 'alerts.settings_changed', { keys: Object.keys(defined(body)) });
    return c.json(out);
  });
  /**
   * Step 1 of binding the alert chat: a one-time code (10 minutes) and the bot link that sends it. Pressing Start
   * through that link sends `/start <code>`; only the chat that sends it can become the alert channel.
   */
  api.post('/alerts/telegram/code', async (c) => {
    requireTrusted(c);
    const token = telegramToken(state.vault);
    if (!token) throw new HTTPException(409, { message: 'no Telegram token in the vault (finc vault set telegram), or the vault is locked' });
    const me = await telegramMe(token);
    const code = randomBytes(12).toString('base64url');
    telegramBinding = { code, sinceUnix: Math.floor(Date.now() / 1000) - 5, expires: Date.now() + 10 * 60_000 };
    record(c, 'alerts.chat_code_created');
    return c.json({ code, bot: me.username ?? null, link: me.username ? `https://t.me/${me.username}?start=${code}` : null, expiresInMin: 10 });
  });
  /** Step 2: after Start was pressed through the link, bind the chat that sent the code. */
  api.post('/alerts/telegram/discover', async (c) => {
    requireTrusted(c);
    const token = telegramToken(state.vault);
    if (!token) throw new HTTPException(409, { message: 'no Telegram token in the vault (finc vault set telegram), or the vault is locked' });
    const b = telegramBinding;
    if (!b || b.expires < Date.now()) throw new HTTPException(409, { message: 'make a connection code first (it is valid for 10 minutes)' });
    const found = await telegramFindChatByCode(token, b.code, b.sinceUnix);
    if (!found) throw new HTTPException(404, { message: 'the code has not arrived yet: open the link, press Start in Telegram, then try again' });
    telegramBinding = null;
    const previous = alertConfig(state.db).telegramChatId;
    if (previous && previous !== found.chatId) {
      // the old chat hears about it, so a quiet takeover cannot go unnoticed
      const he = (getSetting(state.db, 'ui.language') ?? 'he') === 'he';
      await telegramSend(token, previous, he ? '🔒 finc: ההתראות הועברו לצ׳אט אחר. אם לא אתה עשית את זה, בדוק את finc מהמחשב בבית.' : '🔒 finc: alerts were moved to another chat. If that was not you, check finc from the PC at home.');
    }
    setAlertConfig(state.db, { telegramChatId: found.chatId });
    log.info({ changed: !!previous && previous !== found.chatId }, 'alerts: Telegram chat bound by code');
    record(c, 'alerts.chat_bound', { changed: !!previous && previous !== found.chatId });
    // the alarm bot was tested with one chat only; a different chat needs `finc alerts alarm setup` again (P1-05)
    const alarm = readAlarmBot();
    const alarmNeedsSetup = !!alarm && alarm.chatId !== found.chatId;
    return c.json({ ok: true, from: found.from, ...(alarmNeedsSetup ? { alarmNeedsSetup: true, note: 'the alarm bot was set up for another chat and is not used now: run .\\finc alerts alarm setup again (open the alarm bot in Telegram and press Start first)' } : {}) });
  });
  api.post('/alerts/test', async (c) => {
    requireNotPasskey(c);
    // P2-02: every attempt counts (it may reach Telegram)
    const refused = actorRefusal(c, alertsCounter, 'alerts.test', 'alerts.limited', 'alert sends', getLimits(state.db).alertsPerHour);
    if (refused) return refused;
    const token = telegramToken(state.vault);
    const cfg = alertConfig(state.db);
    if (!token || !cfg.telegramChatId) throw new HTTPException(409, { message: 'Telegram is not set up yet' });
    const body = z.object({ weekly: z.boolean().optional() }).parse(await c.req.json().catch(() => ({})));
    const text = body.weekly ? weeklySummaryText(state.db).text : (getSetting(state.db, 'ui.language') ?? 'he') === 'he' ? '✅ finc מחובר. ההתראות יגיעו לכאן.' : '✅ finc is connected. Alerts will arrive here.';
    const r = await telegramSend(token, cfg.telegramChatId, text);
    if (!r.ok) throw new HTTPException(502, { message: r.error ?? 'telegram error' });
    return c.json({ ok: true });
  });
  api.post('/alerts/dispatch', async (c) => {
    requireNotPasskey(c);
    const refused = actorRefusal(c, alertsCounter, 'alerts.dispatch', 'alerts.limited', 'alert sends', getLimits(state.db).alertsPerHour);
    if (refused) return refused;
    await runDispatch(state.db, state.vault, 'manual', true);
    return c.json({ ok: true });
  });

  // --- paired phones
  api.get('/devices', (c) => c.json({ devices: listDevices(state.db, c.req.query('all') === 'true'), pendingCodes: pairings.pending, publicUrl: publicUrl(c), trusted: trusted(c) }));
  api.post('/devices/pairings', async (c) => {
    requireTrusted(c);
    const body = z.object({ name: z.string().max(60).optional() }).parse(await c.req.json().catch(() => ({})));
    const p = pairings.create(body.name?.trim() || 'phone');
    log.info({ client: clientAddress(c) }, 'api: pairing code created');
    securityAlert(state.db, state.vault, `a pairing code was created for "${body.name?.trim() || 'phone'}" (valid 5 minutes)`, ev(c, 'device.pairing_code_created', { name: body.name?.trim() || 'phone' }));
    return c.json({ ...p, url: publicUrl(c) });
  });
  api.patch('/devices/:id', async (c) => {
    requireTrusted(c); // device management is done on the home network (audit M2)
    const { name } = z.object({ name: z.string().min(1).max(60) }).parse(await c.req.json());
    const id = Number(c.req.param('id'));
    const before = listDevices(state.db, true).find((d) => d.id === id)?.name ?? null;
    renameDevice(state.db, id, name);
    record(c, 'device.renamed', { device: id, from: before, to: name });
    return c.json({ ok: true });
  });
  /**
   * Removing a device works from anywhere signed in, like removing a passkey (security research P1-09): a phone stolen
   * while away must be cut off at once. It only ever takes access away; pairing (which grants access) stays home-only.
   * Every removal is announced on Telegram, so a removal you did not make is noticed.
   */
  api.delete('/devices/:id', (c) => {
    const id = Number(c.req.param('id'));
    const name = listDevices(state.db).find((d) => d.id === id)?.name;
    const who = whoOf(c); // a device may remove itself
    if (!revokeDevice(state.db, id)) throw new HTTPException(404, { message: 'no such device' });
    log.info({ device: id, client: clientAddress(c), trusted: trusted(c) }, 'api: device revoked');
    securityAlert(state.db, state.vault, `a paired device was removed: "${name ?? id}"${trusted(c) ? '' : ' (from outside the home network)'}`, ev(c, 'device.removed', { device: id, name: name ?? null, fromOutside: !trusted(c) }, { who }));
    return c.json({ ok: true });
  });
  // --- passkeys: listing and removal work from anywhere signed in (removing access is always safe)
  api.get('/passkeys', (c) => {
    const rp = passkeyRp(state.db);
    return c.json({ passkeys: listPasskeys(state.db), available: !!rp && activePasskeys(state.db, rp.rpId).length > 0, rpId: rp?.rpId ?? null });
  });
  api.delete('/passkeys/:id', (c) => {
    const id = Number(c.req.param('id'));
    const who = whoOf(c); // a passkey session may remove its own passkey
    if (!Number.isInteger(id) || !revokePasskey(state.db, id)) throw new HTTPException(404, { message: 'no such passkey' });
    const ended = sessions.revokeWhere((s) => s.kind === 'passkey' && s.passkeyId === id);
    log.info({ passkey: id, sessions: ended, client: clientAddress(c) }, 'api: passkey revoked');
    securityAlert(state.db, state.vault, `a passkey was removed (#${id}); ${ended} session(s) ended`, ev(c, 'passkey.removed', { passkey: id, sessionsEnded: ended }, { who }));
    return c.json({ ok: true });
  });
  /**
   * "Lock everything" (security research P1-09): every device and passkey revoked, every browser and passkey session ended (the
   * caller's too), the vault locked, and a security alert. Any signed-in caller may do it, from anywhere, because it
   * only takes access away; {confirm: "LOCK"} keeps a stray POST from doing anything. The global write guard applies.
   */
  api.post('/panic', async (c) => {
    z.object({ confirm: z.literal('LOCK') }).parse(await c.req.json().catch(() => ({})));
    const via = authOf(c);
    const home = trusted(c);
    const who = via === 'device' ? `device "${devicesSeen.get(c.req.raw)?.name ?? '?'}"` : via === 'passkey' ? 'a passkey session' : via === 'token' ? 'the CLI (finc panic)' : 'the PC (home browser)';
    log.warn({ via, client: clientAddress(c) }, 'api: panic requested');
    const r = await panic(home || via === 'token' ? who : `${who}, from outside the home network`, whoOf(c));
    return c.json(r); // 200 even after a partial failure: ok, errors and the counts say what happened
  });
  api.get('/settings', (c) => {
    const ai = getAiSettings(state.db);
    return c.json({
      version: FINC_VERSION,
      deviceIdleDays: deviceIdleDays(state.db),
      // P1-09: /lockdown on the alarm bot works right now (alarm bot configured and bound, poller running)
      lockdownTelegram: opts.lockdownTelegram?.() ?? false,
      language: getSetting(state.db, 'ui.language') ?? 'he',
      pinSet: pinIsSet(state.db),
      publicUrl: getSetting(state.db, 'ui.publicUrl'),
      trusted: trusted(c),
      via: authOf(c),
      // chatModel: the chat's own choice (null = same as model); chatModels: the tiers offered for this provider (none for local)
      ai: {
        provider: ai.provider,
        model: ai.model ?? (ai.provider ? AI_DEFAULTS[ai.provider].model : null),
        baseUrl: ai.baseUrl ?? (ai.provider ? AI_DEFAULTS[ai.provider].baseUrl : null),
        chatModel: ai.chatModel,
        // decision aids C: the AI summary of a stock's news (headlines show either way); on unless turned off
        newsSummary: getSetting(state.db, NEWS_SUMMARY_SETTING) !== 'off',
        // MCP: AI apps may read finc's privacy-checked tools (off by default)
        mcp: mcpEnabled(state.db),
        // remote MCP: ChatGPT and Claude through OAuth with a passkey (off by default)
        mcpRemote: mcpRemoteEnabled(state.db),
        chatModels: ai.provider === 'openai' || ai.provider === 'anthropic' ? CHAT_MODELS[ai.provider] : null,
      },
      schedule: state.scheduler.config,
      vault: Vault.exists(vaultPath()) ? (state.vault && !state.vault.locked ? 'unlocked' : 'locked') : 'missing',
      cashflow: { month: 'calendar', salaryShift: 'last 3 days → next month', cardView: 'purchase date, billing toggle' },
      // P2-02: what outside callers may do; changed from home only (PATCH limits)
      limits: getLimits(state.db),
      // Now screen: the effective kind of each income category (income.kind.<key> or the default)
      incomeKinds: incomeKinds(state.db),
      // Now screen: the monthly spending limit that applies to the current month (carried forward), null = none
      spendLimit: (() => {
        const month = limitMonthNow();
        return { month, amount: getSpendLimit(state.db, month) };
      })(),
    });
  });

  // --- decisions
  api.patch('/transactions/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const body = z
      .object({
        category: z.union([z.number().int(), z.string()]).optional(),
        applyToMerchant: z.boolean().optional(),
        createRule: z.boolean().optional(),
        note: z.string().max(500).nullable().optional(),
        excluded: z.boolean().optional(),
        transfer: z.boolean().optional(),
        // Now screen: re-tag one income payment (null = by its category)
        incomeKind: z.enum(['regular', 'extra']).nullable().optional(),
      })
      .parse(await c.req.json());
    const out: Record<string, unknown> = {};
    const cat = body.category === undefined ? undefined : typeof body.category === 'number' ? { id: body.category } : resolveCategory(state.db, body.category);
    // the re-tag is checked against the row as the rest of this patch leaves it, before anything is written, so a
    // refused request writes nothing
    if (body.incomeKind !== undefined) {
      const check = body.incomeKind === null ? (transactionDetail(state.db, id) ? 'ok' : 'missing') : incomeKindAllowed(state.db, id, defined({ categoryId: cat?.id, excluded: body.excluded, transfer: body.transfer }));
      if (check === 'missing') throw new HTTPException(404, { message: 'no such transaction' });
      if (check === 'not_income') throw new HTTPException(400, { message: 'only an income payment can be tagged regular or extra' });
    }
    // all of it or none of it (security research P3-03): a refusal at the end rolls back the earlier writes
    state.db.transaction(() => {
      if (cat) out.category = setCategory(state.db, { txnId: id, categoryId: cat.id, applyToMerchant: body.applyToMerchant ?? false, createRule: body.createRule ?? false });
      if (body.note !== undefined) setNote(state.db, id, body.note);
      if (body.excluded !== undefined) setExcluded(state.db, id, body.excluded);
      if (body.transfer !== undefined) markTransfer(state.db, id, body.transfer);
      if (body.incomeKind !== undefined) {
        const r = setIncomeKindOverride(state.db, id, body.incomeKind);
        if (r === 'missing') throw new HTTPException(404, { message: 'no such transaction' });
        if (r === 'not_income') throw new HTTPException(400, { message: 'only an income payment can be tagged regular or extra' });
      }
    });
    return c.json({ ok: true, ...out, transaction: transactionDetail(state.db, id) });
  });
  // split one transaction across categories (wave 5, core hub/splits.ts): spending only, 2-8 parts adding up exactly
  api.put('/transactions/:id/split', async (c) => {
    const id = Number(c.req.param('id'));
    const { parts } = z
      .object({ parts: z.array(z.object({ category: z.union([z.number().int(), z.string().min(1).max(80)]), amount: z.number().int() }).strict()).min(1).max(SPLIT_MAX_PARTS) })
      .strict()
      .parse(await c.req.json());
    const resolved = parts.map((p) => ({ categoryId: typeof p.category === 'number' ? p.category : resolveCategory(state.db, p.category).id, amount: p.amount }));
    try {
      setSplit(state.db, id, resolved);
    } catch (e) {
      if (e instanceof SplitError) throw new HTTPException(e.message === 'no such transaction' ? 404 : 400, { message: e.message });
      throw e;
    }
    return c.json({ ok: true, transaction: transactionDetail(state.db, id) });
  });
  api.delete('/transactions/:id/split', (c) => {
    const id = Number(c.req.param('id'));
    if (!transactionDetail(state.db, id)) throw new HTTPException(404, { message: 'no such transaction' });
    removeSplit(state.db, id);
    return c.json({ ok: true, transaction: transactionDetail(state.db, id) });
  });
  /**
   * Now screen, paid back to me: the owner's answer about one incoming payment (hub/paidback.ts). Display only, like the
   * incomeKind re-tag above: allowed from home and from a paired phone. Checked before anything is written; the change
   * goes to the security log with the answer and the count (never a name or an amount).
   */
  api.post('/transactions/:id/paid-back', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'no such transaction', code: 'not_found' }, 404);
    const { answer } = z
      .object({ answer: z.enum(['always', 'once', 'no', 'no_once', 'undo']) })
      .strict()
      .parse(await c.req.json());
    // answers can write counterparty rules: limited per device from outside, like the holding-rule edits
    const refused = actorRefusal(c, paidBackCounter, 'paid-back', 'paid_back.limited', 'paid-back answers', PAID_BACK_OUTSIDE_PER_HOUR);
    if (refused) return refused;
    let r: { changed: number };
    try {
      r = answerPaidBack(state.db, id, answer);
    } catch (e) {
      // { error, code }: code is not_found | not_eligible | generic_payer (the web then offers only this-payment answers)
      if (e instanceof PaidBackError) return c.json({ error: e.message, code: e.code }, e.status);
      throw e;
    }
    if (r.changed) record(c, 'transaction.paid_back', { txnId: id, answer, changed: r.changed });
    return c.json({ changed: r.changed });
  });
  api.post('/merchants/:id/category', async (c) => {
    const body = z.object({ category: z.union([z.number().int(), z.string()]), createRule: z.boolean().optional() }).parse(await c.req.json());
    const cat = typeof body.category === 'number' ? { id: body.category } : resolveCategory(state.db, body.category);
    return c.json(setCategory(state.db, { merchantId: Number(c.req.param('id')), categoryId: cat.id, createRule: body.createRule ?? false }));
  });
  api.post('/links/:id/decide', async (c) => {
    const { verdict } = z.object({ verdict: z.enum(['confirm', 'reject']) }).parse(await c.req.json());
    return c.json(decideLink(state.db, Number(c.req.param('id')), verdict));
  });
  api.post('/recurring/:id/state', async (c) => {
    const body = z.object({ state: z.enum(['confirmed', 'rejected', 'ended', 'paused']), label: z.string().max(80).optional() }).parse(await c.req.json());
    setStreamState(state.db, Number(c.req.param('id')), body.state, body.label);
    return c.json({ ok: true });
  });
  api.patch('/categories/groups/:key', async (c) => {
    const { monthlyTarget } = z.object({ monthlyTarget: z.number().int().nullable() }).parse(await c.req.json());
    setGroupTarget(state.db, c.req.param('key'), monthlyTarget);
    return c.json({ ok: true });
  });
  api.patch('/categories/:id', async (c) => {
    const body = z.object({ monthlyTarget: z.number().int().nullable().optional(), nameHe: z.string().max(60).optional(), nameEn: z.string().max(60).optional(), track: z.boolean().optional(), icon: z.string().max(8).nullable().optional() }).parse(await c.req.json());
    updateCategory(state.db, Number(c.req.param('id')), defined(body));
    return c.json({ ok: true });
  });
  api.patch('/rules/:id', async (c) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(await c.req.json());
    setRuleEnabled(state.db, Number(c.req.param('id')), enabled);
    return c.json({ ok: true });
  });
  api.delete('/rules/:id', (c) => {
    deleteRule(state.db, Number(c.req.param('id')));
    return c.json({ ok: true });
  });
  api.post('/insights/dismiss', async (c) => {
    const { key, month, view } = z.object({ key: z.string().max(120), month: z.string().regex(/^\d{4}-\d{2}$/).optional(), view: z.enum(['purchase', 'billing']).optional() }).parse(await c.req.json());
    // Only an insight shown right now can be dismissed (P0-02): pre-dismissing a guessed key such as the next
    // big purchase's would silence its alert before it happens.
    if (!hubOverview(state.db, month, view).attention.some((i) => i.key === key)) throw new HTTPException(404, { message: 'no such insight right now' });
    dismissInsight(state.db, key);
    return c.json({ ok: true });
  });
  api.patch('/settings', async (c) => {
    const body = z
      .object({
        language: z.enum(['he', 'en']).optional(),
        publicUrl: z.string().url().max(200).nullable().optional(),
        ai: z
          .object({
            provider: z.enum(['anthropic', 'openai', 'local']).nullable().optional(),
            model: z.string().max(80).nullable().optional(),
            baseUrl: z.string().max(200).nullable().optional(),
            // chat v2 step 4: one of CHAT_MODELS for the provider, null = the chat uses `model`
            chatModel: z.string().max(80).nullable().optional(),
            // decision aids C: the AI summary of stock news on / off
            newsSummary: z.boolean().optional(),
            // MCP: on only from home (not a passkey); off from anywhere
            mcp: z.boolean().optional(),
            mcpRemote: z.boolean().optional(),
          })
          .optional(),
        // P1-09: days a paired device may go unused before its token is revoked; 0 = never
        deviceIdleDays: z.number().int().min(0).max(365).optional(),
        // P2-02: the outside-caller limits, each within LIMIT_RANGES
        limits: z
          .object(Object.fromEntries(Object.entries(LIMIT_RANGES).map(([k, [lo, hi]]) => [k, z.number().int().min(lo).max(hi).optional()])) as Record<keyof typeof LIMIT_RANGES, z.ZodOptional<z.ZodNumber>>)
          .strict()
          .optional(),
        // Now screen (display only, allowed from anywhere): income category kinds, null = back to the default
        incomeKinds: z.record(z.string().max(80), z.enum(['regular', 'extra']).nullable()).optional(),
        // Now screen: spread a large extra income into this month's weekly envelope too
        spreadExtra: z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), value: z.boolean() }).strict().optional(),
        // Now screen (display only, allowed from anywhere): the monthly spending limit from `month` on, null = off
        spendLimit: z
          .object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), amount: z.number().int().positive().max(100_000_000).nullable() })
          .strict()
          .optional(),
      })
      .parse(await c.req.json());
    // The public address and the model settings steer where tokens and data go: home network only (audit M2). So does
    // how long an unused device stays paired (P1-09), and what an outside caller may do (P2-02). Checked before anything is written.
    if (body.publicUrl !== undefined || body.ai || body.deviceIdleDays !== undefined || body.limits) requireTrusted(c);
    // the chat model: only the allow-list of the provider it will run with (the new one when the patch changes it)
    const aiBefore = body.ai ? getAiSettings(state.db) : undefined;
    if (body.ai?.chatModel !== undefined && body.ai.chatModel !== null) {
      const target = body.ai.provider !== undefined ? body.ai.provider : aiBefore!.provider;
      if (!chatModelAllowed(target, body.ai.chatModel)) throw new HTTPException(400, { message: target === 'openai' || target === 'anthropic' ? `the chat model for ${target} is one of ${Object.values(CHAT_MODELS[target]).join(', ')}` : 'the chat model can be chosen for openai or anthropic only' });
    }
    // the spending limit is checked before anything is written (a past month or a bad amount writes nothing)
    const limitMonth = limitMonthNow();
    if (body.spendLimit) {
      try {
        checkSpendLimit(body.spendLimit.month, body.spendLimit.amount, limitMonth);
      } catch (e) {
        if (e instanceof LimitError) throw new HTTPException(400, { message: e.message });
        throw e;
      }
    }
    // the security log gets the keys that were written (P1-08), even when a later part of the patch is refused
    const changed: string[] = [];
    let idleDays: number | undefined;
    /** the new values of the non-secret URL settings (never a key or a token) */
    const urls: Record<string, string | null> = {};
    /** the new limit values (not secret) */
    let newLimits: Record<string, number> | undefined;
    try {
      if (body.incomeKinds && Object.keys(body.incomeKinds).length) {
        try {
          changed.push(...setIncomeKinds(state.db, body.incomeKinds).map((k) => `incomeKinds.${k}`));
        } catch (e) {
          if (e instanceof IncomeKindError) throw new HTTPException(400, { message: e.message });
          throw e;
        }
      }
      if (body.spreadExtra) {
        setSpreadExtra(state.db, body.spreadExtra.month, body.spreadExtra.value);
        changed.push(`spreadExtra.${body.spreadExtra.month}`);
      }
      if (body.spendLimit) {
        setSpendLimit(state.db, body.spendLimit.month, body.spendLimit.amount, limitMonth);
        changed.push(`spendLimit.${body.spendLimit.month}`);
      }
      if (body.limits) {
        const patch = defined(body.limits);
        const keys = setLimits(state.db, patch);
        if (keys.length) {
          changed.push(...keys.map((k) => `limits.${k}`));
          newLimits = Object.fromEntries(keys.map((k) => [k, patch[k]!]));
          log.info({ limits: newLimits }, 'settings: outside-caller limits changed');
        }
      }
      if (body.language) {
        setSetting(state.db, 'ui.language', body.language);
        changed.push('language');
      }
      if (body.deviceIdleDays !== undefined && body.deviceIdleDays !== deviceIdleDays(state.db)) {
        setDeviceIdleDays(state.db, body.deviceIdleDays);
        changed.push('deviceIdleDays');
        idleDays = body.deviceIdleDays;
        log.info({ days: body.deviceIdleDays }, 'settings: device idle expiry changed');
        securityAlert(state.db, state.vault, body.deviceIdleDays ? `unused devices now expire after ${body.deviceIdleDays} days` : 'unused devices no longer expire', null); // in settings.changed below
      }
      if (body.publicUrl !== undefined) {
        setSetting(state.db, 'ui.publicUrl', body.publicUrl ? body.publicUrl.replace(/\/$/, '') : null);
        changed.push('publicUrl');
        urls.publicUrl = body.publicUrl ? body.publicUrl.replace(/\/$/, '') : null;
      }
      if (body.ai) {
        const provider = body.ai.provider !== undefined ? body.ai.provider : getAiSettings(state.db).provider;
        // A cloud key only travels to its vendor: a base URL is accepted for the local provider alone (audit M1).
        if (body.ai.baseUrl && provider !== 'local') throw new HTTPException(400, { message: 'a base URL is only for the local provider; cloud providers use their official address' });
        if (body.ai.provider !== undefined) {
          setSetting(state.db, 'ai.provider', body.ai.provider);
          if (body.ai.provider !== 'local') setSetting(state.db, 'ai.baseUrl', null);
          changed.push('ai.provider');
          // a chat model of the other provider is meaningless: a real change of provider starts from the default
          if (body.ai.provider !== aiBefore!.provider && body.ai.chatModel === undefined && getSetting(state.db, 'ai.chatModel') !== null) {
            setSetting(state.db, 'ai.chatModel', null);
            changed.push('ai.chatModel');
          }
        }
        if (body.ai.chatModel !== undefined) {
          setSetting(state.db, 'ai.chatModel', body.ai.chatModel);
          changed.push('ai.chatModel');
        }
        if (body.ai.model !== undefined) {
          setSetting(state.db, 'ai.model', body.ai.model);
          changed.push('ai.model');
        }
        if (body.ai.baseUrl !== undefined) {
          setSetting(state.db, 'ai.baseUrl', body.ai.baseUrl);
          changed.push('ai.baseUrl');
          urls.aiBaseUrl = body.ai.baseUrl;
        }
        if (body.ai.newsSummary !== undefined) {
          setSetting(state.db, NEWS_SUMMARY_SETTING, body.ai.newsSummary ? null : 'off');
          changed.push('ai.newsSummary');
        }
        if (body.ai.mcp !== undefined) {
          if (body.ai.mcp) requireTrusted(c);
          setMcpEnabled(state.db, body.ai.mcp);
          changed.push('ai.mcp');
        }
        if (body.ai.mcpRemote !== undefined) {
          if (body.ai.mcpRemote) requireTrusted(c);
          setMcpRemoteEnabled(state.db, body.ai.mcpRemote);
          if (!body.ai.mcpRemote) {
            // off means off: no grant survives to come back when it is turned on again (review 2026-11-17)
            closeConnectWindow(state.db);
            revokeAllGrants(state.db, now());
          }
          changed.push('ai.mcpRemote');
        }
      }
    } finally {
      if (changed.length) record(c, 'settings.changed', { keys: changed, ...(idleDays !== undefined ? { deviceIdleDays: idleDays } : {}), ...(newLimits ? { limits: newLimits } : {}), ...urls });
    }
    return c.json({ ok: true });
  });
  api.post('/engine/run', (c) => {
    const r = runEngine(state.db);
    return c.json({ ok: true, ms: r.ms, refunds: { auto: r.refunds.auto, suggest: r.refunds.suggest }, categorized: r.categorized, recurring: r.recurring });
  });
  api.post('/sync', async (c) => {
    requireNotPasskey(c);
    const body = z.object({ institutions: syncInstitutions.optional(), months: z.number().int().min(1).max(24).optional() }).parse(await c.req.json().catch(() => ({})));
    // P2-02: from outside, a cooldown, a daily cap and few months (each sync is a login at every bank)
    const refused = syncRefusal(c, body.months);
    if (refused) return refused;
    if (!state.vault || state.vault.locked) throw new HTTPException(409, { message: 'vault is locked' });
    if (state.scheduler.isRunning) throw new HTTPException(409, { message: 'a sync is already running' });
    // checked and written with no await in between, so parallel requests cannot both pass
    if (!atHome(c)) recordOutsideSync(state.db, now());
    const targets = body.institutions === undefined || body.institutions === 'all' ? 'all' : (body.institutions as ScrapedInstitutionId[]);
    void state.scheduler.syncNow(targets, 'manual', outsideMonths(c, body.months)).catch((e: unknown) => log.error({ err: e instanceof Error ? e.message : String(e) }, 'ui sync failed'));
    return c.json({ started: true }, 202);
  });
  // An encrypted backup now (P1-12). Home only, never a passkey session (requireTrusted refuses both); it waits for a
  // sync that is running (backups never run alongside one) and answers when the backup is written and verified.
  api.post('/backup/run', async (c) => {
    requireTrusted(c);
    try {
      const r = await state.scheduler.backupNow();
      return c.json({ ok: true, file: r.file, counts: r.counts });
    } catch (e) {
      if (e instanceof BackupLockedError) throw new HTTPException(409, { message: 'vault is locked' });
      if (e instanceof BackupBusyError) throw new HTTPException(409, { message: 'a backup is already running' });
      // the detail (it may carry paths) is in the log and in /api/health's backup.lastError
      return c.json({ ok: false, error: 'backup failed; see backup.lastError in /api/health' }, 500);
    }
  });
  // The off-PC copy on the NAS (SFTP). Pairing is two steps: setup reads the NAS host key and makes a key pair (kept in
  // memory only), the user installs the public key on the NAS and compares the fingerprint there, confirm tries a real
  // connection and only then saves the entry in the vault. All of it home only, never a passkey session.
  /** `c` given (setup, confirm): a changed host key is recorded here; a run records it itself (offsite.ts). */
  const offsiteFail = (e: unknown, c?: Context): never => {
    if (c && e instanceof HostKeyChangedError) record(c, 'backup.offsite_hostkey_changed');
    if (e instanceof OffsiteSetupError) throw new HTTPException(e.status, { message: e.message });
    if (e instanceof OffsiteLockedError || (e instanceof VaultError && e.code === 'LOCKED')) throw new HTTPException(409, { message: 'vault is locked' });
    if (e instanceof OffsiteNotConfiguredError || e instanceof OffsiteBusyError) throw new HTTPException(409, { message: e.message });
    // a changed host key is final, not something to retry after fixing authorized_keys (independent review 2026-11-10)
    if (e instanceof HostKeyChangedError) throw new HTTPException(409, { message: e.message });
    throw e;
  };
  /** The offsite status of an earlier pairing must not linger after a remove or a new pairing (stale warnings). */
  const clearOffsiteStatus = () => {
    for (const k of [OFFSITE_SETTINGS.lastOkAt, OFFSITE_SETTINGS.lastFile, OFFSITE_SETTINGS.lastError, OFFSITE_SETTINGS.lastErrorAt, OFFSITE_SETTINGS.alertDay]) setSetting(state.db, k, null);
  };
  const nasBody = z.object({
    host: z.string().regex(/^[A-Za-z0-9.:-]{1,253}$/, 'a host name or an IP address'),
    port: z.number().int().min(1).max(65535).default(22),
    // a NEW finc-… user only, and a plain folder: the printed NAS recipe must never be able to take over a real login
    // or break on odd characters (independent review 2026-11-10)
    username: z.string().regex(/^finc-[a-z0-9-]{1,24}$/, 'a new NAS user called finc-something'),
    dir: z
      .string()
      .regex(/^(\/[A-Za-z0-9._-]+)+$/, 'a plain folder path like /copies')
      .refine((d) => !d.split('/').includes('..'), 'no ".." in the path'),
  });
  api.post('/backup/offsite/setup', async (c) => {
    requireTrusted(c);
    if (!state.vault || state.vault.locked) throw new HTTPException(409, { message: 'vault is locked' });
    const b = nasBody.parse(await c.req.json().catch(() => ({})));
    try {
      return c.json(await offsiteSetup.start(b));
    } catch (e) {
      return offsiteFail(e, c);
    }
  });
  api.post('/backup/offsite/confirm', async (c) => {
    requireTrusted(c);
    const { hostKey } = z.object({ hostKey: z.string().min(1).max(200) }).parse(await c.req.json().catch(() => ({})));
    try {
      const r = await offsiteSetup.confirm(hostKey, state.vault);
      clearOffsiteStatus(); // a fresh pairing starts with a clean status
      record(c, 'backup.offsite_set', { target: r.target });
      return c.json(r);
    } catch (e) {
      return offsiteFail(e, c);
    }
  });
  api.post('/backup/offsite/run', async (c) => {
    requireTrusted(c);
    if (!state.scheduler.offsiteNow) throw new HTTPException(409, { message: 'offsite backup is not available in this worker' });
    try {
      return c.json(await state.scheduler.offsiteNow());
    } catch (e) {
      if (e instanceof OffsiteLockedError || e instanceof OffsiteNotConfiguredError || e instanceof OffsiteBusyError || (e instanceof VaultError && e.code === 'LOCKED')) return offsiteFail(e);
      // home only and recorded in /api/health offsite.lastError: the reason (host key, permissions, network) is what the user needs
      return c.json({ ok: false, error: e instanceof Error ? e.message.replace(/\s+/g, ' ').slice(0, 300) : String(e) }, 502);
    }
  });
  api.delete('/backup/offsite', (c) => {
    requireTrusted(c);
    if (!state.vault || state.vault.locked) throw new HTTPException(409, { message: 'vault is locked' });
    const removed = state.vault.delete(NAS_ENTRY);
    offsiteSetup.cancel();
    clearOffsiteStatus();
    if (removed) {
      log.info('offsite: NAS entry removed from the vault (nothing on the NAS was touched)');
      record(c, 'backup.offsite_removed');
    }
    return c.json({ ok: true, removed });
  });
  /**
   * Unlocking the vault (security research P1-01), shared by the hub page and the CLI:
   * - home only (QUESTIONS 12: no unlocking from the phone or from the internet);
   * - the attempt is counted before anything is awaited, and one password check runs at a time;
   * - a global escalating lock on wrong master passwords (every internet client looks the same behind Docker Desktop);
   * - Telegram on every wrong password, through the alarm bot even while locked (P1-05); while locked without an alarm
   *   bot (no Telegram token) they are counted and reported right after the next successful unlock.
   */
  const unlockVault = async (c: Context, key: string, via: 'hub' | 'control port', readPassword: () => Promise<string>): Promise<Vault> => {
    const gen = lockdownGen;
    const logVia = via === 'hub' ? 'hub' : 'control';
    requireNotPasskey(c);
    // never a phone's device token, even if one ever reaches the worker directly (independent review 2026-11-10)
    if (authOf(c) === 'device') {
      record(c, 'vault.unlock_failed', { via: logVia, reason: 'paired device' });
      throw new HTTPException(403, { message: 'the vault can be unlocked only from the PC (.\\finc unlock), not from a paired device' });
    }
    if (!trusted(c)) {
      log.warn({ client: clientAddress(c), path: c.req.path }, 'vault: unlock refused from an untrusted address');
      record(c, 'vault.unlock_failed', { via: logVia, reason: 'untrusted address' }, { aggregate: true });
      throw new HTTPException(403, { message: 'the vault can be unlocked only from the PC at home (.\\finc unlock, or this page on the PC)' });
    }
    const wait = unlockGuard.retryAfterMs();
    if (wait > 0) throw new HTTPException(429, { message: `too many wrong master passwords; wait ${Math.ceil(wait / 60_000)} minutes` });
    if (!unlockAttempts.take(key)) throw new HTTPException(429, { message: 'too many unlock attempts; wait 10 minutes' });
    // the body is read OUTSIDE the gate: a slowly sent body must not hold the one password check (review 2026-11-10)
    const password = await readPassword();
    const out = await passwordGate.run(async (): Promise<{ vault: Vault } | { error: VaultError }> => {
      try {
        return { vault: await (opts.openVault ?? ((f, p) => Vault.open(f, p)))(vaultPath(), password) };
      } catch (e) {
        if (e instanceof VaultError) return { error: e };
        throw e;
      }
    });
    if (out === BUSY) throw new HTTPException(429, { message: 'another password check is running; try again in a few seconds' });
    if ('error' in out) {
      if (out.error.code !== 'BAD_PASSWORD') throw new HTTPException(400, { message: out.error.message });
      const g = unlockGuard.record();
      log.warn({ client: key, via, failures: g.failures }, 'vault: wrong master password');
      const locked = !state.vault || state.vault.locked;
      // P1-05: with an alarm bot the alert goes out at once even while locked; without one it waits for the next unlock
      const text = `a wrong master password was tried (${via}), ${g.failures} in a row${g.lockMs ? `; unlocking paused for ${Math.ceil(g.lockMs / 60_000)} min` : ''}${locked ? '; the vault stays locked' : ''}`;
      // every wrong master password is a row (home only and one check at a time, so never a flood)
      record(c, 'vault.unlock_failed', { via: logVia, reason: 'wrong password', failures: g.failures, ...(g.lockMs ? { pausedMin: Math.ceil(g.lockMs / 60_000) } : {}) });
      if (!locked) securityAlert(state.db, state.vault, text, null);
      else if (!canSendSecurityAlerts(state.db, state.vault)) lockedFailures.record();
      else {
        // not awaited (the answer must not wait for Telegram); a send that fails is still reported after the next unlock
        const at = Date.now();
        log.warn({ text }, 'security');
        void sendSecurityAlert(state.db, state.vault, text).then((r) => {
          if (!r.ok) lockedFailures.record(at);
        });
      }
      throw new HTTPException(401, { message: out.error.message });
    }
    const v = out.vault;
    if (lockedDownSince(gen)) {
      // a panic ran while the password was being checked: the vault it would open stays shut
      v.lock();
      log.warn({ via }, 'vault: an unlock finished after a lockdown; the vault stays locked');
      record(c, 'vault.unlock_failed', { via: logVia, reason: 'lockdown meanwhile' });
      throw new HTTPException(409, { message: 'everything was locked meanwhile (lockdown); unlock again' });
    }
    state.vault?.lock();
    state.vault = v;
    chatMemory.clear();
    unlockAttempts.reset(key);
    unlockGuard.reset();
    log.info(`vault unlocked via ${via}`);
    const missed = lockedFailures.take();
    record(c, 'vault.unlock_ok', { via: logVia, ...(missed ? { missedFailures: missed.count } : {}) });
    if (missed) {
      const since = new Date(missed.since).toLocaleString('en-GB', { timeZone: 'Asia/Jerusalem', dateStyle: 'short', timeStyle: 'short' });
      securityAlert(state.db, v, `${missed.count} wrong master password attempt(s) while the vault was locked (first at ${since}); then it was unlocked (${via})`, null); // in vault.unlock_ok
    }
    state.scheduler.onUnlocked?.();
    return v;
  };
  const passwordBody = z.object({ password: z.string().min(1, 'password required').max(1024) });

  api.post('/vault/unlock', async (c) => {
    await unlockVault(c, clientKey(c), 'hub', async () => passwordBody.parse(await c.req.json()).password);
    return c.json({ unlocked: true });
  });
  api.post('/vault/lock', (c) => {
    // Kept off for passkey sessions here, but note that a passkey session or a device CAN lock the vault through
    // POST /api/panic (P1-09). That denial of service is accepted on purpose: it only ever takes access away.
    requireNotPasskey(c);
    const was = !!state.vault && !state.vault.locked;
    state.vault?.lock();
    state.vault = null;
    chatMemory.clear();
    record(c, 'vault.lock', { via: 'hub', wasUnlocked: was });
    return c.json({ unlocked: false });
  });
  // --- the security log (P1-08): read-only, for any signed-in caller (PC, CLI, paired phone, passkey session)
  const optional = <T extends z.ZodTypeAny>(t: T) => z.preprocess((v) => (v === '' ? undefined : v), t.optional());
  api.get('/security-events', (c) => {
    const q = z
      .object({
        limit: optional(z.coerce.number().int().min(1).max(200)),
        before: optional(z.coerce.number().int().min(1)),
        kind: optional(z.string().max(40)),
      })
      .parse(c.req.query());
    const out = listSecurityEvents(state.db, { ...(q.limit !== undefined ? { limit: q.limit } : {}), ...(q.before !== undefined ? { beforeId: q.before } : {}), ...(q.kind ? { kind: q.kind } : {}) });
    // addresses (home network, Tailscale) only for the PC at home and the CLI: a stolen phone or passkey session
    // from outside must not learn them
    if (authOf(c) === 'token' || trusted(c)) return c.json(out);
    return c.json({ ...out, events: out.events.map((e) => ({ ...e, address: null })) });
  });
  // MCP (research_notes/proposals/mcp-server.md §5.4): the owner sees and revokes AI apps' tokens; tokens are made
  // on the PC only (`finc mcp token create`). Revoking takes access away, so any signed-in caller may do it.
  api.get('/mcp/tokens', (c) =>
    c.json({ enabled: mcpEnabled(state.db), tokens: listMcpTokens(state.db, new Date(now())).map((t) => ({ name: t.name, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt, callsToday: t.callsToday })) }),
  );
  // making one is for the CLI on the PC only (the control token): `finc mcp token create <app>` keeps it in a file
  api.post('/mcp/tokens', async (c) => {
    if (authOf(c) !== 'token') throw new HTTPException(403, { message: 'MCP tokens are made on the PC: .\\finc mcp token create <app-name>' });
    const body = z.object({ name: z.string().max(40) }).strict().safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'body: {"name": "claude-desktop"}' }, 400);
    try {
      const t = createMcpToken(state.db, body.data.name, new Date(now()));
      record(c, 'mcp.token_created', { name: t.name });
      return c.json({ name: t.name, token: t.token });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : 'could not make the token' }, 400);
    }
  });
  api.delete('/mcp/tokens/:name', (c) => {
    const name = c.req.param('name');
    if (!revokeMcpToken(state.db, name, new Date(now()))) return c.json({ error: 'no such token' }, 404);
    record(c, 'mcp.token_revoked', { name: name.slice(0, 40) });
    return c.json({ ok: true });
  });
  // remote MCP management: the window opens from home only (not a passkey session); revoking works from anywhere
  api.get('/mcp/remote', (c) => {
    const t = now();
    const base = oauthBase();
    return c.json({ enabled: mcpRemoteEnabled(state.db), endpoint: base ? `${base}/mcp` : null, windowUntil: connectWindowUntil(state.db, t), grants: listGrants(state.db, t) });
  });
  api.post('/mcp/remote/window', (c) => {
    requireTrusted(c);
    if (!mcpRemoteEnabled(state.db)) throw new HTTPException(409, { message: 'turn on remote AI apps first' });
    if (!oauthBase()) throw new HTTPException(409, { message: 'set the public address first' });
    const windowUntil = openConnectWindow(state.db, now());
    record(c, 'mcp.remote_window', { minutes: 10 });
    return c.json({ windowUntil });
  });
  api.delete('/mcp/remote/window', (c) => {
    closeConnectWindow(state.db);
    return c.json({ ok: true });
  });
  api.delete('/mcp/remote/grants/:id', (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || !revokeGrant(state.db, id, now())) return c.json({ error: 'no such connection' }, 404);
    record(c, 'mcp.remote_revoked', { grant: id });
    return c.json({ ok: true });
  });
  app.route('/api', api);

  // --- the MCP bridge's routes (design §4). Outside /api so no hub sign-in applies: only an MCP token works, only
  // while MCP is on, never through the public site (X-Finc-Edge; Caddy also answers 404). The bridge runs inside the
  // container (`finc mcp`) and calls 127.0.0.1. Results go through runMcpTool: allow-list, egress guard, size cap.
  const mcpMinute = new Map<number, { start: number; n: number }>();
  type McpGate = { ok: true; id: number; name: string } | { ok: false; res: Response };
  const mcpGate = (c: Context): McpGate => {
    if (c.req.header('x-finc-edge') !== undefined) return { ok: false, res: c.json({ error: 'not found' }, 404) };
    if (!mcpEnabled(state.db)) {
      record(c, 'mcp.refused', { reason: 'off' }, { aggregate: true });
      return { ok: false, res: c.json({ error: 'MCP is off in finc; turn it on in Settings → AI' }, 403) };
    }
    const bearer = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
    const t = now();
    const a = useMcpToken(state.db, bearer, new Date(t));
    if (!a.ok) {
      record(c, 'mcp.refused', { reason: a.reason }, { aggregate: true });
      return a.reason === 'daily_limit'
        ? { ok: false, res: c.json({ error: `this app reached its ${MCP_PER_DAY} calls for today` }, 429) }
        : { ok: false, res: c.json({ error: 'unknown or revoked MCP token' }, 401) };
    }
    const w = mcpMinute.get(a.token.id);
    if (w && t - w.start < 60_000) {
      if (w.n >= MCP_PER_MINUTE) {
        record(c, 'mcp.refused', { reason: 'minute_limit' }, { aggregate: true });
        return { ok: false, res: c.json({ error: `at most ${MCP_PER_MINUTE} calls a minute; wait a moment` }, 429) };
      }
      w.n++;
    } else {
      if (mcpMinute.size > 200) mcpMinute.clear();
      mcpMinute.set(a.token.id, { start: t, n: 1 });
    }
    return { ok: true, id: a.token.id, name: a.token.name };
  };
  app.get('/mcp/tools', (c) => {
    const g = mcpGate(c);
    if (!g.ok) return g.res;
    return c.json({ instructions: MCP_INSTRUCTIONS, tools: mcpToolList() });
  });
  app.post('/mcp/call', async (c) => {
    const g = mcpGate(c);
    if (!g.ok) return g.res;
    const parsed = z
      .object({ name: z.string().min(1).max(60), arguments: z.record(z.string(), z.unknown()).optional() })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'body: {"name": tool, "arguments": {...}}' }, 400);
    const { name, arguments: args } = parsed.data;
    const out = runMcpTool(state.db, name, args ?? {}, todayLocal(new Date(now())));
    if (out.dropped.length) log.warn({ tool: name, dropped: out.dropped.slice(0, 10) }, 'mcp: the allow-list dropped fields');
    // the tool and the argument names, never their values or the result
    record(c, 'mcp.call', { tool: name.slice(0, 40), args: Object.keys(args ?? {}).slice(0, 10), error: out.isError }, { aggregate: true, who: { actor: `mcp:${g.id}`, actorName: g.name } });
    return c.json({ structured: out.structured, isError: out.isError });
  });

  // --- control endpoints kept for the CLI (token) and anyone with a session
  // Without a token or a session the health answer says only that the worker is up (audit C2: the full
  // payload carries balances and account names).
  /**
   * The worker proves it holds the control token before the CLI sends it, or the master password (security research
   * P3-01): an HMAC of the CLI's random challenge, keyed by the token. Something else answering on 7733 cannot make it.
   * The proof says nothing about the token, so anyone may ask.
   */
  app.get('/whoami', (c) => {
    const challenge = c.req.query('challenge') ?? '';
    if (!/^[0-9a-f]{32,128}$/.test(challenge)) return c.json({ error: 'challenge: 32 to 128 hex characters' }, 400);
    return c.json({ proof: controlProof(opts.controlToken, challenge) });
  });
  app.get('/health', (c) => c.json(authOf(c) === 'none' ? { ok: true, version: FINC_VERSION } : healthPayload(state)));
  app.get('/runs', requireAuth, (c) => c.json(recentRuns(state.db, Number(c.req.query('limit') ?? '20'))));
  app.post('/unlock', async (c) => {
    requireNotPasskey(c);
    // the control port's unlock is for the CLI's control token only (review 2026-11-10: a session or device passed)
    if (authOf(c) !== 'token') throw new HTTPException(401, { message: 'control token missing: is the worker you are talking to the one that wrote data/control.token?' });
    const v = await unlockVault(c, `cli:${clientKey(c)}`, 'control port', async () => {
      const r = passwordBody.safeParse(await c.req.json().catch(() => ({})));
      if (!r.success) throw new HTTPException(400, { message: 'password required (at most 1024 characters)' });
      return r.data.password;
    });
    return c.json({ unlocked: true, entries: v.list().map((e) => e.name) });
  });
  app.post('/lock', requireAuth, (c) => {
    requireNotPasskey(c);
    const was = !!state.vault && !state.vault.locked;
    state.vault?.lock();
    state.vault = null;
    chatMemory.clear();
    record(c, 'vault.lock', { via: authOf(c) === 'token' ? 'control' : 'hub', wasUnlocked: was });
    return c.json({ unlocked: false });
  });
  app.post('/sync', requireAuth, async (c) => {
    requireNotPasskey(c);
    // dump / dryRun: `finc sync --dump / --dry-run` while the worker runs goes through here, so the CLI never opens the
    // database or the browser profile next to the worker (P1-13). The UI's /api/sync does not take them.
    const body = controlSyncBody.parse(await c.req.json().catch(() => ({})));
    // P2-02: the public site does not route /sync, but should a device ever reach it from outside, the same limit applies
    const refused = syncRefusal(c, body.months);
    if (refused) return refused;
    if (!state.vault || state.vault.locked) throw new HTTPException(409, { message: 'vault is locked; run `finc unlock`' });
    if (state.scheduler.isRunning) throw new HTTPException(409, { message: 'a sync is already running' });
    if (!atHome(c)) recordOutsideSync(state.db, now());
    const targets = body.institutions === undefined || body.institutions === 'all' ? 'all' : (body.institutions as ScrapedInstitutionId[]);
    return c.json(await state.scheduler.syncNow(targets, 'manual', outsideMonths(c, body.months), defined({ dump: body.dump, dryRun: body.dryRun, explore: body.dryRun ? body.explore : undefined })));
  });

  // --- the alarm bot (security research P1-05): `finc alerts alarm ...` only, i.e. the control token AND home. Never a
  // session, a passkey or a phone: whoever controls this bot decides whether intrusion alerts arrive.
  const requireControl = (c: Context): void => {
    if (authOf(c) !== 'token') throw new HTTPException(401, { message: 'the alarm bot is managed from the PC only (.\\finc alerts alarm ...): control token missing' });
    if (!trusted(c)) {
      log.warn({ client: clientAddress(c), path: c.req.path }, 'alarm: refused from an untrusted address');
      throw new HTTPException(403, { message: 'the alarm bot is managed from the PC at home only' });
    }
  };
  const alarmView = () => {
    const bot = readAlarmBot();
    return { configured: !!bot, bot: bot?.username ?? null, savedAt: bot?.savedAt ?? null, chatBound: !!alertConfig(state.db).telegramChatId, ...securityAlertStatus(state.db, state.vault) };
  };
  app.get('/alarm', (c) => {
    requireControl(c);
    return c.json(alarmView());
  });
  app.post('/alarm/setup', async (c) => {
    requireControl(c);
    const r = z.object({ token: z.string().min(1).max(200) }).safeParse(await c.req.json().catch(() => ({})));
    if (!r.success) throw new HTTPException(400, { message: 'token required' });
    const replaced = readAlarmBot();
    const resume = opts.alarmPause?.();
    try {
      const { username } = await setupAlarmBot(state.db, state.vault, r.data.token);
      securityAlert(state.db, state.vault, `${replaced ? 'the alarm bot was replaced' : 'an alarm bot was set up'}: ${username ? `@${username}` : 'a new bot'}; security alerts go through it now`, ev(c, 'alarm.set_up', { replaced: !!replaced, bot: username ?? null }));
      return c.json({ ok: true, bot: username });
    } catch (e) {
      if (e instanceof AlarmSetupError) throw new HTTPException(e.status, { message: e.message });
      throw e;
    } finally {
      resume?.();
    }
  });
  app.post('/alarm/test', async (c) => {
    requireControl(c);
    const r = await sendSecurityAlert(state.db, state.vault, 'test: this is how finc security alerts arrive', { retryDelayMs: 1000 });
    if (r.channel === 'none') throw new HTTPException(409, { message: 'no channel for security alerts: set up an alarm bot (finc alerts alarm setup), or bind the Telegram chat and unlock the vault' });
    if (!r.ok) return c.json({ ok: false, channel: r.channel, error: r.error ?? 'telegram error' }, 502);
    return c.json({ ok: true, channel: r.channel });
  });
  app.delete('/alarm', async (c) => {
    requireControl(c);
    // said through the alarm bot itself, before it goes, so a removal is never silent
    const resume = opts.alarmPause?.();
    let removed: boolean;
    try {
      if (readAlarmBot()) await sendSecurityAlert(state.db, state.vault, 'the alarm bot was removed; security alerts now need the vault unlocked (main bot)', { retryDelayMs: 1000 });
      removed = removeAlarmBot();
    } finally {
      resume?.();
    }
    if (removed) {
      log.info('alarm bot: removed');
      record(c, 'alarm.removed');
    }
    return c.json({ ok: true, removed });
  });

  // --- the web app
  app.get('*', (c) => {
    if (c.req.path.startsWith('/api/')) return c.json({ error: 'not found' }, 404);
    const res = serveStatic(webDist, c.req.path);
    return res ?? c.text('finc worker is running; the hub is not built (pnpm --filter @finc/web build)', 200);
  });

  return { app, sessions, panic };
}

export function healthPayload(state: WorkerState): unknown {
  return {
    version: FINC_VERSION,
    scrapers: PINNED.israeliBankScrapers,
    node: process.version,
    uptimeSec: Math.round((Date.now() - state.startedAt) / 1000),
    vault: Vault.exists(vaultPath()) ? (state.vault && !state.vault.locked ? 'unlocked' : 'locked') : 'missing',
    syncPendingSince: state.scheduler.syncPendingSince ?? null,
    syncRunning: state.scheduler.isRunning,
    nextRunAt: state.scheduler.nextRun()?.toISOString() ?? null,
    schedule: state.scheduler.config,
    connections: connectionHealth(state.db),
    backup: backupHealth(state),
    securityAlerts: securityAlertStatus(state.db, state.vault),
    // the hub's TLS key against the phone's pins (P1-10): state, time, days left, an 8-character pin prefix only
    tls: state.tls?.status() ?? null,
  };
}

type OffsiteHealth = Pick<OffsiteStatus, 'configured' | 'target' | 'lastOkAt' | 'lastFile' | 'lastError' | 'lastErrorAt'>;

function backupHealth(state: WorkerState): { lastOkAt: string | null; lastFile: string | null; lastError: string | null; lastErrorAt: string | null; pending: boolean; count: number; dir: string | null; offsite: OffsiteHealth } {
  const s = state.scheduler.backup?.status();
  const o = state.scheduler.backup?.offsite?.status();
  const offsite: OffsiteHealth = o
    ? { configured: o.configured, target: o.target, lastOkAt: o.lastOkAt, lastFile: o.lastFile, lastError: o.lastError, lastErrorAt: o.lastErrorAt }
    : { configured: null, target: null, lastOkAt: getSetting(state.db, OFFSITE_SETTINGS.lastOkAt), lastFile: getSetting(state.db, OFFSITE_SETTINGS.lastFile), lastError: getSetting(state.db, OFFSITE_SETTINGS.lastError), lastErrorAt: getSetting(state.db, OFFSITE_SETTINGS.lastErrorAt) };
  if (s) return { lastOkAt: s.lastOkAt, lastFile: s.lastFile, lastError: s.lastError, lastErrorAt: s.lastErrorAt, pending: s.pending, count: s.count, dir: s.dir, offsite };
  // a scheduler without the backup job (test stubs): what the settings say
  return { lastOkAt: getSetting(state.db, 'backup.lastOkAt'), lastFile: getSetting(state.db, 'backup.lastFile'), lastError: getSetting(state.db, 'backup.lastError'), lastErrorAt: getSetting(state.db, 'backup.lastErrorAt'), pending: false, count: 0, dir: null, offsite };
}
