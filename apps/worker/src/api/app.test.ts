import { ensureAccount, ingestBatch, openDb, runEngine } from '@finc/core';
import type { NormalizedRow } from '@finc/core';
import { beforeAll, describe, expect, it } from 'vitest';
import type { WorkerState } from '../server.js';
import { createApp } from './app.js';

const row = (date: string, amount: number, description: string, extra: Partial<NormalizedRow> = {}): NormalizedRow => ({ externalAccountId: 'x', date, amount, description, status: 'completed', type: 'normal', identifier: `${description}${date}${amount}`, payload: {}, ...extra });

let app: ReturnType<typeof createApp>['app'];
let cookie = '';
const TOKEN = 'a'.repeat(64);

beforeAll(() => {
  const db = openDb(':memory:');
  const acc = ensureAccount(db, { institutionId: 'max', institutionKind: 'card', institutionDisplayName: 'Max', source: 'scraper:max', externalId: 'm', type: 'credit_card' }).accountId;
  const month = new Date().toISOString().slice(0, 7);
  ingestBatch(db, { source: 'scraper:max', runId: null, accountId: acc, rows: [row(`${month}-02`, -5000, 'WOLT'), row(`${month}-03`, -31800, 'דקאתלון'), row(`${month}-04`, 2500, 'WOLT'), row(`${month}-05`, -12000, 'חנות עלומה')] });
  runEngine(db);
  const state: WorkerState = { db, vault: null, scheduler: { config: { times: [], jitterMinutes: 0, timezone: 'UTC', monthsBack: 3 }, isRunning: false, nextRun: () => null } as never, startedAt: Date.now() };
  app = createApp(state, { controlToken: TOKEN, webDist: '/nonexistent' }).app;
});

async function json(path: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const res = await app.request(path, { ...init, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers as Record<string, string> | undefined) } });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown>, headers: res.headers };
}

