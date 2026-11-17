/**
 * Remote MCP's authorization server, the parts that hold state (research_notes/proposals/remote-mcp.md §4): which apps
 * may connect, the connection window, PKCE codes, grants and tokens. One owner; read-only scope `finc.read`.
 *
 * - Clients: ChatGPT by its Client ID Metadata Document (an allow-listed URL), Claude by Dynamic Client Registration;
 *   either way every redirect URI must be that app's own callback.
 * - A code is single-use, 60 seconds, bound to client, redirect URI, PKCE S256 challenge and resource.
 * - Access tokens 1 hour; refresh tokens 30 days, rotated on every use; a reused refresh token revokes the grant.
 * - Only SHA-256 hashes of tokens are stored. Tokens never appear in a log or a security event.
 */
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as cryptoVerify } from 'node:crypto';
import { getSetting, setSetting } from '../ai/settings.js';
import type { Db } from '../db/db.js';
import { MCP_PER_DAY } from './mcp.js';
import { todayLocal } from './overview.js';

export const OAUTH_SCOPE = 'finc.read';
export const ACCESS_TTL_S = 3600;
export const REFRESH_TTL_DAYS = 30;
export const CODE_TTL_MS = 60_000;
export const WINDOW_MS = 10 * 60_000;
export const REQUEST_TTL_MS = 10 * 60_000;
/** registered (DCR) clients kept at most; unused ones older than a day go first */
export const MAX_DCR_CLIENTS = 50;

export const MCP_REMOTE_SETTING = 'mcp.remote.enabled';
export const MCP_WINDOW_SETTING = 'mcp.remote.windowUntil';
/** remote MCP's own public origin (e.g. on port 443 for ChatGPT); unset = the hub's public address */
export const MCP_REMOTE_URL_SETTING = 'mcp.remote.publicUrl';

export type OAuthApp = 'ChatGPT' | 'Claude';

/** The client metadata document URLs finc will fetch (no other URL is ever fetched). */
export const CIMD_ALLOWED: Readonly<Record<string, OAuthApp>> = { 'https://chatgpt.com/oauth/client.json': 'ChatGPT' };

/**
 * Clients that must prove themselves at the token endpoint with a JWT signed by their own key (RFC 7523
 * private_key_jwt), and the only key list (JWKS) finc fetches for each. ChatGPT publishes one; a stolen refresh token
 * alone is then useless outside OpenAI's servers.
 */
export const CLIENT_JWKS: Readonly<Record<string, string>> = { 'https://chatgpt.com/oauth/client.json': 'https://chatgpt.com/oauth/jwks.json' };
export const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
/** an assertion may live at most this long (exp - now) */
const ASSERTION_MAX_S = 600;
const SKEW_S = 60;

const REDIRECTS: ReadonlyArray<[RegExp, OAuthApp]> = [
  [/^https:\/\/chatgpt\.com\/connector_platform_oauth_redirect$/, 'ChatGPT'],
  [/^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]{1,100}$/, 'ChatGPT'],
  [/^https:\/\/claude\.ai\/api\/mcp\/auth_callback$/, 'Claude'],
  [/^https:\/\/claude\.com\/api\/mcp\/auth_callback$/, 'Claude'],
];

/** The app a redirect URI belongs to, or null when it is not an allowed callback. Exact patterns, no normalising. */
export function appForRedirect(uri: unknown): OAuthApp | null {
  if (typeof uri !== 'string' || uri.length > 300) return null;
  return REDIRECTS.find(([re]) => re.test(uri))?.[1] ?? null;
}

/** One app for every URI, or null (mixed apps, unknown callbacks, none, or too many). */
function appForRedirects(uris: unknown): { app: OAuthApp; uris: string[] } | null {
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > 5) return null;
  const apps = uris.map(appForRedirect);
  if (apps.some((a) => a === null) || new Set(apps).size !== 1) return null;
  return { app: apps[0]!, uris: uris as string[] };
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const rand = (prefix: string): string => prefix + randomBytes(32).toString('base64url');
const iso = (ms: number): string => new Date(ms).toISOString();

// --- switch and window

