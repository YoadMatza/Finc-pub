import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { SCRAPED_INSTITUTIONS, dataDir, dumpsDir, openDb } from '@finc/core';
import type { Command } from 'commander';
import { consoleOtp } from '../connectors/otp.js';
import { type ScrapeRunResult, type ScrapedInstitutionId, runScrape } from '../connectors/scrape.js';
import { dumpReport } from '../report/dump-report.js';
import { openVaultInteractive } from './vault.js';
import { workerPost, workerUp } from './worker-client.js';

const IDS = SCRAPED_INSTITUTIONS.map((i) => i.id) as ScrapedInstitutionId[];

function parseTargets(arg: string): ScrapedInstitutionId[] {
  if (arg === 'all') return IDS;
  const ids = arg.split(',').map((s) => s.trim()) as ScrapedInstitutionId[];
  for (const id of ids) if (!IDS.includes(id)) throw new Error(`unknown institution "${id}" (use ${IDS.join('|')}|all)`);
  return ids;
}

export function printResult(r: ScrapeRunResult): void {
  const head = `${r.institutionId.padEnd(10)} ${r.success ? 'OK   ' : 'FAIL '} ${(r.durationMs / 1000).toFixed(1)}s`;
  if (!r.success) {
    console.log(`${head}  ${r.errorType}: ${r.errorMessage ?? ''}`);
    return;
  }
  console.log(`${head}  accounts=${r.accounts.length}  seen=${r.stats.seen} new=${r.stats.new} updated=${r.stats.updated} completed=${r.stats.completed} voided=${r.stats.voided}`);
  for (const a of r.accounts) {
    console.log(`  ${a.accountMasked.padEnd(10)} txns=${a.txns} pending=${a.pending} balance=${a.balance === undefined ? 'n/a' : a.balance}${a.created ? '  (new account)' : ''}`);
  }
  if (r.dumpFile) console.log(`  dump: ${hostPath(r.dumpFile)}`);
}

/**
 * A file the container wrote, as a path on the PC: inside the container (the launcher sets FINC_HOST_DATA_DIR) a file
 * under dataDir() is printed under the host's data folder; anything else is printed as it is.
 */
export function hostPath(file: string, containerDataDir: string = dataDir(), hostDataDir: string | undefined = process.env.FINC_HOST_DATA_DIR): string {
  const host = hostDataDir?.trim();
  if (!host) return file;
  const base = containerDataDir.replace(/[\\/]+$/, '');
  if (file !== base && !file.startsWith(`${base}/`) && !file.startsWith(`${base}\\`)) return file;
  const rest = file.slice(base.length).replace(/^[\\/]+/, '');
  return rest ? `${host.replace(/[\\/]+$/, '')}\\${rest.replace(/\//g, '\\')}` : host;
}

export type SyncRoute = { route: 'delegate' } | { route: 'refuse'; message: string } | { route: 'local' };

/**
 * Where `finc sync` runs (P1-13). A running worker owns the database and the browser profiles, so everything goes
 * through it (--dump and --dry-run included); a visible browser cannot open from inside the worker, so --show-browser
 * is refused while it runs. Without a worker the CLI scrapes locally, as before.
 */
export function syncRoute(opts: { showBrowser: boolean }, workerRunning: boolean): SyncRoute {
  if (!workerRunning) return { route: 'local' };
  if (opts.showBrowser) {
    return {
      route: 'refuse',
      message:
        '--show-browser cannot run while the worker is running: it owns the database and the browser profile. Stop it (docker compose stop worker), then run this on the PC with FINC_HOST=1 so a window can open; start the worker again afterwards (docker compose start worker).',
    };
  }
  return { route: 'delegate' };
}

export function registerSyncCommands(program: Command): void {
  program
    .command('sync <institutions>')
    .description(`Scrape and ingest: ${IDS.join('|')} or all (comma-separated allowed)`)
    .option('-m, --months <n>', 'months back to request', '12')
    .option('--show-browser', 'run Chromium headful (debugging, OTP, WAF challenges)', false)
    .option('--dump', 'write the raw scraper result to data/dumps (local only)', false)
    .option('--dry-run', 'scrape only; do not touch the database', false)
    .action(async (arg: string, opts: { months: string; showBrowser: boolean; dump: boolean; dryRun: boolean }) => {
      const targets = parseTargets(arg);
      // A running worker owns the database, the browser profiles and the unlocked vault: delegate to it (P1-13).
      // Any answer counts (a 401 or a slow /health included): never fall back to a local Chromium next to a live worker.
      const route = syncRoute(opts, await workerUp());
      if (route.route === 'refuse') throw new Error(route.message);
      if (route.route === 'delegate') {
        console.log(`worker is running; ${opts.dryRun ? 'dry run' : 'syncing'} through it${opts.dump ? ' (dump in the worker\'s data/dumps)' : ''}`);
        const r = await workerPost<ScrapeRunResult[] | { error?: string }>('/sync', { institutions: targets, months: Number(opts.months), dump: opts.dump, dryRun: opts.dryRun });
        if (r.status !== 200 || !Array.isArray(r.body)) throw new Error((r.body as { error?: string }).error ?? `sync failed (${r.status})`);
        for (const x of r.body) printResult(x);
        return;
      }
      const vault = await openVaultInteractive();
      const db = opts.dryRun ? null : openDb();
      try {
        for (const institutionId of targets) {
          const r = await runScrape(db, {
            institutionId,
            vault,
            monthsBack: Number(opts.months),
            showBrowser: opts.showBrowser,
            dump: opts.dump,
            trigger: 'manual',
            otp: consoleOtp,
            dryRun: opts.dryRun,
          });
          printResult(r);
        }
      } finally {
        vault.lock();
        db?.$client.close();
      }
    });

  program
    .command('spike <institutions>')
    .description('Connector spike: headful scrape with a raw dump, no DB writes, then an anonymized data-shape report')
    .option('-m, --months <n>', 'months back to request', '12')
    .option('--headless', 'do not show the browser', false)
    .option('--debug', 'verbose scraper logs, no failure screenshot, 5 min timeouts', false)
    .option('--explore', 'FIBI: also record the portal landing page, menu and foreign-currency / securities pages to data/dumps', false)
    .action(async (arg: string, opts: { months: string; headless: boolean; debug: boolean; explore: boolean }) => {
      const targets = parseTargets(arg);
      const vault = await openVaultInteractive();
      try {
        for (const institutionId of targets) {
          const r = await runScrape(null, {
            institutionId,
            vault,
            monthsBack: Number(opts.months),
            showBrowser: !opts.headless,
            dump: true,
            trigger: 'manual',
            otp: consoleOtp,
            dryRun: true,
            debug: opts.debug,
            explore: opts.explore,
            ...(opts.debug ? { timeoutMs: 300_000 } : {}),
          });
          printResult(r);
          if (r.dumpFile) {
            console.log('');
            console.log(dumpReport(r.dumpFile));
          }
        }
      } finally {
        vault.lock();
      }
    });

  const report = program.command('report').description('Read-only reports');
  report
    .command('dump [file]')
    .description('Masked data-shape report over a raw scraper dump (default: newest in data/dumps)')
    .action((file?: string) => {
      const target = file ?? newestDump();
      if (!target) throw new Error('no dump files yet; run finc spike <institution>');
      console.log(dumpReport(target));
    });
}

function newestDump(): string | undefined {
  const dir = dumpsDir();
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return files[0];
}
