import { type FetchFn, openDb, readMarketCache } from '@finc/core';
import { describe, expect, it, vi } from 'vitest';
import { FINNHUB_BACKOFF_BASE_MS, FINNHUB_FAIL_TTL_MS, type FinnhubKey, FinnhubService, finnhubKeyFromVault } from './finnhub.js';

// The Finnhub service: key from the vault, caches (memory and market_data_cache), failure memory, backoff, deadline.
// Fictional ticker, key and numbers; no network.
const KEY = 'TESTKEY000fictional0000';
const T0 = Date.parse('2026-11-11T08:00:00Z'); // 10:00 in Jerusalem
const H = 3_600_000;

function answer(url: string): unknown {
  const sym = new URL(url).searchParams.get('symbol')!;
  if (url.includes('/stock/recommendation')) {
    return [
      { symbol: sym, period: '2026-11-01', strongBuy: 5, buy: 10, hold: 8, sell: 1, strongSell: 1 },
      { symbol: sym, period: '2026-08-01', strongBuy: 2, buy: 8, hold: 10, sell: 2, strongSell: 0 },
    ];
  }
  return { earningsCalendar: [{ symbol: sym, date: '2026-11-16', hour: 'amc', epsEstimate: 1.1, epsActual: null, quarter: 4, year: 2026 }] };
}

function setup(o: { db?: ReturnType<typeof openDb>; respond?: (url: string) => Response | Promise<Response> | undefined; key?: () => FinnhubKey; minGapMs?: number; deadlineMs?: number } = {}) {
  const db = o.db ?? openDb(':memory:');
  const clock = { t: T0 };
  const logs: unknown[] = [];
  const log = { debug: (x: object, m: string) => logs.push([x, m]), info: (x: object, m: string) => logs.push([x, m]), warn: (x: object, m: string) => logs.push([x, m]) };
  const f = vi.fn<FetchFn>(async (url) => (await o.respond?.(url)) ?? new Response(JSON.stringify(answer(url)), { status: 200 }));
  const svc = new FinnhubService({ db, key: o.key ?? (() => ({ ok: true, key: KEY })), fetch: f, now: () => clock.t, minGapMs: o.minGapMs ?? 0, deadlineMs: o.deadlineMs ?? 2000, log });
  const kinds = () => f.mock.calls.map((c) => (c[0].includes('recommendation') ? 'rec' : 'earn')).sort();
  return { db, clock, logs, f, svc, kinds };
}

describe('finnhubKeyFromVault', () => {
  const vault = (fields: Record<string, string> | null, locked = false) => ({ locked, get: (name: string) => (name === 'finnhub' && fields ? { kind: 'generic' as const, fields, updatedAt: 'x' } : undefined) });
  it('field apiKey, else a field named finnhub; trimmed; malformed or missing is no_key; locked or absent is vault_locked', () => {
    expect(finnhubKeyFromVault(vault({ apiKey: ` ${KEY} ` }))).toEqual({ ok: true, key: KEY });
    expect(finnhubKeyFromVault(vault({ finnhub: KEY }))).toEqual({ ok: true, key: KEY });
    expect(finnhubKeyFromVault(vault({ apiKey: 'short' }))).toEqual({ ok: false, code: 'no_key' });
    expect(finnhubKeyFromVault(vault({ other: KEY }))).toEqual({ ok: false, code: 'no_key' });
    expect(finnhubKeyFromVault(vault(null))).toEqual({ ok: false, code: 'no_key' });
    expect(finnhubKeyFromVault(vault({ apiKey: KEY }, true))).toEqual({ ok: false, code: 'vault_locked' });
    expect(finnhubKeyFromVault(null)).toEqual({ ok: false, code: 'vault_locked' });
    expect(finnhubKeyFromVault({ locked: false, get: () => { throw new Error('vault is locked'); } })).toEqual({ ok: false, code: 'vault_locked' });
  });
});

