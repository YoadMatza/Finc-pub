import { flushSecurityEvents, listSecurityEvents, openDb, setPin } from '@finc/core';
import { serve } from '@hono/node-server';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SERVER_LIMITS, type WorkerState } from '../server.js';
import { BODY_LIMIT, CHAT_BODY_LIMIT, createApp } from './app.js';
import type { WebAuthnFns } from './passkeys.js';

// security research P2-12: no request body above the limit is read, on any route, public or control

const TOKEN = 'b'.repeat(64);
const HOME = { authorization: `Bearer ${TOKEN}` };
const EDGE = { 'x-finc-edge': 'public', 'x-forwarded-for': '198.51.100.77', 'x-forwarded-proto': 'https' };
const PUBLIC_URL = 'https://finc-example.duckdns.org:7443';

const webauthn: Partial<WebAuthnFns> = {
  verifyRegistrationResponse: (async (opts: Record<string, unknown>) => {
    const r = opts.response as { id: string };
    return { verified: true, registrationInfo: { credential: { id: r.id, publicKey: new Uint8Array([1, 2, 3, 4]), counter: 0, transports: ['internal'] }, credentialDeviceType: 'multiDevice', credentialBackedUp: true } };
  }) as never,
};

function setup() {
  const db = openDb(':memory:');
  const state: WorkerState = { db, vault: null, scheduler: { config: { times: [], jitterMinutes: 0, timezone: 'UTC', monthsBack: 3 }, isRunning: false, nextRun: () => null } as never, startedAt: Date.now() };
  const { app } = createApp(state, { controlToken: TOKEN, webDist: '/nonexistent', webauthn });
  const jar = { cookie: '' };
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await app.request(path, { ...init, headers: { 'content-type': 'application/json', ...(jar.cookie ? { cookie: jar.cookie } : {}), ...(init.headers as Record<string, string> | undefined) } });
    const set = res.headers.get('set-cookie');
    if (set) jar.cookie = set.split(';')[0]!;
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
  };
  const events = (kind = 'http.body_too_large') => listSecurityEvents(db, { kind, limit: 200 }).events;
  return { db, state, app, call, events };
}

/** A real Node server around the app, as server.ts starts it (@hono/node-server, SERVER_LIMITS). */
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});
async function listen(app: ReturnType<typeof setup>['app']): Promise<{ port: number; server: Server }> {
  const server = await new Promise<Server>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1', serverOptions: { ...SERVER_LIMITS } }, () => resolve(s as Server)) as Server;
  });
  servers.push(server);
  return { port: (server.address() as AddressInfo).port, server };
}

interface RawResult {
  status: number | null;
  body: string;
  /** bytes of body the client managed to hand to its socket before the server answered or hung up */
  written: number;
  /** the server closed the connection (error, or close) */
  closed: boolean;
}

/**
 * Send headers, then (optionally) a chunked body of 64 KiB pieces up to `upTo` bytes, waiting for drain after each, and
 * stop writing as soon as the response arrives or the socket fails.
 */
function raw(port: number, path: string, headers: Record<string, string>, opts: { chunkedUpTo?: number; body?: string } = {}): Promise<RawResult> {
  return new Promise((resolve) => {
    let written = 0;
    let status: number | null = null;
    let body = '';
    let done = false;
    let closed = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve({ status, body, written, closed });
    };
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers: { host: 'localhost', ...headers }, agent: false });
    req.on('response', (res) => {
      status = res.statusCode ?? null;
      res.setEncoding('utf8');
      res.on('data', (d: string) => (body += d));
      res.on('end', () => setTimeout(finish, 50));
      res.on('error', finish);
    });
    req.on('error', () => {
      closed = true;
      finish();
    });
    req.on('close', () => {
      closed = true;
      setTimeout(finish, 50);
    });
    if (opts.body !== undefined) {
      req.end(opts.body);
      return;
    }
    req.flushHeaders();
    if (opts.chunkedUpTo === undefined) return; // headers only: a Content-Length that is never honoured
    const piece = Buffer.alloc(64 * 1024, 0x61);
    const pump = () => {
      while (status === null && !req.destroyed && written < opts.chunkedUpTo!) {
        written += piece.length;
        if (!req.write(piece)) {
          req.once('drain', pump);
          return;
        }
      }
      if (status === null && !req.destroyed && written >= opts.chunkedUpTo!) req.end();
    };
    pump();
  });
}

