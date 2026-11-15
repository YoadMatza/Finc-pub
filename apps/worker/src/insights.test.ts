import type { FetchFn } from '@finc/core';
import { describe, expect, it, vi } from 'vitest';
import { HISTORY_BACKOFF_BASE_MS, HISTORY_FAIL_TTL_MS, HISTORY_TTL_MS, InsightsService } from './insights.js';

// fictional symbols and prices; no network
const T0 = Date.parse('2026-11-11T22:00:00Z');
const MIN = 60_000;

function yahooHistoryBody(symbol: string, n = 300, o: { instrumentType?: string; currency?: string } = {}): unknown {
  const start = Date.parse('2025-08-01T14:30:00Z');
  const ts: number[] = [];
  for (let t = start; ts.length < n; t += 86_400_000) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) ts.push(t / 1000);
  }
  const close = ts.map((_, i) => 100 + (i % 7));
  return {
    chart: {
      result: [{ meta: { symbol, instrumentType: o.instrumentType ?? (symbol === 'SPY' ? 'ETF' : 'EQUITY'), currency: o.currency ?? 'USD', exchangeTimezoneName: 'America/New_York' }, timestamp: ts, events: {}, indicators: { quote: [{ close }], adjclose: [{ adjclose: close }] } }],
      error: null,
    },
  };
}

function fakeYahoo(status: (sym: string, call: number) => number = () => 200) {
  const calls: string[] = [];
  const f = vi.fn<FetchFn>(async (url) => {
    const sym = decodeURIComponent(url.split('/chart/')[1]!.split('?')[0]!);
    calls.push(sym);
    const s = status(sym, calls.length);
    if (s !== 200) return new Response('', { status: s });
    return new Response(JSON.stringify(yahooHistoryBody(sym)), { status: 200 });
  });
  return { f, calls };
}

function capturingLog() {
  const lines: string[] = [];
  const rec = (level: string) => (o: object, m: string) => lines.push(`${level} ${m} ${JSON.stringify(o)}`);
  return { lines, log: { debug: rec('debug'), info: rec('info'), warn: rec('warn') } };
}

