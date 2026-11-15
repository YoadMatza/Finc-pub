import { openDb, setSetting } from '@finc/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerState } from '../server.js';
import { createApp, hostnameOf } from './app.js';

/** Security research P1-06/P1-07: the worker answers only to its own names (DNS rebinding). */
const TOKEN = 'b'.repeat(64);

function make(opts: { publicUrl?: string; allowedHosts?: string[] } = {}) {
  const db = openDb(':memory:');
  if (opts.publicUrl) setSetting(db, 'ui.publicUrl', opts.publicUrl);
  const state: WorkerState = { db, vault: null, scheduler: { config: { times: [], jitterMinutes: 0, timezone: 'UTC', monthsBack: 3 }, isRunning: false, nextRun: () => null } as never, startedAt: Date.now() };
  const { app } = createApp(state, { controlToken: TOKEN, webDist: '/nonexistent', ...(opts.allowedHosts ? { allowedHosts: opts.allowedHosts } : {}) });
  return (path: string, host: string | null, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { 'content-type': 'application/json', ...(host === null ? {} : { host }), ...(init.headers as Record<string, string> | undefined) } });
}

describe('host names', () => {
  it('parses the hostname out of a Host header', () => {
    expect(hostnameOf('FINC-EXAMPLE.duckdns.org:7443')).toBe('finc-example.duckdns.org');
    expect(hostnameOf('127.0.0.1:7733')).toBe('127.0.0.1');
    expect(hostnameOf('[::1]:7733')).toBe('[::1]');
    expect(hostnameOf('localhost.')).toBe('localhost');
    expect(hostnameOf('evil.example')).toBe('evil.example');
  });

  it('answers to the PC, the configured public name and extra names', async () => {
    const call = make({ publicUrl: 'https://finc-example.duckdns.org:7443', allowedHosts: ['finc.home.arpa'] });
    for (const host of [null, '127.0.0.1:7733', 'localhost:7733', 'LOCALHOST', '[::1]:7733', 'finc-example.duckdns.org:7443', 'Finc-Example.DuckDNS.org', 'finc.home.arpa:7733']) {
      expect((await call('/health', host)).status, String(host)).toBe(200);
    }
  });

  it('refuses any other name with 421 before any route runs, the PIN and the control port included', async () => {
    const call = make({ publicUrl: 'https://finc-example.duckdns.org:7443' });
    const hosts = ['evil.example', 'evil.example:7733', 'worker:7733', '127.0.0.1.evil.example', 'finc-example.duckdns.org.evil.example', 'pc.tailnet-example.ts.net', '172.18.0.3:7733'];
    const routes: Array<[string, string]> = [['GET', '/health'], ['GET', '/'], ['POST', '/api/auth/login'], ['POST', '/api/auth/setup'], ['POST', '/unlock'], ['GET', '/api/hub'], ['OPTIONS', '/api/hub']];
    for (const host of hosts) {
      for (const [method, path] of routes) {
        const init: RequestInit = { method, headers: { authorization: `Bearer ${TOKEN}`, origin: `http://${host}` } };
        if (method === 'POST') init.body = JSON.stringify({ pin: 'kiwi-2048', password: 'x' });
        const r = await call(path, host, init);
        expect(r.status, `${host} ${method} ${path}`).toBe(421);
      }
    }
    // a refused PIN setup did not set the PIN: the PC can still set it
    expect((await call('/api/auth/status', '127.0.0.1:7733')).status).toBe(200);
    expect(await (await call('/api/auth/status', '127.0.0.1:7733')).json()).toMatchObject({ pinSet: false });
  });

  it('without a public URL, the public name is refused unless FINC_PUBLIC_HOST, FINC_ALLOWED_HOSTS or allowedHosts names it', async () => {
    vi.stubEnv('FINC_PUBLIC_HOST', '');
    vi.stubEnv('FINC_ALLOWED_HOSTS', '');
    expect((await make()('/health', 'finc-example.duckdns.org:7443')).status).toBe(421);
    expect((await make({ allowedHosts: ['finc-example.duckdns.org:7443'] })('/health', 'finc-example.duckdns.org:7443')).status).toBe(200);
    vi.stubEnv('FINC_PUBLIC_HOST', 'Finc-Example.duckdns.org');
    expect((await make()('/health', 'finc-example.duckdns.org:7443')).status).toBe(200);
    vi.stubEnv('FINC_PUBLIC_HOST', '');
    vi.stubEnv('FINC_ALLOWED_HOSTS', ' other.example , finc.home.arpa:7733, nas.lan. ');
    const call = make();
    for (const h of ['finc.home.arpa', 'finc.home.arpa:7733', 'nas.lan:7733', 'other.example']) expect((await call('/health', h)).status, h).toBe(200);
  });

  it('refuses Host values a browser cannot send (lists, userinfo, spaces)', async () => {
    const call = make();
    for (const h of ['127.0.0.1:7733, evil.example', 'evil@127.0.0.1', '127.0.0.1 evil', '[::1]junk', '127.0.0.1:']) expect((await call('/health', h)).status, h).toBe(421);
  });
});