describe('request body limit (P2-12)', () => {
  it('refuses an oversize Content-Length on the public /api/devices/pair with 413 before reading the body', async () => {
    const env = setup();
    const { port } = await listen(env.app);
    // 1 GB announced, nothing sent: an answer can only come from the header
    const r = await raw(port, '/api/devices/pair', { 'content-type': 'application/json', 'content-length': String(1024 ** 3) });
    expect(r.status).toBe(413);
    expect(JSON.parse(r.body)).toEqual({ error: 'request body too large' });
    const [e] = env.events();
    expect(e).toMatchObject({ kind: 'http.body_too_large', actor: 'pc', address: '127.0.0.1' });
    expect(JSON.parse(e!.detail!)).toEqual({ path: '/api/devices/pair', size: 1024 ** 3, limit: BODY_LIMIT });
    expect(env.events('device.pair_failed')).toHaveLength(0); // the route never ran
  });

  it('refuses an oversize Content-Length on the control routes too (/unlock, /sync, /alarm/setup), token or not', async () => {
    const env = setup();
    const { port } = await listen(env.app);
    for (const [path, h] of [['/unlock', HOME], ['/sync', HOME], ['/alarm/setup', {}]] as const) {
      const r = await raw(port, path, { 'content-type': 'application/json', 'content-length': String(BODY_LIMIT + 1), ...h });
      expect(r.status, path).toBe(413);
      expect(JSON.parse(r.body), path).toEqual({ error: 'request body too large' });
    }
    // one row: the same kind from the same address inside a minute is aggregated
    expect(env.events()).toHaveLength(1);
  });

  it('cuts off a chunked body (no Content-Length) once it passes the limit, without reading the rest', async () => {
    const env = setup();
    const { port } = await listen(env.app);
    const total = 256 * 1024 * 1024; // the client would send 256 MiB
    const r = await raw(port, '/api/devices/pair', { 'content-type': 'application/json', 'transfer-encoding': 'chunked', ...EDGE }, { chunkedUpTo: total });
    // The server stops reading just past the limit, answers 413 and closes. The client, still sending, usually gets a
    // connection reset before it can read the 413 (TCP drops the answer when unread data meets a closed socket), so
    // either is accepted; what matters is that it was cut off after a few hundred KB of the 256 MiB.
    if (r.status !== null) expect(r.status).toBe(413);
    expect(r.closed).toBe(true);
    expect(r.written).toBeLessThan(32 * 1024 * 1024);
    const [e] = env.events();
    expect(e).toMatchObject({ kind: 'http.body_too_large', actor: 'public', address: '198.51.100.77' });
    expect(JSON.parse(e!.detail!)).toEqual({ path: '/api/devices/pair', size: null, limit: BODY_LIMIT });
    expect(env.events('device.pair_failed')).toHaveLength(0);
  });

  it('lets a chunked body under the limit through to the route (node server: the body is handed on intact)', async () => {
    const env = setup();
    const { port } = await listen(env.app);
    const r = await raw(port, '/api/devices/pair', { 'content-type': 'application/json', 'transfer-encoding': 'chunked', ...EDGE }, { body: JSON.stringify({ code: 'WRONGCODE', name: 'x'.repeat(50) }) });
    expect(r.status).toBe(401); // parsed, and the code is wrong
    expect(env.events('device.pair_failed')).toHaveLength(1);
    expect(env.events()).toHaveLength(0);
  });

  it('sets Node request and header timeouts on the server', async () => {
    const env = setup();
    const { server } = await listen(env.app);
    expect(server.requestTimeout).toBe(30_000);
    expect(server.headersTimeout).toBe(15_000);
    expect(SERVER_LIMITS.headersTimeout).toBeLessThanOrEqual(SERVER_LIMITS.requestTimeout);
  });

  it('passes normal requests: a ~10 KB passkey registration, a settings PATCH, a long chat under its own higher limit', async () => {
    const env = setup();
    await setPin(env.db, 'mango-7319'); // passkeys need a PIN
    expect((await env.call('/api/settings', { method: 'PATCH', headers: HOME, body: JSON.stringify({ publicUrl: PUBLIC_URL, language: 'he' }) })).status).toBe(200);
    const code = (await env.call('/api/auth/passkey/enroll-code', { method: 'POST', headers: HOME, body: JSON.stringify({ name: 'Laptop key' }) })).body.code as string;
    expect((await env.call('/api/auth/passkey/register-options', { method: 'POST', headers: EDGE, body: JSON.stringify({ code }) })).status).toBe(200);
    // an attestation with a certificate chain is a few KB of base64url; 10 KB here
    const response = { id: 'cred-big', rawId: 'cred-big', type: 'public-key', response: { clientDataJSON: 'A'.repeat(400), attestationObject: 'B'.repeat(10_000), transports: ['internal'] } };
    const body = JSON.stringify({ code, response });
    expect(body.length).toBeGreaterThan(10_000);
    expect((await env.call('/api/auth/passkey/register', { method: 'POST', headers: EDGE, body })).status).toBe(200);
    // the chat sends its whole conversation: 40 messages of 4000 Hebrew characters (~320 KB) is over BODY_LIMIT but fine
    const messages = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'ש'.repeat(4000) }));
    const chat = JSON.stringify({ messages });
    expect(Buffer.byteLength(chat)).toBeGreaterThan(BODY_LIMIT);
    expect(Buffer.byteLength(chat)).toBeLessThan(CHAT_BODY_LIMIT);
    const r = await env.call('/api/chat', { method: 'POST', headers: HOME, body: chat });
    expect(r.status).toBe(409); // parsed: no model provider configured
    expect(r.body.error).toMatch(/no model provider/);
    // ...the same size on any other route is refused
    expect((await env.call('/api/settings', { method: 'PATCH', headers: HOME, body: chat })).status).toBe(413);
    expect((await env.call('/api/chat', { method: 'POST', headers: HOME, body: 'x'.repeat(CHAT_BODY_LIMIT + 1) })).status).toBe(413);
  });

  it('records the refusal without the body, aggregated: one row a minute per address, the count afterwards', async () => {
    const env = setup();
    const secret = `{"code":"${'S'.repeat(BODY_LIMIT)}"}`;
    for (let i = 0; i < 5; i++) expect((await env.call('/api/devices/pair', { method: 'POST', headers: EDGE, body: secret })).status).toBe(413);
    let rows = env.events();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).not.toContain('SSSS');
    expect(JSON.parse(rows[0]!.detail!)).toMatchObject({ path: '/api/devices/pair', limit: BODY_LIMIT });
    // another address is its own row
    expect((await env.call('/api/devices/pair', { method: 'POST', headers: { ...EDGE, 'x-forwarded-for': '203.0.113.9' }, body: secret })).status).toBe(413);
    expect(env.events()).toHaveLength(2);
    // when the window ends, the four repeats are written as a summary row
    flushSecurityEvents(env.db, Date.now() + 3 * 60_000);
    rows = env.events();
    expect(rows).toHaveLength(3);
    expect(JSON.parse(rows[0]!.detail!)).toMatchObject({ repeats: 4, summary: true });
    expect(rows[0]!.address).toBe('198.51.100.77');
  });
});
