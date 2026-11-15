import { describe, expect, it, vi } from 'vitest';
import { type FetchFn, fetchQuote, parseChart, validSymbol, yahooSymbol } from './yahoo.js';

const NOW = Date.parse('2026-11-11T18:00:00Z'); // Wednesday 13:00 New York
const sec = (iso: string): number => Date.parse(iso) / 1000;

/** A chart answer shaped like Yahoo's (fictional symbol and prices). */
export function chartBody(o: { symbol?: unknown; instrumentType?: unknown; currency?: unknown; price?: unknown; time?: unknown; previousClose?: unknown; chartPreviousClose?: unknown; marketState?: unknown; bars?: Array<[string, number | null]> } = {}): unknown {
  const bars = o.bars ?? [
    ['2026-11-09T14:30:00Z', 100],
    ['2026-11-10T14:30:00Z', 104],
    ['2026-11-11T14:30:00Z', 106],
  ];
  return {
    chart: {
      result: [
        {
          meta: {
            currency: 'currency' in o ? o.currency : 'USD',
            ...('symbol' in o ? (o.symbol === undefined ? {} : { symbol: o.symbol }) : { symbol: 'TEST1' }),
            ...('instrumentType' in o ? { instrumentType: o.instrumentType } : {}),
            exchangeName: 'NMS',
            regularMarketPrice: 'price' in o ? o.price : 106,
            regularMarketTime: 'time' in o ? o.time : sec('2026-11-11T17:59:00Z'),
            chartPreviousClose: 'chartPreviousClose' in o ? o.chartPreviousClose : 90,
            exchangeTimezoneName: 'America/New_York',
            ...('previousClose' in o ? { previousClose: o.previousClose } : {}),
            ...('marketState' in o ? { marketState: o.marketState } : {}),
          },
          timestamp: bars.map(([d]) => sec(d)),
          indicators: { quote: [{ close: bars.map(([, c]) => c) }] },
        },
      ],
      error: null,
    },
  };
}

describe('symbols', () => {
  it('lets only plain ticker characters through', () => {
    for (const s of ['TEST1', 'BRK-B', 'TEST.TA', 'ILS=X', '^GSPC', 'A']) expect(validSymbol(s)).toBe(true);
    for (const s of ['', '-A', '.A', '=X', 'test1', 'A/B', 'A B', '../x', 'TEST1?x=1', 'ABCDEFGHIJKLMNOP', 'מניה', 'A%2F', null, 5]) expect(validSymbol(s)).toBe(false);
  });
});

describe('Yahoo symbols', () => {
  it('maps class shares written with a dot to the dash Yahoo uses, leaves exchange suffixes alone', () => {
    expect(yahooSymbol('BRK.B')).toBe('BRK-B');
    expect(yahooSymbol('TEVA.TA')).toBe('TEVA.TA');
    expect(yahooSymbol('TEST1')).toBe('TEST1');
  });
});

describe('chart parser', () => {
  it('reads price, time, zone and the previous close from the daily bars (not chartPreviousClose)', () => {
    const q = parseChart(chartBody(), 'TEST1', 'USD', NOW)!;
    expect(q).toMatchObject({ symbol: 'TEST1', price: 106, prevClose: 104, currency: 'USD', marketTime: Date.parse('2026-11-11T17:59:00Z'), exchangeTz: 'America/New_York', marketState: null, fetchedAt: NOW });
  });

  it('prefers meta.previousClose when present, and keeps marketState', () => {
    expect(parseChart(chartBody({ previousClose: 103.5, marketState: 'REGULAR' }), 'TEST1', 'USD', NOW)).toMatchObject({ prevClose: 103.5, marketState: 'REGULAR' });
  });

  it('when today has no bar yet, the last bar is the previous close; nulls in bars are skipped', () => {
    const bars: Array<[string, number | null]> = [
      ['2026-11-09T14:30:00Z', 100],
      ['2026-11-10T14:30:00Z', null],
    ];
    expect(parseChart(chartBody({ bars }), 'TEST1', 'USD', NOW)!.prevClose).toBe(100);
  });

  it('a missing previous close stays null; chartPreviousClose only counts for a one-day range', () => {
    expect(parseChart(chartBody({ bars: [] }), 'TEST1', 'USD', NOW)!.prevClose).toBeNull();
    expect(parseChart(chartBody({ bars: [] }), 'TEST1', 'USD', NOW, '1d')!.prevClose).toBe(90);
  });

  it('refuses missing fields, NaN, zero, negatives, strings and a quote from the future', () => {
    for (const bad of [{ price: undefined }, { price: Number.NaN }, { price: 0 }, { price: -3 }, { price: '106' }, { time: undefined }, { time: Number.POSITIVE_INFINITY }, { time: sec('2026-11-11T20:00:00Z') }]) {
      expect(parseChart(chartBody(bad), 'TEST1', 'USD', NOW)).toBeNull();
    }
    expect(parseChart({}, 'TEST1', 'USD', NOW)).toBeNull();
    expect(parseChart(null, 'TEST1', 'USD', NOW)).toBeNull();
    expect(parseChart({ chart: { result: [] } }, 'TEST1', 'USD', NOW)).toBeNull();
    expect(parseChart({ chart: { result: [{}] } }, 'TEST1', 'USD', NOW)).toBeNull();
  });

  it('refuses another currency (a Tel Aviv listing in agorot) or another symbol', () => {
    expect(parseChart(chartBody({ currency: 'ILA' }), 'TEST1', 'USD', NOW)).toBeNull();
    expect(parseChart(chartBody({ currency: undefined }), 'TEST1', 'USD', NOW)).toBeNull();
    expect(parseChart(chartBody({ symbol: 'OTHER' }), 'TEST1', 'USD', NOW)).toBeNull();
    expect(parseChart(chartBody({ symbol: undefined }), 'TEST1', 'USD', NOW)).toBeNull(); // the symbol must be named
  });

  it('accepts EQUITY or ETF (or no type) for a security, CURRENCY for the rate', () => {
    for (const t of ['EQUITY', 'ETF']) expect(parseChart(chartBody({ instrumentType: t }), 'TEST1', 'USD', NOW)).not.toBeNull();
    for (const t of ['OPTION', 'FUTURE', 'CRYPTOCURRENCY', 'CURRENCY']) expect(parseChart(chartBody({ instrumentType: t }), 'TEST1', 'USD', NOW)).toBeNull();
    expect(parseChart(chartBody({ symbol: 'ILS=X', currency: 'ILS', price: 3.7, instrumentType: 'CURRENCY' }), 'ILS=X', 'ILS', NOW)).not.toBeNull();
    expect(parseChart(chartBody({ symbol: 'ILS=X', currency: 'ILS', price: 3.7, instrumentType: 'EQUITY' }), 'ILS=X', 'ILS', NOW)).toBeNull();
  });
});

