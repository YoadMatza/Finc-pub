import { describe, expect, it, vi } from 'vitest';
import { HISTORY_MAX_BARS, fetchHistory, parseHistory } from './history.js';
import type { FetchFn } from './yahoo.js';

// fictional symbols and prices throughout
const sec = (iso: string): number => Date.parse(iso) / 1000;
const NOW = Date.parse('2026-11-11T22:00:00Z'); // Wednesday 17:00 New York, the session has closed

type Bar = [string, number | null | string, number | null | string];
const DEFAULT_BARS: Bar[] = [
  ['2026-11-06T14:30:00Z', 100, 99],
  ['2026-11-09T14:30:00Z', 102, 101],
  ['2026-11-10T14:30:00Z', 101, 100],
  ['2026-11-11T14:30:00Z', 104, 103.5],
];

function historyBody(o: { symbol?: unknown; instrumentType?: unknown; currency?: unknown; tz?: unknown; bars?: Bar[]; dividends?: unknown; splits?: unknown; regularEnd?: number } = {}): unknown {
  const bars = o.bars ?? DEFAULT_BARS;
  return {
    chart: {
      result: [
        {
          meta: {
            ...('symbol' in o ? (o.symbol === undefined ? {} : { symbol: o.symbol }) : { symbol: 'TEST1' }),
            ...('instrumentType' in o ? (o.instrumentType === undefined ? {} : { instrumentType: o.instrumentType }) : { instrumentType: 'EQUITY' }),
            currency: 'currency' in o ? o.currency : 'USD',
            exchangeTimezoneName: 'tz' in o ? o.tz : 'America/New_York',
            ...(o.regularEnd !== undefined ? { currentTradingPeriod: { regular: { start: o.regularEnd - 23_400, end: o.regularEnd } } } : {}),
          },
          timestamp: bars.map(([d]) => sec(d)),
          events: { ...(o.dividends !== undefined ? { dividends: o.dividends } : {}), ...(o.splits !== undefined ? { splits: o.splits } : {}) },
          indicators: { quote: [{ close: bars.map(([, c]) => c) }], adjclose: [{ adjclose: bars.map(([, , a]) => a) }] },
        },
      ],
      error: null,
    },
  };
}
const parse = (o: Parameters<typeof historyBody>[0] = {}, now = NOW, symbol = 'TEST1', currency = 'USD') => parseHistory(historyBody(o), symbol, currency, now);
const why = (o: Parameters<typeof historyBody>[0], now = NOW): string | null => {
  const p = parse(o, now);
  return p.ok ? null : p.why;
};

