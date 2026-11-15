import type { FetchFn } from '@finc/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIRST_REFRESH_MS, OFF_SESSION_EVERY_MS, PriceService, SESSION_EVERY_MS, SESSION_IDLE_EVERY_MS, livePricesEnabled } from './prices.js';

const WED_OPEN = Date.parse('2026-11-11T18:00:00Z'); // Wednesday 13:00 New York
const SAT = Date.parse('2026-11-14T16:00:00Z');

/** A fake Yahoo: fictional prices, no network. */
function fakeYahoo(over: { status?: number } = {}) {
  const calls: string[] = [];
  const f = vi.fn<FetchFn>(async (url) => {
    calls.push(url);
    if (over.status) return new Response('', { status: over.status });
    const sym = decodeURIComponent(url.split('/chart/')[1]!.split('?')[0]!);
    const fx = sym === 'ILS=X';
    const now = Date.now();
    const body = {
      chart: {
        result: [
          {
            meta: { symbol: sym, currency: fx ? 'ILS' : 'USD', regularMarketPrice: fx ? 3.71 : 123.45, regularMarketTime: Math.floor((now - 30_000) / 1000), exchangeTimezoneName: 'America/New_York', previousClose: fx ? 3.69 : 120.5 },
            timestamp: [],
            indicators: { quote: [{ close: [] }] },
          },
        ],
        error: null,
      },
    };
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return { f, calls };
}

function capturingLog() {
  const lines: string[] = [];
  const rec = (level: string) => (o: object, m: string) => lines.push(`${level} ${m} ${JSON.stringify(o)}`);
  return { lines, log: { debug: rec('debug'), info: rec('info'), warn: rec('warn') } };
}

const symbols = () => ({ quotes: [{ symbol: 'TEST1', currency: 'USD' }], fx: true });

describe('price service', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('refreshes quotes and the rate every 2 minutes during the session while watched, symbols only in the URL', async () => {
    vi.setSystemTime(WED_OPEN);
    const { f, calls } = fakeYahoo();
    const svc = new PriceService({ symbols, fetch: f, log: capturingLog().log });
    svc.start();
    await vi.advanceTimersByTimeAsync(FIRST_REFRESH_MS);
    await svc.demand({ wait: false }); // someone opened a live view (fetched 0 s ago: no new round)
    expect(calls).toEqual(['https://query1.finance.yahoo.com/v8/finance/chart/ILS%3DX?interval=1d&range=5d', 'https://query1.finance.yahoo.com/v8/finance/chart/TEST1?interval=1d&range=5d']);
    const c = svc.cache();
    expect(c.quotes.get('TEST1')).toMatchObject({ price: 123.45, prevClose: 120.5, currency: 'USD' });
    expect(c.fx).toMatchObject({ price: 3.71, currency: 'ILS' });
    await vi.advanceTimersByTimeAsync(SESSION_EVERY_MS - 1);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(4);
    svc.stop();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(calls).toHaveLength(4);
  });

  it('outside the session: quotes once after the close, the rate every 30 minutes', async () => {
    vi.setSystemTime(SAT);
    const { f, calls } = fakeYahoo();
    const svc = new PriceService({ symbols, fetch: f, log: capturingLog().log });
    svc.start();
    await vi.advanceTimersByTimeAsync(FIRST_REFRESH_MS);
    expect(calls.map((u) => u.split('/chart/')[1]!.split('?')[0])).toEqual(['ILS%3DX', 'TEST1']);
    await vi.advanceTimersByTimeAsync(OFF_SESSION_EVERY_MS);
    expect(calls.map((u) => u.split('/chart/')[1]!.split('?')[0])).toEqual(['ILS%3DX', 'TEST1', 'ILS%3DX']);
    svc.stop();
  });

  it('never waits past the open; in session 15 minutes when nobody looks, 2 minutes for 15 minutes after a look', async () => {
    vi.setSystemTime(WED_OPEN);
    const svc = new PriceService({ symbols, fetch: fakeYahoo().f, log: capturingLog().log });
    expect(svc.nextDelay(Date.parse('2026-11-13T21:10:00Z'))).toBe(OFF_SESSION_EVERY_MS); // Friday after the close
    expect(svc.nextDelay(Date.parse('2026-11-16T14:10:00Z'))).toBe(20 * 60 * 1000 + 5000); // Monday 09:10
    expect(svc.nextDelay(WED_OPEN)).toBe(SESSION_IDLE_EVERY_MS);
    await svc.demand({ wait: false });
    expect(svc.nextDelay(WED_OPEN)).toBe(SESSION_EVERY_MS);
    expect(svc.nextDelay(WED_OPEN + 15 * 60_000)).toBe(SESSION_EVERY_MS);
    expect(svc.nextDelay(WED_OPEN + 16 * 60_000)).toBe(SESSION_IDLE_EVERY_MS);
  });

  it('an idle in-session wait shrinks to 2 minutes when someone looks', async () => {
    vi.setSystemTime(WED_OPEN);
    const { f, calls } = fakeYahoo();
    const svc = new PriceService({ symbols, fetch: f, log: capturingLog().log });
    svc.start();
    await vi.advanceTimersByTimeAsync(FIRST_REFRESH_MS); // round 1, next in 15 min (nobody looked)
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await svc.demand({ wait: false }); // over 60 s since the last round: a background round, and the pace is back to 2 min
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(SESSION_EVERY_MS);
    expect(calls).toHaveLength(6);
    svc.stop();
  });

  it('only a view that asks to wait, with a cache stale for it, waits', async () => {
    vi.setSystemTime(WED_OPEN);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const inner = fakeYahoo();
    const slow = vi.fn<FetchFn>(async (u, i) => {
      await gate;
      return inner.f(u, i);
    });
    const svc = new PriceService({ symbols, fetch: slow, log: capturingLog().log });
    expect(svc.staleForView(WED_OPEN)).toBe(true); // never fetched
    // the accounts/net-worth reads never wait, even when stale
    let done = false;
    void svc.demand({ wait: false }).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
    // the holdings view waits (at most 4 s) for the round in flight
    let viewDone = false;
    void svc.demand({ wait: true }).then(() => (viewDone = true));
    await vi.advanceTimersByTimeAsync(1000);
    expect(viewDone).toBe(false);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(viewDone).toBe(true);
    expect(svc.staleForView(WED_OPEN)).toBe(false);
    expect(svc.staleForView(WED_OPEN + 6 * 60_000)).toBe(true); // in session, no quote in 5 min
    expect(svc.staleForView(SAT)).toBe(false); // shut: the last close is as good as it gets
  });

  it('backs off on 429 (one request, then a doubling wait), resets after a success', async () => {
    vi.setSystemTime(WED_OPEN);
    const bad = fakeYahoo({ status: 429 });
    const svc = new PriceService({ symbols, fetch: bad.f, log: capturingLog().log });
    await svc.refresh('scheduled');
    expect(bad.calls).toHaveLength(1); // a 429 stops the round
    expect(svc.status().failures).toBe(1);
    expect(svc.status().backoffUntil! - Date.now()).toBe(4 * 60 * 1000);
    await svc.refresh('scheduled');
    expect(svc.status().backoffUntil! - Date.now()).toBe(8 * 60 * 1000);
    expect(svc.nextDelay(Date.now())).toBe(SESSION_IDLE_EVERY_MS); // the longer of the backoff and the idle pace
    // an on-demand read during the backoff does not ask Yahoo
    vi.setSystemTime(WED_OPEN + 2 * 60 * 1000);
    await svc.refreshIfStale(0);
    expect(bad.calls).toHaveLength(2);
    // a 5xx everywhere counts too (query1 then query2)
    const down = fakeYahoo({ status: 503 });
    const svc2 = new PriceService({ symbols, fetch: down.f, log: capturingLog().log });
    await svc2.refresh('scheduled');
    expect(svc2.status().failures).toBe(1);
    expect(down.calls.some((u) => u.startsWith('https://query2.finance.yahoo.com/'))).toBe(true);
    // back to normal
    const good = fakeYahoo();
    const svc3 = new PriceService({ symbols, fetch: good.f, log: capturingLog().log });
    await svc3.refresh('scheduled');
    expect(svc3.status()).toMatchObject({ failures: 0, backoffUntil: null, quotes: 1, fx: true });
  });

  it('on demand: at most once a minute, one round in flight', async () => {
    vi.setSystemTime(WED_OPEN);
    const { f, calls } = fakeYahoo();
    const svc = new PriceService({ symbols, fetch: f, log: capturingLog().log });
    svc.start();
    await Promise.all([svc.demand({ wait: true }), svc.demand({ wait: true }), svc.refreshIfStale()]);
    expect(calls).toHaveLength(2);
    vi.setSystemTime(WED_OPEN + 30_000);
    await svc.refreshIfStale();
    expect(calls).toHaveLength(2);
    vi.setSystemTime(WED_OPEN + 61_000);
    await svc.refreshIfStale();
    expect(calls).toHaveLength(4);
    svc.stop();
    vi.setSystemTime(WED_OPEN + 10 * 60_000);
    await svc.refreshIfStale();
    expect(calls).toHaveLength(4);
  });

  it('drops symbols no longer held, fetches nothing when nothing is held, survives a closed database', async () => {
    vi.setSystemTime(WED_OPEN);
    const { f, calls } = fakeYahoo();
    let want = symbols();
    const svc = new PriceService({ symbols: () => want, fetch: f, log: capturingLog().log });
    await svc.refresh('scheduled');
    expect(svc.cache().quotes.size).toBe(1);
    want = { quotes: [], fx: false };
    await svc.refresh('scheduled');
    expect(svc.cache()).toEqual({ quotes: new Map(), fx: null });
    expect(calls).toHaveLength(2);
    const broken = new PriceService({
      symbols: () => {
        throw new Error('The database connection is not open');
      },
      fetch: f,
    });
    await expect(broken.refresh('scheduled')).resolves.toBeUndefined();
  });

  it('logs counts and reasons only: no symbol, price or amount', async () => {
    vi.setSystemTime(WED_OPEN);
    const cap = capturingLog();
    await new PriceService({ symbols, fetch: fakeYahoo().f, log: cap.log }).refresh('scheduled');
    await new PriceService({ symbols, fetch: fakeYahoo({ status: 429 }).f, log: cap.log }).refresh('scheduled');
    await new PriceService({ symbols: () => ({ quotes: [{ symbol: 'TEST1', currency: 'EUR' }], fx: false }), fetch: fakeYahoo().f, log: cap.log }).refresh('scheduled');
    expect(cap.lines.length).toBeGreaterThanOrEqual(3);
    const all = cap.lines.join('\n');
    for (const s of ['TEST1', 'ILS=X', '123.45', '3.71', '120.5', '3.69']) expect(all).not.toContain(s);
  });

  it('FINC_LIVE_PRICES=off turns it off; anything else leaves it on', () => {
    expect(livePricesEnabled({})).toBe(true);
    expect(livePricesEnabled({ FINC_LIVE_PRICES: 'off' })).toBe(false);
    expect(livePricesEnabled({ FINC_LIVE_PRICES: '0' })).toBe(false);
    expect(livePricesEnabled({ FINC_LIVE_PRICES: 'on' })).toBe(true);
  });
});
