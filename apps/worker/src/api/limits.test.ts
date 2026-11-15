import { flushSecurityEvents, getSetting, listSecurityEvents, openDb, setPin, setSetting } from '@finc/core';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { WorkerState } from '../server.js';
import { createApp } from './app.js';
import type { WebAuthnFns } from './passkeys.js';

// security research P2-02: limits for outside callers on bank syncs, chat and alert sends

const TOKEN = 'e'.repeat(64);
const PUBLIC_URL = 'https://finc-example.duckdns.org:7443';
const HOME = { authorization: `Bearer ${TOKEN}` };
const EDGE = { 'x-finc-edge': 'public', 'x-forwarded-for': '198.51.100.40', 'x-forwarded-proto': 'https' };
const MIN = 60_000;
const HOUR = 60 * MIN;
// 10:00 in Jerusalem (UTC+2 in November); local midnight is 22:00Z
const T0 = Date.parse('2026-11-11T08:00:00Z');
const MIDNIGHT = Date.parse('2026-11-11T22:00:00Z');

const webauthn: Partial<WebAuthnFns> = {
  verifyRegistrationResponse: (async (opts: Record<string, unknown>) => {
    const r = opts.response as { id: string };
    return { verified: true, registrationInfo: { credential: { id: r.id, publicKey: new Uint8Array([1, 2, 3, 4]), counter: 0, transports: ['internal'] }, credentialDeviceType: 'multiDevice', credentialBackedUp: true } };
  }) as never,
  verifyAuthenticationResponse: (async (opts: Record<string, unknown>) => {
    const r = opts.response as { challengeEcho: string };
    const ec = opts.expectedChallenge as (ch: string) => boolean | Promise<boolean>;
    if (!(await ec(r.challengeEcho))) throw new Error('Unexpected authentication response challenge');
    return { verified: true, authenticationInfo: { newCounter: 1 } };
  }) as never,
};

function setup(db = openDb(':memory:'), clock = { t: T0 }, monthsBack = 3) {
  const calls: unknown[][] = [];
  const vault = { locked: false, lock() { this.locked = true; }, get: () => undefined, has: () => false, list: () => [] };
  const scheduler = {
    config: { times: [], jitterMinutes: 0, timezone: 'UTC', monthsBack },
    isRunning: false,
    nextRun: () => null,
    syncNow: async (...args: unknown[]) => {
      calls.push(args);
      return [];
    },
  };
  const state: WorkerState = { db, vault: vault as never, scheduler: scheduler as never, startedAt: Date.now() };
  const { app } = createApp(state, { controlToken: TOKEN, webDist: '/nonexistent', webauthn, now: () => clock.t });
  const browser = () => {
    const jar = { cookie: '' };
    const call = async (path: string, init: RequestInit = {}) => {
      const res = await app.request(path, { ...init, headers: { 'content-type': 'application/json', ...(jar.cookie ? { cookie: jar.cookie } : {}), ...(init.headers as Record<string, string> | undefined) } });
      const set = res.headers.get('set-cookie');
      if (set?.startsWith('finc_session=')) jar.cookie = set.split(';')[0]!;
      return { status: res.status, headers: res.headers, body: (await res.json().catch(() => ({}))) as Record<string, any> };
    };
    return { call, jar };
  };
  const cli = browser().call;
  const pair = async (name: string): Promise<{ token: string; id: number }> => {
    const code = (await cli('/api/devices/pairings', { method: 'POST', headers: HOME, body: JSON.stringify({ name }) })).body.code as string;
    const r = await cli('/api/devices/pair', { method: 'POST', headers: EDGE, body: JSON.stringify({ code }) });
    return { token: r.body.token as string, id: r.body.device.id as number };
  };
  const passkeyBrowser = async () => {
    await setPin(db, 'plum-5821');
    await cli('/api/settings', { method: 'PATCH', headers: HOME, body: JSON.stringify({ publicUrl: PUBLIC_URL }) });
    const code = (await cli('/api/auth/passkey/enroll-code', { method: 'POST', headers: HOME, body: '{}' })).body.code as string;
    const b = browser();
    await b.call('/api/auth/passkey/register-options', { method: 'POST', headers: EDGE, body: JSON.stringify({ code }) });
    const reg = await b.call('/api/auth/passkey/register', { method: 'POST', headers: EDGE, body: JSON.stringify({ code, response: { id: 'cred-Z' } }) });
    expect(reg.status).toBe(200);
    b.jar.cookie = '';
    const lo = await b.call('/api/auth/passkey/login-options', { method: 'POST', headers: EDGE, body: '{}' });
    expect((await b.call('/api/auth/passkey/login', { method: 'POST', headers: EDGE, body: JSON.stringify({ response: { id: 'cred-Z', challengeEcho: lo.body.options.challenge } }) })).status).toBe(200);
    return b;
  };
  const outside = (token: string) => ({ ...EDGE, authorization: `Bearer ${token}` });
  const post = (path: string, headers: Record<string, string>, body: unknown = {}) => cli(path, { method: 'POST', headers, body: JSON.stringify(body) });
  const events = (kind: string) => listSecurityEvents(db, { kind }).events;
  return { db, state, vault, scheduler, clock, calls, cli, pair, passkeyBrowser, outside, post, events };
}

