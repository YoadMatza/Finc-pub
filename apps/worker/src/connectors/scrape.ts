/**
 * Bank/card connector built on israeli-bank-scrapers.
 *
 *  - one persistent Chromium profile per institution (data/browser-profiles/<id>) so the
 *    bank remembers the device and OTP challenges are rare
 *  - credentials are read from the unlocked vault and handed straight to the scraper;
 *    they are never logged (pino redaction is the backstop)
 *  - the raw scraper result can be dumped to data/dumps (gitignored) for analysis
 *  - every run is recorded in sync_run; rows go through the ingest engine
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import {
  type Db,
  dumpsDir,
  ensureAccount,
  finishRunError,
  finishRunOk,
  fromScraperAccount,
  type HoldingRow,
  ingestBatch,
  type IngestStats,
  INSTITUTIONS,
  maskNumber,
  type NormalizedRow,
  parseFibiFxText,
  parseFibiPortfolioText,
  profilesDir,
  recordBalance,
  recordHoldings,
  scraperSource,
  screenshotsDir,
  startRun,
  toMinor,
  type Vault,
} from '@finc/core';
import ibs from 'israeli-bank-scrapers';
import type { ScraperCredentials, ScraperOptions, ScraperScrapingResult } from 'israeli-bank-scrapers';
import puppeteer, { type Browser, type LaunchOptions, type Page } from 'puppeteer';
import { log } from '../logger.js';
import type { OtpProvider } from './otp.js';
import { scraperClient } from './scraper-socket.js';
import { hardenBrowserProfile, isIsracardSignedIn, sameOrigin, urlForLog, writePrivate } from './scrape-hygiene.js';

const { CompanyTypes, createScraper } = ibs;

export type ScrapedInstitutionId = 'beinleumi' | 'isracard' | 'max';

export interface ScrapeRunOptions {
  institutionId: ScrapedInstitutionId;
  vault: Vault;
  /** How far back to ask for. Banks cap this themselves. */
  monthsBack: number;
  showBrowser: boolean;
  /** FIBI spike only: after login, save the portal's landing page text, its menu links and the pages that look like
   *  foreign-currency or securities views to data/dumps (gitignored), so the connector can learn to read those balances. */
  explore?: boolean;
  /** Write the full raw result to data/dumps/<id>-<timestamp>.json */
  dump: boolean;
  trigger: 'scheduled' | 'manual';
  otp: OtpProvider;
  /** Skip the DB entirely (connector spike without ingest). */
  dryRun?: boolean;
  timeoutMs?: number;
  /** Verbose scraper logging and no failure screenshot (the screenshot step can mask the real error). */
  debug?: boolean;
  /** Test seam: replaces puppeteer.launch (tests pass a fake browser or a launch that throws). */
  launchBrowser?: (opts: LaunchOptions) => Promise<Browser>;
  /** Test seam: replaces israeli-bank-scrapers' createScraper. */
  createScraper?: (opts: ScraperOptions) => ReturnType<typeof createScraper>;
  /** Who runs the browser: this process (default) or the scraper container (connectors/scraper-client.ts). */
  scraper?: Scraper;
}

export interface AccountSummary {
  accountMasked: string;
  accountId: number | null;
  txns: number;
  pending: number;
  balance: number | undefined;
  created: boolean;
}

export interface ScrapeRunResult {
  institutionId: ScrapedInstitutionId;
  runId: number | null;
  success: boolean;
  errorType?: string;
  errorMessage?: string;
  accounts: AccountSummary[];
  stats: IngestStats;
  dumpFile?: string;
  durationMs: number;
}

const emptyStats = (): IngestStats => ({ seen: 0, new: 0, updated: 0, completed: 0, voided: 0, annotated: 0 });

/** The first day of the month `n` months before `now`, local midnight. setDate(1) first: on the 29th-31st,
 *  setMonth would otherwise overflow into the next month (Mar 31 - 1 month = "Feb 31" = Mar 3). */
export function monthsAgo(n: number, now: Date = new Date()): Date {
  const d = new Date(now.getTime());
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  d.setMonth(d.getMonth() - n);
  return d;
}

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * One scrape job: everything the scraper needs and nothing else (scraper container design, step 1). The login fields
 * travel with the job and are forgotten with it; the scraper never sees the vault or the database.
 */
export interface ScrapeJob {
  institutionId: ScrapedInstitutionId;
  /** the institution's login fields, for this job only */
  fields: Record<string, string>;
  monthsBack: number;
  showBrowser: boolean;
  explore: boolean;
  debug: boolean;
  timeoutMs?: number;
}

/** What a scrape job returns: the library's raw result and, for FIBI, the summary page's values and positions. */
export interface ScrapeOutput {
  scraped: ScraperScrapingResult;
  extras?: BeinleumiSummary;
  holdings?: { securities: HoldingRow[]; fx: HoldingRow[] };
}

/** Runs one job; throws when the browser or the scraper crashes (the caller records it as CRASH). */
export type Scraper = (job: ScrapeJob, otp: OtpProvider) => Promise<ScrapeOutput>;

/**
 * The in-process scraper: launches Chromium with the institution's profile and drives the bank's site. Holds no
 * database and no vault; the scraper container runs exactly this.
 */