export const mcpRemoteEnabled = (db: Db): boolean => getSetting(db, MCP_REMOTE_SETTING) === 'on';
export const setMcpRemoteEnabled = (db: Db, on: boolean): void => setSetting(db, MCP_REMOTE_SETTING, on ? 'on' : null);

/** Opens the 10-minute connection window (design §4.1); returns when it closes. */
export function openConnectWindow(db: Db, now: number): string {
  const until = iso(now + WINDOW_MS);
  setSetting(db, MCP_WINDOW_SETTING, until);
  return until;
}
export const closeConnectWindow = (db: Db): void => setSetting(db, MCP_WINDOW_SETTING, null);
/** When the window closes, or null when it is shut. */
export function connectWindowUntil(db: Db, now: number): string | null {
  const v = getSetting(db, MCP_WINDOW_SETTING);
  return v && Date.parse(v) > now ? v : null;
}

// --- clients

export interface OAuthClient {
  clientId: string;
  kind: 'cimd' | 'dcr';
  app: OAuthApp;
  redirectUris: string[];
}

type ClientRow = { client_id: string; kind: string; app: string; redirect_uris: string };
const clientOf = (r: ClientRow): OAuthClient => ({ clientId: r.client_id, kind: r.kind as 'cimd' | 'dcr', app: r.app as OAuthApp, redirectUris: JSON.parse(r.redirect_uris) as string[] });

export function getOAuthClient(db: Db, clientId: string): OAuthClient | null {
  const r = db.$client.prepare('select client_id, kind, app, redirect_uris from oauth_client where client_id = ?').get(clientId) as ClientRow | undefined;
  return r ? clientOf(r) : null;
}

export type RegisterResult = { ok: true; client: OAuthClient } | { ok: false; error: 'invalid_redirect_uri' | 'invalid_client_metadata'; description: string };

/**
 * Dynamic Client Registration (RFC 7591), for Claude: a public client (no secret), authorization_code (+ refresh_token),
 * response type code, and every redirect URI one app's callback. Anything else is refused.
 */
export function registerOAuthClient(db: Db, body: unknown, now: number): RegisterResult {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!b) return { ok: false, error: 'invalid_client_metadata', description: 'a JSON object is required' };
  const r = appForRedirects(b.redirect_uris);
  if (!r) return { ok: false, error: 'invalid_redirect_uri', description: 'finc accepts only the ChatGPT and Claude callbacks' };
  const auth = b.token_endpoint_auth_method ?? 'none';
  if (auth !== 'none') return { ok: false, error: 'invalid_client_metadata', description: 'only public clients (token_endpoint_auth_method "none") with PKCE' };
  const grants = (b.grant_types ?? ['authorization_code']) as unknown;
  if (!Array.isArray(grants) || grants.some((g) => g !== 'authorization_code' && g !== 'refresh_token')) return { ok: false, error: 'invalid_client_metadata', description: 'grant_types: authorization_code and refresh_token only' };
  const types = (b.response_types ?? ['code']) as unknown;
  if (!Array.isArray(types) || types.some((t) => t !== 'code')) return { ok: false, error: 'invalid_client_metadata', description: 'response_types: code only' };
  // room for a new one: drop registrations never used and older than a day, then refuse past the cap
  db.$client.prepare(`delete from oauth_client where kind = 'dcr' and last_used_at is null and created_at < ?`).run(iso(now - 86_400_000));
  const n = (db.$client.prepare(`select count(*) n from oauth_client where kind = 'dcr'`).get() as { n: number }).n;
  if (n >= MAX_DCR_CLIENTS) return { ok: false, error: 'invalid_client_metadata', description: 'too many registered clients; revoke unused apps in finc first' };
  const clientId = `finc_client_${randomBytes(16).toString('base64url')}`;
  db.$client.prepare('insert into oauth_client (client_id, kind, app, redirect_uris, created_at) values (?, ?, ?, ?, ?)').run(clientId, 'dcr', r.app, JSON.stringify(r.uris), iso(now));
  return { ok: true, client: { clientId, kind: 'dcr', app: r.app, redirectUris: r.uris } };
}

/**
 * A Client ID Metadata Document, already fetched by the worker from an allow-listed URL: its client_id must be that
 * URL and its redirect URIs that app's callbacks. Saved (or refreshed) as a client.
 */