describe('FinnhubService', () => {
  it('fetches both, answers the sections, stores validated rows (no symbol, no key) in market_data_cache', async () => {
    const env = setup();
    const r = await env.svc.lookup('TSTA');
    expect(r.code).toBeNull();
    expect(r.analysts).toMatchObject({ period: '2026-11', total: 25, buyShareChange3mPts: 14.5, fetchedAt: new Date(T0).toISOString(), source: 'finnhub' });
    expect(r.earnings).toEqual({ next: { date: '2026-11-16', hour: 'amc', epsEstimate: 1.1 }, last: null, fetchedAt: new Date(T0).toISOString(), stale: false });
    expect(r.analysts?.stale).toBe(false);
    expect(env.kinds()).toEqual(['earn', 'rec']);
    const stored = readMarketCache(env.db, 'finnhub', 'recommendation:TSTA');
    expect(stored).toEqual({ fetchedAt: T0, value: { symbol: 'TSTA', rows: [{ period: '2026-11-01', strongBuy: 5, buy: 10, hold: 8, sell: 1, strongSell: 1 }, { period: '2026-08-01', strongBuy: 2, buy: 8, hold: 10, sell: 2, strongSell: 0 }] } });
    expect(r.analysts && 'finnhubSymbol' in r.analysts).toBe(false);
    expect(readMarketCache(env.db, 'finnhub', 'earnings:TSTA')).toMatchObject({ fetchedAt: T0 });
    expect(JSON.stringify(env.db.$client.prepare('select * from market_data_cache').all())).not.toContain(KEY);
  });

  it('the key is never logged, nor the ticker: counts and codes only', async () => {
    const env = setup({ respond: (u) => (u.includes('recommendation') ? new Response('', { status: 401 }) : new Response('', { status: 503 })) });
    await env.svc.lookup('TSTA');
    const ok = setup({ respond: (u) => (u.includes('recommendation') ? new Response('', { status: 429 }) : undefined) });
    await ok.svc.lookup('TSTA');
    const all = JSON.stringify([...env.logs, ...ok.logs]);
    expect(env.logs.length + ok.logs.length).toBeGreaterThan(2);
    expect(all).not.toContain(KEY);
    expect(all).not.toContain('TSTA');
  });

  it('persists across restarts: a new service reads the table and does not fetch while fresh', async () => {
    const first = setup();
    await first.svc.lookup('TSTA');
    const second = setup({ db: first.db });
    const r = await second.svc.lookup('TSTA');
    expect(r.analysts).toMatchObject({ total: 25, fetchedAt: new Date(T0).toISOString() });
    expect(r.earnings?.next?.date).toBe('2026-11-16');
    expect(second.f).not.toHaveBeenCalled();
  });

  it('freshness: earnings refreshed after 12 h, recommendations after 24 h; never more often (as a daily rules run would ask)', async () => {
    const env = setup();
    for (let h = 0; h < 48; h++) {
      env.clock.t = T0 + h * H;
      await env.svc.lookup('TSTA');
    }
    expect(env.kinds()).toEqual(['earn', 'earn', 'earn', 'earn', 'rec', 'rec']);
  });

  it('vault locked or no key: the cached (stale) entry with its fetchedAt; the code only when nothing is cached or it is over 30 days old', async () => {
    let key: FinnhubKey = { ok: true, key: KEY };
    const env = setup({ key: () => key });
    expect((await env.svc.lookup('TSTB')).code).toBeNull();
    key = { ok: false, code: 'vault_locked' };
    env.clock.t = T0 + 2 * 24 * H;
    const locked = await env.svc.lookup('TSTB');
    expect(locked).toMatchObject({ code: null, analysts: { fetchedAt: new Date(T0).toISOString(), stale: true }, earnings: { fetchedAt: new Date(T0).toISOString(), stale: true } });
    key = { ok: false, code: 'no_key' };
    expect((await env.svc.lookup('TSTB')).analysts).not.toBeNull();
    expect(await env.svc.lookup('TSTC')).toEqual({ analysts: null, code: 'no_key', earnings: null });
    env.clock.t = T0 + 31 * 24 * H;
    key = { ok: false, code: 'vault_locked' };
    expect(await env.svc.lookup('TSTB')).toEqual({ analysts: null, code: 'vault_locked', earnings: null });
    expect(env.f).toHaveBeenCalledTimes(2);
  });

  it('a failure is remembered 5 minutes per symbol and kind; a stale cache is served meanwhile', async () => {
    let down = false;
    const env = setup({ respond: () => (down ? new Response('', { status: 503 }) : undefined) });
    await env.svc.lookup('TSTA');
    down = true;
    expect(await env.svc.lookup('TSTD')).toEqual({ analysts: null, code: 'unreachable', earnings: null });
    expect(env.f).toHaveBeenCalledTimes(4);
    await env.svc.lookup('TSTD');
    expect(env.f).toHaveBeenCalledTimes(4);
    env.clock.t += FINNHUB_FAIL_TTL_MS;
    await env.svc.lookup('TSTD');
    expect(env.f).toHaveBeenCalledTimes(6);
    // stale TSTA while Finnhub is down: served from the cache
    env.clock.t = T0 + 25 * H;
    expect((await env.svc.lookup('TSTA')).analysts).toMatchObject({ fetchedAt: new Date(T0).toISOString() });
  });

  it('a 429 backs every fetch off 4, then 8 minutes; busy meanwhile', async () => {
    let limited = true;
    const env = setup({ respond: () => (limited ? new Response('', { status: 429 }) : undefined) });
    expect((await env.svc.lookup('TSTA')).code).toBe('busy');
    const s1 = env.svc.status();
    expect(s1.backoffUntil).toBe(T0 + FINNHUB_BACKOFF_BASE_MS * 2); // both requests were limited: 4 then 8 minutes
    const n = env.f.mock.calls.length;
    expect((await env.svc.lookup('TSTB')).code).toBe('busy');
    expect(env.f).toHaveBeenCalledTimes(n);
    limited = false;
    env.clock.t = s1.backoffUntil!;
    expect((await env.svc.lookup('TSTB')).code).toBeNull();
    expect(env.svc.status()).toMatchObject({ failures: 0, backoffUntil: null });
  });

  it('per-part staleness: earnings past 12 h but recommendations within 24 h, while the refresh fails', async () => {
    let down = false;
    const env = setup({ respond: () => (down ? new Response('', { status: 503 }) : undefined) });
    await env.svc.lookup('TSTA');
    down = true;
    env.clock.t = T0 + 13 * H;
    const r = await env.svc.lookup('TSTA');
    expect(r.analysts?.stale).toBe(false);
    expect(r.earnings?.stale).toBe(true);
  });

  it('a 403 (not on the plan) is not_covered for that symbol only, remembered 5 minutes; the key stays usable', async () => {
    const env = setup({ respond: (u) => (u.includes('TSTX') ? new Response('', { status: 403 }) : undefined) });
    expect(await env.svc.lookup('TSTX')).toEqual({ analysts: null, code: 'not_covered', earnings: null });
    expect(env.svc.status().keyRefused).toBe(false);
    expect((await env.svc.lookup('TSTA')).code).toBeNull();
    const n = env.f.mock.calls.length;
    await env.svc.lookup('TSTX');
    expect(env.f).toHaveBeenCalledTimes(n);
  });

  it('a refused key (401) is not tried again for an hour unless it changes', async () => {
    let key = KEY;
    const env = setup({ key: () => ({ ok: true, key }), respond: () => (key === KEY ? new Response('', { status: 401 }) : undefined) });
    expect((await env.svc.lookup('TSTA')).code).toBe('no_key');
    expect(env.svc.status().keyRefused).toBe(true);
    const n = env.f.mock.calls.length;
    expect((await env.svc.lookup('TSTB')).code).toBe('no_key');
    expect(env.f).toHaveBeenCalledTimes(n);
    key = 'TESTKEY000fictional0001';
    expect((await env.svc.lookup('TSTB')).code).toBeNull();
  });

  it('one fetch per URL in flight; requests spaced by the gap', async () => {
    const starts: number[] = [];
    const env = setup({ minGapMs: 60, respond: () => (starts.push(performance.now()), undefined) });
    const [a, b] = await Promise.all([env.svc.lookup('TSTA'), env.svc.lookup('TSTA')]);
    expect(a).toEqual(b);
    expect(env.f).toHaveBeenCalledTimes(2);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(50);
  });

  it('late: busy now, the cache filled for the next build; not a US ticker: not_covered without a fetch', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => (release = res));
    const env = setup({ deadlineMs: 30, respond: async () => (await gate, undefined) });
    expect(await env.svc.lookup('TSTA')).toEqual({ analysts: null, code: 'busy', earnings: null });
    release();
    await vi.waitFor(() => expect(readMarketCache(env.db, 'finnhub', 'earnings:TSTA')).not.toBeNull());
    await vi.waitFor(() => expect(readMarketCache(env.db, 'finnhub', 'recommendation:TSTA')).not.toBeNull());
    expect((await env.svc.lookup('TSTA')).analysts).toMatchObject({ total: 25 });
    const n = env.f.mock.calls.length;
    expect(await env.svc.lookup('TSTA.TA')).toEqual({ analysts: null, code: 'not_covered', earnings: null });
    expect(env.f).toHaveBeenCalledTimes(n);
  });

  it('an answer that fails validation is invalid and stores nothing', async () => {
    const env = setup({ respond: (u) => (u.includes('recommendation') ? new Response('[{"symbol":"TSTA","period":"2026-11-01","strongBuy":-1,"buy":1,"hold":1,"sell":0,"strongSell":0}]', { status: 200 }) : undefined) });
    expect((await env.svc.lookup('TSTA')).code).toBe('invalid');
    expect(readMarketCache(env.db, 'finnhub', 'recommendation:TSTA')).toBeNull();
  });
});