export function localScraper(seams: { launchBrowser?: (opts: LaunchOptions) => Promise<Browser>; createScraper?: (opts: ScraperOptions) => ReturnType<typeof createScraper> } = {}): Scraper {
  return async (job, otp) => {
    const spec = INSTITUTIONS[job.institutionId];
    if (!spec.scraperId) throw new Error(`${job.institutionId} is not a scraped institution`);
    const scraperId = spec.scraperId;
    const startDate = monthsAgo(job.monthsBack);
    const profile = path.join(profilesDir(), job.institutionId);
    mkdirSync(profile, { recursive: true });
    hardenBrowserProfile(profile); // never save a bank password in the profile (P2-06)
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    log.info({ institution: job.institutionId, headless: !job.showBrowser, profile, startDate: startDate.toISOString().slice(0, 10) }, 'scrape: launching browser');

    // Anti-bot hygiene (israeli-bank-scrapers#1181, Isracard/Cloudflare): no "automation" banner flag,
    // no navigator.webdriver, a real Accept-Language. Applied to every institution; harmless elsewhere.
    const launch = seams.launchBrowser ?? ((opts: LaunchOptions) => puppeteer.launch(opts));
    let b: Browser | null = null;
    try {
      b = await launch({
        headless: !job.showBrowser,
        userDataDir: profile,
        ...(executablePath ? { executablePath } : {}),
        defaultViewport: null,
        ignoreDefaultArgs: ['--enable-automation'],
        args: [
          '--lang=he-IL,he,en-US,en',
          '--disable-blink-features=AutomationControlled',
          '--disable-dev-shm-usage',
          '--no-first-run',
          '--no-default-browser-check',
          ...(process.platform === 'linux' && process.env.FINC_CHROMIUM_SANDBOX !== '1' ? ['--no-sandbox'] : []),
        ],
      });
      const browser = b;
      const userAgent = (await browser.userAgent()).replace('HeadlessChrome/', 'Chrome/');
      const options: ScraperOptions = {
        companyId: CompanyTypes[scraperId],
        startDate,
        browser,
        skipCloseBrowser: true,
        combineInstallments: false,
        includeRawTransaction: true,
        ...(job.debug ? {} : { storeFailureScreenShotPath: path.join(screenshotsDir(), `${job.institutionId}-${stamp()}.png`) }),
        defaultTimeout: job.timeoutMs ?? (job.showBrowser ? 180_000 : 60_000),
        navigationRetryCount: 3,
        verbose: job.debug,
        preparePage: async (page) => {
          await page.setUserAgent(userAgent);
          await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
          });
          await page.setExtraHTTPHeaders({ 'accept-language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7' });
        },
      };
      const scraper = (seams.createScraper ?? createScraper)(options);
      scraper.onProgress((_company, payload) => log.info({ institution: job.institutionId, step: payload.type }, 'scrape: progress'));
      if (scraperId === 'beinleumi') {
        patchBeinleumiSubmit(scraper, job.institutionId);
        patchBeinleumiFetch(scraper, job.institutionId, job.explore);
      }
      if (scraperId === 'isracard') patchIsracardLogin(scraper, job.institutionId, job.showBrowser);

      // The three institutions we use take plain credentials. If a scraper ever asks for an
      // OTP retriever we pass ours; for the rest, a headful run lets you type the code in the window.
      const credentials = { ...job.fields, otpCodeRetriever: () => otp({ institutionId: job.institutionId }) } as unknown as ScraperCredentials;
      if (job.showBrowser) log.info('scrape: if the bank asks for a one-time code, type it in the browser window');

      const scraped = await scraper.scrape(credentials);
      if (!scraped.success && job.debug) await captureDebugState(browser, job.institutionId);
      const extras = beinleumiExtras.get(job.institutionId);
      const holdings = beinleumiHoldings.get(job.institutionId);
      return { scraped, ...(extras ? { extras } : {}), ...(holdings ? { holdings } : {}) };
    } catch (e) {
      if (job.debug && b) await captureDebugState(b, job.institutionId);
      throw e;
    } finally {
      // the scraper has answered (or crashed): free the browser profile now; storing the result needs no browser
      if (b) await b.close().catch(() => undefined);
      beinleumiExtras.delete(job.institutionId);
      beinleumiHoldings.delete(job.institutionId);
    }
  };
}