export function acceptClientMetadata(db: Db, url: string, doc: unknown, now: number): RegisterResult {
  const app = CIMD_ALLOWED[url];
  const d = doc && typeof doc === 'object' && !Array.isArray(doc) ? (doc as Record<string, unknown>) : null;
  if (!app || !d || d.client_id !== url) return { ok: false, error: 'invalid_client_metadata', description: 'not an accepted client' };
  const r = appForRedirects(d.redirect_uris);
  if (!r || r.app !== app) return { ok: false, error: 'invalid_redirect_uri', description: 'the document lists callbacks finc does not accept' };
  if (d.jwks_uri !== undefined && d.jwks_uri !== CLIENT_JWKS[url]) return { ok: false, error: 'invalid_client_metadata', description: 'the document names a key list finc does not use' };
  // a public client with PKCE: its preferred method, or one it lists as supported (ChatGPT prefers private_key_jwt and
  // lists "none" too; finc advertises "none" only, so that is what it uses; found live 2026-11-17)
  const auth = d.token_endpoint_auth_method ?? 'none';
  const supported = Array.isArray(d.token_endpoint_auth_methods_supported) ? (d.token_endpoint_auth_methods_supported as unknown[]) : [];
  if (auth !== 'none' && !supported.includes('none')) return { ok: false, error: 'invalid_client_metadata', description: 'only public clients with PKCE' };
  db.$client
    .prepare(`insert into oauth_client (client_id, kind, app, redirect_uris, created_at) values (?, 'cimd', ?, ?, ?) on conflict(client_id) do update set redirect_uris = excluded.redirect_uris`)
    .run(url, app, JSON.stringify(r.uris), iso(now));
  return { ok: true, client: { clientId: url, kind: 'cimd', app, redirectUris: r.uris } };
}

// --- private_key_jwt (RFC 7523 §2.2, RFC 7521 §4.2)

type Jwk = { kty?: unknown; kid?: unknown; alg?: unknown; use?: unknown; n?: unknown; e?: unknown; crv?: unknown; x?: unknown; y?: unknown };

