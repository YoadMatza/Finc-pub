import type { FetchFn } from '@finc/core';
import { describe, expect, it, vi } from 'vitest';
import { SEC_BACKOFF_BASE_MS, SEC_FAIL_TTL_MS, SecService, secContactFromEnv } from './sec.js';

// SEC EDGAR service: caches, TTLs, backoff and the deadline, with a mocked fetch (no network). Fictional companies,
// CIKs and an example.com contact.

const CONTACT = 'owner-alias@example.com';
const T0 = Date.parse('2026-11-11T08:00:00Z');
const H = 3_600_000;

const tickers = { '0': { cik_str: 9999001, ticker: 'TEST1', title: 'Test One Corp' }, '1': { cik_str: 9999002, ticker: 'TSTB-B', title: 'Test Bee Holdings' } };
const submissions = (cik: number) => ({ cik: String(cik), name: 'Test One Corp', sic: '3571', sicDescription: 'Electronic Computers', filings: { recent: { accessionNumber: ['0009999001-26-000010'], filingDate: ['2026-10-30'], reportDate: ['2026-09-30'], form: ['10-Q'], items: [''] } } });
const facts = (cik: number) => ({ cik, entityName: 'Test One Corp', facts: { 'us-gaap': { Revenues: { units: { USD: [{ start: '2026-07-01', end: '2026-09-30', val: 100, accn: '0009999001-26-000010', fy: 2026, fp: 'Q3', form: '10-Q', filed: '2026-10-30' }] } } } } });

type Answer = Response | Error | Promise<Response>;
function setup(o: { contact?: string | null; answer?: (url: string) => Answer | undefined; deadlineMs?: number } = {}) {
  const clock = { t: T0 };
  const logged: string[] = [];
  const logFn = (o: object, m: string) => void logged.push(`${m} ${JSON.stringify(o)}`);
  const f = vi.fn<FetchFn>(async (url) => {
    const a = o.answer?.(url);
    if (a !== undefined) return a instanceof Error ? Promise.reject(a) : a;
    const cik = Number(/CIK(\d{10})/.exec(url)?.[1] ?? 0);
    const body = url.endsWith('company_tickers.json') ? tickers : url.includes('/submissions/') ? submissions(cik) : facts(cik);
    return new Response(JSON.stringify(body), { status: 200 });
  });
  const svc = new SecService({ contact: o.contact === undefined ? CONTACT : o.contact, fetch: f, now: () => clock.t, minGapMs: 0, deadlineMs: o.deadlineMs ?? 2000, log: { debug: logFn, info: logFn, warn: logFn } });
  const urls = () => f.mock.calls.map(([u]) => u);
  return { svc, f, clock, logged, urls };
}