describe('parseHistory', () => {
  it('reads daily bars with New York dates, dividends and splits', () => {
    const p = parse({
      dividends: { [sec('2026-11-09T14:30:00Z')]: { amount: 0.24, date: sec('2026-11-09T14:30:00Z') }, [sec('2019-01-02T14:30:00Z')]: { amount: 0.1, date: sec('2019-01-02T14:30:00Z') } },
      splits: { [sec('2026-11-10T14:30:00Z')]: { date: sec('2026-11-10T14:30:00Z'), numerator: 1, denominator: 1, splitRatio: '1:1' } },
    });
    expect(p).toEqual({
      ok: true,
      history: {
        symbol: 'TEST1',
        currency: 'USD',
        instrumentType: 'EQUITY',
        exchangeTz: 'America/New_York',
        bars: [
          { d: '2026-11-06', close: 100, adj: 99 },
          { d: '2026-11-09', close: 102, adj: 101 },
          { d: '2026-11-10', close: 101, adj: 100 },
          { d: '2026-11-11', close: 104, adj: 103.5 },
        ],
        dividends: [{ d: '2026-11-09', amount: 0.24 }], // the 2019 one is outside the bars
        splits: [{ d: '2026-11-10', ratio: '1:1' }],
        fetchedAt: NOW,
      },
    });
  });
  it('accepts an ETF; drops a halted session (both closes null)', () => {
    const p = parse({ instrumentType: 'ETF', bars: [DEFAULT_BARS[0]!, ['2026-11-09T14:30:00Z', null, null], DEFAULT_BARS[2]!] });
    expect(p.ok && p.history.bars.map((b) => b.d)).toEqual(['2026-11-06', '2026-11-10']);
    expect(p.ok && p.history.instrumentType).toBe('ETF');
  });
  it('refuses another symbol, a missing one, a wrong instrument type or currency', () => {
    expect(why({ symbol: 'OTHER' })).toBe('symbol');
    expect(why({ symbol: undefined })).toBe('symbol');
    expect(why({ instrumentType: undefined })).toBe('type');
    expect(why({ instrumentType: 'MUTUALFUND' })).toBe('type');
    expect(why({ instrumentType: 'CURRENCY' })).toBe('type');
    expect(why({ currency: 'ILA' })).toBe('currency');
    expect(why({ currency: undefined })).toBe('currency');
    expect(why({ tz: 'Not/AZone' })).toBe('timezone');
  });
  it('refuses unsorted, duplicate-date, non-positive or non-numeric bars', () => {
    expect(why({ bars: [DEFAULT_BARS[1]!, DEFAULT_BARS[0]!] })).toBe('order');
    expect(why({ bars: [DEFAULT_BARS[0]!, ['2026-11-06T15:30:00Z', 100, 99], DEFAULT_BARS[1]!] })).toBe('duplicate');
    expect(why({ bars: [DEFAULT_BARS[0]!, ['2026-11-09T14:30:00Z', 0, 1]] })).toBe('value');
    expect(why({ bars: [DEFAULT_BARS[0]!, ['2026-11-09T14:30:00Z', -5, 1]] })).toBe('value');
    expect(why({ bars: [DEFAULT_BARS[0]!, ['2026-11-09T14:30:00Z', '102', 101]] })).toBe('value');
    expect(why({ bars: [DEFAULT_BARS[0]!, ['2026-11-09T14:30:00Z', Number.NaN, 101]] })).toBe('value');
    expect(why({ bars: [DEFAULT_BARS[0]!, ['2027-06-01T14:30:00Z', 102, 101]] })).toBe('future');
    expect(why({ bars: [] })).toBe('length');
    expect(why({ bars: [['2026-11-09T14:30:00Z', null, null]] })).toBe('length');
  });
  it('a second row of the last day (the live session) is dropped, the earlier row kept', () => {
    const p = parse({ bars: [DEFAULT_BARS[0]!, DEFAULT_BARS[1]!, ['2026-11-09T19:00:00Z', 150, 150]] });
    expect(p.ok && p.history.bars).toEqual([{ d: '2026-11-06', close: 100, adj: 99 }, { d: '2026-11-09', close: 102, adj: 101 }]);
  });
  it('a bar with one side missing is dropped, not refused', () => {
    const p = parse({ bars: [DEFAULT_BARS[0]!, ['2026-11-09T14:30:00Z', 102, null], ['2026-11-10T14:30:00Z', null, 100], DEFAULT_BARS[3]!] });
    expect(p.ok && p.history.bars.map((b) => b.d)).toEqual(['2026-11-06', '2026-11-11']);
  });
  it('refuses a broken shape', () => {
    for (const body of [null, {}, { chart: { result: [] } }, { chart: { result: [null] } }, { chart: { result: [{ meta: { symbol: 'TEST1', instrumentType: 'EQUITY', currency: 'USD' } }] } }]) {
      expect(parseHistory(body, 'TEST1', 'USD', NOW)).toEqual({ ok: false, why: 'shape' });
    }
    const b = historyBody() as { chart: { result: Array<{ indicators: { adjclose: Array<{ adjclose: unknown[] }> } }> } };
    b.chart.result[0]!.indicators.adjclose[0]!.adjclose.pop();
    expect(parseHistory(b, 'TEST1', 'USD', NOW)).toEqual({ ok: false, why: 'shape' });
  });
  it('refuses more bars than 5 years can have', () => {
    const many: Bar[] = Array.from({ length: HISTORY_MAX_BARS + 1 }, (_, i) => [new Date(Date.parse('2010-01-01T14:30:00Z') + i * 86_400_000).toISOString(), 10, 10]);
    expect(why({ bars: many })).toBe('length');
    // the 10-year range (SPY for the position view) takes them
    expect(parseHistory(historyBody({ bars: many }), 'TEST1', 'USD', NOW, '10y').ok).toBe(true);
  });
  it('refuses bad dividends and splits', () => {
    expect(why({ dividends: { [sec('2026-11-09T14:30:00Z')]: { amount: -1 } } })).toBe('dividend');
    expect(why({ dividends: { x: { amount: 1 } } })).toBe('dividend'); // no date at all
    expect(why({ dividends: [1, 2] })).toBe('dividend');
    expect(why({ splits: { [sec('2026-11-09T14:30:00Z')]: { numerator: 0, denominator: 1 } } })).toBe('split');
  });
  it('a split: accepted when the closes are adjusted, refused when the adjusted closes jump by its ratio', () => {
    const split = { [sec('2026-11-10T14:30:00Z')]: { date: sec('2026-11-10T14:30:00Z'), numerator: 4, denominator: 1, splitRatio: '4:1' } };
    const adjusted: Bar[] = [['2026-11-06T14:30:00Z', 25, 25], ['2026-11-09T14:30:00Z', 25.5, 25.5], ['2026-11-10T14:30:00Z', 25.2, 25.2], ['2026-11-11T14:30:00Z', 25.4, 25.4]];
    const p = parse({ bars: adjusted, splits: split });
    expect(p.ok && p.history.splits).toEqual([{ d: '2026-11-10', ratio: '4:1' }]);
    const raw: Bar[] = [['2026-11-06T14:30:00Z', 100, 100], ['2026-11-09T14:30:00Z', 102, 102], ['2026-11-10T14:30:00Z', 25.2, 25.2], ['2026-11-11T14:30:00Z', 25.4, 25.4]];
    expect(why({ bars: raw, splits: split })).toBe('split_unadjusted');
    // a reverse split 1:10 the same way
    const rev = { [sec('2026-11-10T14:30:00Z')]: { date: sec('2026-11-10T14:30:00Z'), numerator: 1, denominator: 10 } };
    const rawRev: Bar[] = [['2026-11-06T14:30:00Z', 2, 2], ['2026-11-09T14:30:00Z', 2, 2], ['2026-11-10T14:30:00Z', 20, 20], ['2026-11-11T14:30:00Z', 20.5, 20.5]];
    expect(why({ bars: rawRev, splits: rev })).toBe('split_unadjusted');
    const okRev = parse({ bars: adjusted, splits: rev });
    expect(okRev.ok && okRev.history.splits).toEqual([{ d: '2026-11-10', ratio: '1:10' }]);
  });
  it('both series are checked against splits: an unadjusted 2:1 on a +12% day is refused', () => {
    const split2 = { [sec('2026-11-10T14:30:00Z')]: { date: sec('2026-11-10T14:30:00Z'), numerator: 2, denominator: 1 } };
    // after the split the price is 56 (a +12% day on the halved price); unadjusted, the day before still shows 100
    const raw: Bar[] = [['2026-11-06T14:30:00Z', 100, 100], ['2026-11-09T14:30:00Z', 100, 100], ['2026-11-10T14:30:00Z', 56, 56], ['2026-11-11T14:30:00Z', 57, 57]];
    expect(why({ bars: raw, splits: split2 })).toBe('split_unadjusted');
    const adjusted: Bar[] = [['2026-11-06T14:30:00Z', 50, 50], ['2026-11-09T14:30:00Z', 50, 50], ['2026-11-10T14:30:00Z', 56, 56], ['2026-11-11T14:30:00Z', 57, 57]];
    expect(parse({ bars: adjusted, splits: split2 }).ok).toBe(true);
    // the close left unadjusted while the adjusted close is fine: close/adj steps with no dividend
    const closeOnly: Bar[] = [['2026-11-06T14:30:00Z', 100, 50], ['2026-11-09T14:30:00Z', 100, 50], ['2026-11-10T14:30:00Z', 50.5, 50.5], ['2026-11-11T14:30:00Z', 51, 51]];
    expect(why({ bars: closeOnly, splits: split2 })).toBe('adjustment');
  });
  it('refuses a 4x one-day jump with no split to explain it', () => {
    const b: Bar[] = [['2026-11-06T14:30:00Z', 25, 25], ['2026-11-09T14:30:00Z', 25, 25], ['2026-11-10T14:30:00Z', 100, 100], ['2026-11-11T14:30:00Z', 101, 101]];
    expect(why({ bars: b })).toBe('jump');
    // a real -60% day that does not revert is kept
    const crash: Bar[] = [['2026-11-06T14:30:00Z', 100, 100], ['2026-11-09T14:30:00Z', 100, 100], ['2026-11-10T14:30:00Z', 40, 40], ['2026-11-11T14:30:00Z', 41, 41]];
    expect(parse({ bars: crash }).ok).toBe(true);
  });
  it('close/adj: never below 0.98, and it steps only on a dividend date', () => {
    expect(why({ bars: [['2026-11-06T14:30:00Z', 97, 100], ['2026-11-09T14:30:00Z', 97, 100]] })).toBe('adjustment');
    const b: Bar[] = [['2026-11-06T14:30:00Z', 100, 98], ['2026-11-09T14:30:00Z', 100, 98], ['2026-11-10T14:30:00Z', 99, 99]];
    expect(why({ bars: b })).toBe('adjustment');
    expect(parse({ bars: b, dividends: { [sec('2026-11-10T14:30:00Z')]: { amount: 2, date: sec('2026-11-10T14:30:00Z') } } }).ok).toBe(true);
  });
  it('refuses a single bad print (1.00 in a series of 100s)', () => {
    const b: Bar[] = [['2026-11-05T14:30:00Z', 100, 100], ['2026-11-06T14:30:00Z', 101, 101], ['2026-11-09T14:30:00Z', 1, 1], ['2026-11-10T14:30:00Z', 102, 102], ['2026-11-11T14:30:00Z', 103, 103]];
    expect(why({ bars: b })).toBe('bad_print');
    // in the close alone
    const c: Bar[] = [['2026-11-05T14:30:00Z', 100, 100], ['2026-11-06T14:30:00Z', 101, 101], ['2026-11-09T14:30:00Z', 160, 101.5], ['2026-11-10T14:30:00Z', 102, 102]];
    expect(why({ bars: c })).not.toBeNull();
  });
  it('drops a session still in progress (by the answer’s trading period, else 16:05 New York)', () => {
    const during = Date.parse('2026-11-11T18:00:00Z'); // 13:00 New York
    const end = sec('2026-11-11T21:00:00Z');
    const a = parse({ regularEnd: end }, during);
    expect(a.ok && a.history.bars.at(-1)!.d).toBe('2026-11-10');
    const b = parse({}, during); // no trading period: the 16:05 rule
    expect(b.ok && b.history.bars.at(-1)!.d).toBe('2026-11-10');
    const settled = parse({ regularEnd: end }, end * 1000 + 5 * 60_000);
    expect(settled.ok && settled.history.bars.at(-1)!.d).toBe('2026-11-11');
    const c = parse({}, Date.parse('2026-11-11T21:06:00Z'));
    expect(c.ok && c.history.bars.at(-1)!.d).toBe('2026-11-11');
  });
});

