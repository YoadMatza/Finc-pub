import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureAccount } from '../db/accounts.js';
import { type Db, openDb } from '../db/db.js';
import { account, accountAlias, balanceSnapshot, syncRun, transactions } from '../db/schema.js';
import type { RiseupTransaction } from '../ingest/riseup-convert.js';
import { RiseupApiError, RiseupClient, currentMonth, prevMonth } from './client.js';
import { importRiseup, inferInstitution } from './import.js';

const FIXTURES = fileURLToPath(new URL('../../../../fixtures/', import.meta.url));
const sample = JSON.parse(readFileSync(path.join(FIXTURES, 'riseup/transactions.sample.json'), 'utf8')) as { transactions: RiseupTransaction[] };

const TOKEN = 'riseup_pat_TESTTESTTESTTESTTESTTESTTESTTESTTESTTEST';

type Route = (url: URL) => { status: number; body?: unknown; headers?: Record<string, string> };

function fakeFetch(route: Route, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push(url.pathname + url.search);
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    if (auth !== `Bearer ${TOKEN}`) return new Response('{"error":"unauthorized"}', { status: 401 });
    const r = route(url);
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json', 'x-riseup-token-ref': 'abc123', ...(r.headers ?? {}) },
    });
  }) as typeof fetch;
}

/** Fixture months: 2026-11 has 3 txns, 2026-10 has 1, 2026-09 is empty but exists, 2026-08 is before the earliest. */
const route: Route = (url) => {
  if (url.pathname === '/api/external/transactions') {
    const m = url.searchParams.get('cashflowMonth');
    const txns = sample.transactions.filter((t) => t.cashflowDate === m);
    return { status: 200, body: { transactions: txns } };
  }
  if (url.pathname.startsWith('/api/external/budget/')) {
    const m = url.pathname.split('/').pop()!;
    return m < '2026-09' ? { status: 404, body: { error: 'not_found' } } : { status: 200, body: { budgetDate: m, envelopes: [] } };
  }
  if (url.pathname === '/api/external/balances/current') {
    return { status: 200, body: { balances: [{ source: 'beinleumi', accountNickname: 'עו"ש', accountNumberHash: 'd4e5f6', balance: 1234.56, lastUpdated: '2026-11-08T05:00:00.000Z', overdraftLimit: 5000, availableOverdraft: 5000, overdraftLimitUpdatedAt: '2026-11-07' }] } };
  }
  if (url.pathname === '/api/external/balances/history') {
    return { status: 200, body: { accounts: [{ source: 'beinleumi', accountNickname: null, accountNumberHash: 'd4e5f6', minBalance: 1, maxBalance: 2, avgBalance: 1.5, balances: [{ date: '2026-11-07', balance: 1200 }, { date: '2026-11-06', balance: 1100 }] }] } };
  }
  return { status: 500, body: { error: 'unexpected' } };
};

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
});

