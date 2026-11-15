import { describe, expect, it, vi } from 'vitest';
import type { FetchFn } from '../prices/yahoo.js';
import { FINNHUB_MAX_BYTES, answerSymbol, earningsPath, finnhubGet, finnhubSymbol, parseEarnings, parseProfile, parseRecommendations, profilePath, recommendationPath } from './finnhub.js';

// Fictional tickers, key and numbers; no network.
const KEY = 'TESTKEY000fictional0000';
const rec = (period: string, o: Partial<Record<'strongBuy' | 'buy' | 'hold' | 'sell' | 'strongSell', unknown>> = {}, symbol = 'TSTA') => ({ symbol, period, strongBuy: 4, buy: 10, hold: 6, sell: 1, strongSell: 0, ...o });
const earn = (date: string, o: Record<string, unknown> = {}) => ({ symbol: 'TSTA', date, hour: 'amc', epsEstimate: 1.25, epsActual: null, quarter: 4, year: 2026, revenueEstimate: 1e9, revenueActual: null, ...o });

describe('finnhubSymbol', () => {
  it('plain US tickers as they are; class shares in the dot form; anything else is not covered', () => {
    expect(finnhubSymbol(' tsta ')).toBe('TSTA');
    expect(finnhubSymbol('TSTB.B')).toBe('TSTB.B');
    expect(finnhubSymbol('TSTB/B')).toBe('TSTB.B');
    expect(finnhubSymbol('TSTB-B')).toBe('TSTB.B');
    expect(finnhubSymbol('TSTA.TA')).toBeNull();
    expect(finnhubSymbol('^TST')).toBeNull();
    expect(finnhubSymbol('TOOLONGX')).toBeNull();
    expect(finnhubSymbol('')).toBeNull();
  });
});

describe('finnhubGet', () => {
  const ok = (body: unknown, init: ResponseInit = {}) => vi.fn<FetchFn>(async () => new Response(JSON.stringify(body), { status: 200, ...init }));

  it('the key goes in the X-Finnhub-Token header, never in the URL; fixed host, no redirects, no cookies', async () => {
    const f = ok([]);
    expect(await finnhubGet(recommendationPath('TSTA'), { apiKey: KEY, fetch: f })).toEqual({ ok: true, body: [] });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://finnhub.io/api/v1/stock/recommendation?symbol=TSTA');
    expect(url).not.toContain(KEY);
    expect(init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error' });
    expect((init.headers as Record<string, string>)['x-finnhub-token']).toBe(KEY);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    await finnhubGet(earningsPath('TSTB.B', '2026-07-14', '2027-03-11'), { apiKey: KEY, fetch: f });
    expect(f.mock.calls[1]![0]).toBe('https://finnhub.io/api/v1/calendar/earnings?from=2026-07-14&to=2027-03-11&symbol=TSTB.B');
  });

  it('no or a malformed key: no_key, nothing sent', async () => {
    const f = ok([]);
    for (const apiKey of [null, '', 'short', 'has space in it 0000000', `${KEY}/../x`]) expect(await finnhubGet(recommendationPath('TSTA'), { apiKey, fetch: f })).toEqual({ ok: false, reason: 'no_key' });
    expect(f).not.toHaveBeenCalled();
  });

  it('refuses a path that leaves the API or carries a token parameter', async () => {
    const f = ok([]);
    expect(await finnhubGet('/other', { apiKey: KEY, fetch: f })).toEqual({ ok: false, reason: 'bad_answer' });
    expect(await finnhubGet('@evil.example/api/v1/x', { apiKey: KEY, fetch: f })).toEqual({ ok: false, reason: 'bad_answer' });
    expect(await finnhubGet('/api/v1/stock/recommendation?symbol=TSTA&token=x', { apiKey: KEY, fetch: f })).toEqual({ ok: false, reason: 'bad_answer' });
    expect(f).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'no_key'],
    [403, 'forbidden'],
    [429, 'rate_limited'],
    [404, 'not_found'],
    [500, 'server'],
    [503, 'server'],
    [302, 'bad_answer'],
    [204, 'bad_answer'],
  ])('status %i is %s', async (status, reason) => {
    const f = vi.fn<FetchFn>(async () => new Response(status === 204 ? null : '{}', { status }));
    expect(await finnhubGet(recommendationPath('TSTA'), { apiKey: KEY, fetch: f })).toMatchObject({ ok: false, reason, status });
  });

  it('a network error, a body that is not JSON, an answer over 2 MB', async () => {
    expect(await finnhubGet(recommendationPath('TSTA'), { apiKey: KEY, fetch: async () => Promise.reject(new Error('reset')) })).toEqual({ ok: false, reason: 'network' });
    expect(await finnhubGet(recommendationPath('TSTA'), { apiKey: KEY, fetch: async () => new Response('<html>', { status: 200 }) })).toMatchObject({ ok: false, reason: 'bad_answer' });
    expect(await finnhubGet(recommendationPath('TSTA'), { apiKey: KEY, fetch: async () => new Response('[]', { status: 200, headers: { 'content-length': String(FINNHUB_MAX_BYTES + 1) } }) })).toEqual({ ok: false, reason: 'too_large' });
    expect(await finnhubGet(recommendationPath('TSTA'), { apiKey: KEY, maxBytes: 10, fetch: async () => new Response(JSON.stringify([rec('2026-11-01')]), { status: 200 }) })).toEqual({ ok: false, reason: 'too_large' });
  });
});

