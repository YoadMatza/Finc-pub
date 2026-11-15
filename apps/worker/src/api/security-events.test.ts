import { VaultError, listSecurityEvents, openDb, setPin } from '@finc/core';
import { describe, expect, it } from 'vitest';
import type { WorkerState } from '../server.js';
import { type ApiOptions, createApp } from './app.js';
import type { WebAuthnFns } from './passkeys.js';

// security research P1-08: the security log through the API (who may read it, and what the API writes into it)

const TOKEN = 'c'.repeat(64);
const PIN = 'mango-7319';
const MASTER = 'correct horse battery staple 42';
const PUBLIC_URL = 'https://finc-example.duckdns.org:7443';
const HOME = { authorization: `Bearer ${TOKEN}` };
const EDGE = { 'x-finc-edge': 'public', 'x-forwarded-for': '198.51.100.23', 'x-forwarded-proto': 'https' };

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

function fakeVault() {
  return { locked: false, lock() { this.locked = true; }, get: () => undefined, has: () => false, list: () => [], delete: () => false };
}

function setup(extra: Partial<ApiOptions> = {}) {
  const db = openDb(':memory:');
  const vault = fakeVault();
  const state: WorkerState = { db, vault: vault as never, scheduler: { config: { times: [], jitterMinutes: 0, timezone: 'UTC', monthsBack: 3 }, isRunning: false, nextRun: () => null } as never, startedAt: Date.now() };
  const { app } = createApp(state, { controlToken: TOKEN, webDist: '/nonexistent', webauthn, ...extra });
  const browser = () => {
    const jar = { cookie: '' };
    const call = async (path: string, init: RequestInit = {}) => {
      const res = await app.request(path, { ...init, headers: { 'content-type': 'application/json', ...(jar.cookie ? { cookie: jar.cookie } : {}), ...(init.headers as Record<string, string> | undefined) } });
      const set = res.headers.get('set-cookie');
      if (set?.startsWith('finc_session=')) jar.cookie = set.split(';')[0]!;
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
    };
    return { call, jar };
  };
  const cli = browser().call;
  const codes: string[] = [];
  const pair = async (name: string): Promise<{ token: string; id: number }> => {
    const code = (await cli('/api/devices/pairings', { method: 'POST', headers: HOME, body: JSON.stringify({ name }) })).body.code as string;
    codes.push(code);
    const r = await cli('/api/devices/pair', { method: 'POST', headers: EDGE, body: JSON.stringify({ code }) });
    return { token: r.body.token as string, id: r.body.device.id as number };
  };
  const passkeyBrowser = async () => {
    await cli('/api/settings', { method: 'PATCH', headers: HOME, body: JSON.stringify({ publicUrl: PUBLIC_URL }) });
    const code = (await cli('/api/auth/passkey/enroll-code', { method: 'POST', headers: HOME, body: JSON.stringify({ name: 'Laptop key' }) })).body.code as string;
    codes.push(code);
    const b = browser();
    await b.call('/api/auth/passkey/register-options', { method: 'POST', headers: EDGE, body: JSON.stringify({ code }) });
    expect((await b.call('/api/auth/passkey/register', { method: 'POST', headers: EDGE, body: JSON.stringify({ code, response: { id: 'cred-Z' } }) })).status).toBe(200);
    b.jar.cookie = '';
    const lo = await b.call('/api/auth/passkey/login-options', { method: 'POST', headers: EDGE, body: '{}' });
    expect((await b.call('/api/auth/passkey/login', { method: 'POST', headers: EDGE, body: JSON.stringify({ response: { id: 'cred-Z', challengeEcho: lo.body.options.challenge } }) })).status).toBe(200);
    return b;
  };
  const kinds = () => listSecurityEvents(db, { limit: 200 }).events.map((e) => e.kind).reverse();
  const last = (kind: string) => listSecurityEvents(db, { kind, limit: 1 }).events[0];
  return { db, state, vault, browser, cli, pair, passkeyBrowser, kinds, last, codes };
}

