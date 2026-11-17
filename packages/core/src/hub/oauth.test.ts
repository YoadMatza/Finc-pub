import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/db.js';
import {
  OAuthCodes,
  acceptClientMetadata,
  appForRedirect,
  closeConnectWindow,
  connectWindowUntil,
  createGrant,
  listGrants,
  openConnectWindow,
  pkceMatches,
  refreshGrant,
  registerOAuthClient,
  revokeAllGrants,
  revokeGrant,
  useAccessToken,
} from './oauth.js';

// remote MCP (research_notes/proposals/remote-mcp.md §4): every rule of the authorization server's state

const T0 = Date.parse('2026-11-17T10:00:00Z');
const RES = 'https://finc.example:7443/mcp';
const VERIFIER = 'v'.repeat(43) + 'abcDEF123-._~';
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const CLAUDE = 'https://claude.ai/api/mcp/auth_callback';

describe('which apps may connect', () => {
  it('only the ChatGPT and Claude callbacks, exactly', () => {
    expect(appForRedirect('https://chatgpt.com/connector_platform_oauth_redirect')).toBe('ChatGPT');
    expect(appForRedirect('https://chatgpt.com/connector/oauth/abc_123')).toBe('ChatGPT');
    expect(appForRedirect(CLAUDE)).toBe('Claude');
    expect(appForRedirect('https://claude.com/api/mcp/auth_callback')).toBe('Claude');
    for (const bad of ['http://claude.ai/api/mcp/auth_callback', 'https://claude.ai/api/mcp/auth_callback/', 'https://claude.ai.evil.com/api/mcp/auth_callback', 'https://evil.com/?https://claude.ai/api/mcp/auth_callback', 'https://CLAUDE.AI/api/mcp/auth_callback', 'https://chatgpt.com/connector/oauth/../x', 'http://localhost:3000/callback', 42])
      expect(appForRedirect(bad), String(bad)).toBeNull();
  });

  it('registration (Claude): public clients with Claude callbacks only; unused ones expire', () => {
    const db = openDb(':memory:');
    const ok = registerOAuthClient(db, { redirect_uris: [CLAUDE], client_name: 'Claude', token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }, T0);
    expect(ok).toMatchObject({ ok: true, client: { app: 'Claude', kind: 'dcr' } });
    expect(registerOAuthClient(db, { redirect_uris: ['https://evil.example/cb'] }, T0)).toMatchObject({ ok: false, error: 'invalid_redirect_uri' });
    expect(registerOAuthClient(db, { redirect_uris: [CLAUDE, 'https://chatgpt.com/connector_platform_oauth_redirect'] }, T0)).toMatchObject({ ok: false });
    expect(registerOAuthClient(db, { redirect_uris: [CLAUDE], token_endpoint_auth_method: 'client_secret_basic' }, T0)).toMatchObject({ ok: false });
    expect(registerOAuthClient(db, { redirect_uris: [CLAUDE], grant_types: ['client_credentials'] }, T0)).toMatchObject({ ok: false });
    expect(registerOAuthClient(db, { redirect_uris: [CLAUDE], response_types: ['token'] }, T0)).toMatchObject({ ok: false });
    for (let i = 0; i < 60; i++) registerOAuthClient(db, { redirect_uris: [CLAUDE] }, T0);
    expect(registerOAuthClient(db, { redirect_uris: [CLAUDE] }, T0)).toMatchObject({ ok: false }); // capped
    expect(registerOAuthClient(db, { redirect_uris: [CLAUDE] }, T0 + 2 * 86_400_000)).toMatchObject({ ok: true }); // the unused ones aged out
  });

  it('metadata documents (ChatGPT): only from the allow-listed URL, naming itself, with ChatGPT callbacks', () => {
    const db = openDb(':memory:');
    const url = 'https://chatgpt.com/oauth/client.json';
    expect(acceptClientMetadata(db, url, { client_id: url, redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'] }, T0)).toMatchObject({ ok: true, client: { app: 'ChatGPT', kind: 'cimd' } });
    expect(acceptClientMetadata(db, 'https://evil.example/client.json', { client_id: 'https://evil.example/client.json', redirect_uris: [CLAUDE] }, T0)).toMatchObject({ ok: false });
    expect(acceptClientMetadata(db, url, { client_id: 'https://other', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'] }, T0)).toMatchObject({ ok: false });
    expect(acceptClientMetadata(db, url, { client_id: url, redirect_uris: [CLAUDE] }, T0)).toMatchObject({ ok: false, error: 'invalid_redirect_uri' });
  });

  it('the connection window: 10 minutes, then shut; can be closed early', () => {
    const db = openDb(':memory:');
    expect(connectWindowUntil(db, T0)).toBeNull();
    openConnectWindow(db, T0);
    expect(connectWindowUntil(db, T0 + 9 * 60_000)).not.toBeNull();
    expect(connectWindowUntil(db, T0 + 10 * 60_000 + 1)).toBeNull();
    openConnectWindow(db, T0);
    closeConnectWindow(db);
    expect(connectWindowUntil(db, T0 + 1000)).toBeNull();
  });
});

describe('codes', () => {
  const g = { clientId: 'c1', app: 'Claude' as const, redirectUri: CLAUDE, challenge: CHALLENGE, resource: RES };
  const right = { clientId: 'c1', redirectUri: CLAUDE, verifier: VERIFIER, resource: RES };

  it('PKCE S256', () => {
    expect(pkceMatches(VERIFIER, CHALLENGE)).toBe(true);
    expect(pkceMatches(`${VERIFIER}x`, CHALLENGE)).toBe(false);
    expect(pkceMatches('short', CHALLENGE)).toBe(false);
  });

  it('single use, 60 seconds, bound to client, redirect, verifier and resource', () => {
    const c = new OAuthCodes();
    const code = c.issue(g, T0);
    expect(c.redeem(code, right, T0 + 1000)).toMatchObject({ ok: true, grant: { clientId: 'c1', resource: RES } });
    expect(c.redeem(code, right, T0 + 1000)).toMatchObject({ ok: false }); // replay
    for (const [what, x] of [
      ['client', { ...right, clientId: 'c2' }],
      ['redirect', { ...right, redirectUri: 'https://claude.com/api/mcp/auth_callback' }],
      ['verifier', { ...right, verifier: 'w'.repeat(50) }],
      ['resource', { ...right, resource: 'https://other.example/mcp' }],
    ] as const) {
      const k = c.issue(g, T0);
      expect(c.redeem(k, x, T0 + 1000), what).toMatchObject({ ok: false });
      expect(c.redeem(k, right, T0 + 1000), `${what}: gone after a wrong try`).toMatchObject({ ok: false });
    }
    const late = c.issue(g, T0);
    expect(c.redeem(late, right, T0 + 61_000)).toMatchObject({ ok: false });
  });
});

describe('grants and tokens', () => {
  const g = { clientId: 'c1', app: 'Claude' as const, redirectUri: CLAUDE, challenge: CHALLENGE, resource: RES };

  it('an access token works for its resource for an hour, and counts calls', () => {
    const db = openDb(':memory:');
    const { tokens } = createGrant(db, g, T0);
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'finc.read' });
    expect(useAccessToken(db, tokens.access_token, RES, T0 + 1000)).toMatchObject({ ok: true, app: 'Claude' });
    expect(useAccessToken(db, tokens.access_token, 'https://other.example/mcp', T0 + 1000)).toMatchObject({ ok: false, reason: 'audience' });
    expect(useAccessToken(db, tokens.access_token, RES, T0 + 3_600_001)).toMatchObject({ ok: false, reason: 'expired' });
    expect(useAccessToken(db, tokens.refresh_token, RES, T0 + 1000)).toMatchObject({ ok: false, reason: 'unknown' });
    expect(listGrants(db, T0 + 2000)).toEqual([expect.objectContaining({ app: 'Claude', callsToday: 1 })]);
    // nothing stored in clear
    expect(JSON.stringify(db.$client.prepare('select * from oauth_token').all())).not.toContain(tokens.access_token.slice(8));
  });

  it('refresh rotates; a reused refresh token revokes the whole grant', () => {
    const db = openDb(':memory:');
    const first = createGrant(db, g, T0).tokens;
    const r1 = refreshGrant(db, first.refresh_token, 'c1', RES, T0 + 5000);
    expect(r1.ok).toBe(true);
    const second = r1.ok ? r1.tokens : null;
    expect(refreshGrant(db, second!.refresh_token, 'c2', RES, T0 + 6000)).toMatchObject({ ok: false }); // another client
    const reuse = refreshGrant(db, first.refresh_token, 'c1', RES, T0 + 7000);
    expect(reuse).toMatchObject({ ok: false, reused: { grantId: expect.any(Number) } });
    expect(useAccessToken(db, second!.access_token, RES, T0 + 8000)).toMatchObject({ ok: false });
    expect(refreshGrant(db, second!.refresh_token, 'c1', RES, T0 + 8000)).toMatchObject({ ok: false });
    expect(listGrants(db, T0 + 9000)).toEqual([]);
  });

  it('refresh tokens die after 30 days; revoke and panic end everything at once', () => {
    const db = openDb(':memory:');
    const a = createGrant(db, g, T0);
    expect(refreshGrant(db, a.tokens.refresh_token, 'c1', RES, T0 + 31 * 86_400_000)).toMatchObject({ ok: false });
    const b = createGrant(db, g, T0);
    expect(revokeGrant(db, b.grantId, T0 + 1)).toBe(true);
    expect(useAccessToken(db, b.tokens.access_token, RES, T0 + 2)).toMatchObject({ ok: false });
    const c = createGrant(db, g, T0);
    createGrant(db, g, T0);
    expect(revokeAllGrants(db, T0 + 3)).toBe(3); // a is not revoked yet (only expired), plus c and d
    expect(useAccessToken(db, c.tokens.access_token, RES, T0 + 4)).toMatchObject({ ok: false });
  });
});