export async function runScrape(db: Db | null, o: ScrapeRunOptions): Promise<ScrapeRunResult> {
  const t0 = Date.now();
  const spec = INSTITUTIONS[o.institutionId];
  if (!spec.scraperId) throw new Error(`${o.institutionId} is not a scraped institution`);
  const scraperId = spec.scraperId;
  const source = scraperSource(scraperId);
  const entry = o.vault.get(o.institutionId);
  if (!entry) throw new Error(`no credentials for ${o.institutionId} in the vault (finc vault set ${o.institutionId})`);
  const fields = entry.fields;
  const recording = db !== null && !o.dryRun;
  const missing = spec.fields.filter((f) => !entry.fields[f.key]).map((f) => f.key);
  if (missing.length) {
    const msg = `vault entry ${o.institutionId} is missing: ${missing.join(', ')} (finc vault set ${o.institutionId})`;
    if (!db || !recording) throw new Error(msg);
    // A broken vault entry is a failed sync, not a silent one: record it so the connection shows the error and alerts fire.
    const runId = startRun(db, { institutionId: o.institutionId, source, trigger: o.trigger });
    finishRunError(db, runId, 'CONFIG', msg);
    log.warn({ institution: o.institutionId, missing }, 'scrape: vault entry incomplete, recorded as a failed run');
    return { institutionId: o.institutionId, runId, success: false, errorType: 'CONFIG', errorMessage: msg, accounts: [], stats: emptyStats(), durationMs: Date.now() - t0 };
  }

  const runId = db && recording ? startRun(db, { institutionId: o.institutionId, source, trigger: o.trigger }) : null;
  const result: ScrapeRunResult = { institutionId: o.institutionId, runId, success: false, accounts: [], stats: emptyStats(), durationMs: 0 };

  // From here on every failure ends the run as an error (P1-04): nothing may leave it 'running'.
  // phase: 'CRASH' until the scraper has answered (launch, login, fetch), 'INGEST' while its result is stored.
  let phase: 'CRASH' | 'INGEST' = 'CRASH';
  try {
    return await scrapeAndStore();
  } catch (e) {
    const msg = errMessage(e).slice(0, 500);
    log.error({ institution: o.institutionId, phase, err: msg }, 'scrape: crashed');
    if (db && runId !== null) finishRunError(db, runId, phase, msg);
    result.success = false;
    result.errorType = phase;
    result.errorMessage = msg;
    result.durationMs = Date.now() - t0;
    return result;
  }

  async function scrapeAndStore(): Promise<ScrapeRunResult> {
    // the scraper (in this process, or the scraper container) gets this institution's fields for this job only
    // FINC_SCRAPER_SOCKET (set in the worker container) sends the job to the scraper container; the test seams and a
    // host run (finc spike, headful logins) keep the browser in this process
    const seams = o.launchBrowser !== undefined || o.createScraper !== undefined;
    const socket = process.env.FINC_SCRAPER_SOCKET;
    const scraper = o.scraper ?? (socket && !seams && !o.showBrowser ? scraperClient(socket) : localScraper({ ...(o.launchBrowser ? { launchBrowser: o.launchBrowser } : {}), ...(o.createScraper ? { createScraper: o.createScraper } : {}) }));
    const out = await scraper(
      { institutionId: o.institutionId, fields: { ...fields }, monthsBack: o.monthsBack, showBrowser: o.showBrowser, explore: o.explore ?? false, debug: o.debug ?? false, ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}) },
      o.otp,
    );
    const scraped = out.scraped;
    phase = 'INGEST';

    if (o.dump) {
      const file = path.join(dumpsDir(), `${o.institutionId}-${stamp()}.json`);
      writeFileSync(file, JSON.stringify(scraped, null, 2), { mode: 0o600 });
      result.dumpFile = file;
      log.info({ institution: o.institutionId, file }, 'scrape: raw result dumped (local only, gitignored)');
    }

    if (!scraped.success) {
      const errorType = scraped.errorType ?? 'UNKNOWN';
      const errorMessage = (scraped.errorMessage ?? '').slice(0, 500);
      const status = errorType === 'TWO_FACTOR_RETRIEVER_MISSING' ? 'otp_required' : 'error';
      log.warn({ institution: o.institutionId, errorType, errorMessage }, 'scrape: failed');
      if (db && runId !== null) finishRunError(db, runId, errorType, errorMessage, status);
      result.errorType = errorType;
      result.errorMessage = errorMessage;
      result.durationMs = Date.now() - t0;
      return result;
    }

    const accountType = spec.kind === 'bank' ? 'checking' : 'credit_card';
    for (const acc of scraped.accounts ?? []) {
      const rows: NormalizedRow[] = fromScraperAccount(acc);
      const summary: AccountSummary = {
        accountMasked: maskNumber(acc.accountNumber),
        accountId: null,
        txns: rows.length,
        pending: rows.filter((r) => r.status === 'pending').length,
        balance: acc.balance,
        created: false,
      };
      if (db && !o.dryRun) {
        const { accountId, created } = ensureAccount(db, {
          institutionId: o.institutionId,
          institutionKind: spec.kind,
          institutionDisplayName: spec.displayName,
          scraperId,
          source,
          externalId: acc.accountNumber,
          type: accountType,
          last4: acc.accountNumber.slice(-4),
          displayName: `${spec.displayName} ${maskNumber(acc.accountNumber)}`,
          ...(acc.currency ? { currency: acc.currency } : {}),
        });
        summary.accountId = accountId;
        summary.created = created;
        const stats = ingestBatch(db, { source, runId, accountId, rows, batchIsComplete: true });
        for (const k of Object.keys(stats) as Array<keyof IngestStats>) result.stats[k] += stats[k];
        const bal = toMinor(acc.balance);
        if (bal !== undefined) {
          recordBalance(db, { accountId, runId, balanceMinor: bal, source, ...(acc.balanceDate ? { takenAt: acc.balanceDate } : {}) });
        }
      }
      result.accounts.push(summary);
    }

    // FIBI's summary page also values the foreign-currency account and the securities portfolio in
    // shekels. The library does not expose them, so they become balance-only accounts of their own.
    const extras = out.extras;
    const mainNumber = scraped.accounts?.[0]?.accountNumber;
    if (extras && mainNumber && db && !o.dryRun) {
      const sideAccounts: Array<{ key: 'fxIls' | 'investmentsIls'; type: 'foreign_currency' | 'securities'; suffix: string; label: string }> = [
        { key: 'fxIls', type: 'foreign_currency', suffix: 'fx', label: 'מט״ח' },
        { key: 'investmentsIls', type: 'securities', suffix: 'securities', label: 'ניירות ערך' },
      ];
      for (const side of sideAccounts) {
        const v = extras[side.key];
        if (v === undefined) continue;
        const { accountId } = ensureAccount(db, {
          institutionId: o.institutionId,
          institutionKind: spec.kind,
          institutionDisplayName: spec.displayName,
          scraperId,
          source,
          externalId: `${mainNumber}-${side.suffix}`,
          type: side.type,
          last4: mainNumber.slice(-4),
          displayName: `FIBI ${side.label} ${maskNumber(mainNumber)}`,
        });
        recordBalance(db, { accountId, runId, balanceMinor: v, source: `${source}:summary` });
        const rows = out.holdings?.[side.suffix === 'fx' ? 'fx' : 'securities'] ?? [];
        if (rows.length) {
          const n = recordHoldings(db, { accountId, runId, source: `${source}:${side.suffix}`, rows });
          log.info({ institution: o.institutionId, account: side.suffix, positions: n }, 'fibi: holdings recorded');
        }
        result.accounts.push({ accountMasked: `${maskNumber(mainNumber)} ${side.suffix}`, accountId, txns: 0, pending: 0, balance: v / 100, created: false });
      }
    }

    if (db && runId !== null) {
      finishRunOk(db, runId, result.stats, { accounts: result.accounts.map((a) => ({ account: a.accountMasked, txns: a.txns, pending: a.pending, hasBalance: a.balance !== undefined })) });
    }
    result.success = true;
    result.durationMs = Date.now() - t0;
    log.info({ institution: o.institutionId, accounts: result.accounts.length, stats: result.stats, ms: result.durationMs }, 'scrape: done');
    return result;
  }
}

