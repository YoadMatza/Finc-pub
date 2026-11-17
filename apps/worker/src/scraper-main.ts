/**
 * The scraper container's entry point (research_notes/proposals/scraper-container.md, step 2): Chromium and
 * israeli-bank-scrapers behind a Unix socket, one job at a time. No database, no vault, no network port; it sees only
 * the browser profiles and the failure screenshots folder.
 *
 * At start it checks Chromium's own sandbox once (chrome://sandbox, step 4) and logs what it found, so a profile that
 * stopped working shows in the log instead of silently running without the sandbox.
 */
import puppeteer from 'puppeteer';
import { localScraper } from './connectors/scrape.js';
import { SCRAPER_SOCKET_DEFAULT, serveScraper } from './connectors/scraper-socket.js';
import { log } from './logger.js';

const socketPath = process.env.FINC_SCRAPER_SOCKET || SCRAPER_SOCKET_DEFAULT;
const wantSandbox = process.env.FINC_CHROMIUM_SANDBOX === '1';

/** What chrome://sandbox says: the namespace and seccomp-BPF layers, or why Chromium would not start. */
async function sandboxStatus(): Promise<{ started: boolean; namespace?: boolean; seccomp?: boolean; adequate?: boolean; error?: string }> {
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  try {
    const b = await puppeteer.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: ['--disable-dev-shm-usage', ...(wantSandbox ? [] : ['--no-sandbox'])] });
    try {
      const page = await b.newPage();
      await page.goto('chrome://sandbox', { timeout: 15_000 });
      const text = await page.evaluate(() => (globalThis as unknown as { document: { body: { innerText: string } } }).document.body.innerText);
      const row = (label: string) => new RegExp(`${label}\\s*(Yes|No)`, 'i').exec(text)?.[1]?.toLowerCase() === 'yes';
      // the page lists "Layer 1 Sandbox  Namespace" then "PID namespaces Yes", "Network namespaces Yes", "Seccomp-BPF sandbox Yes"
      const namespace = /Layer 1 Sandbox\s*Namespace/i.test(text) && row('PID namespaces') && row('Network namespaces');
      return { started: true, namespace, seccomp: row('Seccomp-BPF sandbox'), adequate: /adequately sandboxed/i.test(text) && !/not adequately/i.test(text) };
    } finally {
      await b.close().catch(() => undefined);
    }
  } catch (e) {
    return { started: false, error: (e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 200) };
  }
}

const sandbox = await sandboxStatus();
if (wantSandbox && !(sandbox.started && sandbox.adequate)) log.error({ sandbox }, 'scraper: Chromium sandbox wanted but not working; set FINC_CHROMIUM_SANDBOX=0 to run with --no-sandbox');
else log.info({ sandbox, wanted: wantSandbox }, 'scraper: Chromium sandbox status');

const server = await serveScraper(localScraper(), socketPath);
log.info({ socket: socketPath }, 'scraper: ready');
const stop = () => {
  void server.close().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