const b64json = (part: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** jti values already used, until their assertion expires (a replayed assertion is refused). */
export class SeenJti {
  private seen = new Map<string, number>();
  /** true the first time; false for a replay */
  use(jti: string, expMs: number, now: number): boolean {
    for (const [k, v] of this.seen) if (v <= now) this.seen.delete(k);
    if (this.seen.has(jti)) return false;
    if (this.seen.size > 5000) return false; // fail closed rather than grow without bound
    this.seen.set(jti, expMs);
    return true;
  }
}

export type AssertionCheck = { ok: true; kid: string } | { ok: false; reason: string; unknownKid?: boolean };

/**
 * A client assertion: a compact JWS, RS256 or ES256 only, signed by a key in the client's JWKS (matched by kid);
 * iss = sub = client_id; aud is the token endpoint or the issuer; exp in the future and at most 10 minutes away;
 * iat/nbf not in the future; a jti never seen before. `unknownKid` tells the caller to refresh the key list once.
 */
export function checkClientAssertion(jwt: unknown, x: { clientId: string; audiences: string[]; jwks: unknown; now: number; seen: SeenJti }): AssertionCheck {
  if (typeof jwt !== 'string' || jwt.length > 8192) return { ok: false, reason: 'malformed' };
  const parts = jwt.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return { ok: false, reason: 'malformed' };
  const header = b64json(parts[0]!);
  const claims = b64json(parts[1]!);
  if (!header || !claims) return { ok: false, reason: 'malformed' };
  const alg = header.alg;
  if (alg !== 'RS256' && alg !== 'ES256') return { ok: false, reason: 'alg' };
  if (header.crit !== undefined) return { ok: false, reason: 'crit' };
  const keys = (x.jwks && typeof x.jwks === 'object' && Array.isArray((x.jwks as { keys?: unknown }).keys) ? (x.jwks as { keys: Jwk[] }).keys : []).filter(
    (k) => k && (k.use === undefined || k.use === 'sig') && (k.alg === undefined || k.alg === alg) && (alg === 'RS256' ? k.kty === 'RSA' : k.kty === 'EC' && k.crv === 'P-256'),
  );
  const kid = typeof header.kid === 'string' ? header.kid : undefined;
  const key = kid !== undefined ? keys.find((k) => k.kid === kid) : keys.length === 1 ? keys[0] : undefined;
  if (!key) return { ok: false, reason: 'unknown key', unknownKid: true };
  let valid = false;
  try {
    const pub = createPublicKey({ key: (alg === 'RS256' ? { kty: 'RSA', n: key.n, e: key.e } : { kty: 'EC', crv: 'P-256', x: key.x, y: key.y }) as never, format: 'jwk' });
    const data = Buffer.from(`${parts[0]}.${parts[1]}`);
    const sig = Buffer.from(parts[2]!, 'base64url');
    valid = alg === 'RS256' ? cryptoVerify('RSA-SHA256', data, pub, sig) : cryptoVerify('sha256', data, { key: pub, dsaEncoding: 'ieee-p1363' }, sig);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'signature' };
  if (claims.iss !== x.clientId || claims.sub !== x.clientId) return { ok: false, reason: 'iss/sub' };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.some((a) => typeof a === 'string' && x.audiences.includes(a))) return { ok: false, reason: 'aud' };
  const now = x.now / 1000;
  const exp = claims.exp;
  if (typeof exp !== 'number' || exp <= now - SKEW_S) return { ok: false, reason: 'expired' };
  if (exp > now + ASSERTION_MAX_S + SKEW_S) return { ok: false, reason: 'exp too far' };
  if (typeof claims.iat === 'number' && claims.iat > now + SKEW_S) return { ok: false, reason: 'iat in the future' };
  if (typeof claims.nbf === 'number' && claims.nbf > now + SKEW_S) return { ok: false, reason: 'not yet valid' };
  if (typeof claims.jti !== 'string' || !claims.jti || claims.jti.length > 200) return { ok: false, reason: 'jti' };
  if (!x.seen.use(`${x.clientId} ${claims.jti}`, (exp + SKEW_S) * 1000, x.now)) return { ok: false, reason: 'replayed' };
  return { ok: true, kid: typeof key.kid === 'string' ? key.kid : '' };
}

// --- PKCE and codes

/** RFC 7636 S256: the verifier is 43–128 unreserved characters and hashes to the challenge. */
export function pkceMatches(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const got = Buffer.from(createHash('sha256').update(verifier).digest('base64url'));
  const want = Buffer.from(challenge);
  return got.length === want.length && timingSafeEqual(got, want);
}
export const validChallenge = (c: unknown): c is string => typeof c === 'string' && /^[A-Za-z0-9_-]{43}$/.test(c);

export interface CodeGrant {
  clientId: string;
  app: OAuthApp;
  redirectUri: string;
  challenge: string;
  resource: string;
}

/** Authorization codes, in memory: single-use, 60 seconds. A worker restart drops them (the app just asks again). */
export class OAuthCodes {
  private codes = new Map<string, CodeGrant & { expires: number }>();

  issue(g: CodeGrant, now: number): string {
    for (const [k, v] of this.codes) if (v.expires <= now) this.codes.delete(k);
    if (this.codes.size > 100) this.codes.clear();
    const code = randomBytes(32).toString('base64url');
    this.codes.set(sha(code), { ...g, expires: now + CODE_TTL_MS });
    return code;
  }

  /** Forgets every code (the panic button). */
  clear(): void {
    this.codes.clear();
  }

  /** Redeems a code once (it is gone after the first attempt, right or wrong). */
  redeem(code: unknown, x: { clientId: unknown; redirectUri: unknown; verifier: unknown; resource: unknown }, now: number): { ok: true; grant: CodeGrant } | { ok: false; error: 'invalid_grant'; description: string } {
    if (typeof code !== 'string' || code.length > 200) return { ok: false, error: 'invalid_grant', description: 'unknown code' };
    const key = sha(code);
    const g = this.codes.get(key);
    this.codes.delete(key);
    if (!g || g.expires <= now) return { ok: false, error: 'invalid_grant', description: 'unknown or expired code' };
    if (x.clientId !== g.clientId) return { ok: false, error: 'invalid_grant', description: 'the code was issued to another client' };
    if (x.redirectUri !== g.redirectUri) return { ok: false, error: 'invalid_grant', description: 'redirect_uri does not match' };
    if (x.resource !== undefined && x.resource !== g.resource) return { ok: false, error: 'invalid_grant', description: 'resource does not match' };
    if (!pkceMatches(x.verifier, g.challenge)) return { ok: false, error: 'invalid_grant', description: 'code_verifier does not match' };
    const { expires: _e, ...grant } = g;
    return { ok: true, grant };
  }
}