const stamp = (): string => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

export interface BeinleumiSummary {
  /** foreign-currency account valued in shekels */
  fxIls?: number;
  /** securities and deposits total, shekels */
  investmentsIls?: number;
  /** traded securities valuation, shekels */
  securitiesIls?: number;
  /** current checking balance as the summary page shows it */
  checkingIls?: number;
}
const beinleumiExtras = new Map<string, BeinleumiSummary>();

/**
 * FIBI's post-login summary page lists labelled amounts one per line. Read the ones the library
 * ignores. Quotes vary (״ " ') so they are matched loosely; amounts are agorot, signed.
 */
export function parseBeinleumiSummary(text: string): BeinleumiSummary {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const q = '["״\u05f4\']?';
  const labels: Array<{ key: keyof BeinleumiSummary; re: RegExp }> = [
    { key: 'checkingIls', re: new RegExp(`^יתרת עו${q}ש עדכנית$`) },
    { key: 'fxIls', re: new RegExp(`^שערוך עו${q}ש מט${q}ח$`) },
    { key: 'investmentsIls', re: new RegExp(`^סה${q}כ השקעות$`) },
    { key: 'securitiesIls', re: new RegExp(`^שערוך ני${q}ע סחיר$`) },
  ];
  const out: BeinleumiSummary = {};
  for (let i = 0; i < lines.length - 1; i++) {
    for (const l of labels) {
      if (out[l.key] !== undefined || !l.re.test(lines[i]!)) continue;
      const m = lines[i + 1]!.replace(/[₪\s]/g, '').match(/^(-?)([\d,]+)(?:\.(\d{1,2}))?$/);
      if (!m) continue;
      const whole = Number(m[2]!.replace(/,/g, ''));
      const cents = Number((m[3] ?? '0').padEnd(2, '0'));
      out[l.key] = (m[1] ? -1 : 1) * (whole * 100 + cents);
    }
  }
  return out;
}
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * FIBI's login button (#continueBtn, an <input type=button>) often ignores Puppeteer's click
 * (upstream has a sleep "HACK" for it; on 2026-11-08 the user still had to click by hand).
 * Replace the submit step with a ladder: click, DOM click, Enter in the password field, and
 * finally leave it to the person in front of a headful window.
 */
function patchBeinleumiSubmit(scraper: object, institutionId: string): void {
  const s = scraper as { getLoginOptions?: (c: unknown) => Record<string, unknown>; page?: Page };
  const orig = s.getLoginOptions?.bind(scraper);
  if (!orig) return;
  s.getLoginOptions = (creds: unknown) => {
    const opts = orig(creds);
    const selector = typeof opts.submitButtonSelector === 'string' ? opts.submitButtonSelector : '#continueBtn';
    const c = (creds ?? {}) as { username?: unknown; password?: unknown };
    return {
      ...opts,
      submitButtonSelector: async () => {
        const page = s.page;
        if (!page) return;
        // 2026-11-11/12: three failed logins showed both fields EMPTY at the moment of the click (the page re-rendered its
        // form after the library typed). Check before clicking; if a field is empty, wait for the page to settle and type
        // again, at most twice. Only "filled or not" is logged, never the values.
        const filled = async (): Promise<{ user: boolean; pass: boolean }> => ({
          user: ((await page.$eval('#username', (el) => String((el as unknown as { value?: string }).value ?? '').length).catch(() => 0)) as number) > 0,
          pass: ((await page.$eval('#password', (el) => String((el as unknown as { value?: string }).value ?? '').length).catch(() => 0)) as number) > 0,
        });
        for (let attempt = 1; attempt <= 2; attempt++) {
          const f = await filled();
          if (f.user && f.pass) break;
          log.info({ institution: institutionId, attempt, userFilled: f.user, passFilled: f.pass }, 'login: a field was empty before submit; typing again');
          await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15_000 }).catch(() => undefined);
          for (const [sel, value] of [['#username', c.username], ['#password', c.password]] as const) {
            if (typeof value !== 'string' || !value) continue;
            await page.$eval(sel, (el) => {
              (el as unknown as { value: string }).value = '';
            }).catch(() => undefined);
            await page.type(sel, value, { delay: 30 }).catch(() => undefined);
          }
          await wait(800);
        }
        const before = page.url();
        const moved = async (): Promise<boolean> => {
          await wait(2500);
          return page.url() !== before;
        };
        await page.click(selector).catch(() => undefined);
        if (await moved()) return;
        log.info({ institution: institutionId }, 'login: click ignored, trying DOM click');
        await page.$eval(selector, (el) => (el as unknown as { click: () => void }).click()).catch(() => undefined);
        if (await moved()) return;
        log.info({ institution: institutionId }, 'login: DOM click ignored, pressing Enter');
        await page.focus('#password').catch(() => undefined);
        await page.keyboard.press('Enter').catch(() => undefined);
        if (await moved()) return;
        log.warn({ institution: institutionId }, 'login: the button did not react; if the window is visible, click כניסה yourself');
      },
    };
  };
}

