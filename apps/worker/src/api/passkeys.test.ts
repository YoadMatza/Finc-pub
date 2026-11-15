import { readFileSync } from 'node:fs';
import { openDb, setPin } from '@finc/core';
import { describe, expect, it } from 'vitest';
import type { WorkerState } from '../server.js';
import { createApp } from './app.js';
import { PASSKEY_SESSION_MS, Sessions } from './auth.js';
import type { WebAuthnFns } from './passkeys.js';

const TOKEN = 'a'.repeat(64);
const PUBLIC_URL = 'https://finc-example.duckdns.org:7443';
const RP_ID = 'finc-example.duckdns.org';
const HOME = { authorization: `Bearer ${TOKEN}` };
// behind Docker Desktop every internet client shares the bridge address; Caddy stamps the request
const EDGE = { 'x-finc-edge': 'public', 'x-forwarded-for': '172.18.0.1', 'x-forwarded-proto': 'https' };

type Call = { fn: string; opts: Record<string, unknown> };

/** No authenticator in a test: the verifiers check what the server passes and answer like the library would. */
function fakeWebAuthn(calls: Call[]): Partial<WebAuthnFns> {
  return {
    verifyRegistrationResponse: (async (opts: Record<string, unknown>) => {
      calls.push({ fn: 'register', opts });
      const r = opts.response as { id: string; challengeEcho?: string; bad?: boolean };
      if (r.bad) throw new Error('signature mismatch');
      if (r.challengeEcho !== opts.expectedChallenge) throw new Error('unexpected challenge');
      return {
        verified: true,
        registrationInfo: { credential: { id: r.id, publicKey: new Uint8Array([1, 2, 3, 4]), counter: 0, transports: ['internal', 'hybrid'] }, credentialDeviceType: 'multiDevice', credentialBackedUp: true },
      };
    }) as never,
    verifyAuthenticationResponse: (async (opts: Record<string, unknown>) => {
      calls.push({ fn: 'login', opts });
      const r = opts.response as { id: string; challengeEcho?: string; bad?: boolean };
      const cred = opts.credential as { id: string; publicKey: Uint8Array; counter: number };
      if (r.bad) throw new Error('signature mismatch');
      // like the library: expectedChallenge may be a string or a function judging the challenge in the client data
      const ec = opts.expectedChallenge as string | ((ch: string) => boolean | Promise<boolean>);
      const challengeOk = typeof ec === 'function' ? await ec(r.challengeEcho ?? '') : r.challengeEcho === ec;
      if (!challengeOk) throw new Error('Unexpected authentication response challenge');
      if (cred.id !== r.id || cred.publicKey.length !== 4) return { verified: false, authenticationInfo: {} };
      return { verified: true, authenticationInfo: { newCounter: cred.counter + 1 } };
    }) as never,
  };
}

function setup() {
  const db = openDb(':memory:');
  const state: WorkerState = { db, vault: null, scheduler: { config: { times: [], jitterMinutes: 0, timezone: 'UTC', monthsBack: 3 }, isRunning: false, nextRun: () => null } as never, startedAt: Date.now() };
  const clock = { t: Date.now() };
  const calls: Call[] = [];
  const { app } = createApp(state, { controlToken: TOKEN, webDist: '/nonexistent', webauthn: fakeWebAuthn(calls), now: () => clock.t });
  /** one browser = one jar */
  const browser = () => {
    const jar = { cookie: '', lastSetCookie: '' };
    const call = async (path: string, init: RequestInit = {}) => {
      const res = await app.request(path, { ...init, headers: { 'content-type': 'application/json', ...(jar.cookie ? { cookie: jar.cookie } : {}), ...(init.headers as Record<string, string> | undefined) } });
      const set = res.headers.get('set-cookie');
      if (set?.startsWith('finc_session=')) {
        jar.cookie = set.split(';')[0]!;
        jar.lastSetCookie = set;
      }
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
    };
    return { call, jar };
  };
  const cli = browser().call;
  return { db, clock, calls, browser, cli };
}