describe('SecService', () => {
  it('fetches the ticker list, then the CIK submissions and facts, with the User-Agent; caches them', async () => {
    const env = setup();
    const r = await env.svc.company('TEST1');
    expect(r).toMatchObject({ ok: true, submissions: { cik: '0009999001', name: 'Test One Corp', sic: '3571' }, facts: { cik: '0009999001' } });
    expect(env.urls()).toEqual(['https://www.sec.gov/files/company_tickers.json', 'https://data.sec.gov/submissions/CIK0009999001.json', 'https://data.sec.gov/api/xbrl/companyfacts/CIK0009999001.json']);
    for (const [, init] of env.f.mock.calls) expect(init).toMatchObject({ headers: { 'user-agent': `finc personal finance app ${CONTACT}` }, redirect: 'error', credentials: 'omit' });
    await env.svc.company('TEST1');
    expect(env.f).toHaveBeenCalledTimes(3);
    // the ticker never goes to SEC; the log has no contact, symbol or CIK
    expect(env.urls().some((u) => u.includes('TEST1'))).toBe(false);
    expect(env.logged.join('\n')).not.toMatch(/example\.com|TEST1|9999001|owner-alias/);
  });

  it('TTLs: submissions 12 h, facts and the ticker list 24 h', async () => {
    const env = setup();
    await env.svc.company('TEST1');
    env.clock.t += 12 * H + 1;
    await env.svc.company('TEST1');
    expect(env.urls().slice(3)).toEqual(['https://data.sec.gov/submissions/CIK0009999001.json']);
    env.clock.t += 12 * H - 1; // 24 h after the first open
    await env.svc.company('TEST1');
    expect(env.urls().slice(4).sort()).toEqual(['https://data.sec.gov/api/xbrl/companyfacts/CIK0009999001.json', 'https://www.sec.gov/files/company_tickers.json']);
  });

  it('class shares (TSTB.B is TSTB-B at SEC); unknown or foreign tickers are not covered', async () => {
    const env = setup();
    expect((await env.svc.company('TSTB.B')).ok).toBe(true);
    expect(env.urls()).toContain('https://data.sec.gov/submissions/CIK0009999002.json');
    expect(await env.svc.company('NOPE')).toEqual({ ok: false, code: 'not_covered' });
    expect(await env.svc.company('TEST1.TA')).toEqual({ ok: false, code: 'not_covered' });
  });

  it('off without a valid contact: nothing is sent', async () => {
    for (const contact of [null, '', 'not an email']) {
      const env = setup({ contact });
      expect(env.svc.enabled()).toBe(false);
      expect(await env.svc.company('TEST1')).toEqual({ ok: false, code: 'off' });
      expect(env.f).not.toHaveBeenCalled();
    }
    expect(secContactFromEnv({ FINC_SEC_CONTACT: ` ${CONTACT} ` })).toBe(CONTACT);
    expect(secContactFromEnv({ FINC_SEC_CONTACT: '' })).toBeNull();
    expect(secContactFromEnv({})).toBeNull();
  });

  it('429/403 back every SEC fetch off 4, then 8 minutes; busy meanwhile without fetching', async () => {
    let limited = true;
    const env = setup({ answer: () => (limited ? new Response('', { status: 429 }) : undefined) });
    expect(await env.svc.company('TEST1')).toEqual({ ok: false, code: 'busy' });
    expect(env.f).toHaveBeenCalledTimes(1);
    expect(env.svc.status()).toMatchObject({ failures: 1, backoffUntil: T0 + SEC_BACKOFF_BASE_MS });
    expect(await env.svc.company('TEST1')).toEqual({ ok: false, code: 'busy' });
    expect(env.f).toHaveBeenCalledTimes(1);
    env.clock.t += SEC_BACKOFF_BASE_MS;
    expect((await env.svc.company('TEST1')).ok).toBe(false);
    expect(env.svc.status().backoffUntil).toBe(env.clock.t + 2 * SEC_BACKOFF_BASE_MS);
    env.clock.t += 2 * SEC_BACKOFF_BASE_MS;
    limited = false;
    expect((await env.svc.company('TEST1')).ok).toBe(true);
    expect(env.svc.status()).toMatchObject({ failures: 0, backoffUntil: null });
    expect(env.logged.join('\n')).toMatch(/rate limited/);
  });

  it('server and network failures are unreachable, remembered 5 minutes', async () => {
    let fail: Answer | undefined = new Response('', { status: 503 });
    const env = setup({ answer: (u) => (u.endsWith('company_tickers.json') ? fail : undefined) });
    expect(await env.svc.company('TEST1')).toEqual({ ok: false, code: 'unreachable' });
    expect(await env.svc.company('TEST1')).toEqual({ ok: false, code: 'unreachable' });
    expect(env.f).toHaveBeenCalledTimes(1);
    env.clock.t += SEC_FAIL_TTL_MS;
    fail = new Error('offline');
    expect(await env.svc.company('TEST1')).toEqual({ ok: false, code: 'unreachable' });
    expect(env.f).toHaveBeenCalledTimes(2);
  });

  it('submissions failing: the facts still come back (submissions null); facts failing fails the company', async () => {
    const env = setup({ answer: (u) => (u.includes('/submissions/') ? new Response('', { status: 503 }) : undefined) });
    expect(await env.svc.company('TEST1')).toMatchObject({ ok: true, cik: '0009999001', title: 'Test One Corp', submissions: null, facts: { cik: '0009999001' } });
    const nf = setup({ answer: (u) => (u.includes('companyfacts') ? new Response('', { status: 503 }) : undefined) });
    expect(await nf.svc.company('TEST1')).toEqual({ ok: false, code: 'unreachable' });
  });

  it('a per-call deadline (what is left of the panel) answers busy', async () => {
    const env = setup({ answer: () => new Promise<Response>(() => {}) });
    expect(await env.svc.company('TEST1', 20)).toEqual({ ok: false, code: 'busy' });
  });

  it('a company without XBRL facts (404) still has its filings; a bad body is invalid', async () => {
    const env = setup({ answer: (u) => (u.includes('companyfacts') ? new Response('', { status: 404 }) : undefined) });
    expect(await env.svc.company('TEST1')).toMatchObject({ ok: true, facts: null });
    const bad = setup({ answer: (u) => (u.includes('companyfacts') ? new Response(JSON.stringify({ cik: 123, facts: {} }), { status: 200 }) : undefined) });
    expect(await bad.svc.company('TEST1')).toEqual({ ok: false, code: 'invalid' });
  });

  it('one fetch per URL in flight; a slow SEC answers busy at the deadline and fills the cache for the next open', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const env = setup({ deadlineMs: 30, answer: (u) => (u.includes('companyfacts') ? gate.then(() => new Response(JSON.stringify(facts(9999001)), { status: 200 })) : undefined) });
    const [a, b] = await Promise.all([env.svc.company('TEST1'), env.svc.company('TEST1')]);
    expect(a).toEqual({ ok: false, code: 'busy' });
    expect(b).toEqual({ ok: false, code: 'busy' });
    expect(env.f).toHaveBeenCalledTimes(3);
    release();
    await vi.waitFor(() => expect(env.svc.status().inflight).toBe(0));
    expect((await env.svc.company('TEST1')).ok).toBe(true);
    expect(env.f).toHaveBeenCalledTimes(3);
  });
});