describe('GET /api/security-events (P1-08)', () => {
  it('is for any signed-in caller (PC session, control token, paired device, passkey session); anonymous gets 401', async () => {
    const env = setup();
    await setPin(env.db, PIN);
    const phone = await env.pair('Phone A');
    const pk = await env.passkeyBrowser();
    const home = env.browser();
    expect((await home.call('/api/auth/login', { method: 'POST', body: JSON.stringify({ pin: PIN }) })).status).toBe(200);

    expect((await env.browser().call('/api/security-events')).status).toBe(401);
    expect((await env.browser().call('/api/security-events', { headers: EDGE })).status).toBe(401);
    expect((await env.browser().call('/api/security-events', { headers: { ...EDGE, authorization: `Bearer finc_dev_${'x'.repeat(43)}` } })).status).toBe(401);
    // a PIN session cookie is a home-network thing: not through the public site (P0-04)
    expect((await env.browser().call('/api/security-events', { headers: { ...EDGE, cookie: home.jar.cookie } })).status).toBe(401);

    for (const [who, r] of [
      ['control token', await env.cli('/api/security-events', { headers: HOME })],
      ['PC session', await home.call('/api/security-events')],
      ['paired device', await env.cli('/api/security-events', { headers: { ...EDGE, authorization: `Bearer ${phone.token}` } })],
      ['passkey session', await pk.call('/api/security-events', { headers: EDGE })],
    ] as const) {
      expect(r.status, who).toBe(200);
      expect(Object.keys(r.body).sort(), who).toEqual(['events', 'nextBefore']);
      expect(r.body.events.length, who).toBeGreaterThan(0);
      expect(Object.keys(r.body.events[0]).sort(), who).toEqual(['actor', 'actorName', 'address', 'at', 'detail', 'id', 'kind']);
    }

    // read-only: nothing else answers on the path
    for (const method of ['POST', 'PATCH', 'DELETE']) expect((await env.cli('/api/security-events', { method, headers: HOME, body: '{}' })).status, method).toBe(404);
    // a revoked device is out
    expect((await env.cli(`/api/devices/${phone.id}`, { method: 'DELETE', headers: HOME })).status).toBe(200);
    expect((await env.cli('/api/security-events', { headers: { ...EDGE, authorization: `Bearer ${phone.token}` } })).status).toBe(401);
  });

  it('pages newest first with limit / before, filters by kind and checks the query', async () => {
    const env = setup();
    for (let i = 0; i < 5; i++) await env.cli('/api/vault/lock', { method: 'POST', headers: HOME });
    const p1 = await env.cli('/api/security-events?limit=2', { headers: HOME });
    expect(p1.body.events.map((e: { id: number }) => e.id)).toEqual([5, 4]);
    expect(p1.body.nextBefore).toBe(4);
    const p3 = await env.cli('/api/security-events?limit=2&before=2', { headers: HOME });
    expect(p3.body).toMatchObject({ events: [{ id: 1, kind: 'vault.lock', actor: 'control', actorName: null }], nextBefore: null });
    expect((await env.cli('/api/security-events?limit=&before=&kind=', { headers: HOME })).body.events).toHaveLength(5);
    expect((await env.cli('/api/security-events?kind=auth.pin_ok', { headers: HOME })).body).toEqual({ events: [], nextBefore: null });
    for (const q of ['limit=0', 'limit=201', 'limit=abc', 'before=-1', `kind=${'k'.repeat(41)}`]) expect((await env.cli(`/api/security-events?${q}`, { headers: HOME })).status, q).toBe(400);
  });

  it('records sign-ins, pairings, removals, vault unlocks, settings and the lockdown, with who and from where', async () => {
    let failUnlock = true;
    const env = setup({
      openVault: async () => {
        if (failUnlock) throw new VaultError('wrong master password', 'BAD_PASSWORD');
        return fakeVault() as never;
      },
    });
    await setPin(env.db, PIN);

    // PIN: a wrong one, then the right one
    const home = env.browser();
    expect((await home.call('/api/auth/login', { method: 'POST', body: JSON.stringify({ pin: 'wrong-pin-1' }) })).status).toBe(401);
    expect(env.last('auth.pin_failed')).toMatchObject({ actor: 'pc', address: '127.0.0.1', detail: '{"failures":1}' });
    expect((await home.call('/api/auth/login', { method: 'POST', body: JSON.stringify({ pin: PIN }) })).status).toBe(200);
    expect(env.last('auth.pin_ok')).toMatchObject({ actor: 'pc', address: '127.0.0.1' });

    // a phone paired from the public side, then renamed and removed at home
    const phone = await env.pair('Phone A');
    expect(env.last('device.pairing_code_created')).toMatchObject({ actor: 'control', detail: '{"name":"Phone A"}' });
    expect(env.last('device.paired')).toMatchObject({ actor: `device:${phone.id}`, actorName: 'Phone A', address: '198.51.100.23' });
    expect((await home.call(`/api/devices/${phone.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'Phone A2' }) })).status).toBe(200);
    expect(JSON.parse(env.last('device.renamed')!.detail!)).toEqual({ device: phone.id, from: 'Phone A', to: 'Phone A2' });
    // a bad pairing code from the internet
    expect((await env.cli('/api/devices/pair', { method: 'POST', headers: EDGE, body: JSON.stringify({ code: 'not-a-real-code-123' }) })).status).toBe(401);
    expect(env.last('device.pair_failed')).toMatchObject({ actor: 'public', address: '198.51.100.23' });
    // the phone removes itself: the actor is the phone, taken before the removal
    expect((await env.cli(`/api/devices/${phone.id}`, { method: 'DELETE', headers: { ...EDGE, authorization: `Bearer ${phone.token}` } })).status).toBe(200);
    expect(env.last('device.removed')).toMatchObject({ actor: `device:${phone.id}`, actorName: 'Phone A2', address: '198.51.100.23' });
    expect(JSON.parse(env.last('device.removed')!.detail!)).toEqual({ device: phone.id, name: 'Phone A2', fromOutside: true });

    // the vault: a wrong master password, then a good one (through the CLI's control port)
    expect((await env.cli('/unlock', { method: 'POST', headers: HOME, body: JSON.stringify({ password: MASTER }) })).status).toBe(401);
    expect(env.last('vault.unlock_failed')).toMatchObject({ actor: 'control', detail: '{"via":"control","reason":"wrong password","failures":1}' });
    failUnlock = false;
    expect((await home.call('/api/vault/unlock', { method: 'POST', body: JSON.stringify({ password: MASTER }) })).status).toBe(200);
    expect(env.last('vault.unlock_ok')).toMatchObject({ actor: 'pc', detail: '{"via":"hub"}' });
    // the vault from the internet: refused and recorded
    expect((await env.cli('/api/vault/unlock', { method: 'POST', headers: { ...EDGE, cookie: home.jar.cookie }, body: JSON.stringify({ password: MASTER }) })).status).toBe(401);

    // settings and alert settings: the keys, never the values of amounts
    expect((await home.call('/api/settings', { method: 'PATCH', body: JSON.stringify({ language: 'en', deviceIdleDays: 45 }) })).status).toBe(200);
    expect(JSON.parse(env.last('settings.changed')!.detail!)).toEqual({ keys: ['language', 'deviceIdleDays'], deviceIdleDays: 45 });
    expect((await home.call('/api/alerts', { method: 'PATCH', body: JSON.stringify({ amounts: { big: 4321, urgent: 98765 }, quiet: 'off' }) })).status).toBe(200);
    expect(JSON.parse(env.last('alerts.settings_changed')!.detail!)).toEqual({ keys: ['quiet', 'amounts'] });
    // a refused part of a settings patch still leaves the part that was written
    expect((await home.call('/api/settings', { method: 'PATCH', body: JSON.stringify({ language: 'he', ai: { provider: 'openai', baseUrl: 'http://example.test' } }) })).status).toBe(400);
    expect(JSON.parse(env.last('settings.changed')!.detail!)).toEqual({ keys: ['language'] });

    // sign-out, then the lockdown from the CLI
    expect((await home.call('/api/auth/logout', { method: 'POST' })).status).toBe(200);
    expect(env.last('auth.logout')).toMatchObject({ actor: 'pc', detail: '{"via":"session"}' });
    expect((await env.cli('/api/panic', { method: 'POST', headers: HOME, body: JSON.stringify({ confirm: 'LOCK' }) })).status).toBe(200);
    const lock = env.last('lockdown.run')!;
    expect(lock.actor).toBe('control');
    expect(JSON.parse(lock.detail!)).toMatchObject({ by: 'the CLI (finc panic)', vaultLocked: true });

    expect(env.kinds()).toEqual([
      'auth.pin_failed',
      'auth.pin_ok',
      'device.pairing_code_created',
      'device.paired',
      'device.renamed',
      'device.pair_failed',
      'device.used',
      'device.removed',
      'vault.unlock_failed',
      'vault.unlock_ok',
      'settings.changed',
      'alerts.settings_changed',
      'settings.changed',
      'auth.logout',
      'lockdown.run',
    ]);

    // nothing secret anywhere in the log: PINs, the master password, pairing codes, the device token, the control token, amounts
    const all = JSON.stringify(listSecurityEvents(env.db, { limit: 200 }).events);
    for (const secret of [PIN, 'wrong-pin-1', MASTER, phone.token, TOKEN, 'not-a-real-code-123', '4321', '98765', ...env.codes]) expect(all, secret).not.toContain(secret);
  });

  it('records passkey enrolment, sign-in and removal, and a failed passkey sign-in', async () => {
    const env = setup();
    await setPin(env.db, PIN);
    const pk = await env.passkeyBrowser();
    expect(env.last('passkey.enrol_code_created')).toMatchObject({ actor: 'control', detail: '{"name":"Laptop key"}' });
    const enrolled = env.last('passkey.enrolled')!;
    expect(enrolled).toMatchObject({ actorName: 'Laptop key', address: '198.51.100.23' });
    expect(enrolled.actor).toMatch(/^passkey:\d+$/);
    expect(env.last('passkey.login_ok')).toMatchObject({ actor: enrolled.actor, actorName: 'Laptop key' });
    // an unknown credential
    expect((await env.browser().call('/api/auth/passkey/login', { method: 'POST', headers: EDGE, body: JSON.stringify({ response: { id: 'cred-unknown', challengeEcho: 'x' } }) })).status).toBe(401);
    expect(env.last('passkey.login_failed')).toMatchObject({ actor: 'public', detail: '{"why":"unknown or revoked passkey"}' });
    // the passkey session removes its own passkey: recorded with the passkey as the actor (2 sessions: enrolment, sign-in)
    const id = Number(enrolled.actor.split(':')[1]);
    expect((await pk.call(`/api/passkeys/${id}`, { method: 'DELETE', headers: EDGE })).status).toBe(200);
    expect(env.last('passkey.removed')).toMatchObject({ actor: enrolled.actor, actorName: 'Laptop key', detail: `{"passkey":${id},"sessionsEnded":2}` });
  });

  it('records each device / passkey use at most once an hour, and at once from a new address or agent', async () => {
    const clock = { t: Date.parse('2026-11-11T08:00:00Z') };
    const env = setup({ now: () => clock.t });
    await setPin(env.db, PIN);
    const phone = await env.pair('Phone C');
    const asPhone = (ua: string, ip = '198.51.100.23') => env.cli('/api/hub', { headers: { ...EDGE, 'x-forwarded-for': ip, 'user-agent': ua, authorization: `Bearer ${phone.token}` } });
    for (let i = 0; i < 5; i++) expect((await asPhone('FincApp/0.7.2')).status).toBe(200);
    let used = listSecurityEvents(env.db, { kind: 'device.used' }).events;
    expect(used).toHaveLength(1);
    expect(used[0]).toMatchObject({ actor: `device:${phone.id}`, actorName: 'Phone C', address: '198.51.100.23', detail: '{"ua":"FincApp/0.7.2"}' });
    // another address: at once
    await asPhone('FincApp/0.7.2', '203.0.113.77');
    used = listSecurityEvents(env.db, { kind: 'device.used' }).events;
    expect(used).toHaveLength(2);
    expect(used[0]).toMatchObject({ address: '203.0.113.77', detail: '{"ua":"FincApp/0.7.2","changed":["address"]}' });
    // another agent, two minutes later (the per-minute cap is per address): at once
    clock.t += 2 * 60_000;
    await asPhone('curl/8.4', '203.0.113.77');
    expect(listSecurityEvents(env.db, { kind: 'device.used', limit: 1 }).events[0]!.detail).toBe('{"ua":"curl/8.4","changed":["agent"]}');
    // the same again within the hour: nothing; after an hour: one more
    clock.t += 30 * 60_000;
    await asPhone('curl/8.4', '203.0.113.77');
    expect(listSecurityEvents(env.db, { kind: 'device.used' }).events).toHaveLength(3);
    clock.t += 61 * 60_000;
    await asPhone('curl/8.4', '203.0.113.77');
    expect(listSecurityEvents(env.db, { kind: 'device.used' }).events).toHaveLength(4);
    expect(JSON.stringify(listSecurityEvents(env.db, { limit: 200 }).events)).not.toContain(phone.token);
  });

  it('a passkey session is recorded as passkey.used', async () => {
    const env = setup();
    await setPin(env.db, PIN);
    const pk = await env.passkeyBrowser();
    for (let i = 0; i < 3; i++) expect((await pk.call('/api/hub', { headers: EDGE })).status).toBe(200);
    const used = listSecurityEvents(env.db, { kind: 'passkey.used' }).events;
    expect(used).toHaveLength(1);
    expect(used[0]).toMatchObject({ actorName: 'Laptop key', address: '198.51.100.23' });
    expect(used[0]!.actor).toMatch(/^passkey:\d+$/);
  });

  it('a device flooding events of one kind is aggregated; an expired token is only device.expired', async () => {
    const env = setup();
    await setPin(env.db, PIN);
    const phone = await env.pair('Phone D');
    for (let i = 0; i < 30; i++) expect((await env.cli('/api/settings', { method: 'PATCH', headers: { ...EDGE, authorization: `Bearer ${phone.token}` }, body: JSON.stringify({ language: i % 2 ? 'he' : 'en' }) })).status).toBe(200);
    expect(listSecurityEvents(env.db, { kind: 'settings.changed' }).events).toHaveLength(1);
    // idle for longer than the expiry: its next request records the expiry and nothing else
    env.db.$client.prepare('update device set last_seen_at = ?, created_at = ? where id = ?').run('2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', phone.id);
    expect((await env.cli('/api/hub', { headers: { ...EDGE, authorization: `Bearer ${phone.token}` } })).status).toBe(401);
    expect(listSecurityEvents(env.db, { kind: 'device.expired' }).events).toHaveLength(1);
    expect(listSecurityEvents(env.db, { kind: 'device.token_rejected' }).events).toHaveLength(0);
    // later requests with the dead token are rejected tokens
    expect((await env.cli('/api/hub', { headers: { ...EDGE, authorization: `Bearer ${phone.token}` } })).status).toBe(401);
    expect(listSecurityEvents(env.db, { kind: 'device.token_rejected' }).events[0]!.detail).toBe('{"status":"revoked"}');
  });

  it('shows addresses only to the PC at home and the CLI', async () => {
    const env = setup();
    await setPin(env.db, PIN);
    const phone = await env.pair('Phone E');
    const pk = await env.passkeyBrowser();
    const fromCli = (await env.cli('/api/security-events', { headers: HOME })).body.events as { address: string | null }[];
    expect(fromCli.some((e) => e.address !== null)).toBe(true);
    const home = env.browser();
    await home.call('/api/auth/login', { method: 'POST', body: JSON.stringify({ pin: PIN }) });
    expect(((await home.call('/api/security-events')).body.events as { address: string | null }[]).some((e) => e.address !== null)).toBe(true);
    for (const r of [await env.cli('/api/security-events', { headers: { ...EDGE, authorization: `Bearer ${phone.token}` } }), await pk.call('/api/security-events', { headers: EDGE })]) {
      expect(r.status).toBe(200);
      expect(r.body.events.length).toBeGreaterThan(0);
      expect(r.body.events.every((e: { address: string | null }) => e.address === null)).toBe(true);
    }
  });

  it('records URL settings with their values, and the NAS pairing being removed', async () => {
    const env = setup();
    expect((await env.cli('/api/settings', { method: 'PATCH', headers: HOME, body: JSON.stringify({ publicUrl: `${PUBLIC_URL}/`, ai: { provider: 'local', baseUrl: 'http://192.168.1.50:11434' } }) })).status).toBe(200);
    expect(JSON.parse(env.last('settings.changed')!.detail!)).toEqual({ keys: ['publicUrl', 'ai.provider', 'ai.baseUrl'], publicUrl: PUBLIC_URL, aiBaseUrl: 'http://192.168.1.50:11434' });
    (env.vault as { delete: () => boolean }).delete = () => true;
    expect((await env.cli('/api/backup/offsite', { method: 'DELETE', headers: HOME })).status).toBe(200);
    expect(env.last('backup.offsite_removed')).toMatchObject({ actor: 'control' });
  });

  it('a flood of junk device tokens from the internet is one row (with the count later), not hundreds', async () => {
    const env = setup();
    for (let i = 0; i < 300; i++) await env.cli('/api/hub', { headers: { ...EDGE, authorization: `Bearer finc_dev_${String(i).padStart(43, 'q')}` } });
    const rows = listSecurityEvents(env.db, { kind: 'device.token_rejected' }).events;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: 'public', address: '198.51.100.23', detail: '{"status":"unknown"}' });
    // 20 wrong pairing codes: one row too
    for (let i = 0; i < 20; i++) await env.cli('/api/devices/pair', { method: 'POST', headers: EDGE, body: JSON.stringify({ code: `guess-${i}-xxxxxxxx` }) });
    expect(listSecurityEvents(env.db, { kind: 'device.pair_failed' }).events).toHaveLength(1);
  });
});