const post = (body: unknown, headers: Record<string, string> = EDGE): RequestInit => ({ method: 'POST', headers, body: JSON.stringify(body) });

/** Enrol a passkey from outside through a fresh code; returns the phone's browser (now signed in) and the passkey. */
async function enrol(env: ReturnType<typeof setup>, credId: string, name?: string) {
  const code = (await env.cli('/api/auth/passkey/enroll-code', post(name ? { name } : {}, HOME))).body.code as string;
  const phone = env.browser();
  const opts = await phone.call('/api/auth/passkey/register-options', post({ code }));
  expect(opts.status).toBe(200);
  const reg = await phone.call('/api/auth/passkey/register', post({ code, response: { id: credId, rawId: credId, type: 'public-key', response: {}, challengeEcho: opts.body.options.challenge } }));
  expect(reg.status).toBe(200);
  return { phone, passkey: reg.body.passkey as { id: number; name: string } };
}

async function signIn(call: ReturnType<typeof setup>['cli'], credId: string) {
  const lo = await call('/api/auth/passkey/login-options', post({}));
  expect(lo.status).toBe(200);
  return call('/api/auth/passkey/login', post({ challengeId: lo.body.challengeId, response: { id: credId, rawId: credId, type: 'public-key', response: {}, challengeEcho: lo.body.options.challenge } }));
}