describe('RiseupClient', () => {
  it('rejects a token without the prefix', () => {
    expect(() => new RiseupClient('abc')).toThrow(/riseup_pat_/);
  });

  it('sends the bearer header and parses transactions', async () => {
    const calls: string[] = [];
    const c = new RiseupClient(TOKEN, { fetchImpl: fakeFetch(route, calls) });
    const txns = await c.transactions('2026-11');
    expect(txns).toHaveLength(3);
    expect(calls).toEqual(['/api/external/transactions?cashflowMonth=2026-11']);
  });

  it('maps 401/403 to clear errors without leaking the token', async () => {
    const c = new RiseupClient(TOKEN, { fetchImpl: fakeFetch(() => ({ status: 403, body: { required: 'balances:read' } })) });
    const err = await c.currentBalances().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RiseupApiError);
    expect((err as RiseupApiError).status).toBe(403);
    expect((err as Error).message).not.toContain(TOKEN);
    expect((err as RiseupApiError).tokenRef).toBe('abc123');
  });

  it('waits on 429 using Retry-After, then succeeds', async () => {
    let n = 0;
    const sleeps: number[] = [];
    const c = new RiseupClient(TOKEN, {
      fetchImpl: fakeFetch(() => (n++ === 0 ? { status: 429, body: { error: 'rate_limit_exceeded' }, headers: { 'retry-after': '2' } } : { status: 200, body: { transactions: [] } })),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(await c.transactions('2026-11')).toEqual([]);
    expect(sleeps).toEqual([2000]);
    expect(c.calls).toBe(2);
  });

  it('budget() returns null on 404 (before earliest record)', async () => {
    const c = new RiseupClient(TOKEN, { fetchImpl: fakeFetch(route) });
    expect(await c.budget('2026-01')).toBeNull();
    expect(await c.budget('2026-10')).toMatchObject({ budgetDate: '2026-10' });
  });

  it('month helpers', () => {
    expect(prevMonth('2026-01')).toBe('2025-12');
    expect(prevMonth('2026-11')).toBe('2026-10');
    expect(currentMonth(new Date('2026-11-08T12:00:00Z'))).toBe('2026-11');
  });
});

describe('importRiseup', () => {
  it('walks back until RiseUp has no earlier month, ingests with annotations, snapshots balances', async () => {
    const calls: string[] = [];
    const c = new RiseupClient(TOKEN, { fetchImpl: fakeFetch(route, calls) });
    const months: string[] = [];
    const r = await importRiseup(db, c, { to: '2026-11', balances: true, onMonth: (m) => months.push(m) });

    expect(r.error).toBeUndefined();
    expect(r.stoppedBecause).toBe('before-earliest');
    expect(r.months).toEqual(['2026-11', '2026-10', '2026-09']);
    expect(r.stats).toMatchObject({ seen: 4, new: 4 });
    // Budget probe only on empty months: 2026-09 (exists) and 2026-08 (404).
    expect(calls.filter((p) => p.startsWith('/api/external/budget/'))).toEqual(['/api/external/budget/2026-09', '/api/external/budget/2026-08']);

    const txns = db.select().from(transactions).all();
    expect(txns).toHaveLength(4);
    const excluded = txns.find((t) => t.descriptionRaw === 'העברה לחשבון חיסכון')!;
    expect(JSON.parse(excluded.annotationsJson!).riseup).toMatchObject({ isExcluded: true, comment: 'חיסכון, לא הוצאה', categoryLabel: 'אחר' });
    expect(excluded.amountIls).toBe(-150000);
    expect(excluded.excluded).toBe(false); // RiseUp's flag is an annotation; our own exclusion is Phase 2's call

    // Two RiseUp accounts: max card (a1b2c3) and beinleumi checking (d4e5f6), inferred from source/sourceType
    const accounts = db.select().from(account).all();
    expect(accounts.map((a) => [a.institutionId, a.type]).sort()).toEqual([
      ['beinleumi', 'checking'],
      ['max', 'credit_card'],
    ]);
    expect(r.accounts).toHaveLength(2);

    const snaps = db.select().from(balanceSnapshot).all();
    expect(snaps).toHaveLength(3); // 1 current + 2 history
    expect(snaps.find((s) => s.source === 'riseup')?.balance).toBe(123456);

    const run = db.select().from(syncRun).where(eq(syncRun.id, r.runId)).get();
    expect(run).toMatchObject({ status: 'ok', institutionId: 'riseup', rowsNew: 4 });
  });

  it('adopts an existing scraped account instead of creating a duplicate', async () => {
    const scraped = ensureAccount(db, {
      institutionId: 'max',
      institutionKind: 'card',
      institutionDisplayName: 'Max',
      scraperId: 'max',
      source: 'scraper:max',
      externalId: '6150',
      type: 'credit_card',
    }).accountId;
    const c = new RiseupClient(TOKEN, { fetchImpl: fakeFetch(route) });
    const r = await importRiseup(db, c, { to: '2026-11', from: '2026-11' });
    expect(r.stoppedBecause).toBe('from-reached');
    const maxAcc = r.accounts.find((a) => a.externalId === 'a1b2c3')!;
    expect(maxAcc.accountId).toBe(scraped);
    expect(maxAcc.created).toBe(false);
    const aliases = db.select().from(accountAlias).where(eq(accountAlias.accountId, scraped)).all();
    expect(aliases.map((a) => a.source).sort()).toEqual(['riseup', 'scraper:max']);
  });

  it('a scraper that runs after RiseUp adopts the RiseUp-created account (and FIBI is spelled "benleumi")', async () => {
    const c = new RiseupClient(TOKEN, { fetchImpl: fakeFetch(route) });
    await importRiseup(db, c, { to: '2026-11' });
    const riseupMax = db.select().from(accountAlias).where(eq(accountAlias.externalId, 'a1b2c3')).get()!;
    const scraped = ensureAccount(db, { institutionId: 'max', institutionKind: 'card', institutionDisplayName: 'Max', scraperId: 'max', source: 'scraper:max', externalId: '6150', type: 'credit_card', last4: '6150' });
    expect(scraped).toEqual({ accountId: riseupMax.accountId, created: false });
    expect(db.select().from(account).where(eq(account.id, scraped.accountId)).get()?.last4).toBe('6150');
    // a second card from the same scraper does NOT adopt: the singleton is taken
    const second = ensureAccount(db, { institutionId: 'max', institutionKind: 'card', institutionDisplayName: 'Max', scraperId: 'max', source: 'scraper:max', externalId: '1111', type: 'credit_card' });
    expect(second.created).toBe(true);
    expect(inferInstitution({ source: 'benleumi', sourceType: 'checkingAccount' })).toMatchObject({ institutionId: 'beinleumi', type: 'checking' });
  });

  it('treats an empty 200 body as "no data" instead of crashing', async () => {
    const c = new RiseupClient(TOKEN, {
      fetchImpl: fakeFetch((url) => (url.pathname.startsWith('/api/external/budget/') ? { status: 200, body: undefined } : { status: 200, body: { transactions: [] } })),
    });
    const r = await importRiseup(db, c, { to: '2026-11', maxMonths: 2 });
    expect(r.error).toBeUndefined();
    expect(r.stoppedBecause).toBe('before-earliest');
  });

  it('re-running is idempotent', async () => {
    const c = new RiseupClient(TOKEN, { fetchImpl: fakeFetch(route) });
    await importRiseup(db, c, { to: '2026-11' });
    const r2 = await importRiseup(db, c, { to: '2026-11' });
    expect(r2.stats).toMatchObject({ seen: 4, new: 0, updated: 0 });
    expect(db.select().from(transactions).all()).toHaveLength(4);
  });

  it('records an error run when the token is rejected', async () => {
    const c = new RiseupClient(TOKEN, { fetchImpl: fakeFetch(() => ({ status: 401, body: {} })) });
    const r = await importRiseup(db, c, { to: '2026-11' });
    expect(r.stoppedBecause).toBe('error');
    expect(r.error).toMatch(/401/);
    const run = db.select().from(syncRun).where(eq(syncRun.id, r.runId)).get();
    expect(run).toMatchObject({ status: 'error', errorType: 'RISEUP' });
  });

  it('respects the per-minute pacing', async () => {
    const sleeps: number[] = [];
    const c = new RiseupClient(TOKEN, { fetchImpl: fakeFetch(() => ({ status: 200, body: { transactions: [] } })), perMinute: 2, sleep: async (ms) => { sleeps.push(ms); } });
    await c.transactions('2026-11');
    await c.transactions('2026-10');
    await c.transactions('2026-09');
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(59_000);
    vi.restoreAllMocks();
  });
});
