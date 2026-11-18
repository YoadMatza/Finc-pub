import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type Db, ensureAccount, openDb, type Vault } from '@finc/core';
import type { Browser } from 'puppeteer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { monthsAgo, runScrape, type ScrapeRunOptions } from './scrape.js';

// runScrape creates browser-profile / screenshot folders under the data dir: keep them in a temp dir.
let tmp = '';
const savedDataDir = process.env.FINC_DATA_DIR;
beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'finc-scrape-test-'));
  process.env.FINC_DATA_DIR = tmp;
});
afterAll(() => {
  if (savedDataDir === undefined) delete process.env.FINC_DATA_DIR;
  else process.env.FINC_DATA_DIR = savedDataDir;
  rmSync(tmp, { recursive: true, force: true });
});

const fakeVault = (fields: Record<string, string> = { username: 'u', password: 'p' }): Vault =>
  ({ locked: false, has: () => true, get: () => ({ kind: 'scraper', fields, updatedAt: '2026-11-10T00:00:00Z' }) }) as unknown as Vault;

function fakeBrowser(): { browser: Browser; close: ReturnType<typeof vi.fn> } {
  const close = vi.fn(async () => undefined);
  return { browser: { userAgent: async () => 'Mozilla/5.0 HeadlessChrome/130', close, pages: async () => [] } as unknown as Browser, close };
}

const fakeScraper = (scrape: () => Promise<unknown>) => (() => ({ onProgress: () => undefined, scrape })) as unknown as NonNullable<ScrapeRunOptions['createScraper']>;

const base = (vault: Vault = fakeVault()): ScrapeRunOptions => ({
  institutionId: 'max',
  vault,
  monthsBack: 3,
  showBrowser: false,
  dump: false,
  trigger: 'manual',
  otp: async () => '000000',
});

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
  // the connection row exists once the institution has an account (as in production after the first sync)
  ensureAccount(db, { institutionId: 'max', institutionKind: 'card', institutionDisplayName: 'Max', scraperId: 'max', source: 'scraper:max', externalId: 'm', type: 'credit_card' });
});

const run = (id: number | null) => db.$client.prepare(`select status, error_type as errorType, error, ended_at as endedAt from sync_run where id = ?`).get(id) as { status: string; errorType: string | null; error: string | null; endedAt: string | null };
const conn = () => db.$client.prepare(`select last_error as lastError, consecutive_failures as failures, last_run_id as lastRunId from connection where institution_id = 'max'`).get() as { lastError: string | null; failures: number; lastRunId: number | null };
const allRuns = () => db.$client.prepare(`select id, status from sync_run`).all() as Array<{ id: number; status: string }>;