describe('fetchHistory', () => {
  const ok = (body: unknown = historyBody()) => new Response(JSON.stringify(body), { status: 200 });
  it('asks query1 for 5 years of daily bars with events: symbol only, no cookies, no redirects', async () => {
    const f = vi.fn<FetchFn>(async () => ok());
    const r = await fetchHistory('TEST1', 'USD', { fetch: f, now: () => NOW });
    expect(r.ok).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://query1.finance.yahoo.com/v8/finance/chart/TEST1?interval=1d&range=5y&events=div%2Csplit');
    expect(init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(init.headers)).not.toMatch(/finc|cookie/i);
    const f10 = vi.fn<FetchFn>(async () => ok());
    await fetchHistory('SPY', 'USD', { fetch: f10, now: () => NOW, range: '10y' });
    expect(f10.mock.calls[0]![0]).toBe('https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=10y&events=div%2Csplit');
  });
  it('class shares go as BRK-B style and come back under the holding’s symbol', async () => {
    const f = vi.fn<FetchFn>(async () => ok(historyBody({ symbol: 'TSTX-B' })));
    const r = await fetchHistory('TSTX.B', 'USD', { fetch: f, now: () => NOW });
    expect(f.mock.calls[0]![0]).toContain('/chart/TSTX-B?');
    expect(r.ok && r.history.symbol).toBe('TSTX.B');
  });
  it('falls back to query2 on a server or network error, not on 429 or 404', async () => {
    const f5 = vi.fn<FetchFn>().mockResolvedValueOnce(new Response('', { status: 502 })).mockResolvedValueOnce(ok());
    expect((await fetchHistory('TEST1', 'USD', { fetch: f5, now: () => NOW })).ok).toBe(true);
    expect(f5.mock.calls[1]![0]).toMatch(/^https:\/\/query2\.finance\.yahoo\.com\//);
    const fn = vi.fn<FetchFn>().mockRejectedValueOnce(new Error('ECONNRESET')).mockRejectedValueOnce(new Error('timeout'));
    expect(await fetchHistory('TEST1', 'USD', { fetch: fn })).toEqual({ ok: false, reason: 'network' });
    const f429 = vi.fn<FetchFn>(async () => new Response('', { status: 429 }));
    expect(await fetchHistory('TEST1', 'USD', { fetch: f429 })).toEqual({ ok: false, reason: 'rate_limited', status: 429 });
    expect(f429).toHaveBeenCalledTimes(1);
    const f404 = vi.fn<FetchFn>(async () => new Response('', { status: 404 }));
    expect(await fetchHistory('TEST1', 'USD', { fetch: f404 })).toEqual({ ok: false, reason: 'not_found', status: 404 });
  });
  it('refuses bad symbols without fetching, bad JSON and invalid answers', async () => {
    const f = vi.fn<FetchFn>(async () => ok());
    expect(await fetchHistory('../etc', 'USD', { fetch: f })).toEqual({ ok: false, reason: 'invalid_symbol' });
    expect(await fetchHistory('TEST1', 'us', { fetch: f })).toMatchObject({ ok: false, reason: 'bad_answer' });
    expect(f).not.toHaveBeenCalled();
    const bad = vi.fn<FetchFn>(async () => new Response('not json', { status: 200 }));
    expect(await fetchHistory('TEST1', 'USD', { fetch: bad })).toMatchObject({ ok: false, reason: 'bad_answer', why: 'json' });
    const other = vi.fn<FetchFn>(async () => ok(historyBody({ currency: 'EUR' })));
    expect(await fetchHistory('TEST1', 'USD', { fetch: other, now: () => NOW })).toMatchObject({ ok: false, reason: 'bad_answer', why: 'currency' });
  });
});