describe('parseRecommendations', () => {
  const TODAY = '2026-11-11';
  it('rows newest first, one per period; an empty list is valid', () => {
    const rows = parseRecommendations([rec('2026-08-01', { buy: 8 }), rec('2026-11-01'), rec('2026-10-01', { hold: 7 }), rec('2026-11-01', { buy: 99 })], 'TSTA', TODAY);
    expect(rows).toEqual([
      { period: '2026-11-01', strongBuy: 4, buy: 10, hold: 6, sell: 1, strongSell: 0 },
      { period: '2026-10-01', strongBuy: 4, buy: 10, hold: 7, sell: 1, strongSell: 0 },
      { period: '2026-08-01', strongBuy: 4, buy: 8, hold: 6, sell: 1, strongSell: 0 },
    ]);
    expect(parseRecommendations([], 'TSTA', TODAY)).toEqual([]);
    expect(parseRecommendations([rec('2026-11-01', {}, 'tsta')], 'TSTA', TODAY)).toHaveLength(1);
  });

  it.each([
    ['not an array', { data: [] }],
    ['another symbol', [rec('2026-11-01'), rec('2026-10-01', {}, 'TSTX')]],
    ['no symbol', [{ ...rec('2026-11-01'), symbol: undefined }]],
    ['a negative count', [rec('2026-11-01', { sell: -1 })]],
    ['a fractional count', [rec('2026-11-01', { buy: 2.5 })]],
    ['a count as text', [rec('2026-11-01', { buy: '3' })]],
    ['a missing count', [rec('2026-11-01', { strongSell: null })]],
    ['an absurd count', [rec('2026-11-01', { hold: 5000 })]],
    ['a date that does not exist', [rec('2026-02-30')]],
    ['a malformed date', [rec('2026-11')]],
    ['a period far in the future', [rec('2027-01-01')]],
    ['an entry that is not an object', [rec('2026-11-01'), null]],
  ])('refuses %s', (_why, body) => {
    expect(parseRecommendations(body, 'TSTA', TODAY)).toBeNull();
  });
});