describe('passkeys (QUESTIONS 17)', () => {
  it('are unavailable until the public address is set', async () => {
    const env = setup();
    await setPin(env.db, 'kiwi-2048');
    expect((await env.cli('/api/auth/passkey/enroll-code', post({}, HOME))).status).toBe(409);
    expect((await env.cli('/api/auth/passkey/register-options', post({ code: 'x'.repeat(22) }))).status).toBe(409);
    expect((await env.cli('/api/auth/passkey/login-options', post({}))).status).toBe(409);
    expect((await env.cli('/api/auth/status')).body.passkeys).toEqual({ available: false, rpId: null });
    expect((await env.cli('/api/passkeys', { headers: HOME })).body).toEqual({ passkeys: [], available: false, rpId: null });
    // with the address but no passkey yet: the rp is known, sign-in is not offered
    expect((await env.cli('/api/settings', { method: 'PATCH', headers: HOME, body: JSON.stringify({ publicUrl: PUBLIC_URL }) })).status).toBe(200);
    expect((await env.cli('/api/auth/status')).body.passkeys).toEqual({ available: false, rpId: RP_ID });
    expect((await env.cli('/api/passkeys', { headers: HOME })).body).toEqual({ passkeys: [], available: false, rpId: RP_ID });
  });

  it('enrolment links are made at home only, are single use and expire in 5 minutes; a failed registration keeps the link', async () => {
    const env = setup();
    await setPin(env.db, 'kiwi-2048');
    await env.cli('/api/settings', { method: 'PATCH', headers: HOME, body: JSON.stringify({ publicUrl: PUBLIC_URL }) });
    // Caddy 404s the path publicly, and the worker refuses it through the edge anyway
    expect(readFileSync(new URL('../../../../deploy/caddy/Caddyfile', import.meta.url), 'utf8')).toMatch(/@private path [^\n]*\/api\/auth\/passkey\/enroll-code/);
    expect((await env.cli('/api/auth/passkey/enroll-code', post({}))).status).toBe(401); // no credential from outside
    const pairCode = (await env.cli('/api/devices/pairings', post({ name: 'Galaxy' }, HOME))).body.code as string;
    const device = (await env.cli('/api/devices/pair', post({ code: pairCode }))).body.token as string;
    expect((await env.cli('/api/auth/passkey/enroll-code', post({}, { ...EDGE, authorization: `Bearer ${device}` }))).status).toBe(403);

    const made = await env.cli('/api/auth/passkey/enroll-code', post({ name: 'Pixel' }, HOME));
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ expiresInMin: 5 });
    const code = made.body.code as string;
    expect(code).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(made.body.url).toBe(`${PUBLIC_URL}/passkey?code=${code}`);

    const phone = env.browser();
    expect((await phone.call('/api/auth/passkey/register-options', post({ code: 'wrong-code-123' }))).status).toBe(401);
    const opts = await phone.call('/api/auth/passkey/register-options', post({ code }));
    expect(opts.status).toBe(200);
    expect(opts.body.options).toMatchObject({ rp: { name: 'finc', id: RP_ID }, user: { name: 'finc' }, attestation: 'none', authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, excludeCredentials: [] });
    // the user handle is stable
    const again = await phone.call('/api/auth/passkey/register-options', post({ code }));
    expect(again.body.options.user.id).toBe(opts.body.options.user.id);

    // a failed verification is a 400 and keeps the code for a retry
    const bad = await phone.call('/api/auth/passkey/register', post({ code, response: { id: 'cred-1', bad: true } }));
    expect(bad.status).toBe(400);
    expect(phone.jar.cookie).toBe('');
    const ok = await phone.call('/api/auth/passkey/register', post({ code, response: { id: 'cred-1', rawId: 'cred-1', type: 'public-key', response: {}, challengeEcho: again.body.options.challenge } }));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, passkey: { name: 'Pixel' } });
    const reg = env.calls.find((x) => x.fn === 'register' && (x.opts.response as { id: string }).id === 'cred-1' && !(x.opts.response as { bad?: boolean }).bad)!;
    expect(reg.opts).toMatchObject({ expectedOrigin: PUBLIC_URL, expectedRPID: RP_ID, requireUserVerification: true });
    // stored, a session cookie for 12 hours (Secure over https), signed in from outside
    expect(phone.jar.lastSetCookie).toMatch(/Max-Age=43200/);
    expect(phone.jar.lastSetCookie).toMatch(/Secure/);
    expect(phone.jar.lastSetCookie).toMatch(/HttpOnly/);
    const listed = (await env.cli('/api/passkeys', { headers: HOME })).body.passkeys as Array<{ name: string; rpId: string; deviceType: string; backedUp: boolean }>;
    expect(listed).toEqual([expect.objectContaining({ name: 'Pixel', rpId: RP_ID, deviceType: 'multiDevice', backedUp: true })]);
    expect((await phone.call('/api/auth/status', { headers: EDGE })).body).toMatchObject({ authenticated: true, via: 'passkey', trusted: false, passkeys: { available: true, rpId: RP_ID } });
    // single use
    expect((await env.browser().call('/api/auth/passkey/register-options', post({ code }))).status).toBe(401);
    // the next registration excludes the existing credential
    const code2 = (await env.cli('/api/auth/passkey/enroll-code', post({}, HOME))).body.code as string;
    expect((await env.cli('/api/auth/passkey/register-options', post({ code: code2 }))).body.options.excludeCredentials).toEqual([{ id: 'cred-1', type: 'public-key', transports: ['internal', 'hybrid'] }]);
    // expiry
    env.clock.t += 5 * 60_000 + 1;
    expect((await env.cli('/api/auth/passkey/register-options', post({ code: code2 }))).status).toBe(401);
  });

  it('a passkey session works from outside but is no admin, ends after 12 hours, on a PIN change and when its passkey is revoked', async () => {
    const env = setup();
    await setPin(env.db, 'kiwi-2048');
    await env.cli('/api/settings', { method: 'PATCH', headers: HOME, body: JSON.stringify({ publicUrl: PUBLIC_URL }) });
    const { passkey } = await enrol(env, 'cred-A', 'Pixel');

    // sign in from outside with a fresh browser
    const away = env.browser();
    const lo = await away.call('/api/auth/passkey/login-options', post({}));
    expect(lo.body.options).toMatchObject({ rpId: RP_ID, userVerification: 'required' });
    expect(lo.body.options.allowCredentials ?? []).toEqual([]);
    const login = await away.call('/api/auth/passkey/login', post({ challengeId: lo.body.challengeId, response: { id: 'cred-A', challengeEcho: lo.body.options.challenge } }));
    expect(login.status).toBe(200);
    expect(login.body).toEqual({ ok: true });
    expect(env.calls.at(-1)!.opts).toMatchObject({ expectedOrigin: PUBLIC_URL, expectedRPID: RP_ID, requireUserVerification: true, credential: { id: 'cred-A', counter: 0 } });
    expect((await env.cli('/api/passkeys', { headers: HOME })).body.passkeys[0].lastUsedAt).not.toBeNull();
    // the challenge is single use
    expect((await env.browser().call('/api/auth/passkey/login', post({ challengeId: lo.body.challengeId, response: { id: 'cred-A', challengeEcho: lo.body.options.challenge } }))).status).toBe(401);

    expect((await away.call('/api/hub', { headers: EDGE })).status).toBe(200);
    expect((await away.call('/api/auth/status', { headers: EDGE })).body).toMatchObject({ authenticated: true, via: 'passkey' });
    expect((await away.call('/api/settings', { method: 'PATCH', headers: EDGE, body: JSON.stringify({ language: 'en' }) })).status).toBe(200);
    // ...but not an admin from outside
    expect((await away.call('/api/devices/999', { method: 'DELETE', headers: EDGE })).status).toBe(404); // removing is allowed (P1-09); granting is not
    expect((await away.call('/api/alerts', { method: 'PATCH', headers: EDGE, body: JSON.stringify({ quiet: 'off' }) })).status).toBe(403);
    expect((await away.call('/api/settings', { method: 'PATCH', headers: EDGE, body: JSON.stringify({ publicUrl: 'https://evil.example' }) })).status).toBe(403);
    expect((await away.call('/api/devices/pairings', post({ name: 'x' }))).status).toBe(403);
    expect((await away.call('/api/auth/passkey/enroll-code', post({}))).status).toBe(403);
    // a cross-site write with the passkey cookie is refused like with a PIN cookie
    expect((await away.call('/api/settings', { method: 'PATCH', headers: { ...EDGE, origin: 'https://evil.example', host: RP_ID }, body: JSON.stringify({ language: 'he' }) })).status).toBe(403);

    // fixed lifetime: use does not extend it
    env.clock.t += PASSKEY_SESSION_MS - 1000;
    expect((await away.call('/api/hub', { headers: EDGE })).status).toBe(200);
    env.clock.t += 1000;
    expect((await away.call('/api/hub', { headers: EDGE })).status).toBe(401);

    // a PIN change ends it
    expect((await signIn(away.call, 'cred-A')).status).toBe(200);
    expect((await away.call('/api/hub', { headers: EDGE })).status).toBe(200);
    await setPin(env.db, 'mango-4096');
    expect((await away.call('/api/hub', { headers: EDGE })).status).toBe(401);

    // revoking the passkey (from outside, by its own session) ends every session it opened
    expect((await signIn(away.call, 'cred-A')).status).toBe(200);
    const other = env.browser();
    expect((await signIn(other.call, 'cred-A')).status).toBe(200);
    expect((await away.call(`/api/passkeys/${passkey.id}`, { method: 'DELETE', headers: EDGE })).status).toBe(200);
    expect((await away.call('/api/hub', { headers: EDGE })).status).toBe(401);
    expect((await other.call('/api/hub', { headers: EDGE })).status).toBe(401);
    expect((await env.cli(`/api/passkeys/${passkey.id}`, { method: 'DELETE', headers: HOME })).status).toBe(404);
    expect((await env.cli('/api/passkeys', { headers: HOME })).body.passkeys).toEqual([]);
    expect((await env.cli('/api/auth/status')).body.passkeys).toEqual({ available: false, rpId: RP_ID });
    // and the revoked passkey cannot sign in again
    expect((await signIn(env.browser().call, 'cred-A')).status).toBe(401);
  });

  it('a flood of failures from the shared Docker address never blocks a valid passkey (P0-03)', async () => {
    const env = setup();
    await setPin(env.db, 'kiwi-2048');
    await env.cli('/api/settings', { method: 'PATCH', headers: HOME, body: JSON.stringify({ publicUrl: PUBLIC_URL }) });
    await enrol(env, 'cred-B');
    const attacker = env.browser();
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) statuses.push((await attacker.call('/api/auth/passkey/login', post({ challengeId: `junk-${i}`, response: { id: 'cred-B' } }))).status);
    for (let i = 0; i < 5; i++) statuses.push((await signIn(attacker.call, 'cred-nope')).status);
    for (let i = 0; i < 5; i++) statuses.push((await attacker.call('/api/auth/passkey/register-options', post({ code: `bad-code-${i}` }))).status);
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses.at(-1)).toBe(429);
    // the owner, same address: a valid passkey still signs in, a valid enrolment link still works
    const owner = env.browser();
    expect((await signIn(owner.call, 'cred-B')).status).toBe(200);
    expect((await owner.call('/api/hub', { headers: EDGE })).status).toBe(200);
    const code = (await env.cli('/api/auth/passkey/enroll-code', post({}, HOME))).body.code as string;
    expect((await env.cli('/api/auth/passkey/register-options', post({ code }))).status).toBe(200);
  });

  it('logout ends a passkey session; a passkey cannot be used without a PIN', async () => {
    const env = setup();
    await env.cli('/api/settings', { method: 'PATCH', headers: HOME, body: JSON.stringify({ publicUrl: PUBLIC_URL }) });
    // no PIN: enrolment can start, but no session can be tied to a PIN, so registration refuses
    const code = (await env.cli('/api/auth/passkey/enroll-code', post({}, HOME))).body.code as string;
    const phone = env.browser();
    const opts = await phone.call('/api/auth/passkey/register-options', post({ code }));
    expect((await phone.call('/api/auth/passkey/register', post({ code, response: { id: 'cred-C', challengeEcho: opts.body.options.challenge } }))).status).toBe(409);
    await setPin(env.db, 'kiwi-2048');
    expect((await phone.call('/api/auth/passkey/register', post({ code, response: { id: 'cred-C', challengeEcho: opts.body.options.challenge } }))).status).toBe(200);
    expect((await phone.call('/api/hub', { headers: EDGE })).status).toBe(200);
    expect((await phone.call('/api/auth/logout', post({}))).status).toBe(200);
    expect((await phone.call('/api/hub', { headers: EDGE })).status).toBe(401);
  });
});