// --- grants and tokens

export interface TokenSet {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
}

function issue(db: Db, grantId: number, now: number): TokenSet {
  const access = rand('finc_at_');
  const refresh = rand('finc_rt_');
  const ins = db.$client.prepare('insert into oauth_token (grant_id, kind, token_hash, created_at, expires_at) values (?, ?, ?, ?, ?)');
  ins.run(grantId, 'access', sha(access), iso(now), iso(now + ACCESS_TTL_S * 1000));
  const refreshUntil = iso(now + REFRESH_TTL_DAYS * 86_400_000);
  ins.run(grantId, 'refresh', sha(refresh), iso(now), refreshUntil);
  db.$client.prepare('update oauth_grant set refresh_expires_at = ? where id = ?').run(refreshUntil, grantId);
  // old, dead tokens of this grant are of no use
  db.$client.prepare(`delete from oauth_token where grant_id = ? and expires_at < ?`).run(grantId, iso(now - 86_400_000));
  return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: ACCESS_TTL_S, scope: OAUTH_SCOPE };
}

/** A new grant from a redeemed code, with its first tokens. */
export function createGrant(db: Db, g: CodeGrant, now: number, clientAuth: 'none' | 'private_key_jwt' = 'none'): { grantId: number; tokens: TokenSet } {
  return db.$client.transaction(() => {
    const r = db.$client.prepare('insert into oauth_grant (client_id, app, resource, created_at, refresh_expires_at, client_auth) values (?, ?, ?, ?, ?, ?)').run(g.clientId, g.app, g.resource, iso(now), iso(now), clientAuth);
    const grantId = Number(r.lastInsertRowid);
    db.$client.prepare('update oauth_client set last_used_at = ? where client_id = ?').run(iso(now), g.clientId);
    return { grantId, tokens: issue(db, grantId, now) };
  })();
}

export type RefreshResult = { ok: true; grantId: number; tokens: TokenSet } | { ok: false; error: 'invalid_grant'; description: string; reused?: { grantId: number } };

/**
 * Rotates a refresh token. A token already used once revokes its whole grant (RFC 9700 refresh token reuse). A grant
 * that began with a signed client assertion needs one again (`assertionVerified`), checked before the token is spent.
 */
export function refreshGrant(db: Db, token: unknown, clientId: unknown, resource: unknown, now: number, assertionVerified = false): RefreshResult {
  if (typeof token !== 'string' || !token.startsWith('finc_rt_') || token.length > 120) return { ok: false, error: 'invalid_grant', description: 'unknown refresh token' };
  return db.$client.transaction((): RefreshResult => {
    const t = db.$client
      .prepare(`select t.id, t.grant_id, t.expires_at, t.used_at, g.client_id, g.resource, g.revoked_at, g.client_auth from oauth_token t join oauth_grant g on g.id = t.grant_id where t.token_hash = ? and t.kind = 'refresh'`)
      .get(sha(token)) as { id: number; grant_id: number; expires_at: string; used_at: string | null; client_id: string; resource: string; revoked_at: string | null; client_auth: string } | undefined;
    if (!t || t.revoked_at !== null) return { ok: false, error: 'invalid_grant', description: 'unknown or revoked refresh token' };
    if (t.client_auth === 'private_key_jwt' && !assertionVerified) return { ok: false, error: 'invalid_grant', description: 'this connection signs its requests; the client assertion is missing' };
    if (t.used_at !== null) {
      revokeGrantById(db, t.grant_id, 'refresh_reuse', now);
      return { ok: false, error: 'invalid_grant', description: 'refresh token already used; the connection is revoked', reused: { grantId: t.grant_id } };
    }
    if (Date.parse(t.expires_at) <= now) return { ok: false, error: 'invalid_grant', description: 'refresh token expired' };
    if (clientId !== t.client_id) return { ok: false, error: 'invalid_grant', description: 'the token was issued to another client' };
    if (resource !== undefined && resource !== t.resource) return { ok: false, error: 'invalid_grant', description: 'resource does not match' };
    db.$client.prepare('update oauth_token set used_at = ? where id = ?').run(iso(now), t.id);
    return { ok: true, grantId: t.grant_id, tokens: issue(db, t.grant_id, now) };
  })();
}

