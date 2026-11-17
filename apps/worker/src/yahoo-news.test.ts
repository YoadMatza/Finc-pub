import { type FetchFn, openDb } from '@finc/core';
import { describe, expect, it, vi } from 'vitest';
import { YahooNewsService } from './yahoo-news.js';

// Yahoo company news, the news panel's fallback (made-up items)

const T0 = Date.parse('2026-11-16T08:00:00Z');
const BODY = { news: [{ title: 'Demo Group sells a unit', publisher: 'Demo Wire', link: 'https://news.example/1', providerPublishTime: Date.parse('2026-11-15T12:00:00Z') / 1000, relatedTickers: ['DEMOY'] }] };

function setup() {
  const db = openDb(':memory:');
  let t = T0;
  let fail = false;
  const lines: object[] = [];
  const log = { debug: (o: object) => lines.push(o), info: (o: object) => lines.push(o), warn: (o: object) => lines.push(o) };
  const f = vi.fn<FetchFn>(async () => (fail ? new Response('', { status: 503 }) : new Response(JSON.stringify(BODY), { status: 200 })));
  const make = () => new YahooNewsService({ db, fetch: f, now: () => t, deadlineMs: 1000, log });
  return { make, f, lines, at: (x: number) => (t = x), failing: (x: boolean) => (fail = x) };
}

describe('YahooNewsService', () => {
  it('fresh for 12 hours (also from the table after a restart), then a stale entry when it cannot be refreshed', async () => {
    const env = setup();
    const a = await env.make().news('DEMOY');
    expect(a).toMatchObject({ ok: true, stale: false, fetchedAt: T0 });
    // a new service (a worker restart) reads market_data_cache: no request
    expect(await env.make().news('DEMOY')).toMatchObject({ ok: true, stale: false });
    expect(env.f).toHaveBeenCalledTimes(1);
    env.at(T0 + 13 * 3_600_000);
    env.failing(true);
    const s = env.make();
    const b = await s.news('DEMOY');
    expect(b).toMatchObject({ ok: true, stale: true, fetchedAt: T0 });
    // query1 then query2 on a server error
    expect(env.f.mock.calls.slice(1).map((c) => new URL(String(c[0])).host)).toEqual(['query1.finance.yahoo.com', 'query2.finance.yahoo.com']);
    // the failure is remembered: no new request within 5 minutes
    await s.news('DEMOY');
    expect(env.f).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(env.lines)).not.toContain('DEMOY');
  });

  it('a symbol Yahoo cannot take is not_covered; nothing is sent', async () => {
    const env = setup();
    expect(await env.make().news('bad symbol!')).toEqual({ ok: false, code: 'not_covered' });
    expect(env.f).not.toHaveBeenCalled();
  });
});
