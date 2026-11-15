import { listDevices, listPasskeys, openDb, setPin } from '@finc/core';
import { describe, expect, it } from 'vitest';
import type { WorkerState } from '../server.js';
import { type ApiOptions, createApp } from './app.js';
import type { WebAuthnFns } from './passkeys.js';

// security research P1-09: the panic switch, idle expiry through the API, and the idle-days setting

const TOKEN = 'a'.repeat(64);
const PUBLIC_URL = 'https://finc-example.duckdns.org:7443';
const HOME = { authorization: `Bearer ${TOKEN}` };
const EDGE = { 'x-finc-edge': 'public', 'x-forwarded-for': '172.18.0.1', 'x-forwarded-proto': 'https' };
const LOCK = JSON.stringify({ confirm: 'LOCK' });

/** No authenticator in a test: accept whatever echoes the challenge. */
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

/** A stand-in for the vault: only what the panic touches. */
function fakeVault() {
  return { locked: false, lock() { this.locked = true; }, get: () => undefined, has: () => false, list: () => [] };
}

function setup(extra: Partial<ApiOptions> = {}) {
  const db = openDb(':memory:');
  const vault = fakeVault();
  const state: WorkerState = { db, vault: vault as never, scheduler: { config: { times: [], jitterMinutes: 0, timezone: 'UTC', monthsBack: 3 }, isRunning: false, nextRun: () => null } as never, startedAt: Date.now() };
  const { app, sessions, panic } = createApp(state, { controlToken: TOKEN, webDist: '/nonexistent', webauthn, ...extra });
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
  const pair = async (name: string): Promise<string> => {
    const code = (await cli('/api/devices/pairings', { method: 'POST', headers: HOME, body: JSON.stringify({ name }) })).body.code as string;
    return (await cli('/api/devices/pair', { method: 'POST', headers: EDGE, body: JSON.stringify({ code }) })).body.token as string;
  };
  /** a browser at home signed in with the PIN */
  const homeBrowser = async () => {
    const b = browser();
    expect((await b.call('/api/auth/login', { method: 'POST', body: JSON.stringify({ pin: 'kiwi-2048' }) })).status).toBe(200);
    return b;
  };
  /** a browser outside signed in with a passkey */
  const passkeyBrowser = async () => {
    await cli('/api/settings', { method: 'PATCH', headers: HOME, body: JSON.stringify({ publicUrl: PUBLIC_URL }) });
    const code = (await cli('/api/auth/passkey/enroll-code', { method: 'POST', headers: HOME, body: '{}' })).body.code as string;
    const b = browser();
    await b.call('/api/auth/passkey/register-options', { method: 'POST', headers: EDGE, body: JSON.stringify({ code }) });
    expect((await b.call('/api/auth/passkey/register', { method: 'POST', headers: EDGE, body: JSON.stringify({ code, response: { id: 'cred-A' } }) })).status).toBe(200);
    b.jar.cookie = '';
    const lo = await b.call('/api/auth/passkey/login-options', { method: 'POST', headers: EDGE, body: '{}' });
    expect((await b.call('/api/auth/passkey/login', { method: 'POST', headers: EDGE, body: JSON.stringify({ response: { id: 'cred-A', challengeEcho: lo.body.options.challenge } }) })).status).toBe(200);
    return b;
  };
  return { db, state, vault, sessions, panic, browser, cli, pair, homeBrowser, passkeyBrowser };
}

