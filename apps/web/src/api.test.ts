import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security research P2-01 (on top of P1-10): in the Android app every hub request goes through FincVault.request()
 * (native HttpsURLConnection, pinned), which adds the device token itself. JS names only an "/api/..." path; the
 * token is never in any object JS builds or keeps. The browser keeps fetch, unchanged.
 */
const native = vi.hoisted(() => ({ on: true }));
const vault = vi.hoisted(() => ({ request: vi.fn(), pair: vi.fn(), lock: vi.fn(), capacitorHttp: vi.fn() }));
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => native.on },
  // must never be used for the hub any more
  CapacitorHttp: { request: vault.capacitorHttp },
  registerPlugin: (name: string) => {
    if (name !== 'FincVault') throw new Error(`unexpected plugin ${name}`);
    return vault;
  },
}));

const { ApiError, api, checkApiPath, getServer, nativeOnlyPath, onLocked, onUnauthorized, pairDevice, setServer } = await import('./api');

const fetchMock = vi.fn();
const HUB = 'https://hub.example:7443';
const TOKEN = 'tok-SECRET-1';

/** Every argument the native side ever received, and everything JS keeps, must be free of the token. */
function expectNoToken(...values: unknown[]): void {
  for (const v of values) expect(JSON.stringify(v ?? null)).not.toContain(TOKEN);
}

const answer = (status: number, data: unknown, headers: Record<string, string> = {}) => ({ status, data, headers });

beforeEach(() => {
  native.on = true;
  vault.request.mockReset();
  vault.pair.mockReset();
  vault.capacitorHttp.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  setServer({ url: HUB });
});
afterEach(() => {
  setServer(null);
  vi.unstubAllGlobals();
});