describe('the enrolment link', () => {
  it('a plain GET of /passkey?code=… gets the web app (SPA fallback)', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dist = mkdtempSync(join(tmpdir(), 'finc-web-'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>finc</title>');
    const db = openDb(':memory:');
    const state: WorkerState = { db, vault: null, scheduler: { config: { times: [], jitterMinutes: 0, timezone: 'UTC', monthsBack: 3 }, isRunning: false, nextRun: () => null } as never, startedAt: Date.now() };
    const { app } = createApp(state, { controlToken: TOKEN, webDist: dist });
    const res = await app.request('/passkey?code=abcDEF123_-xyz', { headers: EDGE });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(await res.text()).toContain('<title>finc</title>');
  });
});

describe('passkey sessions in the store', () => {
  it('keep their fixed end across a restart and are dropped by revokeWhere', () => {
    let t = 1_000_000;
    let saved: Record<string, never> = {};
    const store = { load: () => saved, save: (e: Record<string, unknown>) => void (saved = e as never) };
    const s = new Sessions(store, () => t);
    const { token, expiresAt } = s.createPasskey('phone', 'stamp', 7);
    expect(expiresAt).toBe(t + PASSKEY_SESSION_MS);
    const pin = s.create('pc', 'stamp');
    t += PASSKEY_SESSION_MS - 1;
    const restarted = new Sessions(store, () => t);
    expect(restarted.check(token, 'stamp')).toMatchObject({ kind: 'passkey', passkeyId: 7 });
    expect(restarted.check(pin, 'stamp')?.kind).toBeUndefined();
    expect(restarted.revokeWhere((e) => e.kind === 'passkey' && e.passkeyId === 7)).toBe(1);
    expect(new Sessions(store, () => t).check(token, 'stamp')).toBeNull();
    expect(new Sessions(store, () => t).check(pin, 'stamp')).not.toBeNull();
    const second = s.createPasskey('phone', 'stamp', 8).token;
    t += PASSKEY_SESSION_MS;
    expect(new Sessions(store, () => t).check(second, 'stamp')).toBeNull(); // expired entries are not even loaded
  });
});

describe('passkeys: independent review 2026-11-10', () => {
  async function ready() {
    const env = setup();
    await setPin(env.db, 'kiwi-2048');
    await env.cli('/api/settings', { method: 'PATCH', headers: HOME, body: JSON.stringify({ publicUrl: PUBLIC_URL }) });
    return env;
  }

  it('flooding the public login-options endpoint never pushes out the owner (stateless challenges)', async () => {
    const env = await ready();
    await enrol(env, 'cred-F');
    const owner = env.browser();
    const lo = await owner.call('/api/auth/passkey/login-options', post({}));
    const attacker = env.browser();
    for (let i = 0; i < 1500; i++) await attacker.call('/api/auth/passkey/login-options', post({}));
    const res = await owner.call('/api/auth/passkey/login', post({ challengeId: lo.body.challengeId, response: { id: 'cred-F', challengeEcho: lo.body.options.challenge } }));
    expect(res.status).toBe(200);
    // the same challenge cannot be used twice, and a forged one is refused
    expect((await env.browser().call('/api/auth/passkey/login', post({ response: { id: 'cred-F', challengeEcho: lo.body.options.challenge } }))).status).toBe(401);
    const forged = Buffer.alloc(56, 7).toString('base64url');
    expect((await env.browser().call('/api/auth/passkey/login', post({ response: { id: 'cred-F', challengeEcho: forged } }))).status).toBe(401);
    // and it expires
    const late = await env.browser().call('/api/auth/passkey/login-options', post({}));
    env.clock.t += 6 * 60_000;
    expect((await env.browser().call('/api/auth/passkey/login', post({ response: { id: 'cred-F', challengeEcho: late.body.options.challenge } }))).status).toBe(401);
  });

  it('a passkey session cannot operate the worker (vault, sync, alerts), nor be an admin even on a direct connection', async () => {
    const env = await ready();
    const { phone } = await enrol(env, 'cred-G');
    for (const [method, path] of [
      ['POST', '/api/vault/lock'],
      ['POST', '/api/vault/unlock'],
      ['POST', '/api/sync'],
      ['POST', '/api/alerts/dispatch'],
      ['POST', '/api/alerts/test'],
      ['POST', '/lock'],
      ['POST', '/unlock'],
      ['POST', '/sync'],
    ] as const) {
      const r = await phone.call(path, { method, headers: { ...EDGE, origin: PUBLIC_URL, host: 'finc-example.duckdns.org:7443' }, body: JSON.stringify({ password: 'x' }) });
      expect(r.status, `${method} ${path}`).toBe(403);
    }
    // the same cookie sent straight to the worker (no edge stamp, a private address): still no admin
    const direct = { origin: 'http://127.0.0.1:7733', host: '127.0.0.1:7733' };
    expect((await phone.call('/api/auth/passkey/enroll-code', { method: 'POST', headers: direct, body: '{}' })).status).toBe(403);
    expect((await phone.call('/api/devices/pairings', { method: 'POST', headers: direct, body: '{}' })).status).toBe(403);
    expect((await phone.call('/api/settings', { method: 'PATCH', headers: direct, body: JSON.stringify({ publicUrl: 'https://evil.example' }) })).status).toBe(403);
    // reading still works
    expect((await phone.call('/api/hub', { headers: EDGE })).status).toBe(200);
  });

  it('a passkey removed by any path ends its sessions at once', async () => {
    const env = await ready();
    const { phone, passkey } = await enrol(env, 'cred-H');
    expect((await phone.call('/api/hub', { headers: EDGE })).status).toBe(200);
    // revoked in the store directly (as a concurrent removal would leave it), without touching the session store
    env.db.$client.prepare('update passkey set revoked_at = ? where id = ?').run(new Date().toISOString(), passkey.id);
    expect((await phone.call('/api/hub', { headers: EDGE })).status).toBe(401);
  });
});
