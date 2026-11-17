import { base32Decode, hotp, openDb, setPin } from '@finc/core';
import { describe, expect, it } from 'vitest';
import type { WorkerState } from '../server.js';
import { createApp } from './app.js';

// the backup login from outside (research_notes/proposals/totp-backup-login.md): PIN + authenticator code

const TOKEN = 't'.repeat(64);
const HOME = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
// behind Docker Desktop every internet client shares the bridge address; Caddy stamps the request
const EDGE = { 'x-finc-edge': 'public', 'x-forwarded-for': '172.18.0.1', 'x-forwarded-proto': 'https', 'content-type': 'application/json' };
const PIN = 'kiwi-2048';

async function setup() {
  const db = openDb(':memory:');
  await setPin(db, PIN);
  let t = Date.parse('2026-11-17T12:00:00Z');
  const state = { db, vault: null, scheduler: { config: { times: [], jitterMinutes: 0, timezone: 'UTC', monthsBack: 3 }, isRunning: false, nextRun: () => null }, startedAt: t } as unknown as WorkerState;
  const { app } = createApp(state, { controlToken: TOKEN, webDist: '/nonexistent', now: () => t });
  const req = async (path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) => {
    const res = await app.request(path, { method: init.method ?? 'GET', headers: init.headers ?? {}, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any>, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '' };
  };
  let secret = '';
  const code = () => hotp(base32Decode(secret), Math.floor(t / 30_000));
  const turnOn = async () => {
    secret = (await req('/api/auth/totp/setup', { method: 'POST', headers: HOME })).body.secret;
    return req('/api/auth/totp/confirm', { method: 'POST', headers: HOME, body: { code: code() } });
  };
  return { db, req, turnOn, code, tick: (ms: number) => (t += ms) };
}

describe('backup login', () => {
  it('set up at home; from outside, PIN + code opens a 12-hour session that cannot do admin', async () => {
    const env = await setup();
    expect((await env.req('/api/auth/status', { headers: EDGE })).body.totp).toBe(false);
    const on = await env.turnOn();
    expect(on.body.recoveryCodes).toHaveLength(8);
    expect((await env.req('/api/auth/status', { headers: EDGE })).body.totp).toBe(true);
    env.tick(30_000); // the setup code is spent; the next one signs in
    const login = await env.req('/api/auth/totp/login', { method: 'POST', headers: EDGE, body: { pin: PIN, code: env.code() } });
    expect(login.status).toBe(200);
    const SESSION = { ...EDGE, cookie: login.cookie };
    expect((await env.req('/api/auth/status', { headers: SESSION })).body).toMatchObject({ authenticated: true, via: 'passkey' });
    expect((await env.req('/api/hub', { headers: SESSION })).status).toBe(200);
    // never admin, never the backup login's own settings
    expect((await env.req('/api/auth/totp/setup', { method: 'POST', headers: SESSION })).status).toBe(403);
    expect((await env.req('/api/auth/totp', { method: 'DELETE', headers: SESSION })).status).toBe(403);
    // the same code again: refused (used once)
    expect((await env.req('/api/auth/totp/login', { method: 'POST', headers: EDGE, body: { pin: PIN, code: env.code() } })).status).toBe(401);
    // after 12 hours the session is gone
    env.tick(12 * 3_600_000 + 1);
    expect((await env.req('/api/hub', { headers: SESSION })).status).toBe(401);
  });

  it('setup and confirm are home only; a wrong confirm code is refused', async () => {
    const env = await setup();
    expect((await env.req('/api/auth/totp/setup', { method: 'POST', headers: { ...HOME, ...EDGE } })).status).toBe(403);
    await env.req('/api/auth/totp/setup', { method: 'POST', headers: HOME });
    expect((await env.req('/api/auth/totp/confirm', { method: 'POST', headers: HOME, body: { code: '000000' } })).status).toBe(400);
    env.tick(11 * 60_000);
    expect((await env.req('/api/auth/totp/confirm', { method: 'POST', headers: HOME, body: { code: '123456' } })).status).toBe(410);
  });

  it('wrong PIN or code: one message; five wrong tries lock it; a right one then waits too', async () => {
    const env = await setup();
    await env.turnOn();
    env.tick(30_000);
    const wrongPin = await env.req('/api/auth/totp/login', { method: 'POST', headers: EDGE, body: { pin: 'nope-0000', code: env.code() } });
    expect(wrongPin).toMatchObject({ status: 401, body: { error: 'wrong PIN or code' } });
    // a wrong PIN did not spend the code: it still works with the right PIN
    for (let i = 0; i < 4; i++) await env.req('/api/auth/totp/login', { method: 'POST', headers: EDGE, body: { pin: PIN, code: '000000' } });
    const locked = await env.req('/api/auth/totp/login', { method: 'POST', headers: EDGE, body: { pin: PIN, code: env.code() } });
    expect(locked.status).toBe(429);
    expect(locked.body.retryAt).toEqual(expect.any(String));
    const events = env.db.$client.prepare(`select kind from security_event where kind like 'auth.totp%'`).all() as Array<{ kind: string }>;
    expect(events.map((e) => e.kind)).toEqual(expect.arrayContaining(['auth.totp_failed', 'auth.totp_locked']));
    env.tick(16 * 60_000);
    expect((await env.req('/api/auth/totp/login', { method: 'POST', headers: EDGE, body: { pin: PIN, code: env.code() } })).status).toBe(200);
  });

  it('a recovery code signs in once; turning it off ends backup sessions; panic turns it off', async () => {
    const env = await setup();
    const codes = (await env.turnOn()).body.recoveryCodes as string[];
    const r = await env.req('/api/auth/totp/login', { method: 'POST', headers: EDGE, body: { pin: PIN, code: codes[0] } });
    expect(r.status).toBe(200);
    expect((await env.req('/api/auth/totp/login', { method: 'POST', headers: EDGE, body: { pin: PIN, code: codes[0] } })).status).toBe(401);
    expect((await env.req('/api/auth/totp', { headers: HOME })).body).toMatchObject({ enabled: true, recoveryLeft: 7 });
    expect((await env.req('/api/auth/totp', { method: 'DELETE', headers: HOME })).status).toBe(200);
    expect((await env.req('/api/hub', { headers: { ...EDGE, cookie: r.cookie } })).status).toBe(401);
    expect((await env.req('/api/auth/totp/login', { method: 'POST', headers: EDGE, body: { pin: PIN, code: codes[1] } })).status).toBe(409);
    await env.turnOn();
    expect((await env.req('/api/panic', { method: 'POST', headers: HOME, body: { confirm: 'LOCK' } })).status).toBeLessThan(500);
    expect((await env.req('/api/auth/status', { headers: EDGE })).body.totp).toBe(false);
  });
});