describe('FinnhubService: an answer about another symbol', () => {
  // fictional: TSTA is asked; Finnhub answers for `echo`; profile2 says `ticker`
  const aliased = (echo: string, ticker: string | null, extra: (u: string) => Response | undefined = () => undefined) => (u: string) => {
    const x = extra(u);
    if (x) return x;
    if (u.includes('profile2')) return new Response(JSON.stringify(ticker ? { ticker, name: 'Test A' } : {}), { status: 200 });
    return new Response(JSON.stringify(answer(u.replace('symbol=TSTA', `symbol=${echo}`))), { status: 200 });
  };

  it.each([
    ['a share class (prefix)', 'TSTA.B'],
    ['another listing (other)', 'TSTQ.L'],
  ])('%s verified by profile2: accepted, finnhubSymbol set, profile cached', async (_why, echo) => {
    const env = setup({ respond: aliased(echo, echo) });
    const r = await env.svc.lookup('TSTA');
    expect(r.code).toBeNull();
    expect(r.analysts).toMatchObject({ total: 25, finnhubSymbol: echo });
    expect(r.earnings).toMatchObject({ next: { date: '2026-11-16' }, finnhubSymbol: echo });
    expect(env.f.mock.calls.filter((c) => c[0].includes('profile2'))).toHaveLength(1); // shared by both parts
    expect(readMarketCache(env.db, 'finnhub', 'profile:TSTA')).toEqual({ fetchedAt: T0, value: { ticker: echo } });
    expect(readMarketCache(env.db, 'finnhub', 'recommendation:TSTA')?.value).toMatchObject({ symbol: echo });
    expect(JSON.stringify(env.logs)).not.toMatch(/TSTA|TSTQ/);
  });

  it('unverified (profile2 empty or naming another ticker): refused as not_covered, logged as symbol_unverified without symbols', async () => {
    for (const ticker of [null, 'TSTZ']) {
      const env = setup({ respond: aliased('TSTQ.L', ticker) });
      expect(await env.svc.lookup('TSTA')).toEqual({ analysts: null, code: 'not_covered', earnings: null });
      expect(readMarketCache(env.db, 'finnhub', 'recommendation:TSTA')).toBeNull();
      expect(JSON.stringify(env.logs)).toContain('symbol_unverified');
      expect(JSON.stringify(env.logs)).not.toMatch(/TSTA|TSTQ|TSTZ/);
    }
  });

  it('entries with different symbols in one answer are refused (invalid), without asking profile2', async () => {
    const env = setup({
      respond: (u) =>
        u.includes('recommendation')
          ? new Response(JSON.stringify([{ symbol: 'TSTA', period: '2026-11-01', strongBuy: 5, buy: 10, hold: 8, sell: 1, strongSell: 1 }, { symbol: 'TSTA.B', period: '2026-10-01', strongBuy: 5, buy: 10, hold: 8, sell: 1, strongSell: 1 }]), { status: 200 })
          : undefined,
    });
    expect((await env.svc.lookup('TSTA')).code).toBe('invalid');
    expect(env.f.mock.calls.some((c) => c[0].includes('profile2'))).toBe(false);
    expect(JSON.stringify(env.logs)).toContain('symbol_mixed');
  });

  it('cache round trip: a new service reads the alias from the table, re-validates with it, fetches nothing', async () => {
    const first = setup({ respond: aliased('TSTA.B', 'TSTA.B') });
    await first.svc.lookup('TSTA');
    const second = setup({ db: first.db, respond: () => new Response('', { status: 503 }) });
    const r = await second.svc.lookup('TSTA');
    expect(r.analysts).toMatchObject({ total: 25, finnhubSymbol: 'TSTA.B', stale: false });
    expect(r.earnings).toMatchObject({ finnhubSymbol: 'TSTA.B' });
    expect(second.f).not.toHaveBeenCalled();
    // a stored entry whose rows do not fit (tampered symbol) is not used
    first.db.$client.prepare(`update market_data_cache set json = json_set(json, '$.symbol', 'bad symbol!') where key = 'recommendation:TSTA'`).run();
    const third = setup({ db: first.db, respond: () => new Response('', { status: 503 }) });
    expect((await third.svc.lookup('TSTA')).code).toBe('unreachable');
  });

  it('the profile is cached 30 days: a later refresh of the alias asks profile2 no more', async () => {
    const env = setup({ respond: aliased('TSTA.B', 'TSTA.B') });
    await env.svc.lookup('TSTA');
    env.clock.t = T0 + 25 * H;
    await env.svc.lookup('TSTA');
    expect(env.f.mock.calls.filter((c) => c[0].includes('profile2'))).toHaveLength(1);
    expect(env.f.mock.calls.filter((c) => c[0].includes('recommendation'))).toHaveLength(2);
  });
});