describe('fetchQuote', () => {
  const ok = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

  it('asks query1 with only the symbol in the path, a generic agent and no cookies', async () => {
    const f = vi.fn<FetchFn>(async () => ok(chartBody()));
    const r = await fetchQuote('TEST1', 'USD', { fetch: f, now: () => NOW });
    expect(r).toMatchObject({ ok: true, quote: { price: 106 } });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://query1.finance.yahoo.com/v8/finance/chart/TEST1?interval=1d&range=5d');
    const headers = init.headers as Record<string, string>;
    expect(Object.keys(headers).sort()).toEqual(['accept', 'user-agent']);
    expect(headers['user-agent']).not.toMatch(/finc/i);
    expect(init.credentials).toBe('omit');
    expect(init.body).toBeUndefined();
  });

  it('asks for BRK-B when the bank says BRK.B, and caches it under the bank symbol', async () => {
    const f = vi.fn<FetchFn>(async () => ok(chartBody({ symbol: 'BRK-B' })));
    expect(await fetchQuote('BRK.B', 'USD', { fetch: f, now: () => NOW })).toMatchObject({ ok: true, quote: { symbol: 'BRK.B' } });
    expect(f.mock.calls[0]![0]).toContain('/chart/BRK-B?');
  });

  it('URL-encodes the FX pair', async () => {
    const f = vi.fn<FetchFn>(async () => ok(chartBody({ symbol: 'ILS=X', currency: 'ILS', price: 3.7 })));
    expect(await fetchQuote('ILS=X', 'ILS', { fetch: f, now: () => NOW })).toMatchObject({ ok: true, quote: { price: 3.7 } });
    expect(f.mock.calls[0]![0]).toContain('/chart/ILS%3DX?');
  });

  it('falls back to query2 on a server or network error, not on 429', async () => {
    const f = vi.fn<FetchFn>().mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(ok(chartBody()));
    expect((await fetchQuote('TEST1', 'USD', { fetch: f, now: () => NOW })).ok).toBe(true);
    expect(f.mock.calls[1]![0]).toMatch(/^https:\/\/query2\.finance\.yahoo\.com\//);
    const g = vi.fn<FetchFn>().mockRejectedValueOnce(new Error('ECONNRESET')).mockRejectedValueOnce(new Error('ECONNRESET'));
    expect(await fetchQuote('TEST1', 'USD', { fetch: g, now: () => NOW })).toEqual({ ok: false, reason: 'network' });
    const h = vi.fn<FetchFn>(async () => new Response('', { status: 429 }));
    expect(await fetchQuote('TEST1', 'USD', { fetch: h, now: () => NOW })).toEqual({ ok: false, reason: 'rate_limited', status: 429 });
    expect(h).toHaveBeenCalledTimes(1);
  });

  it('never sends an invalid symbol, and treats a bad answer as unavailable', async () => {
    const f = vi.fn<FetchFn>(async () => ok({ nope: 1 }));
    expect(await fetchQuote('a/b', 'USD', { fetch: f })).toEqual({ ok: false, reason: 'invalid_symbol' });
    expect(f).not.toHaveBeenCalled();
    expect(await fetchQuote('TEST1', 'USD', { fetch: f, now: () => NOW })).toMatchObject({ ok: false, reason: 'bad_answer' });
    const notJson = vi.fn<FetchFn>(async () => new Response('<html>', { status: 200 }));
    expect(await fetchQuote('TEST1', 'USD', { fetch: notJson, now: () => NOW })).toMatchObject({ ok: false, reason: 'bad_answer' });
  });
});