/**
 * FIBI: navigating to the transactions page right after login leaves the portal on its loading
 * spinner (seen three times on 2026-11-08; the one success was the run where a human was slower).
 * Give the portal a moment, and retry the whole fetch once if it still is not ready.
 */
function patchBeinleumiFetch(scraper: object, institutionId: string, explore: boolean): void {
  const s = scraper as { fetchData?: () => Promise<unknown>; page?: Page };
  const orig = s.fetchData?.bind(scraper);
  if (!orig) return;
  s.fetchData = async () => {
    const page = s.page;
    if (page) await page.waitForNetworkIdle({ idleTime: 1500, timeout: 30_000 }).catch(() => undefined);
    await wait(5000);
    if (page) {
      const text = (await page.evaluate("document.body ? document.body.innerText : ''").catch(() => '')) as string;
      const extras = parseBeinleumiSummary(text);
      if (Object.keys(extras).length) {
        beinleumiExtras.set(institutionId, extras);
        log.info({ institution: institutionId, found: Object.keys(extras) }, 'fibi: summary page balances read');
      }
    }
    if (page) await readBeinleumiHoldings(page, institutionId);
    if (explore && page) await exploreBeinleumi(page, institutionId);
    for (let attempt = 1; ; attempt++) {
      try {
        return await orig();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/acc_num|fibi_dates|main_balance|divTable|card-header/.test(msg) || attempt >= 3) throw e;
        // The scraper's page is still open here: record what the portal shows before we retry.
        if (page) await snapshotPage(page, `${institutionId}-fetch-fail-${attempt}`);
        log.warn({ institution: institutionId, attempt, url: page ? urlForLog(page.url()) : undefined, err: msg }, 'fetch: portal not ready; reloading and retrying');
        await page?.reload({ waitUntil: 'networkidle2', timeout: 60_000 }).catch(() => undefined);
        await wait(10_000 * attempt);
      }
    }
  };
}

const FIBI_ROUTES = {
  securities: '#/Online/OnCapitalMarket/OnMyportfolio/cpmDevelope',
  fx: '#/Online/OnForeignCurrency/OnCurrentAccountFC/AuthFCTransFCPortfolio',
} as const;
/** Positions read from FIBI's portfolio and foreign-currency pages, keyed by institution until runScrape stores them. */
const beinleumiHoldings = new Map<string, { securities: HoldingRow[]; fx: HoldingRow[] }>();

/** The visible text of every frame on the page, joined. */
async function frameTexts(page: Page): Promise<string> {
  const parts: string[] = [];
  for (const f of page.frames()) {
    const t = (await f.evaluate("document.body ? document.body.innerText : ''").catch(() => '')) as string;
    if (t.trim()) parts.push(t);
  }
  return parts.join('\n');
}

/**
 * After login, visit the two pages the library ignores (routes learned 2026-11-10) and read the positions:
 * securities with quantity, price, cost and value, and the foreign-currency balances with rate and value.
 * Back on the summary page afterwards so the library's own flow continues unchanged. Failures only log.
 */
async function readBeinleumiHoldings(page: Page, institutionId: string): Promise<void> {
  const landing = page.url();
  const out = { securities: [] as HoldingRow[], fx: [] as HoldingRow[] };
  try {
    for (const [key, route] of Object.entries(FIBI_ROUTES) as Array<[keyof typeof FIBI_ROUTES, string]>) {
      await page.goto(new URL(route, landing).toString(), { waitUntil: 'networkidle2', timeout: 45_000 });
      await wait(6000);
      const text = await frameTexts(page);
      const parsed = key === 'securities' ? parseFibiPortfolioText(text) : parseFibiFxText(text);
      out[key] = parsed.positions;
      log.info({ institution: institutionId, page: key, positions: parsed.positions.length, totalIls: parsed.totalIls }, 'fibi: holdings page read');
    }
    beinleumiHoldings.set(institutionId, out);
  } catch (e) {
    log.warn({ institution: institutionId, err: e instanceof Error ? e.message : String(e) }, 'fibi: holdings pages not read');
  } finally {
    await page.goto(landing, { waitUntil: 'networkidle2', timeout: 45_000 }).catch(() => undefined);
    await wait(2500);
  }
}