describe('runScrape failure recording (P1-04)', () => {
  it('a browser that fails to launch ends the run as an error and sets the connection error', async () => {
    const r = await runScrape(db, { ...base(), launchBrowser: async () => { throw new Error('profile is locked'); } });
    expect(r).toMatchObject({ success: false, errorType: 'CRASH', errorMessage: 'profile is locked' });
    expect(r.runId).not.toBeNull();
    expect(run(r.runId)).toMatchObject({ status: 'error', errorType: 'CRASH', error: 'profile is locked' });
    expect(run(r.runId).endedAt).not.toBeNull();
    expect(conn()).toMatchObject({ lastError: 'CRASH: profile is locked', failures: 1, lastRunId: r.runId });
  });

  it('a scraper that throws ends the run as an error and still closes the browser', async () => {
    const { browser, close } = fakeBrowser();
    const r = await runScrape(db, { ...base(), launchBrowser: async () => browser, createScraper: fakeScraper(async () => { throw new Error('navigation timeout'); }) });
    expect(r).toMatchObject({ success: false, errorType: 'CRASH' });
    expect(run(r.runId)).toMatchObject({ status: 'error', errorType: 'CRASH' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('a failure while storing the result ends the run as an INGEST error', async () => {
    const { browser, close } = fakeBrowser();
    // an account without a number cannot be stored
    const scraped = { success: true, accounts: [{ accountNumber: undefined, txns: [] }] };
    const r = await runScrape(db, { ...base(), launchBrowser: async () => browser, createScraper: fakeScraper(async () => scraped) });
    expect(r).toMatchObject({ success: false, errorType: 'INGEST' });
    expect(run(r.runId)).toMatchObject({ status: 'error', errorType: 'INGEST' });
    expect(conn().lastError).toMatch(/^INGEST: /);
    expect(close).toHaveBeenCalledTimes(1);
    expect(allRuns().filter((x) => x.status === 'running')).toEqual([]);
  });

  it('keeps the scraper-reported failure as before (error type and otp_required status)', async () => {
    const { browser } = fakeBrowser();
    const r = await runScrape(db, { ...base(), launchBrowser: async () => browser, createScraper: fakeScraper(async () => ({ success: false, errorType: 'TWO_FACTOR_RETRIEVER_MISSING', errorMessage: 'otp' })) });
    expect(r).toMatchObject({ success: false, errorType: 'TWO_FACTOR_RETRIEVER_MISSING' });
    expect(run(r.runId)).toMatchObject({ status: 'otp_required', errorType: 'TWO_FACTOR_RETRIEVER_MISSING' });
  });

  it('a successful scrape still ends ok and clears the connection error', async () => {
    const { browser, close } = fakeBrowser();
    await runScrape(db, { ...base(), launchBrowser: async () => { throw new Error('first fails'); } });
    expect(conn().failures).toBe(1);
    const scraped = { success: true, accounts: [{ accountNumber: '4580123412341234', balance: 0, txns: [] }] };
    const r = await runScrape(db, { ...base(), launchBrowser: async () => browser, createScraper: fakeScraper(async () => scraped) });
    expect(r.success).toBe(true);
    expect(run(r.runId).status).toBe('ok');
    expect(conn()).toMatchObject({ lastError: null, failures: 0 });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('an incomplete vault entry is recorded as a failed run (not thrown before any run exists)', async () => {
    const launch = vi.fn(async () => fakeBrowser().browser);
    const r = await runScrape(db, { ...base(fakeVault({ username: 'u' })), launchBrowser: launch });
    expect(r).toMatchObject({ success: false, errorType: 'CONFIG' });
    expect(r.errorMessage).toContain('missing: password');
    expect(run(r.runId)).toMatchObject({ status: 'error', errorType: 'CONFIG' });
    expect(conn().lastError).toMatch(/^CONFIG: vault entry max is missing: password/);
    expect(launch).not.toHaveBeenCalled();
  });

  it('an incomplete vault entry still throws on a dry run (nothing to record)', async () => {
    await expect(runScrape(db, { ...base(fakeVault({ username: 'u' })), dryRun: true })).rejects.toThrow(/missing: password/);
    expect(allRuns()).toEqual([]);
  });
});

describe('monthsAgo', () => {
  const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  it('does not overflow on the 29th-31st', () => {
    expect(ymd(monthsAgo(1, new Date(2026, 2, 31, 15, 0)))).toBe('2026-02-01'); // Mar 31: used to give Mar 1
    expect(ymd(monthsAgo(3, new Date(2026, 4, 31)))).toBe('2026-02-01'); // May 31 - 3: used to give Mar 1
    expect(ymd(monthsAgo(1, new Date(2026, 0, 31)))).toBe('2025-12-01');
    expect(ymd(monthsAgo(1, new Date(2024, 2, 29)))).toBe('2024-02-01');
  });
  it('is the first of the month at local midnight', () => {
    const d = monthsAgo(0, new Date(2026, 10, 10, 13, 45));
    expect(ymd(d)).toBe('2026-11-01');
    expect([d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()]).toEqual([0, 0, 0, 0]);
    expect(ymd(monthsAgo(12, new Date(2026, 10, 30)))).toBe('2025-11-01');
  });
});

describe('FIBI position pages (position-view.md)', () => {
  it('stores the purchase lots and the tax year on the securities account', async () => {
    const lot = { paperId: '11111', name: 'ACME', action: 'buy' as const, actionText: 'קניה בבורסה', quantity: 10, costPrice: 20.5, costPriceIls: 75.1, currency: 'USD', tradeDate: '2025-02-03', avgPrice: null, lastPrice: 1, changePct: -95 };
    const taxYear = { year: 2026, lossesIls: -100, gains: [{ ratePct: 25, amountIls: 0 }], taxWithheld: [], interestDividendIls: null, interestDividendTaxIls: null };
    const scraper: NonNullable<ScrapeRunOptions['scraper']> = async () => ({
      scraped: { success: true, accounts: [{ accountNumber: '000123456', txns: [] }] } as never,
      extras: { investmentsIls: 100_00 },
      position: { lots: [lot], taxYear },
    });
    const r = await runScrape(db, { ...base(), institutionId: 'beinleumi', scraper });
    expect(r.success).toBe(true);
    const lots = db.$client.prepare(`select l.paper_id p, a.type t from cost_lot_snapshot l join account a on a.id = l.account_id`).all();
    expect(lots).toEqual([{ p: '11111', t: 'securities' }]);
    expect(db.$client.prepare(`select year, losses_ils l from tax_year_summary`).all()).toEqual([{ year: 2026, l: -100 }]);
  });
});