export type AccessCheck = { ok: true; grantId: number; app: OAuthApp } | { ok: false; reason: 'unknown' | 'expired' | 'revoked' | 'audience' | 'daily_limit' };

/** Checks an access token for this resource and counts one call for today. */
export function useAccessToken(db: Db, token: string | undefined, resource: string, now: number): AccessCheck {
  if (typeof token !== 'string' || !token.startsWith('finc_at_') || token.length > 120) return { ok: false, reason: 'unknown' };
  const t = db.$client
    .prepare(`select t.expires_at, g.id grant_id, g.app, g.resource, g.revoked_at, g.calls_day, g.calls_today from oauth_token t join oauth_grant g on g.id = t.grant_id where t.token_hash = ? and t.kind = 'access'`)
    .get(sha(token)) as { expires_at: string; grant_id: number; app: OAuthApp; resource: string; revoked_at: string | null; calls_day: string | null; calls_today: number } | undefined;
  if (!t) return { ok: false, reason: 'unknown' };
  if (t.revoked_at !== null) return { ok: false, reason: 'revoked' };
  if (Date.parse(t.expires_at) <= now) return { ok: false, reason: 'expired' };
  if (t.resource !== resource) return { ok: false, reason: 'audience' };
  const today = todayLocal(new Date(now));
  const calls = t.calls_day === today ? t.calls_today : 0;
  if (calls >= MCP_PER_DAY) return { ok: false, reason: 'daily_limit' };
  db.$client.prepare('update oauth_grant set last_used_at = ?, calls_day = ?, calls_today = ? where id = ?').run(iso(now), today, calls + 1, t.grant_id);
  return { ok: true, grantId: t.grant_id, app: t.app };
}

export interface GrantView {
  id: number;
  app: OAuthApp;
  createdAt: string;
  lastUsedAt: string | null;
  callsToday: number;
  expiresAt: string;
}

/** Active grants (not revoked, refresh not expired), most recently used first. */
export function listGrants(db: Db, now: number): GrantView[] {
  const today = todayLocal(new Date(now));
  const rows = db.$client
    .prepare(`select id, app, created_at, last_used_at, refresh_expires_at, calls_day, calls_today from oauth_grant where revoked_at is null and refresh_expires_at > ? order by coalesce(last_used_at, created_at) desc, id desc`)
    .all(iso(now)) as Array<{ id: number; app: OAuthApp; created_at: string; last_used_at: string | null; refresh_expires_at: string; calls_day: string | null; calls_today: number }>;
  return rows.map((r) => ({ id: r.id, app: r.app, createdAt: r.created_at, lastUsedAt: r.last_used_at, callsToday: r.calls_day === today ? r.calls_today : 0, expiresAt: r.refresh_expires_at }));
}

function revokeGrantById(db: Db, id: number, reason: string, now: number): boolean {
  const changed = db.$client.prepare('update oauth_grant set revoked_at = ?, revoked_reason = ? where id = ? and revoked_at is null').run(iso(now), reason, id).changes > 0;
  db.$client.prepare('delete from oauth_token where grant_id = ?').run(id);
  return changed;
}
export const revokeGrant = (db: Db, id: number, now: number): boolean => revokeGrantById(db, id, 'removed', now);

/** The panic button: every grant and token goes. */
export function revokeAllGrants(db: Db, now: number): number {
  const ids = (db.$client.prepare('select id from oauth_grant where revoked_at is null').all() as Array<{ id: number }>).map((r) => r.id);
  for (const id of ids) revokeGrantById(db, id, 'panic', now);
  return ids.length;
}