/**
 * Connector design aid (`finc spike beinleumi --explore`): record what the FIBI portal offers beyond the
 * checking account. Saves the landing page's visible text, every menu link (text + href), and the text of
 * the pages whose link text mentions foreign currency, securities, deposits or investments. Everything goes
 * to data/dumps (gitignored, 0600); nothing leaves the machine.
 */
async function exploreBeinleumi(page: Page, institutionId: string): Promise<void> {
  const out: { landingUrl: string; landingText: string; links: Array<{ text: string; href: string }>; controls: unknown[]; sections: unknown[]; pages: Array<{ title: string; url: string; text: string }> } = { landingUrl: page.url(), landingText: '', links: [], controls: [], sections: [], pages: [] };
  const grab = async () => {
    // string expressions: the worker's tsconfig has no DOM lib, and these run inside the page anyway.
    // Content pages live in iframes: read every frame and join, each under its own URL.
    const parts: string[] = [];
    for (const f of page.frames()) {
      const t = (await f.evaluate("document.body ? document.body.innerText : ''").catch(() => '')) as string;
      if (t.trim()) parts.push(`### frame ${f.url()}\n${t}`);
    }
    const text = parts.join('\n\n');
    const links = (await page
      .evaluate("Array.from(document.querySelectorAll('a')).map(a => ({ text: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80), href: a.getAttribute('href') || '' })).filter(l => l.text && l.href && !l.href.startsWith('javascript'))")
      .catch(() => [])) as Array<{ text: string; href: string }>;
    return { text, links };
  };
  try {
    const landing = await grab();
    out.landingText = landing.text.slice(0, 20_000);
    // Manual mode (FINC_EXPLORE_MANUAL=1): the owner navigates in the visible browser and presses Enter in the
    // terminal to record each page (text, URL and the markup of the main content), "done" ends it. Used when the
    // automatic clicks cannot find the portal's own navigation.
    if (process.env.FINC_EXPLORE_MANUAL === '1' && process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      const manualSections = out.sections as unknown[];
      const ask = (q: string) => new Promise<string>((resolve) => rl.question(q, resolve));
      let n = 0;
      process.stderr.write('\nManual explore: in the browser, open the page you want recorded (securities, foreign currency...),\nthen press Enter here. Type "done" + Enter when finished.\n');
      for (;;) {
        const answer = (await ask(`[page ${n + 1}] Enter = record this page, done = finish: `)).trim().toLowerCase();
        if (answer === 'done' || answer === 'q') break;
        n++;
        const g = await grab();
        let html = '';
        for (const f of page.frames()) {
          const h = (await f.evaluate("document.body ? document.body.innerHTML : ''").catch(() => '')) as string;
          if (h.trim()) html += `\n<!-- frame ${f.url()} -->\n${h}`;
        }
        out.pages.push({ title: `manual:${n}`, url: page.url(), text: g.text.slice(0, 60_000) });
        manualSections.push({ label: `manual:${n}`, url: page.url(), html: html.slice(0, 400_000) });
        process.stderr.write(`recorded page ${n}: ${urlForLog(page.url())} (${g.text.length} chars of text, ${html.length} chars of markup)\n`);
      }
      rl.close();
    }
    // v2 (2026-11-10): the portal navigates through controls that are not <a href>. Record every candidate control
    // (text, tag, role, attributes that smell like a route or a handler) and the markup of the sections we care about,
    // so the next version can click the right thing.
    out.controls = (await page
      .evaluate(
        "Array.from(document.querySelectorAll('a,button,[role=button],[role=link],[role=menuitem],[role=tab],[ng-click],[ui-sref],[routerlink],[data-route],[tabindex]')).slice(0,400).map(e => { const a = {}; for (const n of e.getAttributeNames()) if (/^(href|role|class|id|ng-click|ui-sref|routerlink|data-.*|aria-label|title|type|name)$/i.test(n)) a[n] = (e.getAttribute(n) || '').slice(0, 120); return { tag: e.tagName.toLowerCase(), text: (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80), attrs: a }; }).filter(c => c.text || c.attrs.href || c.attrs['aria-label'])",
      )
      .catch(() => [])) as unknown[];
    const autoSections = (await page
      .evaluate(
        "(function(){ const labels=['ניירות ערך ופיקדונות','סה״כ השקעות','שערוך עו״ש מט״ח','שערוך ני\"ע סחיר']; const out=[]; for (const label of labels){ const el=[...document.querySelectorAll('*')].find(e=>e.children.length<=2 && (e.textContent||'').replace(/\s+/g,' ').trim()===label); if(!el) continue; let box=el; for (let i=0;i<6 && box.parentElement;i++){ box=box.parentElement; if ((box.innerText||'').length>200) break; } out.push({ label, html: box.outerHTML.slice(0, 6000) }); } return out; })()",
      )
      .catch(() => [])) as unknown[];
    out.sections.push(...autoSections);
    log.info({ institution: institutionId, controls: out.controls.length, sections: out.sections.length }, 'explore: controls and sections recorded');
    const seen = new Set<string>();
    for (const l of landing.links) if (!seen.has(l.href)) { seen.add(l.href); out.links.push(l); }
    const interesting = out.links.filter((l) => /מט["״]?ח|מטבע|ניירות|ני["״]?ע|תיק|השקע|פיקדו|פקדו|חסכ|foreign|securit|deposit|invest|portfolio/i.test(l.text)).slice(0, 8);
    log.info({ institution: institutionId, links: out.links.length, interesting: interesting.map((l) => l.text) }, 'explore: landing page recorded');
    // The portal is a single-page app with no plain links: click the menu items by their text instead.
    const clickTargets = ['מט"ח', 'מט״ח', 'עו"ש מט"ח', 'שערוך עו״ש מט״ח', 'ניירות ערך', 'ניירות ערך ופיקדונות', 'סה״כ השקעות'];
    for (const label of clickTargets) {
      try {
        const script =
          "(function(label){ const els=[...document.querySelectorAll('a,button,span,div,li,td,h2,h3')].filter(e=>e.children.length<=2 && (e.textContent||'').replace(/\\s+/g,' ').trim()===label); for (const e of els){ const t=e.closest('a,button,[role=button],li') || e; t.click(); return true; } return false; })(" +
          JSON.stringify(label) +
          ')';
        const clicked = (await page.evaluate(script)) as boolean;
        if (!clicked) continue;
        await page.waitForNetworkIdle({ idleTime: 1200, timeout: 20_000 }).catch(() => undefined);
        await wait(2500);
        const g = await grab();
        out.pages.push({ title: `click:${label}`, url: page.url(), text: g.text.slice(0, 20_000) });
        log.info({ institution: institutionId, clicked: label, url: urlForLog(page.url()), chars: g.text.length }, 'explore: clicked and recorded');
        await page.goto(out.landingUrl, { waitUntil: 'networkidle2', timeout: 45_000 }).catch(() => undefined);
        await wait(2000);
      } catch (e) {
        out.pages.push({ title: `click:${label}`, url: page.url(), text: `ERROR ${e instanceof Error ? e.message : String(e)}` });
      }
    }
    const KNOWN_ROUTES = [
      { text: 'שוק ההון: התיק שלי', href: '#/Online/OnCapitalMarket/OnMyportfolio/cpmDevelope' },
      { text: 'תיק מט"ח', href: '#/Online/OnForeignCurrency/OnCurrentAccountFC/AuthFCTransFCPortfolio' },
      // position view (research_notes/proposals/position-view.md): trades, nominal cost for capital gains, tax pages
      { text: 'תנועות בני"ע', href: '/wps/myportal/FibiMenu/Online/OnCapitalMarket/OnMyportfolio/OnlnNewSecuritiesTrans' },
      { text: 'עלות נומינלית לחישוב רווח הון', href: '/wps/myportal/FibiMenu/Online/OnCapitalMarket/OnTaxes/AuthTaxesTaxesCalculation' },
      { text: 'סימולציה לחישוב מס - תיק', href: '/wps/myportal/FibiMenu/Online/OnCapitalMarket/OnTaxes/TaxSimulation' },
      { text: 'פירוט אירועי מס', href: '/wps/myportal/FibiMenu/Online/OnCapitalMarket/OnTaxes/AuthTaxEventDetails2012' },
    ];
    const routes = (out.controls as Array<{ text: string; attrs: Record<string, string> }>)
      .map((c) => ({ text: c.text, href: c.attrs.href ?? c.attrs['ui-sref'] ?? c.attrs.routerlink ?? '' }))
      .filter((c) => /^#\//.test(c.href) && /מט|ניירות|ני"ע|תיק|השקע|פיקדו|securit|invest|portfolio|foreign|deposit|currency/i.test(`${c.text} ${c.href}`))
      .slice(0, 8);
    for (const r of [...KNOWN_ROUTES, ...routes]) {
      if (!sameOrigin(r.href, out.landingUrl)) continue; // never leave the bank's origin (P2-06)
      try {
        await page.goto(new URL(r.href, out.landingUrl).toString(), { waitUntil: 'networkidle2', timeout: 45_000 });
        await wait(8000); // the iframe loads its table after the shell settles
        const g = await grab();
        let html = '';
        for (const f of page.frames()) {
          const h = (await f.evaluate("document.body ? document.body.innerHTML : ''").catch(() => '')) as string;
          if (h.trim()) html += `\n<!-- frame ${f.url()} -->\n${h}`;
        }
        out.sections.push({ label: `route:${r.text || r.href}`, url: page.url(), html: html.slice(0, 400_000) });
        out.pages.push({ title: `route:${r.text || r.href}`, url: page.url(), text: g.text.slice(0, 60_000) });
        log.info({ institution: institutionId, route: r.href, chars: g.text.length }, 'explore: route recorded');
      } catch (e) {
        out.pages.push({ title: `route:${r.href}`, url: r.href, text: `ERROR ${e instanceof Error ? e.message : String(e)}` });
      }
    }
    for (const l of interesting) {
      try {
        const url = new URL(l.href, page.url()).toString();
        if (!sameOrigin(url, out.landingUrl)) continue; // never leave the bank's origin (P2-06)
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 45_000 });
        await wait(2500);
        const g = await grab();
        out.pages.push({ title: l.text, url: page.url(), text: g.text.slice(0, 20_000) });
        for (const x of g.links) if (!seen.has(x.href)) { seen.add(x.href); out.links.push(x); }
        log.info({ institution: institutionId, page: l.text, chars: g.text.length }, 'explore: page recorded');
      } catch (e) {
        out.pages.push({ title: l.text, url: l.href, text: `ERROR ${e instanceof Error ? e.message : String(e)}` });
      }
    }
    await page.goto(out.landingUrl, { waitUntil: 'networkidle2', timeout: 45_000 }).catch(() => undefined);
    await wait(2000);
  } finally {
    mkdirSync(dumpsDir(), { recursive: true });
    const file = path.join(dumpsDir(), `${institutionId}-explore-${stamp()}.json`);
    writeFileSync(file, JSON.stringify(out, null, 2), { mode: 0o600 });
    log.info({ file, pages: out.pages.length, links: out.links.length }, 'explore: saved');
  }
}