describe('insights service', () => {
  it('fetches the holding and SPY once, then serves both from memory for 6 hours', async () => {
    const clock = { t: T0 };
    const { f, calls } = fakeYahoo();
    const svc = new InsightsService({ fetch: f, now: () => clock.t, log: capturingLog().log });
    const a = await svc.histories('TEST1', 'USD');
    expect(a.history.ok).toBe(true);
    expect(a.spy?.symbol).toBe('SPY');
    expect(calls.sort()).toEqual(['SPY', 'TEST1']);
    clock.t += HISTORY_TTL_MS - 1;
    await svc.histories('TEST1', 'USD');
    await svc.histories('TEST2', 'USD'); // SPY still cached
    expect(calls.sort()).toEqual(['SPY', 'TEST1', 'TEST2']);
    clock.t += 1;
    await svc.histories('TEST1', 'USD');
    expect(calls.filter((s) => s === 'TEST1')).toHaveLength(2);
    expect(calls.filter((s) => s === 'SPY')).toHaveLength(2);
  });

  it('one fetch in flight per symbol: concurrent opens join it', async () => {
    const { f, calls } = fakeYahoo();
    const svc = new InsightsService({ fetch: f, now: () => T0, log: capturingLog().log });
    const [a, b, c] = await Promise.all([svc.histories('TEST1', 'USD'), svc.histories('TEST1', 'USD'), svc.history('TEST1', 'USD')]);
    expect(calls.sort()).toEqual(['SPY', 'TEST1']);
    expect(a.history).toBe(b.history);
    expect(c).toBe(a.history);
    expect(svc.status().inflight).toBe(0);
  });

  it('SPY itself is fetched once and is its own benchmark', async () => {
    const { f, calls } = fakeYahoo();
    const svc = new InsightsService({ fetch: f, now: () => T0, log: capturingLog().log });
    const r = await svc.histories('SPY', 'USD');
    expect(calls).toEqual(['SPY']);
    expect(r.spy).not.toBeNull();
  });

  it('a 429 backs every fetch off 4, then 8 minutes; cached histories are still served', async () => {
    const clock = { t: T0 };
    let limit = false;
    const { f, calls } = fakeYahoo(() => (limit ? 429 : 200));
    const { lines, log } = capturingLog();
    const svc = new InsightsService({ fetch: f, now: () => clock.t, log });
    await svc.histories('TEST1', 'USD'); // TEST1 and SPY cached
    limit = true;
    const r = await svc.histories('TEST2', 'USD');
    expect(r.history).toEqual({ ok: false, reason: 'rate_limited', status: 429 });
    expect(r.spy).not.toBeNull(); // from the cache
    expect(svc.status().backoffUntil).toBe(T0 + HISTORY_BACKOFF_BASE_MS);
    const before = calls.length;
    clock.t += HISTORY_BACKOFF_BASE_MS - 1;
    expect((await svc.histories('TEST2', 'USD')).history).toEqual({ ok: false, reason: 'rate_limited' });
    expect(calls.length).toBe(before); // nothing fetched during the backoff
    clock.t += 1;
    await svc.histories('TEST2', 'USD');
    expect(calls.length).toBe(before + 1);
    expect(svc.status().backoffUntil).toBe(clock.t + 2 * HISTORY_BACKOFF_BASE_MS);
    limit = false;
    clock.t += 2 * HISTORY_BACKOFF_BASE_MS;
    expect((await svc.histories('TEST2', 'USD')).history.ok).toBe(true);
    expect(svc.status()).toMatchObject({ failures: 0, backoffUntil: null });
    expect(lines.some((l) => l.includes('backing off'))).toBe(true);
    expect(lines.join('\n')).not.toMatch(/TEST|SPY|\b100\b/); // counts and reasons only
  });

  it('a server failure or a refused answer is remembered per symbol for 5 minutes', async () => {
    const clock = { t: T0 };
    const { f, calls } = fakeYahoo((sym) => (sym === 'TEST1' ? 503 : 200));
    const svc = new InsightsService({ fetch: f, now: () => clock.t, log: capturingLog().log });
    expect((await svc.history('TEST1', 'USD')).ok).toBe(false);
    expect(calls).toEqual(['TEST1', 'TEST1']); // query1 then query2
    await svc.history('TEST1', 'USD');
    expect(calls).toHaveLength(2);
    clock.t += HISTORY_FAIL_TTL_MS;
    await svc.history('TEST1', 'USD');
    expect(calls).toHaveLength(4);
    // a currency mismatch (the holding says EUR, Yahoo USD) is a refused answer
    const r = await svc.history('TEST3', 'EUR');
    expect(r).toMatchObject({ ok: false, reason: 'bad_answer', why: 'currency' });
    expect(svc.status().backoffUntil).toBeNull();
  });

  it('an invalid symbol never reaches the network', async () => {
    const { f } = fakeYahoo();
    const svc = new InsightsService({ fetch: f, now: () => T0, log: capturingLog().log });
    expect(await svc.history('a b', 'USD')).toEqual({ ok: false, reason: 'invalid_symbol' });
    expect(f).not.toHaveBeenCalled();
  });

  it('cross-check counts, without symbols or prices', () => {
    const { lines, log } = capturingLog();
    const svc = new InsightsService({ now: () => T0, log });
    svc.noteCrossCheck('TEST1', '2026-11-10', true);
    svc.noteCrossCheck('TEST2', '2026-11-10', null);
    svc.noteCrossCheck('TEST2', '2026-11-10', false);
    svc.noteCrossCheck('TEST2', '2026-11-10', false); // the same ticker and session: counted once
    expect(svc.status()).toMatchObject({ checks: 2, mismatches: 1 });
    expect(lines).toEqual(['warn insights: a Yahoo close disagrees with the bank price {"mismatches":1,"checks":2}']);
  });

  it('never waits past the deadline: a late SPY means no benchmark, a late holding is unreachable', async () => {
    const never = () => new Promise<Response>(() => undefined);
    const f = vi.fn<FetchFn>(async (url) => (url.includes('/SPY?') ? never() : new Response(JSON.stringify(yahooHistoryBody('TEST1')), { status: 200 })));
    const svc = new InsightsService({ fetch: f, now: () => T0, deadlineMs: 50, log: capturingLog().log });
    const t = Date.now();
    const r = await svc.histories('TEST1', 'USD');
    expect(Date.now() - t).toBeLessThan(1000);
    expect(r.history.ok).toBe(true);
    expect(r.spy).toBeNull();
    const g = vi.fn<FetchFn>(async () => never());
    const svc2 = new InsightsService({ fetch: g, now: () => T0, deadlineMs: 50, log: capturingLog().log });
    expect((await svc2.histories('TEST1', 'USD')).history).toEqual({ ok: false, reason: 'network' });
  });

  it('per request: a 6 s timeout by default', async () => {
    const seen: number[] = [];
    const f = vi.fn<FetchFn>(async (url, init) => {
      seen.push(init.signal ? 1 : 0);
      return new Response(JSON.stringify(yahooHistoryBody(decodeURIComponent(url.split('/chart/')[1]!.split('?')[0]!))), { status: 200 });
    });
    const svc = new InsightsService({ fetch: f, now: () => T0, log: capturingLog().log });
    await svc.histories('TEST1', 'USD');
    expect(seen).toEqual([1, 1]);
  });

  it('a stale cached SPY is refetched once; still behind, the panel goes without it', async () => {
    let spyBars = 299; // one session behind the holding's 300
    const calls: string[] = [];
    const f = vi.fn<FetchFn>(async (url) => {
      const sym = decodeURIComponent(url.split('/chart/')[1]!.split('?')[0]!);
      calls.push(sym);
      return new Response(JSON.stringify(yahooHistoryBody(sym, sym === 'SPY' ? spyBars : 300)), { status: 200 });
    });
    const svc = new InsightsService({ fetch: f, now: () => T0, log: capturingLog().log });
    const a = await svc.histories('TEST1', 'USD');
    expect(calls.filter((c) => c === 'SPY')).toHaveLength(2); // the refetch
    expect(a.spy!.bars).toHaveLength(299); // still behind: buildInsights drops the benchmark
    await svc.histories('TEST1', 'USD');
    expect(calls.filter((c) => c === 'SPY')).toHaveLength(2); // once per holding session date
    // a fresh holding session: SPY refetched again, now in step
    spyBars = 300;
    const svc2 = new InsightsService({ fetch: f, now: () => T0, log: capturingLog().log });
    const b = await svc2.histories('TEST1', 'USD');
    expect(b.spy!.bars.at(-1)!.d).toBe(b.history.ok ? b.history.history.bars.at(-1)!.d : '');
  });
});