describe('hub api', () => {
  it('refuses everything but auth and /health without a session, then opens one with a PIN', async () => {
    expect((await json('/api/hub')).status).toBe(401);
    expect((await json('/health')).status).toBe(200);
    expect((await json('/runs')).status).toBe(401);
    expect((await json('/api/auth/status')).body).toMatchObject({ pinSet: false, authenticated: false });
    expect((await json('/api/auth/setup', { method: 'POST', body: JSON.stringify({ pin: '1234' }) })).status).toBe(400); // too easy
    const setup = await json('/api/auth/setup', { method: 'POST', body: JSON.stringify({ pin: 'kiwi-2048' }) });
    expect(setup.status).toBe(200);
    cookie = setup.headers.get('set-cookie')!.split(';')[0]!;
    expect(cookie.startsWith('finc_session=')).toBe(true);
    expect((await json('/api/auth/setup', { method: 'POST', body: JSON.stringify({ pin: 'other-9' }) })).status).toBe(409);
    expect((await json('/api/auth/status')).body).toMatchObject({ pinSet: true, authenticated: true, via: 'session' });
  });

  it('wrong PIN is refused and rate limited; the control token works for the CLI', async () => {
    const saved = cookie;
    cookie = '';
    // three free failures; the fourth is refused and locks the PIN for everyone, even for the right PIN (audit H1)
    for (let i = 0; i < 4; i++) expect((await json('/api/auth/login', { method: 'POST', body: JSON.stringify({ pin: 'nope-1' }) })).status).toBe(401);
    expect((await json('/api/auth/login', { method: 'POST', body: JSON.stringify({ pin: 'nope-1' }) })).status).toBe(429);
    expect((await json('/api/auth/login', { method: 'POST', body: JSON.stringify({ pin: 'kiwi-2048' }) })).status).toBe(429);
    expect((await json('/runs', { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
    expect((await json('/runs', { headers: { authorization: `Bearer ${'b'.repeat(64)}` } })).status).toBe(401);
    cookie = saved;
  });

  it('read models answer and agree with each other', async () => {
    const hub = await json('/api/hub');
    expect(hub.status).toBe(200);
    const summary = hub.body.summary as { variable: { count: number; sum: number }; income: { count: number } };
    const variable = await json(`/api/transactions?month=${hub.body.month}&bucket=variable`);
    expect(variable.body.total).toBe(summary.variable.count);
    expect(variable.body.netSum).toBe(summary.variable.sum);
    expect((await json('/api/transactions?bucket=uncategorised')).body.total).toBe(2); // דקאתלון (unknown spelling) and חנות עלומה
    expect((await json('/api/transactions?q=wolt')).body.total).toBe(1); // the WOLT credit is linked as a refund and hidden by default
    expect((await json('/api/transactions?q=wolt&includeExcluded=true')).body.total).toBe(2);
    for (const p of ['/api/review', '/api/recurring', '/api/categories', '/api/accounts', '/api/settings', '/api/rules', '/api/health']) expect((await json(p)).status, p).toBe(200);
    expect((await json('/api/transactions?limit=0')).status).toBe(400);
  });

  it('decisions: category with merchant memory and rule, note, exclude, dismiss', async () => {
    const list = await json('/api/transactions?q=עלומה');
    const id = (list.body.items as Array<{ id: number }>)[0]!.id;
    const patched = await json(`/api/transactions/${id}`, { method: 'PATCH', body: JSON.stringify({ category: 'lifestyle.shopping', applyToMerchant: true, createRule: true, note: 'birthday' }) });
    expect(patched.status).toBe(200);
    expect(patched.body.transaction).toMatchObject({ categoryKey: 'lifestyle.shopping', categorySource: 'user', note: 'birthday' });
    expect(((await json('/api/rules')).body as unknown as unknown[]).length).toBe(1);
    expect((await json('/api/transactions?bucket=uncategorised')).body.total).toBe(1);
    expect((await json(`/api/transactions/${id}`, { method: 'PATCH', body: JSON.stringify({ excluded: true }) })).body.transaction).toMatchObject({ excluded: true, bucket: 'excluded' });
    expect((await json(`/api/transactions/${id}`, { method: 'PATCH', body: JSON.stringify({ excluded: false }) })).body.transaction).toMatchObject({ excluded: false });
    expect((await json(`/api/transactions/${id}`, { method: 'PATCH', body: JSON.stringify({ category: 'nonsense' }) })).status).toBe(404);
    // only an insight that exists now can be dismissed; a guessed future key is refused (P0-02)
    const attention = ((await json('/api/hub')).body.attention as Array<{ key: string }>).map((i) => i.key);
    expect(attention.length).toBeGreaterThan(0);
    expect((await json('/api/insights/dismiss', { method: 'POST', body: JSON.stringify({ key: attention[0] }) })).status).toBe(200);
    expect(((await json('/api/hub')).body.attention as Array<{ key: string }>).map((i) => i.key)).not.toContain(attention[0]);
    expect((await json('/api/insights/dismiss', { method: 'POST', body: JSON.stringify({ key: 'uncat:x' }) })).status).toBe(404);
    expect((await json('/api/insights/dismiss', { method: 'POST', body: JSON.stringify({ key: 'big:999999' }) })).status).toBe(404);
    expect((await json('/api/transactions/999999')).status).toBe(404);
  });

  it('the PIN is refused from the internet; a paired device gets in with its token until revoked', async () => {
    const PUBLIC = { 'x-forwarded-for': '203.0.113.7', 'x-forwarded-proto': 'https' };
    // the PIN flow from a public address: refused before the hash is even checked
    expect((await json('/api/auth/login', { method: 'POST', headers: PUBLIC, body: JSON.stringify({ pin: 'kiwi-2048' }) })).status).toBe(403);
    expect((await json('/api/auth/status', { headers: PUBLIC })).body).toMatchObject({ trusted: false });
    expect((await json('/api/auth/status', { headers: { 'x-forwarded-for': '192.168.1.7' } })).body).toMatchObject({ trusted: true });
    // the cookie session is a LAN thing; only a pairing code opens the door for a phone
    expect((await json('/api/devices/pairings', { method: 'POST', headers: PUBLIC, body: JSON.stringify({ name: 'Galaxy' }) })).status).toBe(401); // the cookie does not count from outside (P0-04)
    const pairing = await json('/api/devices/pairings', { method: 'POST', body: JSON.stringify({ name: 'Galaxy' }) });
    expect(pairing.status).toBe(200);
    expect(typeof pairing.body.code).toBe('string');
    expect((await json('/api/devices')).body).toMatchObject({ pendingCodes: 1 });
    // a wrong code is refused and counted; the right one works exactly once, no session needed
    const saved = cookie;
    cookie = '';
    expect((await json('/api/devices/pair', { method: 'POST', headers: PUBLIC, body: JSON.stringify({ code: 'nonsense-code' }) })).status).toBe(401);
    const paired = await json('/api/devices/pair', { method: 'POST', headers: PUBLIC, body: JSON.stringify({ code: pairing.body.code as string }) });
    expect(paired.status).toBe(200);
    const token = paired.body.token as string;
    expect(token.startsWith('finc_dev_')).toBe(true);
    expect(paired.body.device).toMatchObject({ name: 'Galaxy' });
    expect((await json('/api/devices/pair', { method: 'POST', headers: PUBLIC, body: JSON.stringify({ code: pairing.body.code as string }) })).status).toBe(401);
    // the token works from the internet, the control token's privileges are not involved
    const auth = { ...PUBLIC, authorization: `Bearer ${token}` };
    expect((await json('/api/hub', { headers: auth })).status).toBe(200);
    expect((await json('/api/auth/status', { headers: auth })).body).toMatchObject({ authenticated: true, via: 'device', device: { name: 'Galaxy' } });
    expect((await json('/api/hub', { headers: { ...PUBLIC, authorization: `Bearer finc_dev_${'x'.repeat(43)}` } })).status).toBe(401);
    // a device from the internet is not an admin: device management and where data goes need home (audit M2)
    const edgeDevice = { ...auth, 'x-finc-edge': 'public' };
    // removing a device only takes access away, so it is allowed from outside (P1-09): 404 for an unknown one, not 403
    expect((await json('/api/devices/999', { method: 'DELETE', headers: edgeDevice })).status).toBe(404);
    expect((await json('/api/devices/pairings', { method: 'POST', headers: edgeDevice, body: JSON.stringify({ name: 'x' }) })).status).toBe(403);
    expect((await json('/api/settings', { method: 'PATCH', headers: edgeDevice, body: JSON.stringify({ publicUrl: 'https://evil.example' }) })).status).toBe(403);
    expect((await json('/api/settings', { method: 'PATCH', headers: edgeDevice, body: JSON.stringify({ language: 'en' }) })).status).toBe(200);
    // the alert channel is steered from home only: a device from outside cannot rebind, mute or reshape it (P0-02)
    expect((await json('/api/alerts/telegram/discover', { method: 'POST', headers: edgeDevice })).status).toBe(403);
    expect((await json('/api/alerts/telegram/code', { method: 'POST', headers: edgeDevice })).status).toBe(403);
    expect((await json('/api/alerts', { method: 'PATCH', headers: edgeDevice, body: JSON.stringify({ quiet: { from: '00:00', to: '23:59' } }) })).status).toBe(403);
    expect((await json('/api/alerts', { method: 'PATCH', headers: edgeDevice, body: JSON.stringify({ matrix: { big_purchase: { telegram: false } } }) })).status).toBe(403);
    expect((await json('/api/alerts', { headers: edgeDevice })).status).toBe(200); // reading the settings is fine
    // at home: no Telegram token in this test vault, so making a code says so; discovering without a code is refused
    const home = { authorization: `Bearer ${TOKEN}` };
    expect((await json('/api/alerts/telegram/code', { method: 'POST', headers: home })).status).toBe(409);
    expect((await json('/api/alerts/telegram/discover', { method: 'POST', headers: home })).status).toBe(409);
    expect((await json('/api/alerts', { method: 'PATCH', headers: home, body: JSON.stringify({ weekly: { hour: 9 } }) })).status).toBe(200);
    // the money-out amounts: a valid pair is saved; urgent below big is a 400 with the reason and changes nothing
    expect((await json('/api/alerts', { method: 'PATCH', headers: edgeDevice, body: JSON.stringify({ amounts: { big: 1 } }) })).status).toBe(403);
    expect((await json('/api/alerts', { method: 'PATCH', headers: home, body: JSON.stringify({ amounts: { big: 1500, urgent: 6000 } }) })).status).toBe(200);
    expect(((await json('/api/alerts', { headers: home })).body as { config: { amounts: unknown } }).config.amounts).toEqual({ big: 1500, urgent: 6000 });
    const badAmounts = await json('/api/alerts', { method: 'PATCH', headers: home, body: JSON.stringify({ amounts: { urgent: 500 }, weekly: { hour: 10 } }) });
    expect(badAmounts.status).toBe(400);
    expect((badAmounts.body as { error: string }).error).toMatch(/urgent/);
    const afterBad = (await json('/api/alerts', { headers: home })).body as unknown as { config: { amounts: unknown; weekly: { hour: number } } };
    expect(afterBad.config.amounts).toEqual({ big: 1500, urgent: 6000 });
    expect(afterBad.config.weekly.hour).toBe(9);
    expect((await json('/api/alerts', { method: 'PATCH', headers: home, body: JSON.stringify({ amounts: { big: 0 } }) })).status).toBe(400);
    // the app's WebView origin is allowed for the token flow
    const pre = await app.request('/api/hub', { method: 'OPTIONS', headers: { origin: 'https://localhost', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } });
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://localhost');
    expect((await app.request('/api/hub', { headers: { ...auth, origin: 'https://evil.example' } })).headers.get('access-control-allow-origin')).toBeNull();
    // revoke from the PC: the phone is out immediately
    cookie = saved;
    const list = await json('/api/devices');
    const dev = (list.body.devices as Array<{ id: number; name: string; lastAddress: string }>)[0]!;
    expect(dev).toMatchObject({ name: 'Galaxy', lastAddress: '203.0.113.7' });
    expect((await json(`/api/devices/${dev.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await json(`/api/devices/${dev.id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await json('/api/hub', { headers: auth })).status).toBe(401);
    expect(((await json('/api/devices')).body.devices as unknown[]).length).toBe(0);
    // the public URL the QR carries follows the setting
    expect((await json('/api/settings', { method: 'PATCH', body: JSON.stringify({ publicUrl: 'https://finc-example.duckdns.org/' }) })).status).toBe(200);
    expect((await json('/api/devices')).body.publicUrl).toBe('https://finc-example.duckdns.org');
    expect((await json('/api/settings', { method: 'PATCH', body: JSON.stringify({ publicUrl: 'not a url' }) })).status).toBe(400);
  });

  it('the PIN guard locks after three failures and grows; a cloud base URL and remote admin actions are refused', async () => {
    const { PinGuard } = await import('./auth.js');
    const g = new PinGuard(3, 60 * 60_000);
    expect(g.record().lockMs).toBe(0);
    expect(g.record().lockMs).toBe(0);
    expect(g.record().lockMs).toBe(0);
    expect(g.record().lockMs).toBe(30_000);
    expect(g.record().lockMs).toBe(60_000);
    expect(g.retryAfterMs()).toBeGreaterThan(0);
    g.reset();
    expect(g.retryAfterMs()).toBe(0);
    // a base URL for a cloud provider is refused; the local provider may have one
    expect((await json('/api/settings', { method: 'PATCH', body: JSON.stringify({ ai: { provider: 'openai', baseUrl: 'https://evil.example/v1' } }) })).status).toBe(400);
    expect((await json('/api/settings', { method: 'PATCH', body: JSON.stringify({ ai: { provider: 'local', baseUrl: 'http://host.docker.internal:11434/v1' } }) })).status).toBe(200);
    // through the edge a cookie session does not count at all (P0-04); admin actions from a device are 403 (see above)
    const edge = { 'x-finc-edge': 'public' };
    expect((await json('/api/devices/1', { method: 'DELETE', headers: edge })).status).toBe(401);
    expect((await json('/api/settings', { method: 'PATCH', headers: edge, body: JSON.stringify({ language: 'en' }) })).status).toBe(401);
    // a cookie write from another site is refused; our own origin passes
    expect((await json('/api/settings', { method: 'PATCH', headers: { origin: 'https://evil.example', host: '127.0.0.1:7733' }, body: JSON.stringify({ language: 'he' }) })).status).toBe(403);
    expect((await json('/api/settings', { method: 'PATCH', headers: { origin: 'http://127.0.0.1:7733', host: '127.0.0.1:7733' }, body: JSON.stringify({ language: 'he' }) })).status).toBe(200);
  });

  it('logout closes the session; unknown api paths are 404; the root answers even without a build', async () => {
    expect((await json('/api/nothing')).status).toBe(404);
    const root = await app.request('/', { headers: { cookie } });
    expect(root.status).toBe(200);
    expect((await json('/api/auth/logout', { method: 'POST' })).status).toBe(200);
    expect((await json('/api/hub')).status).toBe(401);
  });
});

describe('the edge (security audit 2026-11-09)', () => {
  it('a request stamped by Caddy is never trusted, whatever address it carries; /health says nothing without auth', async () => {
    const saved = cookie;
    cookie = '';
    const edge = { 'x-finc-edge': 'public', 'x-forwarded-for': '192.168.1.5', 'x-forwarded-proto': 'https' };
    expect((await json('/api/auth/status', { headers: edge })).body).toMatchObject({ trusted: false, authenticated: false });
    expect((await json('/api/auth/login', { method: 'POST', headers: edge, body: JSON.stringify({ pin: 'kiwi-2048' }) })).status).toBe(403);
    expect((await json('/api/auth/setup', { method: 'POST', headers: edge, body: JSON.stringify({ pin: 'kiwi-2048' }) })).status).toBe(403);
    // without the stamp a private address is still the home network (direct connection, or Tailscale)
    expect((await json('/api/auth/status', { headers: { 'x-forwarded-for': '192.168.1.5' } })).body).toMatchObject({ trusted: true });
    const anon = await json('/health');
    expect(anon.status).toBe(200);
    expect(Object.keys(anon.body).sort()).toEqual(['ok', 'version']);
    const withToken = await json('/health', { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(withToken.body).toHaveProperty('connections');
    cookie = saved;
  });
});

describe('lock-out from the internet (security research P0-03)', () => {
  it('junk tokens and pairing codes from the shared Docker address never lock out a valid device or a valid code', async () => {
    const db = openDb(':memory:');
    const state: WorkerState = { db, vault: null, scheduler: { config: { times: [], jitterMinutes: 0, timezone: 'UTC', monthsBack: 3 }, isRunning: false, nextRun: () => null } as never, startedAt: Date.now() };
    const fresh = createApp(state, { controlToken: TOKEN, webDist: '/nonexistent' }).app;
    const call = async (path: string, init: RequestInit = {}) => {
      const res = await fresh.request(path, { ...init, headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) } });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    };
    // behind Docker Desktop the owner's phone and an attacker reach the worker with the same address
    const EDGE = { 'x-finc-edge': 'public', 'x-forwarded-for': '172.18.0.1', 'x-forwarded-proto': 'https' };
    const pairCode = async (name: string) => (await call('/api/devices/pairings', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ name }) })).body.code as string;
    const phone = (await call('/api/devices/pair', { method: 'POST', headers: EDGE, body: JSON.stringify({ code: await pairCode('Galaxy') }) })).body.token as string;
    expect(phone.startsWith('finc_dev_')).toBe(true);

    // the attacker floods junk device tokens and junk pairing codes: refused, then throttled
    const junk = { ...EDGE, authorization: `Bearer finc_dev_${'x'.repeat(43)}` };
    const junkStatuses: number[] = [];
    for (let i = 0; i < 25; i++) junkStatuses.push((await call('/api/hub', { headers: junk })).status);
    expect(junkStatuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(junkStatuses.at(-1)).toBe(429);
    for (let i = 0; i < 25; i++) await call('/api/devices/pair', { method: 'POST', headers: EDGE, body: JSON.stringify({ code: `bad-code-${i}` }) });
    expect((await call('/api/devices/pair', { method: 'POST', headers: EDGE, body: JSON.stringify({ code: 'bad-code-x' }) })).status).toBe(429);

    // the owner's phone, same address, keeps working
    const mine = { ...EDGE, authorization: `Bearer ${phone}` };
    expect((await call('/api/hub', { headers: mine })).status).toBe(200);
    expect((await call('/api/auth/status', { headers: mine })).body).toMatchObject({ authenticated: true, via: 'device' });
    // and a fresh pairing code made at home still pairs through the flooded address
    expect((await call('/api/devices/pair', { method: 'POST', headers: EDGE, body: JSON.stringify({ code: await pairCode('Laptop') }) })).status).toBe(200);

    // the status says WHY a token is refused, so the app unpairs only when the token is really gone
    expect((await call('/api/auth/status', { headers: mine })).body.deviceStatus).toBe('ok');
    expect((await call('/api/auth/status', { headers: junk })).body).toMatchObject({ authenticated: false, deviceStatus: 'unknown' });
    expect((await call('/api/auth/status', { headers: EDGE })).body.deviceStatus).toBeUndefined();
    const devs = (await call('/api/devices', { headers: { authorization: `Bearer ${TOKEN}` } })).body.devices as Array<{ id: number; name: string }>;
    const galaxy = devs.find((d) => d.name === 'Galaxy')!;
    expect((await call(`/api/devices/${galaxy.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
    expect((await call('/api/auth/status', { headers: mine })).body).toMatchObject({ authenticated: false, deviceStatus: 'revoked' });
  });
});

describe('sessions', () => {
  it('survive a restart through the store, hashed, and revocation reaches the store too', async () => {
    const { Sessions } = await import('./auth.js');
    let saved: Record<string, { createdAt: number; lastSeen: number; agent: string; pin?: string }> = {};
    const store = { load: () => saved, save: (e: typeof saved) => void (saved = e) };
    const first = new Sessions(store);
    const token = first.create('browser', 'stamp-1');
    expect(Object.keys(saved)).toHaveLength(1);
    expect(Object.keys(saved)[0]).not.toBe(token); // the cookie itself is never stored
    const afterRestart = new Sessions(store);
    expect(afterRestart.valid(token, 'stamp-1')).toBe(true);
    expect(afterRestart.valid('nope', 'stamp-1')).toBe(false);
    afterRestart.revoke(token);
    expect(new Sessions(store).valid(token, 'stamp-1')).toBe(false);
    expect(new Sessions().valid(token, 'stamp-1')).toBe(false); // memory-only sessions start empty
  });

  it('belong to the PIN they were opened with: another PIN, no PIN, or an unstamped old session is invalid (P0-04)', async () => {
    const { Sessions } = await import('./auth.js');
    const s = new Sessions();
    const token = s.create('browser', 'stamp-1');
    expect(s.valid(token, 'stamp-2')).toBe(false);
    expect(s.valid(token, 'stamp-1')).toBe(false); // the mismatch dropped it for good
    const t2 = s.create('browser', 'stamp-1');
    expect(s.valid(t2, null)).toBe(false);
    // a session stored before stamping existed (2026-11-10) is not honoured
    const { createHash } = await import('node:crypto');
    const old = 'old-cookie';
    const legacy = new Sessions({ load: () => ({ [createHash('sha256').update(old).digest('hex')]: { createdAt: Date.now(), lastSeen: Date.now(), agent: 'x' } }), save: () => undefined });
    expect(legacy.valid(old, 'stamp-1')).toBe(false);
  });
});

describe('browser sessions (security research P0-04)', () => {
  it('a session cookie works only from home, and a PIN change or clear ends every session', async () => {
    const { clearPin, setPin } = await import('@finc/core');
    const db = openDb(':memory:');
    const state: WorkerState = { db, vault: null, scheduler: { config: { times: [], jitterMinutes: 0, timezone: 'UTC', monthsBack: 3 }, isRunning: false, nextRun: () => null } as never, startedAt: Date.now() };
    const fresh = createApp(state, { controlToken: TOKEN, webDist: '/nonexistent' }).app;
    let jar = '';
    const call = async (path: string, init: RequestInit = {}) => {
      const res = await fresh.request(path, { ...init, headers: { 'content-type': 'application/json', ...(jar ? { cookie: jar } : {}), ...(init.headers as Record<string, string> | undefined) } });
      const set = res.headers.get('set-cookie');
      if (set?.startsWith('finc_session=')) jar = set.split(';')[0]!;
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    };
    const EDGE = { 'x-finc-edge': 'public', 'x-forwarded-for': '172.18.0.1', 'x-forwarded-proto': 'https' };

    expect((await call('/api/auth/setup', { method: 'POST', body: JSON.stringify({ pin: 'kiwi-2048' }) })).status).toBe(200);
    expect((await call('/api/hub')).status).toBe(200);
    // the same cookie through the public site: refused, the internet uses device tokens only
    expect((await call('/api/hub', { headers: EDGE })).status).toBe(401);
    expect((await call('/api/auth/status', { headers: EDGE })).body).toMatchObject({ authenticated: false });
    expect((await call('/api/hub')).status).toBe(200); // still fine at home

    // a PIN change (the CLI writes the DB directly) ends the session at once, no restart needed
    await setPin(db, 'mango-4096');
    expect((await call('/api/hub')).status).toBe(401);
    expect((await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ pin: 'mango-4096' }) })).status).toBe(200);
    expect((await call('/api/hub')).status).toBe(200);
    // clearing the PIN ends it too
    clearPin(db);
    expect((await call('/api/hub')).status).toBe(401);
  });
});

describe('removing a device from outside (security research P1-09)', () => {
  it('a phone stolen while away can be cut off from another device on the internet; pairing stays home-only', async () => {
    const db = openDb(':memory:');
    const state: WorkerState = { db, vault: null, scheduler: { config: { times: [], jitterMinutes: 0, timezone: 'UTC', monthsBack: 3 }, isRunning: false, nextRun: () => null } as never, startedAt: Date.now() };
    const fresh = createApp(state, { controlToken: TOKEN, webDist: '/nonexistent' }).app;
    const call = async (p: string, init: RequestInit = {}) => {
      const res = await fresh.request(p, { ...init, headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) } });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    };
    const EDGE = { 'x-finc-edge': 'public', 'x-forwarded-for': '172.18.0.1', 'x-forwarded-proto': 'https' };
    const home = { authorization: `Bearer ${TOKEN}` };
    const pair = async (name: string) => {
      const code = (await call('/api/devices/pairings', { method: 'POST', headers: home, body: JSON.stringify({ name }) })).body.code as string;
      return (await call('/api/devices/pair', { method: 'POST', headers: EDGE, body: JSON.stringify({ code }) })).body.token as string;
    };
    const stolen = await pair('old phone');
    const laptop = await pair('laptop');
    const devs = (await call('/api/devices', { headers: home })).body.devices as Array<{ id: number; name: string }>;
    const stolenId = devs.find((d) => d.name === 'old phone')!.id;
    const fromLaptop = { ...EDGE, authorization: `Bearer ${laptop}` };
    expect((await call(`/api/devices/${stolenId}`, { method: 'DELETE', headers: fromLaptop })).status).toBe(200);
    expect((await call('/api/hub', { headers: { ...EDGE, authorization: `Bearer ${stolen}` } })).status).toBe(401);
    expect((await call('/api/hub', { headers: fromLaptop })).status).toBe(200);
    // granting access is still for home only
    expect((await call('/api/devices/pairings', { method: 'POST', headers: fromLaptop, body: JSON.stringify({ name: 'x' }) })).status).toBe(403);
    expect((await call(`/api/devices/${stolenId}`, { method: 'PATCH', headers: fromLaptop, body: JSON.stringify({ name: 'x' }) })).status).toBe(403);
  });
});

describe('POST /sync on the control port takes dump and dryRun (security research P1-13)', () => {
  const setup = () => {
    const db = openDb(':memory:');
    const calls: unknown[][] = [];
    const scheduler = {
      config: { times: [], jitterMinutes: 0, timezone: 'UTC', monthsBack: 3 },
      isRunning: false,
      nextRun: () => null,
      syncNow: async (...args: unknown[]) => {
        calls.push(args);
        return [];
      },
    };
    const vault = { locked: false, has: () => true, list: () => [], lock: () => {} };
    const state: WorkerState = { db, vault: vault as never, scheduler: scheduler as never, startedAt: Date.now() };
    const fresh = createApp(state, { controlToken: TOKEN, webDist: '/nonexistent' }).app;
    const post = async (p: string, body: unknown) => {
      const res = await fresh.request(p, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    };
    return { calls, post };
  };

  it('passes dump and dryRun through to the scheduler; without them nothing extra is passed', async () => {
    const { calls, post } = setup();
    expect((await post('/sync', { institutions: ['max'], months: 2, dump: true, dryRun: true })).status).toBe(200);
    expect(calls[0]).toEqual([['max'], 'manual', 2, { dump: true, dryRun: true }]);
    expect((await post('/sync', { institutions: 'all', dryRun: false })).status).toBe(200);
    expect(calls[1]).toEqual(['all', 'manual', undefined, { dryRun: false }]);
    expect((await post('/sync', {})).status).toBe(200);
    expect(calls[2]).toEqual(['all', 'manual', undefined, {}]);
  });

  it('rejects bodies of the wrong types', async () => {
    const { calls, post } = setup();
    for (const bad of [{ dump: 'yes' }, { dryRun: 1 }, { months: 0 }, { months: 37 }, { months: 1.5 }, { institutions: 'max' }, { institutions: [1] }]) {
      expect((await post('/sync', bad)).status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it("the UI's /api/sync does not take them", async () => {
    const { calls, post } = setup();
    expect((await post('/api/sync', { institutions: ['max'], dump: true, dryRun: true })).status).toBe(202);
    expect(calls[0]).toEqual([['max'], 'manual', undefined]);
  });
});