async function snapshotPage(page: Page, name: string): Promise<void> {
  try {
    const base = path.join(screenshotsDir(), `${name}-${stamp()}`);
    const shot = await page.screenshot().catch(() => undefined);
    if (shot) writePrivate(`${base}.png`, shot);
    const html = await page.content().catch(() => '');
    if (html) writePrivate(`${base}.html`, html);
    log.info({ url: urlForLog(page.url()), file: base }, 'saved page state');
  } catch {
    /* diagnostics only */
  }
}

const ISRACARD_BASE = 'https://digital.isracard.co.il';

/**
 * Isracard: the scraper logs in through the site's JSON API from inside the page. Isracard's WAF
 * answers 429 "Block Automation" when no human has touched the page (2026-11-08: hands-off run
 * blocked at the first call; the run where a human interacted got LOGIN_SUCCESS). So:
 *  1. after the login page loads, behave like a person for a few seconds (mouse, scroll), then
 *     let the scraper try its API login;
 *  2. if that is blocked and the window is visible, ask the person to log in themselves and wait
 *     for the logged-in area, then hand back to the scraper's normal data fetch.
 * Headless runs that get blocked fail with AUTOMATION_BLOCKED so health shows why.
 */
function patchIsracardLogin(scraper: object, institutionId: string, headful: boolean): void {
  const s = scraper as {
    page?: Page;
    navigateTo?: (url: string, ...rest: unknown[]) => Promise<void>;
    login?: (c: unknown) => Promise<{ success: boolean; errorType?: string; errorMessage?: string }>;
  };
  const origNav = s.navigateTo?.bind(scraper);
  const origLogin = s.login?.bind(scraper);
  if (!origNav || !origLogin) return;

  s.navigateTo = async (url: string, ...rest: unknown[]) => {
    await origNav(url, ...rest);
    if (/personalarea\/login/i.test(url) && s.page) await actHuman(s.page);
  };

  s.login = async (creds: unknown) => {
    try {
      return await origLogin(creds);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/automation|block/i.test(msg)) throw e;
      const page = s.page;
      if (!headful || !page) {
        return { success: false, errorType: 'AUTOMATION_BLOCKED', errorMessage: 'Isracard blocked the automated login; run `finc spike isracard` and log in yourself in the window' };
      }
      log.warn({ institution: institutionId }, 'Isracard blocked the automated login. LOG IN YOURSELF in the browser window (password login); I will continue once you are in. Up to 5 minutes.');
      const deadline = Date.now() + 300_000;
      while (Date.now() < deadline) {
        await wait(1500);
        const url = page.url();
        if (isIsracardSignedIn(url)) break;
      }
      if (!isIsracardSignedIn(page.url())) return { success: false, errorType: 'TIMEOUT', errorMessage: 'no manual login within 5 minutes' };
      log.info({ institution: institutionId }, 'manual login detected; fetching data');
      await wait(3000);
      // Back to the services origin so the scraper's in-page fetches are same-origin.
      await page.goto(`${ISRACARD_BASE}/personalarea/cardlist/?WebPage=true`, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
      await wait(2000);
      return { success: true };
    }
  };
}

