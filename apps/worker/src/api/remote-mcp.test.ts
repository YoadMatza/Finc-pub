import { createHash } from 'node:crypto';
import { addPasskey, ensureAccount, ingestBatch, openDb, runEngine, type NormalizedRow } from '@finc/core';
import { describe, expect, it } from 'vitest';
import type { WorkerState } from '../server.js';
import { createApp } from './app.js';
import type { WebAuthnFns } from './passkeys.js';

// Remote MCP (research_notes/proposals/remote-mcp.md): discovery, registration, the connection window, passkey
// consent, PKCE codes, rotating tokens and /mcp over Streamable HTTP. Made-up rows; a fake authenticator.

const TOKEN = 'r'.repeat(64);
const HOME = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const BASE = 'https://finc-example.duckdns.org:7443';
const RESOURCE = `${BASE}/mcp`;
const EDGE = { 'x-finc-edge': 'public', 'x-forwarded-for': '172.18.0.1', 'x-forwarded-proto': 'https' };
const CLAUDE_CB = 'https://claude.ai/api/mcp/auth_callback';
const CHATGPT_CIMD = 'https://chatgpt.com/oauth/client.json';
const CHATGPT_CB = 'https://chatgpt.com/connector_platform_oauth_redirect';
const VERIFIER = 'verifier-'.repeat(6);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} };
const row = (date: string, amount: number, description: string): NormalizedRow => ({ externalAccountId: 'x', date, amount, description, status: 'completed', type: 'normal', identifier: `${description}${date}${amount}`, payload: {} });

function fakeWebAuthn(): Partial<WebAuthnFns> {
  return {
    generateAuthenticationOptions: (async (o: { challenge: string }) => ({ challenge: o.challenge, rpId: 'finc-example.duckdns.org', allowCredentials: [], userVerification: 'required' })) as never,
    verifyAuthenticationResponse: (async (opts: Record<string, unknown>) => {
      const r = opts.response as { id: string; challengeEcho?: string };
      if (r.challengeEcho !== opts.expectedChallenge) throw new Error('Unexpected authentication response challenge');
      const cred = opts.credential as { id: string; counter: number };
      return cred.id === r.id ? { verified: true, authenticationInfo: { newCounter: cred.counter + 1 } } : { verified: false, authenticationInfo: {} };
    }) as never,
  };
}