describe('POST /api/panic (P1-09)', () => {
  it('refuses anonymous callers and a missing or wrong confirmation, and then changes nothing', async () => {
    const env = setup();
    await setPin(env.db, 'kiwi-2048');
    const phone = await env.pair('Phone A');
    expect((await env.browser().call('/api/panic', { method: 'POST', headers: EDGE, body: LOCK })).status).toBe(401);
    expect((await env.browser().call('/api/panic', { method: 'POST', body: LOCK })).status).toBe(401);
    expect((await env.cli('/api/panic', { method: 'POST', headers: HOME })).status).toBe(400);
    expect((await env.cli('/api/panic', { method: 'POST', headers: HOME, body: '{}' })).status).toBe(400);
    expect((await env.cli('/api/panic', { method: 'POST', headers: HOME, body: JSON.stringify({ confirm: 'lock' }) })).status).toBe(400);
    expect((await env.cli('/api/panic', { method: 'POST', headers: { ...EDGE, authorization: `Bearer ${phone}` }, body: JSON.stringify({ confirm: true }) })).status).toBe(400);
    // the global write guard: another site, or a form post, never reaches it
    expect((await env.cli('/api/panic', { method: 'POST', headers: { ...HOME, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }, body: LOCK })).status).toBe(403);
    expect((await env.cli('/api/panic', { method: 'POST', headers: { ...HOME, 'content-type': 'text/plain' }, body: LOCK })).status).toBe(415);
    expect(listDevices(env.db)).toHaveLength(1);
    expect(env.vault.locked).toBe(false);
  });

  it('a paired device locks everything from outside: devices, sessions, pairing codes, the vault', async () => {
    const env = setup();
    await setPin(env.db, 'kiwi-2048');
    const phone = await env.pair('Phone A');
    await env.pair('Tablet B');
    const home = await env.homeBrowser();
    const pending = (await env.cli('/api/devices/pairings', { method: 'POST', headers: HOME, body: JSON.stringify({ name: 'Later' }) })).body.code as string;
    const mine = { ...EDGE, authorization: `Bearer ${phone}` };

    const r = await env.cli('/api/panic', { method: 'POST', headers: mine, body: LOCK });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, devices: 2, passkeys: 0, sessions: 1, vaultLocked: true });
    expect(env.state.vault).toBeNull();
    expect(env.vault.locked).toBe(true);
    // the phone is now refused as revoked (the app unpairs), the home browser is signed out, the code is gone
    expect((await env.cli('/api/auth/status', { headers: mine })).body).toMatchObject({ authenticated: false, deviceStatus: 'revoked' });
    expect((await home.call('/api/hub')).status).toBe(401);
    expect((await env.cli('/api/devices/pair', { method: 'POST', headers: EDGE, body: JSON.stringify({ code: pending }) })).status).toBe(401);
    const all = (await env.cli('/api/devices?all=true', { headers: HOME })).body.devices as Array<{ name: string; revokedReason: string | null }>;
    expect(all.map((d) => d.revokedReason)).toEqual(['panic', 'panic']);
  });

  it('works for a passkey session, a PIN session at home and the control token', async () => {
    const env = setup();
    await setPin(env.db, 'kiwi-2048');
    const away = await env.passkeyBrowser();
    await env.pair('Phone A');
    const r1 = await away.call('/api/panic', { method: 'POST', headers: EDGE, body: LOCK });
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ ok: true, devices: 1, passkeys: 1, vaultLocked: true });
    expect(r1.body.sessions).toBeGreaterThanOrEqual(1);
    expect((await away.call('/api/hub', { headers: EDGE })).status).toBe(401);
    // the passkey itself is revoked: it cannot sign back in, and the list shows it gone
    const lo = await away.call('/api/auth/passkey/login-options', { method: 'POST', headers: EDGE, body: '{}' });
    expect((await away.call('/api/auth/passkey/login', { method: 'POST', headers: EDGE, body: JSON.stringify({ response: { id: 'cred-A', challengeEcho: lo.body.options.challenge } }) })).status).toBe(401);
    expect((await env.cli('/api/passkeys', { headers: HOME })).body.passkeys).toEqual([]);

    await env.pair('Phone B');
    const home = await env.homeBrowser();
    const r2 = await home.call('/api/panic', { method: 'POST', body: LOCK });
    expect(r2.body).toMatchObject({ ok: true, devices: 1, passkeys: 0, sessions: 1, vaultLocked: true });
    expect((await home.call('/api/hub')).status).toBe(401);

    const r3 = await env.cli('/api/panic', { method: 'POST', headers: HOME, body: LOCK });
    expect(r3.status).toBe(200);
    expect(r3.body).toMatchObject({ ok: true, devices: 0, passkeys: 0, sessions: 0, vaultLocked: true });
  });
});