/** A few seconds of human-looking activity: mouse wander, a scroll, a pause. */
async function actHuman(page: Page): Promise<void> {
  try {
    const vp = page.viewport() ?? { width: 1200, height: 800 };
    const rnd = (n: number): number => Math.floor(Math.random() * n);
    for (let i = 0; i < 6; i++) {
      await page.mouse.move(100 + rnd(vp.width - 200), 100 + rnd(vp.height - 200), { steps: 10 + rnd(15) });
      await wait(300 + rnd(700));
    }
    await page.mouse.wheel({ deltaY: 200 + rnd(300) });
    await wait(800 + rnd(1200));
    await page.mouse.wheel({ deltaY: -(100 + rnd(200)) });
    await wait(1500 + rnd(2000));
  } catch {
    /* cosmetic */
  }
}

/** Debug mode: save URL, HTML and a screenshot of every open page before the browser closes (local only). */
async function captureDebugState(browser: Browser, institutionId: string): Promise<void> {
  try {
    const pages = await browser.pages();
    let i = 0;
    for (const page of pages) {
      const base = path.join(screenshotsDir(), `${institutionId}-${stamp()}-debug-${i++}`);
      const url = page.url();
      log.info({ institution: institutionId, url: urlForLog(url), file: base }, 'debug: capturing page state');
      const shot = await page.screenshot({ fullPage: true }).catch(() => undefined);
      if (shot) writePrivate(`${base}.png`, shot);
      const html = await page.content().catch(() => '');
      if (html) writePrivate(`${base}.html`, html);
    }
  } catch (e) {
    log.warn({ err: e instanceof Error ? e.message : String(e) }, 'debug: capture failed');
  }
}