afterEach(() => vi.unstubAllEnvs());

/** Calls with a fake TCP peer, the way @hono/node-server hands it to getConnInfo. */
function makeWithPeer() {
  const db = openDb(':memory:');
  const state: WorkerState = { db, vault: null, scheduler: { config: { times: [], jitterMinutes: 0, timezone: 'UTC', monthsBack: 3 }, isRunning: false, nextRun: () => null } as never, startedAt: Date.now() };
  const { app } = createApp(state, { controlToken: TOKEN, webDist: '/nonexistent' });
  return async (peer: string, headers: Record<string, string>) => {
    const r = await app.request('/api/auth/status', { headers: { host: '127.0.0.1:7733', ...headers } }, { incoming: { socket: { remoteAddress: peer, remotePort: 1, remoteFamily: 'IPv4' } } });
    return (await r.json()) as { trusted: boolean };
  };
}

describe('X-Forwarded-For only from Caddy (P1-07)', () => {
  it('a forwarded address is believed from the fixed Caddy address only, not from any private peer', async () => {
    vi.stubEnv('FINC_TRUSTED_PROXIES', '172.30.73.10');
    const call = makeWithPeer();
    // the PC browser arrives as the gateway: its own X-Forwarded-For must not change who it is
    expect((await call('172.30.73.1', {})).trusted).toBe(true);
    expect((await call('172.30.73.1', { 'x-forwarded-for': '8.8.8.8' })).trusted).toBe(true);
    // a sibling on another private address cannot pose as anything either
    expect((await call('172.30.73.5', { 'x-forwarded-for': '8.8.8.8' })).trusted).toBe(true);
    // from Caddy the forwarded address counts, in both address forms
    expect((await call('172.30.73.10', { 'x-forwarded-for': '8.8.8.8' })).trusted).toBe(false);
    expect((await call('::ffff:172.30.73.10', { 'x-forwarded-for': '8.8.8.8' })).trusted).toBe(false);
    // an internet peer is never trusted
    expect((await call('8.8.8.8', {})).trusted).toBe(false);
  });

  it('the old `private` setting still believes every private peer', async () => {
    vi.stubEnv('FINC_TRUSTED_PROXIES', 'private');
    expect((await makeWithPeer()('172.30.73.5', { 'x-forwarded-for': '8.8.8.8' })).trusted).toBe(false);
  });
});

describe('API answers are never cached (P1-11 review)', () => {
  it('sends Cache-Control: no-store on API and control routes, errors included', async () => {
    const call = make();
    for (const path of ['/api/auth/status', '/api/hub', '/health', '/runs']) {
      const r = await call(path, '127.0.0.1:7733');
      expect(r.headers.get('cache-control'), path).toBe('no-store');
    }
  });
});