describe('api in the app: FincVault.request only, no token in JS', () => {
  it('GET: the path only (no url, no Authorization); fetch and CapacitorHttp are never used', async () => {
    vault.request.mockResolvedValue(answer(200, { ok: 1 }));
    expect(await api.get('/api/hub?month=2026-11')).toEqual({ ok: 1 });
    expect(vault.request).toHaveBeenCalledWith({ path: '/api/hub?month=2026-11', method: 'GET' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vault.capacitorHttp).not.toHaveBeenCalled();
  });

  it('setServer in the app keeps the url only, even if a token is handed to it', () => {
    setServer({ url: HUB, token: TOKEN });
    expect(getServer()).toEqual({ url: HUB });
    expectNoToken(getServer());
  });

  it('PATCH sends the JSON as text; DELETE sends no body; no headers from JS at all', async () => {
    vault.request.mockResolvedValue(answer(200, { ok: true }));
    await api.patch('/api/settings', { label: 'מזון' });
    expect(vault.request.mock.calls[0]![0]).toEqual({ path: '/api/settings', method: 'PATCH', body: '{"label":"מזון"}' });
    await api.del('/api/devices/3');
    expect(vault.request.mock.calls[1]![0]).toEqual({ path: '/api/devices/3', method: 'DELETE' });
    for (const [o] of vault.request.mock.calls) {
      expect(o.headers).toBeUndefined();
      expect('url' in o).toBe(false);
    }
  });

  it('a path that is not /api/... never reaches native (the JS mirror of the native check)', async () => {
    for (const p of ['/health', 'https://evil.example/api/x', '//evil.example/api/x', '/api/../x', '/api//x', '/api/%2e%2e/x', '/api/x#y', '/api/x\\y', '/api/devices/pair']) {
      await expect(api.get(p)).rejects.toThrow(/refused/);
    }
    expect(vault.request).not.toHaveBeenCalled();
  });

  it("an error status surfaces the hub's own message and issues; 401 tells the listeners", async () => {
    const seen = vi.fn();
    const off = onUnauthorized(seen);
    vault.request.mockResolvedValue(answer(400, { error: 'invalid request', issues: ['amount: required'] }));
    const e = await api.post('/api/x', {}).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ message: 'invalid request', status: 400, issues: ['amount: required'] });
    vault.request.mockResolvedValue(answer(401, { error: 'unauthorized' }));
    await expect(api.get('/api/hub')).rejects.toMatchObject({ status: 401, message: 'unauthorized' });
    expect(seen).toHaveBeenCalledTimes(1);
    // /api/auth/* 401s are answers, not revocations
    await expect(api.get('/api/auth/status')).rejects.toMatchObject({ status: 401 });
    expect(seen).toHaveBeenCalledTimes(1);
    off();
  });

  it('an error keeps the whole body: a 429 carries retryAt (P2-02)', async () => {
    vault.request.mockResolvedValue(answer(429, { error: 'too many requests', retryAt: '2026-11-11T12:35:00.000Z' }, { 'retry-after': '60' }));
    const e = (await api.post('/api/sync', {}).catch((x: unknown) => x)) as InstanceType<typeof ApiError>;
    expect(e).toMatchObject({ message: 'too many requests', status: 429 });
    expect(e.data).toEqual({ error: 'too many requests', retryAt: '2026-11-11T12:35:00.000Z' });
    vault.request.mockResolvedValue(answer(502, '<html>bad gateway</html>'));
    expect(((await api.get('/api/hub').catch((x: unknown) => x)) as InstanceType<typeof ApiError>).data).toEqual({});
  });

  it('JSON that arrives as text is parsed; a non-JSON error falls back to the status; 204 is an empty object; a redirect is an error', async () => {
    vault.request.mockResolvedValue(answer(200, '{"a":1}'));
    expect(await api.get('/api/a')).toEqual({ a: 1 });
    // list endpoints (e.g. /api/events) answer an array, parsed natively or as text
    vault.request.mockResolvedValue(answer(200, [{ id: 1 }]));
    expect(await api.get('/api/events')).toEqual([{ id: 1 }]);
    vault.request.mockResolvedValue(answer(200, '[{"id":2}]'));
    expect(await api.get('/api/events')).toEqual([{ id: 2 }]);
    vault.request.mockResolvedValue(answer(502, '<html>bad gateway</html>'));
    await expect(api.get('/api/hub')).rejects.toMatchObject({ message: 'HTTP 502', status: 502 });
    vault.request.mockResolvedValue(answer(204, ''));
    expect(await api.del('/api/x')).toEqual({});
    vault.request.mockResolvedValue(answer(302, ''));
    await expect(api.get('/api/hub')).rejects.toMatchObject({ message: 'HTTP 302', status: 302 });
  });

  it('a native failure (pin mismatch, no network) rejects and nothing falls back to fetch', async () => {
    vault.request.mockRejectedValue(Object.assign(new Error('secure connection to the hub failed (certificate or pin)'), { code: 'network' }));
    await expect(api.get('/api/hub')).rejects.toThrow(/certificate or pin/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vault.capacitorHttp).not.toHaveBeenCalled();
  });

  it("a native error that names the hub never shows the hub's address", async () => {
    vault.request.mockRejectedValue(new Error(`failed: ${HUB}/api/hub`));
    const err = (await api.get('/api/hub').catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain('hub.example');
  });

  it("native 'locked' (relocked natively): the locked listeners run, no 401 listeners", async () => {
    const locked = vi.fn();
    const unauthorized = vi.fn();
    const off1 = onLocked(locked);
    const off2 = onUnauthorized(unauthorized);
    vault.request.mockRejectedValue(Object.assign(new Error('finc is locked'), { code: 'locked' }));
    await expect(api.get('/api/hub')).rejects.toThrow(/locked/);
    expect(locked).toHaveBeenCalledTimes(1);
    expect(unauthorized).not.toHaveBeenCalled();
    off1();
    off2();
  });

  it('no hub in JS (relocked): nothing is sent, the app goes to the lock screen', async () => {
    const locked = vi.fn();
    const off = onLocked(locked);
    setServer(null);
    await expect(api.get('/api/hub')).rejects.toThrow(/locked/);
    expect(vault.request).not.toHaveBeenCalled();
    expect(locked).toHaveBeenCalledTimes(1);
    off();
  });

  it('pairing is redeemed natively: JS gets the hub and the device, never a token', async () => {
    setServer(null);
    // even if a (buggy) native side answered with a token, pairDevice would not pass it on
    vault.pair.mockResolvedValue({ ok: true, url: `${HUB}/`, device: { id: 5, name: 'Pixel' }, token: TOKEN });
    const r = await pairDevice(`${HUB}/`, 'code-12345678', 'Pixel');
    expect(r).toEqual({ url: HUB, device: { id: 5, name: 'Pixel' } });
    expectNoToken(r, getServer());
    expect(vault.pair).toHaveBeenCalledWith({ url: HUB, code: 'code-12345678', name: 'Pixel' });
    expect(vault.request).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vault.capacitorHttp).not.toHaveBeenCalled();
  });

  it("pairing errors: the hub's message, a wrong host, a transport failure without the address", async () => {
    vault.pair.mockResolvedValue({ ok: false, status: 401, data: { error: 'pairing code is wrong or expired' } });
    await expect(pairDevice(HUB, 'code-12345678', 'Pixel')).rejects.toMatchObject({ message: 'pairing code is wrong or expired', status: 401 });
    vault.pair.mockResolvedValue({ ok: false, status: 429, data: {} });
    await expect(pairDevice(HUB, 'code-12345678', 'Pixel')).rejects.toMatchObject({ message: 'HTTP 429', status: 429 });
    vault.pair.mockResolvedValue({ ok: false, reason: 'wrong-host' });
    await expect(pairDevice('https://evil.example', 'code-12345678', 'Pixel')).rejects.toBeInstanceOf(ApiError);
    vault.pair.mockRejectedValue(new Error(`no route to ${HUB}`));
    const e = (await pairDevice(HUB, 'code-12345678', 'Pixel').catch((x: unknown) => x)) as Error;
    expect(e.message).not.toContain('hub.example');
  });
});