describe('parseEarnings', () => {
  it('rows oldest first, one per date; an empty hour is null, missing numbers are null', () => {
    const rows = parseEarnings({ earningsCalendar: [earn('2027-01-28', { hour: '' }), earn('2026-10-29', { hour: 'bmo', epsActual: 1.4, quarter: 3 }), earn('2026-10-29', { epsActual: 9 })] }, 'TSTA');
    expect(rows).toEqual([
      { date: '2026-10-29', hour: 'bmo', epsEstimate: 1.25, epsActual: 1.4, quarter: 3, year: 2026 },
      { date: '2027-01-28', hour: null, epsEstimate: 1.25, epsActual: null, quarter: 4, year: 2026 },
    ]);
    expect(parseEarnings({ earningsCalendar: [] }, 'TSTA')).toEqual([]);
    expect(parseEarnings({ earningsCalendar: [earn('2026-12-01', { hour: 'dmh', epsEstimate: null, quarter: null, year: null })] }, 'TSTA')).toEqual([{ date: '2026-12-01', hour: 'dmh', epsEstimate: null, epsActual: null, quarter: null, year: null }]);
  });

  it.each([
    ['no calendar', {}],
    ['an array body', []],
    ['another symbol', { earningsCalendar: [earn('2026-12-01', { symbol: 'TSTX' })] }],
    ['a bad date', { earningsCalendar: [earn('2026-13-01')] }],
    ['an unknown hour', { earningsCalendar: [earn('2026-12-01', { hour: 'noon' })] }],
    ['an estimate as text', { earningsCalendar: [earn('2026-12-01', { epsEstimate: '1.2' })] }],
    ['a quarter of 5', { earningsCalendar: [earn('2026-12-01', { quarter: 5 })] }],
    ['a year as text', { earningsCalendar: [earn('2026-12-01', { year: '2026' })] }],
  ])('refuses %s', (_why, body) => {
    expect(parseEarnings(body, 'TSTA')).toBeNull();
  });
});

describe('answerSymbol and parseProfile', () => {
  it('the one symbol of an answer; none for an empty list; mixed when entries disagree or lack one', () => {
    expect(answerSymbol([rec('2026-11-01'), rec('2026-10-01')], 'recommendation')).toBe('TSTA');
    expect(answerSymbol([rec('2026-11-01', {}, 'tsta.b')], 'recommendation')).toBe('TSTA.B');
    expect(answerSymbol([], 'recommendation')).toBeNull();
    expect(answerSymbol({ earningsCalendar: [] }, 'earnings')).toBeNull();
    expect(answerSymbol({ earningsCalendar: [earn('2026-12-01'), earn('2026-09-01', { symbol: 'TSTA.L' })] }, 'earnings')).toBe('mixed');
    expect(answerSymbol([rec('2026-11-01'), rec('2026-10-01', {}, 'TSTB')], 'recommendation')).toBe('mixed');
    expect(answerSymbol([{ ...rec('2026-11-01'), symbol: undefined }], 'recommendation')).toBe('mixed');
    expect(answerSymbol([rec('2026-11-01', {}, 'TS TA')], 'recommendation')).toBe('mixed');
  });

  it('profile2: the ticker, null for an empty answer, refused for a malformed one; the path carries only the symbol', () => {
    expect(parseProfile({ ticker: 'tsta.b', name: 'Test A' })).toEqual({ ticker: 'TSTA.B' });
    expect(parseProfile({})).toEqual({ ticker: null });
    expect(parseProfile({ name: 'x' })).toEqual({ ticker: null });
    expect(parseProfile({ ticker: 'bad ticker' })).toBeNull();
    expect(parseProfile([])).toBeNull();
    expect(profilePath('TSTA')).toBe('/api/v1/stock/profile2?symbol=TSTA');
  });

  it('the parsers take the verified alias as the expected symbol', () => {
    expect(parseRecommendations([rec('2026-11-01', {}, 'TSTA.B')], 'TSTA.B', '2026-11-11')).toHaveLength(1);
    expect(parseRecommendations([rec('2026-11-01', {}, 'TSTA.B')], 'TSTA', '2026-11-11')).toBeNull();
  });
});