describe('nothing in flight survives a panic (review 2026-11-11)', () => {
  it('a PIN sign-in whose check was running when the panic ran gets no session', async () => {
    const hook: { panic?: (who: string) => Promise<unknown> } = {};
    const env = setup({
      verifyPin: async () => {
        await hook.panic!('test');
        return true;
      },
    });
    hook.panic = env.panic;
    await setPin(env.db, 'kiwi-2048');
    const b = env.browser();
    const r = await b.call('/api/auth/login', { method: 'POST', body: JSON.stringify({ pin: 'kiwi-2048' }) });
    expect(r.status).toBe(409);
    expect(b.jar.cookie).toBe('');
    expect(env.sessions.count).toBe(0);
  });

  it('a passkey enrolment verified across a panic adds no passkey and opens no session', async () => {
    const hook: { panic?: (who: string) => Promise<unknown> } = {};
    const env = setup({
      webauthn: {
        ...webauthn,
        verifyRegistrationResponse: (async (opts: Record<string, unknown>) => {
          await hook.panic!('test');
          return (webauthn.verifyRegistrationResponse as (o: unknown) => Promise<unknown>)(opts);
        }) as never,
      },
    });
    hook.panic = env.panic;
    await setPin(env.db, 'kiwi-2048');
    await env.cli('/api/settings', { method: 'PATCH', headers: HOME, body: JSON.stringify({ publicUrl: PUBLIC_URL }) });
    const code = (await env.cli('/api/auth/passkey/enroll-code', { method: 'POST', headers: HOME, body: '{}' })).body.code as string;
    const b = env.browser();
    await b.call('/api/auth/passkey/register-options', { method: 'POST', headers: EDGE, body: JSON.stringify({ code }) });
    const r = await b.call('/api/auth/passkey/register', { method: 'POST', headers: EDGE, body: JSON.stringify({ code, response: { id: 'cred-B' } }) });
    expect(r.status).toBe(409);
    expect(listPasskeys(env.db, true)).toEqual([]);
    expect(b.jar.cookie).toBe('');
  });

  it('a passkey sign-in verified across a panic is refused', async () => {
    const hook: { panic?: (who: string) => Promise<unknown>; armed?: boolean } = {};
    const env = setup({
      webauthn: {
        ...webauthn,
        verifyAuthenticationResponse: (async (opts: Record<string, unknown>) => {
          if (hook.armed) await hook.panic!('test');
          return (webauthn.verifyAuthenticationResponse as (o: unknown) => Promise<unknown>)(opts);
        }) as never,
      },
    });
    hook.panic = env.panic;
    await setPin(env.db, 'kiwi-2048');
    await env.passkeyBrowser();
    hook.armed = true;
    const b = env.browser();
    const lo = await b.call('/api/auth/passkey/login-options', { method: 'POST', headers: EDGE, body: '{}' });
    const r = await b.call('/api/auth/passkey/login', { method: 'POST', headers: EDGE, body: JSON.stringify({ response: { id: 'cred-A', challengeEcho: lo.body.options.challenge } }) });
    expect(r.status).toBe(401);
    expect(b.jar.cookie).toBe('');
  });

  it('a vault unlock whose password check was running when the panic ran leaves the vault locked', async () => {
    const hook: { panic?: (who: string) => Promise<unknown> } = {};
    const opened = fakeVault();
    const env = setup({
      openVault: async () => {
        await hook.panic!('test');
        return opened as never;
      },
    });
    hook.panic = env.panic;
    const r = await env.cli('/unlock', { method: 'POST', headers: HOME, body: JSON.stringify({ password: 'right-horse-42' }) });
    expect(r.status).toBe(409);
    expect(env.state.vault).toBeNull();
    expect(opened.locked).toBe(true);
    // without a panic the same seam unlocks
    const later = fakeVault();
    const env2 = setup({ openVault: async () => later as never });
    env2.state.vault = null;
    expect((await env2.cli('/unlock', { method: 'POST', headers: HOME, body: JSON.stringify({ password: 'right-horse-42' }) })).status).toBe(200);
    expect(env2.state.vault).toBe(later);
  });
});