describe('checkApiPath: the same rule as HubRequestRules.validApiPath', () => {
  it('accepts /api/ paths with queries (escapes only after "?")', () => {
    for (const p of ['/api/hub', '/api/hub?month=2026-11&view=all', '/api/transactions?q=a..b', '/api/transactions?q=%D7%90%20x', '/api/passkeys/abc-DEF_1', '/api/@evil.example']) expect(checkApiPath(p)).toBe(p);
  });
  it('any escape in the path is refused: the hub would decode /api/devices/%70air to the pair route', async () => {
    for (const p of ['/api/devices/%70air', '/api/devices/pai%72', '/api/%61pi/x', '/api/x%20y', '/api/x/%D7%90', '/api/x/א']) expect(checkApiPath(p), p).toBeNull();
    await expect(api.post('/api/devices/%70air', { code: 'x' })).rejects.toThrow(/refused/);
    expect(vault.request).not.toHaveBeenCalled();
  });
  it('refuses everything else', () => {
    for (const p of ['', '/api', '/api/', 'api/hub', '/health', '//evil.example/api/x', 'https://evil.example/api/x', '/api//x', '/api/../admin', '/api/x/..', '/api/./x', '/api/x/.', '/api/%2e%2e/x', '/api/%2E/x', '/api/x%2fy', '/api/x%5Cy', '/api/x%00', '/api/x\\y', '/api/x#frag', '/api/x y', '/api/x\ny', '/apix/y', '/API/hub', '/api/x\t', `/api/${'a'.repeat(8200)}`, '/api/\ud800']) {
      expect(checkApiPath(p), JSON.stringify(p.slice(0, 40))).toBeNull();
    }
  });
  it('pairing is native-only', () => {
    expect(nativeOnlyPath('/api/devices/pair')).toBe(true);
    expect(nativeOnlyPath('/api/devices/PAIR/?x=1')).toBe(true);
    expect(nativeOnlyPath('/api/devices/pairings')).toBe(false);
  });
});

describe('api in the browser: fetch, unchanged', () => {
  it('same-origin cookie session without a device token; error message from the hub', async () => {
    native.on = false;
    setServer(null);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ x: 1 }), { status: 200, headers: { 'content-type': 'application/json' } }));
    expect(await api.get('/api/hub')).toEqual({ x: 1 });
    expect(fetchMock).toHaveBeenCalledWith('/api/hub', { method: 'GET', headers: {}, body: null, credentials: 'same-origin' });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'nope' }), { status: 403 }));
    await expect(api.post('/api/x', {})).rejects.toMatchObject({ message: 'nope', status: 403 });
    expect(vault.request).not.toHaveBeenCalled();
  });

  it('a browser paired away from home keeps its token and sends it as a bearer, without cookies', async () => {
    native.on = false;
    setServer({ url: '', token: 'browser-tok' });
    expect(getServer()).toEqual({ url: '', token: 'browser-tok' });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    await api.post('/api/x', { a: 1 });
    expect(fetchMock).toHaveBeenCalledWith('/api/x', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer browser-tok' }, body: '{"a":1}', credentials: 'omit' });
    expect(vault.request).not.toHaveBeenCalled();
  });

  it('browser pairing goes through fetch and returns the token', async () => {
    native.on = false;
    setServer(null);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ token: 't2', url: 'https://h/', device: { id: 5, name: 'Edge' } }), { status: 200 }));
    expect(await pairDevice('https://h/', 'code-12345678', 'Edge')).toEqual({ token: 't2', url: 'https://h', device: { id: 5, name: 'Edge' } });
    expect(fetchMock.mock.calls[0]![0]).toBe('https://h/api/devices/pair');
    expect(vault.pair).not.toHaveBeenCalled();
  });
});