describe('writes from another site (review of P1-06/P1-07)', () => {
  it('a blind cross-site POST to the PC address is refused before the PIN is checked, and does not count', async () => {
    const call = make();
    const pin = (headers: Record<string, string>) => call('/api/auth/setup', '127.0.0.1:7733', { method: 'POST', headers, body: JSON.stringify({ pin: 'evil-9876' }) });
    expect((await pin({ origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await pin({ origin: 'http://127.0.0.1:8080', 'sec-fetch-site': 'same-site' })).status).toBe(403); // another local port
    expect((await pin({ origin: 'null' })).status).toBe(403);
    expect((await pin({ 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    // a no-cors text/plain body never reaches JSON.parse
    expect((await call('/api/auth/setup', '127.0.0.1:7733', { method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8' }, body: JSON.stringify({ pin: 'evil-9876' }) })).status).toBe(415);
    expect(await (await call('/api/auth/status', '127.0.0.1:7733')).json()).toMatchObject({ pinSet: false });
    // our own page and a non-browser caller still work
    expect((await pin({ origin: 'http://127.0.0.1:7733', 'sec-fetch-site': 'same-origin' })).status).toBe(200);
  });

  it('through Caddy (fixed peer, X-Forwarded-Host) our own public page may write; X-Forwarded-Host from anyone else is ignored', async () => {
    vi.stubEnv('FINC_TRUSTED_PROXIES', '172.30.73.10');
    const db = openDb(':memory:');
    setSetting(db, 'ui.publicUrl', 'https://finc-example.duckdns.org:7443');
    const state: WorkerState = { db, vault: null, scheduler: { config: { times: [], jitterMinutes: 0, timezone: 'UTC', monthsBack: 3 }, isRunning: false, nextRun: () => null } as never, startedAt: Date.now() };
    const { app } = createApp(state, { controlToken: TOKEN, webDist: '/nonexistent' });
    const pair = (peer: string, headers: Record<string, string>) =>
      app.request('/api/devices/pair', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ code: 'x'.repeat(16) }) }, { incoming: { socket: { remoteAddress: peer, remotePort: 1, remoteFamily: 'IPv4' } } });
    const PUBLIC = 'finc-example.duckdns.org:7443';
    // the real PWA path: Caddy keeps Host and adds X-Forwarded-Host; Origin is the public page
    expect((await pair('172.30.73.10', { host: PUBLIC, 'x-forwarded-host': PUBLIC, 'x-finc-edge': 'public', origin: `https://${PUBLIC}`, 'sec-fetch-site': 'same-origin' })).status).toBe(401);
    // a caller at the gateway cannot make an evil Origin match by sending its own X-Forwarded-Host
    expect((await pair('172.30.73.1', { host: '127.0.0.1:7733', 'x-forwarded-host': 'evil.example', origin: 'http://evil.example' })).status).toBe(403);
    // the app's origin aimed at the PC's own port is not the app; the refusal still carries CORS headers
    const local = await pair('172.30.73.1', { host: '127.0.0.1:7733', origin: 'https://localhost', 'sec-fetch-site': 'cross-site' });
    expect(local.status).toBe(403);
    expect(local.headers.get('access-control-allow-origin')).toBe('https://localhost');
  });

  it('login from another site is refused too; the Android app and the CLI are not', async () => {
    const call = make({ publicUrl: 'https://finc-example.duckdns.org:7443' });
    const login = (headers: Record<string, string>) => call('/api/auth/login', '127.0.0.1:7733', { method: 'POST', headers, body: JSON.stringify({ pin: '0000' }) });
    expect((await login({ origin: 'https://evil.example' })).status).toBe(403);
    // reaches the PIN check (no PIN set → not 403 for cross-site)
    expect((await login({})).status).not.toBe(403);
    const pair = await call('/api/devices/pair', 'finc-example.duckdns.org:7443', { method: 'POST', headers: { origin: 'https://localhost', 'sec-fetch-site': 'cross-site' }, body: JSON.stringify({ code: 'x'.repeat(16) }) });
    expect(pair.status).toBe(401); // a wrong code, but not refused as cross-site
  });
});