describe('GET /api/settings lockdownTelegram', () => {
  it('says whether /lockdown on the alarm bot is live', async () => {
    expect((await setup().cli('/api/settings', { headers: HOME })).body.lockdownTelegram).toBe(false);
    expect((await setup({ lockdownTelegram: () => true }).cli('/api/settings', { headers: HOME })).body.lockdownTelegram).toBe(true);
  });
});

describe('idle device expiry through the API (P1-09)', () => {
  it('a device idle for the set number of days is refused as revoked on its next request', async () => {
    const env = setup();
    const phone = await env.pair('Phone A');
    const mine = { ...EDGE, authorization: `Bearer ${phone}` };
    expect((await env.cli('/api/hub', { headers: mine })).status).toBe(200);
    env.db.$client.prepare('update device set last_seen_at = ?').run(new Date(Date.now() - 31 * 86_400_000).toISOString());
    expect((await env.cli('/api/hub', { headers: mine })).status).toBe(401);
    expect((await env.cli('/api/auth/status', { headers: mine })).body).toMatchObject({ authenticated: false, deviceStatus: 'revoked' });
    const all = (await env.cli('/api/devices?all=true', { headers: HOME })).body.devices as Array<{ revokedReason: string | null }>;
    expect(all[0]!.revokedReason).toBe('expired');
  });

  it('deviceIdleDays is in the settings and changes only at home, 0..365', async () => {
    const env = setup();
    await setPin(env.db, 'kiwi-2048');
    expect((await env.cli('/api/settings', { headers: HOME })).body.deviceIdleDays).toBe(30);
    expect((await env.cli('/api/settings', { method: 'PATCH', headers: HOME, body: JSON.stringify({ deviceIdleDays: 7 }) })).status).toBe(200);
    expect((await env.cli('/api/settings', { headers: HOME })).body.deviceIdleDays).toBe(7);
    expect((await env.cli('/api/settings', { method: 'PATCH', headers: HOME, body: JSON.stringify({ deviceIdleDays: 0 }) })).status).toBe(200);
    expect((await env.cli('/api/settings', { headers: HOME })).body.deviceIdleDays).toBe(0);
    for (const bad of [366, -1, 2.5, '30']) expect((await env.cli('/api/settings', { method: 'PATCH', headers: HOME, body: JSON.stringify({ deviceIdleDays: bad }) })).status, String(bad)).toBe(400);
    // a home browser may; a phone from outside and a passkey session may not (and nothing else in the patch is written)
    const home = await env.homeBrowser();
    expect((await home.call('/api/settings', { method: 'PATCH', body: JSON.stringify({ deviceIdleDays: 60 }) })).status).toBe(200);
    const phone = await env.pair('Phone A');
    expect((await env.cli('/api/settings', { method: 'PATCH', headers: { ...EDGE, authorization: `Bearer ${phone}` }, body: JSON.stringify({ deviceIdleDays: 365, language: 'en' }) })).status).toBe(403);
    const away = await env.passkeyBrowser();
    expect((await away.call('/api/settings', { method: 'PATCH', headers: EDGE, body: JSON.stringify({ deviceIdleDays: 365 }) })).status).toBe(403);
    const s = (await env.cli('/api/settings', { headers: HOME })).body;
    expect(s.deviceIdleDays).toBe(60);
    expect(s.language).toBe('he');
  });
});