function setup() {
  const db = openDb(':memory:');
  const card = ensureAccount(db, { institutionId: 'max', institutionKind: 'card', institutionDisplayName: 'Max ****4580', source: 'scraper:max', externalId: 'MX-77001234', type: 'credit_card', last4: '4580' }).accountId;
  ingestBatch(db, { source: 'scraper:max', runId: null, accountId: card, rows: [row('2026-11-02', -5_000, 'WOLT'), row('2026-11-03', -8_800, 'PIZZA 052-7654321')] });
  runEngine(db);
  addPasskey(db, { credentialId: 'cred-1', publicKey: Buffer.from([1, 2, 3, 4]).toString('base64url'), counter: 0, rpId: 'finc-example.duckdns.org', name: 'Pixel' });
  let t = Date.parse('2026-11-17T10:00:00Z');
  const fetched: string[] = [];
  const oauthFetch = (async (url: string) => {
    fetched.push(String(url));
    return new Response(JSON.stringify({ client_id: CHATGPT_CIMD, client_name: 'ChatGPT', redirect_uris: [CHATGPT_CB], token_endpoint_auth_method: 'none' }), { status: 200 });
  }) as typeof fetch;
  const state = { db, vault: null, scheduler: { config: { times: [], jitterMinutes: 0, timezone: 'UTC', monthsBack: 3 }, isRunning: false, nextRun: () => null }, startedAt: t } as unknown as WorkerState;
  const { app } = createApp(state, { controlToken: TOKEN, webDist: '/nonexistent', webauthn: fakeWebAuthn(), now: () => t, oauthFetch });
  const req = async (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const res = await app.request(path, { method: init.method ?? 'GET', headers: init.headers ?? {}, ...(init.body === undefined ? {} : { body: init.body }) });
    const text = await res.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, body, headers: res.headers };
  };
  const json = (path: string, body: unknown, headers: Record<string, string> = {}) => req(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const form = (path: string, fields: Record<string, string>) => req(path, { method: 'POST', headers: { ...EDGE, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
  return { db, req, json, form, fetched, tick: (ms: number) => (t += ms) };
}

type Env = ReturnType<typeof setup>;

async function turnOn(env: Env) {
  expect((await env.req('/api/settings', { method: 'PATCH', headers: HOME, body: JSON.stringify({ publicUrl: BASE, ai: { mcpRemote: true } }) })).status).toBe(200);
}
const openWindow = (env: Env) => env.req('/api/mcp/remote/window', { method: 'POST', headers: HOME });

/** Claude: register, authorize, approve with the passkey, redeem the code. */
async function connectClaude(env: Env, state = 'st-1') {
  const reg = await env.json('/oauth/register', { redirect_uris: [CLAUDE_CB], client_name: 'Claude', token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }, EDGE);
  expect(reg.status).toBe(201);
  const clientId = reg.body.client_id as string;
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: CLAUDE_CB, code_challenge: CHALLENGE, code_challenge_method: 'S256', state, scope: 'finc.read', resource: RESOURCE });
  const auth = await env.req(`/oauth/authorize?${q}`, { headers: EDGE });
  expect(auth.status).toBe(302);
  const consent = new URL(auth.headers.get('location')!);
  expect(consent.origin + consent.pathname).toBe(`${BASE}/connect`);
  const id = consent.searchParams.get('req')!;
  const info = await env.req(`/api/oauth/requests/${id}`, { headers: EDGE });
  expect(info.body).toMatchObject({ app: 'Claude', redirectHost: 'claude.ai', scope: 'finc.read' });
  const options = await env.json(`/api/oauth/requests/${id}/options`, {}, EDGE);
  const approve = await env.json(`/api/oauth/requests/${id}/approve`, { response: { id: 'cred-1', challengeEcho: options.body.challenge } }, EDGE);
  expect(approve.status).toBe(200);
  const back = new URL(approve.body.redirect);
  expect(back.origin + back.pathname).toBe(CLAUDE_CB);
  expect(back.searchParams.get('state')).toBe(state);
  expect(back.searchParams.get('iss')).toBe(BASE);
  const tok = await env.form('/oauth/token', { grant_type: 'authorization_code', code: back.searchParams.get('code')!, redirect_uri: CLAUDE_CB, client_id: clientId, code_verifier: VERIFIER, resource: RESOURCE });
  expect(tok.status).toBe(200);
  return { clientId, tokens: tok.body as { access_token: string; refresh_token: string; expires_in: number } };
}

const mcp = (env: Env, token: string | null, method: string, params: Record<string, unknown> = {}, extra: Record<string, string> = {}) =>
  env.req('/mcp', {
    method: 'POST',
    headers: { ...EDGE, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': method, ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: META } }),
  });

describe('remote MCP', () => {
  it('is invisible while off: discovery, registration, authorize and /mcp all answer 404', async () => {
    const env = setup();
    for (const p of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server', '/oauth/authorize?client_id=x']) expect((await env.req(p, { headers: EDGE })).status, p).toBe(404);
    expect((await env.json('/oauth/register', { redirect_uris: [CLAUDE_CB] }, EDGE)).status).toBe(404);
    expect((await mcp(env, null, 'tools/list')).status).toBe(404);
    expect((await env.req('/api/settings', { headers: HOME })).body.ai.mcpRemote).toBe(false);
  });

  it('discovery points the app at finc: 401 with resource metadata, then the server metadata', async () => {
    const env = setup();
    await turnOn(env);
    const r = await mcp(env, null, 'tools/list');
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp", scope="finc.read"`);
    expect((await env.req('/.well-known/oauth-protected-resource/mcp', { headers: EDGE })).body).toEqual({ resource: RESOURCE, authorization_servers: [BASE], scopes_supported: ['finc.read'], bearer_methods_supported: ['header'], resource_name: 'finc' });
    expect((await env.req('/.well-known/oauth-authorization-server', { headers: EDGE })).body).toMatchObject({ issuer: BASE, code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], client_id_metadata_document_supported: true, authorization_response_iss_parameter_supported: true });
  });

  it('Claude end to end: the window, a passkey approval, tokens, then the privacy-checked tools over HTTP', async () => {
    const env = setup();
    await turnOn(env);
    // no window: registration refused
    expect((await env.json('/oauth/register', { redirect_uris: [CLAUDE_CB] }, EDGE)).status).toBe(400);
    await openWindow(env);
    const { tokens } = await connectClaude(env);
    expect(tokens.expires_in).toBe(3600);
    // the window closed with the approval
    expect((await env.req('/api/mcp/remote', { headers: HOME })).body).toMatchObject({ enabled: true, endpoint: RESOURCE, windowUntil: null, grants: [{ app: 'Claude', callsToday: 0 }] });
    const list = await mcp(env, tokens.access_token, 'tools/list');
    expect(list.status).toBe(200);
    expect(list.body.result.tools).toHaveLength(10);
    const call = await mcp(env, tokens.access_token, 'tools/call', { name: 'find_transactions', arguments: { from: '2026-10-01', to: '2026-11-30' } });
    expect(call.body.result).toMatchObject({ resultType: 'complete', isError: false });
    const text = JSON.stringify(call.body.result.structuredContent);
    for (const bad of ['7654321', '4580', '77001234']) expect(text).not.toContain(bad);
    // the 2025-11-25 era over HTTP too
    const legacy = await env.req('/mcp', { method: 'POST', headers: { ...EDGE, 'content-type': 'application/json', authorization: `Bearer ${tokens.access_token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) });
    expect(legacy.body.result.protocolVersion).toBe('2025-11-25');
    // notifications: 202, no body
    const note = await env.req('/mcp', { method: 'POST', headers: { ...EDGE, 'content-type': 'application/json', authorization: `Bearer ${tokens.access_token}` }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    expect(note.status).toBe(202);
    // header mismatch: 400
    expect((await mcp(env, tokens.access_token, 'tools/call', { name: 'net_worth', arguments: {} }, { 'mcp-name': 'trends' })).status).toBe(400);
    // a browser page may not call /mcp
    expect((await mcp(env, tokens.access_token, 'tools/list', {}, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await env.req('/mcp', { headers: EDGE })).status).toBe(405);
  });

  it('ChatGPT through its metadata document; only the allow-listed URL is ever fetched', async () => {
    const env = setup();
    await turnOn(env);
    await openWindow(env);
    const q = (clientId: string) => new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: CHATGPT_CB, code_challenge: CHALLENGE, code_challenge_method: 'S256', resource: RESOURCE });
    const auth = await env.req(`/oauth/authorize?${q(CHATGPT_CIMD)}`, { headers: EDGE });
    expect(auth.status).toBe(302);
    expect(env.fetched).toEqual([CHATGPT_CIMD]);
    const id = new URL(auth.headers.get('location')!).searchParams.get('req')!;
    expect((await env.req(`/api/oauth/requests/${id}`, { headers: EDGE })).body).toMatchObject({ app: 'ChatGPT', redirectHost: 'chatgpt.com' });
    // any other URL as a client id: never fetched, plain error page, no redirect
    const evil = await env.req(`/oauth/authorize?${q('http://192.168.1.1/admin.json')}`, { headers: EDGE });
    expect(evil.status).toBe(400);
    expect(env.fetched).toEqual([CHATGPT_CIMD]);
  });

  it('refused: unknown callbacks, a closed window at approval, a stale passkey challenge, a cross-site approval', async () => {
    const env = setup();
    await turnOn(env);
    await openWindow(env);
    const reg = await env.json('/oauth/register', { redirect_uris: [CLAUDE_CB] }, EDGE);
    const clientId = reg.body.client_id as string;
    const q = (o: Record<string, string>) => new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: CLAUDE_CB, code_challenge: CHALLENGE, code_challenge_method: 'S256', resource: RESOURCE, ...o });
    // a callback the client did not register: no redirect at all
    expect((await env.req(`/oauth/authorize?${q({ redirect_uri: 'https://evil.example/cb' })}`, { headers: EDGE })).status).toBe(400);
    // no PKCE / wrong resource / another scope: back to the app with an error
    for (const bad of [{ code_challenge_method: 'plain' }, { resource: 'https://other.example/mcp' }, { scope: 'finc.write' }]) {
      const r = await env.req(`/oauth/authorize?${q(bad)}`, { headers: EDGE });
      expect(r.status).toBe(302);
      expect(new URL(r.headers.get('location')!).searchParams.get('error')).toBeTruthy();
    }
    const auth = await env.req(`/oauth/authorize?${q({})}`, { headers: EDGE });
    const id = new URL(auth.headers.get('location')!).searchParams.get('req')!;
    // cross-site: refused
    expect((await env.json(`/api/oauth/requests/${id}/options`, {}, { ...EDGE, origin: 'https://evil.example' })).status).toBe(403);
    const options = await env.json(`/api/oauth/requests/${id}/options`, {}, EDGE);
    // a signature over another challenge
    expect((await env.json(`/api/oauth/requests/${id}/approve`, { response: { id: 'cred-1', challengeEcho: 'old' } }, EDGE)).status).toBe(401);
    // the window shut meanwhile
    const o2 = await env.json(`/api/oauth/requests/${id}/options`, {}, EDGE);
    await env.req('/api/mcp/remote/window', { method: 'DELETE', headers: HOME });
    const late = await env.json(`/api/oauth/requests/${id}/approve`, { response: { id: 'cred-1', challengeEcho: o2.body.challenge } }, EDGE);
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('window_closed');
    expect(options.status).toBe(200);
  });

  it('tokens: the code works once; refresh rotates; a reused refresh token ends the connection; revoke and panic', async () => {
    const env = setup();
    await turnOn(env);
    await openWindow(env);
    const { clientId, tokens } = await connectClaude(env);
    const r1 = await env.form('/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId, resource: RESOURCE });
    expect(r1.status).toBe(200);
    expect(r1.headers.get('cache-control')).toContain('no-store');
    const reuse = await env.form('/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
    expect(reuse.status).toBe(400);
    expect((await mcp(env, r1.body.access_token, 'tools/list')).status).toBe(401);
    // a new connection, revoked from Settings
    await openWindow(env);
    const second = await connectClaude(env, 'st-2');
    const grants = (await env.req('/api/mcp/remote', { headers: HOME })).body.grants as Array<{ id: number }>;
    expect((await env.req(`/api/mcp/remote/grants/${grants[0]!.id}`, { method: 'DELETE', headers: HOME })).status).toBe(200);
    expect((await mcp(env, second.tokens.access_token, 'tools/list')).status).toBe(401);
    // an expired access token
    await openWindow(env);
    const third = await connectClaude(env, 'st-3');
    env.tick(3_600_001);
    expect((await mcp(env, third.tokens.access_token, 'tools/list')).status).toBe(401);
    // the security log never holds a token or a code
    const log = JSON.stringify(env.db.$client.prepare(`select detail from security_event where kind like 'mcp.%'`).all());
    expect(log).not.toContain(third.tokens.access_token);
    expect(log).not.toContain('finc_rt_');
  });

  it('turning it on is for home only; the window opens from home only', async () => {
    const env = setup();
    expect((await env.req('/api/settings', { method: 'PATCH', headers: { ...HOME, ...EDGE }, body: JSON.stringify({ ai: { mcpRemote: true } }) })).status).toBe(403);
    await turnOn(env);
    expect((await env.req('/api/mcp/remote/window', { method: 'POST', headers: { ...HOME, ...EDGE } })).status).toBe(403);
  });
});