describe('POST /api/sync from outside (P2-02)', () => {
  it('a 30-minute cooldown from the last outside start; 429 carries retryAt', async () => {
    const env = setup();
    const phone = env.outside((await env.pair('Phone Ofer')).token);
    expect((await env.post('/api/sync', phone)).status).toBe(202);
    env.clock.t = T0 + 30 * MIN - 1000;
    const r = await env.post('/api/sync', phone);
    expect(r.status).toBe(429);
    expect(r.body).toEqual({ error: expect.any(String), retryAt: new Date(T0 + 30 * MIN).toISOString() });
    expect(r.headers.get('retry-after')).toBe('1');
    env.clock.t = T0 + 30 * MIN;
    expect((await env.post('/api/sync', phone)).status).toBe(202);
    expect(env.calls).toHaveLength(2);
  });

  it('the cooldown is global across outside callers', async () => {
    const env = setup();
    const a = env.outside((await env.pair('Phone Ofer')).token);
    const b = env.outside((await env.pair('Tablet Noa')).token);
    expect((await env.post('/api/sync', a)).status).toBe(202);
    env.clock.t += 5 * MIN;
    expect((await env.post('/api/sync', b)).status).toBe(429);
  });

  it('a refusal for another reason (vault locked, already running) does not use the allowance', async () => {
    const env = setup();
    const phone = env.outside((await env.pair('Phone Ofer')).token);
    env.state.vault = null;
    expect((await env.post('/api/sync', phone)).status).toBe(409);
    expect(getSetting(env.db, 'limits.syncOutside')).toBeNull();
    env.state.vault = env.vault as never;
    (env.scheduler as { isRunning: boolean }).isRunning = true;
    expect((await env.post('/api/sync', phone)).status).toBe(409);
    expect(getSetting(env.db, 'limits.syncOutside')).toBeNull();
    (env.scheduler as { isRunning: boolean }).isRunning = false;
    expect((await env.post('/api/sync', phone)).status).toBe(202);
    expect(JSON.parse(getSetting(env.db, 'limits.syncOutside')!)).toEqual([T0]);
  });

  it('without months (what the app sends) an outside sync is never refused: the default, capped at the outside max', async () => {
    const big = setup(openDb(':memory:'), { t: T0 }, 12);
    const phone = big.outside((await big.pair('Phone Ofer')).token);
    expect((await big.post('/api/sync', phone)).status).toBe(202);
    expect(big.calls[0]![2]).toBe(3);
    // home without months keeps the scheduler default
    expect((await big.post('/api/sync', HOME)).status).toBe(202);
    expect(big.calls[1]![2]).toBeUndefined();
    // a default within the outside max is passed on as it is (the scheduler's own default)
    const small = setup();
    const p2 = small.outside((await small.pair('Phone Ofer')).token);
    expect((await small.post('/api/sync', p2)).status).toBe(202);
    expect(small.calls[0]![2]).toBeUndefined();
  });

  it('six outside syncs a calendar day (Asia/Jerusalem); the seventh waits until local midnight', async () => {
    const env = setup();
    const phone = env.outside((await env.pair('Phone Ofer')).token);
    for (let i = 0; i < 6; i++) {
      env.clock.t = T0 + i * 31 * MIN;
      expect((await env.post('/api/sync', phone)).status).toBe(202);
    }
    env.clock.t = MIDNIGHT - 1000; // 23:59:59 local, long after the cooldown
    const r = await env.post('/api/sync', phone);
    expect(r.status).toBe(429);
    expect(r.body.retryAt).toBe(new Date(MIDNIGHT).toISOString());
    env.clock.t = MIDNIGHT; // 00:00 local, still 22:00 on the UTC day
    expect((await env.post('/api/sync', phone)).status).toBe(202);
    flushSecurityEvents(env.db, env.clock.t + 10 * MIN, true);
    const ev = env.events('sync.limited');
    expect(ev.length).toBeGreaterThan(0);
    expect(JSON.parse(ev.at(-1)!.detail!)).toMatchObject({ reason: 'daily_cap', retryAt: new Date(MIDNIGHT).toISOString() });
  });

  it('more than 3 months is a 400 from outside; home may fetch 24', async () => {
    const env = setup();
    const phone = env.outside((await env.pair('Phone Ofer')).token);
    const r = await env.post('/api/sync', phone, { months: 4 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/at most 3 months/);
    expect(env.calls).toHaveLength(0);
    expect(JSON.parse(env.events('sync.limited')[0]!.detail!)).toMatchObject({ reason: 'months', retryAt: null });
    expect((await env.post('/api/sync', phone, { months: 3 })).status).toBe(202);
    expect((await env.post('/api/sync', HOME, { months: 24 })).status).toBe(202);
    expect(env.calls.map((c) => c[2])).toEqual([3, 24]);
  });

  it('home, the control token and a home device are exempt and do not start the outside cooldown', async () => {
    const env = setup();
    const { token } = await env.pair('Phone Ofer');
    for (let i = 0; i < 10; i++) expect((await env.post('/api/sync', HOME, { months: 24 })).status).toBe(202);
    // the same phone on the home Wi-Fi (no edge header) is at home
    for (let i = 0; i < 8; i++) expect((await env.post('/api/sync', { authorization: `Bearer ${token}` }, { months: 12 })).status).toBe(202);
    expect((await env.post('/sync', HOME, { months: 36 })).status).toBe(200);
    expect(getSetting(env.db, 'limits.syncOutside')).toBeNull();
    // and the phone from outside may still sync at once
    expect((await env.post('/api/sync', env.outside(token))).status).toBe(202);
  });

  it('the control token through the public site is not home: it is limited like a device (review)', async () => {
    const env = setup();
    const road = { ...EDGE, ...HOME };
    expect((await env.post('/api/sync', road, { months: 12 })).status).toBe(400);
    expect((await env.post('/api/sync', road)).status).toBe(202);
    const r = await env.post('/api/sync', road);
    expect(r.status).toBe(429);
    expect(r.body.retryAt).toBe(new Date(T0 + 30 * MIN).toISOString());
    expect((await env.post('/sync', road, {})).status).toBe(429);
    // the CLI on the PC is unaffected
    expect((await env.post('/sync', HOME, { months: 36 })).status).toBe(200);
  });

  it('institutions: known ids only, each once, at most all of them; otherwise 400 (review)', async () => {
    const env = setup();
    for (const path of ['/api/sync', '/sync']) {
      for (const bad of [{ institutions: ['max', 'max'] }, { institutions: Array(200).fill('max') }, { institutions: ['evilbank'] }, { institutions: ['riseup'] }, { institutions: ['max', 'isracard', 'beinleumi', 'max'] }]) {
        expect((await env.post(path, HOME, bad)).status).toBe(400);
      }
    }
    expect(env.calls).toHaveLength(0);
    expect((await env.post('/api/sync', HOME, { institutions: ['max', 'isracard', 'beinleumi'] })).status).toBe(202);
    expect((await env.post('/sync', HOME, { institutions: ['isracard'] })).status).toBe(200);
    expect(env.calls.map((c) => c[0])).toEqual([['max', 'isracard', 'beinleumi'], ['isracard']]);
  });

  it('the control-port /sync applies the same limit to an outside device', async () => {
    const env = setup();
    const phone = env.outside((await env.pair('Phone Ofer')).token);
    expect((await env.post('/sync', phone, { months: 6 })).status).toBe(400);
    expect((await env.post('/sync', phone, {})).status).toBe(200);
    expect((await env.post('/api/sync', phone, {})).status).toBe(429);
  });

  it('survives a worker restart: a new createApp on the same database keeps the cooldown and the day count', async () => {
    const first = setup();
    const { token } = await first.pair('Phone Ofer');
    expect((await first.post('/api/sync', first.outside(token))).status).toBe(202);
    first.clock.t += 10 * MIN;
    const second = setup(first.db, first.clock);
    const r = await second.post('/api/sync', second.outside(token));
    expect(r.status).toBe(429);
    expect(r.body.retryAt).toBe(new Date(T0 + 30 * MIN).toISOString());
  });
});

describe('POST /api/chat from outside (P2-02)', () => {
  /** a local model that cannot be reached: every allowed question is a 502, a refused one a 429 */
  const withModel = (env: ReturnType<typeof setup>) => {
    setSetting(env.db, 'ai.provider', 'local');
    setSetting(env.db, 'ai.baseUrl', 'http://127.0.0.1:1/v1');
  };
  const Q = { messages: [{ role: 'user', content: 'how much on groceries?' }] };

  it('from outside: a question over 2,000 characters is a 400; the history is cut to 12 messages of 2,000 (review)', async () => {
    const env = setup();
    const bodies: string[] = [];
    const server = createServer((req, res) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => {
        bodies.push(b);
        res.writeHead(500).end('test model');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      setSetting(env.db, 'ai.provider', 'local');
      setSetting(env.db, 'ai.baseUrl', `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
      const a = env.outside((await env.pair('Phone Ofer')).token);
      const long = { messages: [{ role: 'user', content: 'q'.repeat(2001) }] };
      const r = await env.post('/api/chat', a, long);
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/at most 2000 characters/);
      expect(bodies).toHaveLength(0);
      // 21 messages, answers of 3,000 characters: only the last ones reach the model, each cut to 2,000
      const history = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? { role: 'user', content: `msg-${String(i).padStart(2, '0')} question` } : { role: 'assistant', content: `msg-${String(i).padStart(2, '0')} ${'z'.repeat(3000)}` }));
      history.push({ role: 'user', content: 'msg-20 last question' });
      expect((await env.post('/api/chat', a, { messages: history })).status).toBe(502);
      const sent = JSON.stringify(JSON.parse(bodies[0]!).messages);
      // the last 12 are msg-09..msg-20; msg-09 is an answer, so the history starts at the question msg-10
      expect(sent).not.toContain('msg-08');
      expect(sent).not.toContain('msg-09');
      expect(sent).toContain('msg-10 question');
      expect(sent).toContain('msg-20 last question');
      expect(Math.max(...(sent.match(/z+/g) ?? ['']).map((x) => x.length))).toBeLessThanOrEqual(2000);
      // home is unchanged: the long question and the whole history go through
      bodies.length = 0;
      expect((await env.post('/api/chat', HOME, long)).status).toBe(502);
      expect((await env.post('/api/chat', HOME, { messages: history })).status).toBe(502);
      expect(JSON.stringify(JSON.parse(bodies[0]!).messages)).toContain('q'.repeat(2001));
      expect(Math.max(...(JSON.stringify(JSON.parse(bodies[1]!).messages).match(/z+/g) ?? ['']).map((x) => x.length))).toBe(3000);
    } finally {
      server.close();
    }
  });

  it('30 per rolling hour per device; another device has its own count; home is unlimited', async () => {
    const env = setup();
    withModel(env);
    await env.cli('/api/settings', { method: 'PATCH', headers: HOME, body: JSON.stringify({ limits: { chatPerHour: 3 } }) });
    const a = env.outside((await env.pair('Phone Ofer')).token);
    const b = env.outside((await env.pair('Tablet Noa')).token);
    for (let i = 0; i < 3; i++) {
      env.clock.t = T0 + i * MIN;
      expect((await env.post('/api/chat', a, Q)).status).toBe(502);
    }
    const r = await env.post('/api/chat', a, Q);
    expect(r.status).toBe(429);
    expect(r.body.retryAt).toBe(new Date(T0 + HOUR).toISOString());
    expect((await env.post('/api/chat', b, Q)).status).toBe(502);
    for (let i = 0; i < 5; i++) expect((await env.post('/api/chat', HOME, Q)).status).toBe(502);
    env.clock.t = T0 + HOUR;
    expect((await env.post('/api/chat', a, Q)).status).toBe(502);
    flushSecurityEvents(env.db, env.clock.t + 10 * MIN, true);
    expect(env.events('chat.limited').length).toBeGreaterThan(0);
  });

  it('the default is 30 an hour', async () => {
    const env = setup();
    withModel(env);
    const a = env.outside((await env.pair('Phone Ofer')).token);
    for (let i = 0; i < 30; i++) expect((await env.post('/api/chat', a, Q)).status).toBe(502);
    expect((await env.post('/api/chat', a, Q)).status).toBe(429);
  });

  it('a calendar-day cap per caller (a passkey session too), until local midnight', async () => {
    const env = setup();
    withModel(env);
    await env.cli('/api/settings', { method: 'PATCH', headers: HOME, body: JSON.stringify({ limits: { chatPerHour: 100, chatPerDay: 4 } }) });
    env.clock.t = MIDNIGHT - 4 * HOUR; // a passkey session lasts 12 hours
    const away = await env.passkeyBrowser();
    for (let i = 0; i < 4; i++) {
      env.clock.t = MIDNIGHT - 4 * HOUR + i * 30 * MIN;
      expect((await away.call('/api/chat', { method: 'POST', headers: EDGE, body: JSON.stringify(Q) })).status).toBe(502);
    }
    env.clock.t = MIDNIGHT - MIN;
    const r = await away.call('/api/chat', { method: 'POST', headers: EDGE, body: JSON.stringify(Q) });
    expect(r.status).toBe(429);
    expect(r.body.retryAt).toBe(new Date(MIDNIGHT).toISOString());
    env.clock.t = MIDNIGHT;
    expect((await away.call('/api/chat', { method: 'POST', headers: EDGE, body: JSON.stringify(Q) })).status).toBe(502);
  });

  it('refused before the model when no provider is configured: those do not count', async () => {
    const env = setup();
    await env.cli('/api/settings', { method: 'PATCH', headers: HOME, body: JSON.stringify({ limits: { chatPerHour: 1 } }) });
    const a = env.outside((await env.pair('Phone Ofer')).token);
    for (let i = 0; i < 3; i++) expect((await env.post('/api/chat', a, Q)).status).toBe(409);
    withModel(env);
    expect((await env.post('/api/chat', a, Q)).status).toBe(502);
    expect((await env.post('/api/chat', a, Q)).status).toBe(429);
  });
});

describe('POST /api/alerts/test and /dispatch from outside (P2-02)', () => {
  it('3 an hour per device for each; 429 with retryAt; home is unlimited', async () => {
    const env = setup();
    const a = env.outside((await env.pair('Phone Ofer')).token);
    for (let i = 0; i < 3; i++) expect((await env.post('/api/alerts/test', a)).status).toBe(409); // Telegram not set up
    const r = await env.post('/api/alerts/test', a);
    expect(r.status).toBe(429);
    expect(r.body).toEqual({ error: expect.any(String), retryAt: new Date(T0 + HOUR).toISOString() });
    for (let i = 0; i < 3; i++) expect((await env.post('/api/alerts/dispatch', a)).status).toBe(200);
    expect((await env.post('/api/alerts/dispatch', a)).status).toBe(429);
    for (let i = 0; i < 6; i++) expect((await env.post('/api/alerts/dispatch', HOME)).status).toBe(200);
    env.clock.t = T0 + HOUR;
    expect((await env.post('/api/alerts/dispatch', a)).status).toBe(200);
    flushSecurityEvents(env.db, env.clock.t + 10 * MIN, true);
    const ev = env.events('alerts.limited');
    // aggregated: two refusals by the same device in the same minute are one row (plus its repeat count)
    expect(ev.length).toBeGreaterThanOrEqual(1);
    expect(ev.every((e) => e.actor.startsWith('device:'))).toBe(true);
  });
});

describe('limits in settings (P2-02)', () => {
  it('GET /api/settings shows the limits; defaults first', async () => {
    const env = setup();
    expect((await env.cli('/api/settings', { headers: HOME })).body.limits).toEqual({ syncCooldownMin: 30, syncDailyCap: 6, syncMaxMonthsOutside: 3, chatPerHour: 30, chatPerDay: 100, alertsPerHour: 3 });
  });

  it('home may change them, within range; outside may not; the change is logged', async () => {
    const env = setup();
    const a = env.outside((await env.pair('Phone Ofer')).token);
    const patch = (headers: Record<string, string>, limits: unknown) => env.cli('/api/settings', { method: 'PATCH', headers, body: JSON.stringify({ limits }) });
    expect((await patch(a, { syncCooldownMin: 5 })).status).toBe(403);
    for (const bad of [{ syncCooldownMin: 0 }, { syncCooldownMin: 4 }, { syncCooldownMin: 1441 }, { chatPerHour: 501 }, { chatPerDay: 5001 }, { alertsPerHour: 61 }, { syncDailyCap: 0 }, { syncMaxMonthsOutside: 25 }, { chatPerHour: 1.5 }, { alertsPerHour: '3' }, { unknown: 1 }]) {
      expect((await patch(HOME, bad)).status).toBe(400);
    }
    expect((await patch(HOME, { syncCooldownMin: 5, syncMaxMonthsOutside: 6 })).status).toBe(200);
    expect((await env.cli('/api/settings', { headers: a })).body.limits).toMatchObject({ syncCooldownMin: 5, syncMaxMonthsOutside: 6, syncDailyCap: 6 });
    const ev = env.events('settings.changed').at(0)!;
    expect(JSON.parse(ev.detail!)).toMatchObject({ keys: ['limits.syncCooldownMin', 'limits.syncMaxMonthsOutside'], limits: { syncCooldownMin: 5, syncMaxMonthsOutside: 6 } });
    // the new values apply: 6 months, and a 5-minute cooldown
    expect((await env.post('/api/sync', a, { months: 6 })).status).toBe(202);
    env.clock.t += 4 * MIN;
    expect((await env.post('/api/sync', a, { months: 6 })).body.retryAt).toBe(new Date(T0 + 5 * MIN).toISOString());
    env.clock.t = T0 + 5 * MIN;
    expect((await env.post('/api/sync', a, { months: 6 })).status).toBe(202);
  });

  it('a passkey session cannot change them', async () => {
    const env = setup();
    const away = await env.passkeyBrowser();
    expect((await away.call('/api/settings', { method: 'PATCH', headers: EDGE, body: JSON.stringify({ limits: { chatPerDay: 500 } }) })).status).toBe(403);
  });
});
