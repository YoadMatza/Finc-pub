import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  INSTITUTIONS,
  type IngestStats,
  MAPPINGS,
  RiseupClient,
  type ScraperAccount,
  Vault,
  ensureAccount,
  finishRunOk,
  fromScraperAccount,
  importFile,
  importRiseup,
  ingestBatch,
  mappingScore,
  maskNumber,
  openDb,
  readGrid,
  recordBalance,
  scraperSource,
  startRun,
  toMinor,
  vaultPath,
} from '@finc/core';
import type { Command } from 'commander';
import { log } from '../logger.js';
import { openVaultInteractive } from './vault.js';

/** Token from the vault entry "riseup" and nowhere else (environment variables are never used). Never printed. */
async function riseupToken(): Promise<{ token: string; from: 'vault' }> {
  if (!Vault.exists(vaultPath())) throw new Error('no vault yet: run `finc vault init`, then `finc vault set riseup`');
  const v = await openVaultInteractive();
  try {
    const e = v.get('riseup');
    if (e?.fields.token) return { token: e.fields.token, from: 'vault' };
  } finally {
    v.lock();
  }
  throw new Error('no RiseUp token in the vault: run `finc vault set riseup`');
}

export function registerImportCommands(program: Command): void {
  const imp = program.command('import').description('Importers: RiseUp history, Excel/CSV statements');

  imp
    .command('riseup')
    .description('Backfill full history from the RiseUp read-only API (categories, exclusions, comments)')
    .option('--to <YYYY-MM>', 'newest cashflow month (default: current)')
    .option('--from <YYYY-MM>', 'oldest cashflow month (default: walk back until RiseUp has no earlier record)')
    .option('--max-months <n>', 'safety cap on months walked', '120')
    .option('--no-balances', 'skip current + 90-day balance snapshots')
    .action(async (opts: { to?: string; from?: string; maxMonths: string; balances: boolean }) => {
      const { token, from } = await riseupToken();
      log.info({ tokenFrom: from }, 'riseup import: starting');
      const client = new RiseupClient(token);
      const db = openDb();
      try {
        const r = await importRiseup(db, client, {
          ...(opts.to ? { to: opts.to } : {}),
          ...(opts.from ? { from: opts.from } : {}),
          maxMonths: Number(opts.maxMonths),
          balances: opts.balances,
          onMonth: (m, n, s) => console.log(`  ${m}  ${String(n).padStart(4)} txns  new=${s.new} annotated=${s.annotated} updated=${s.updated}`),
        });
        console.log('');
        console.log(`months: ${r.months.length} (${r.months[r.months.length - 1] ?? '-'} → ${r.months[0] ?? '-'})  stopped: ${r.stoppedBecause}  api calls: ${r.apiCalls}`);
        console.log(`rows: seen=${r.stats.seen} new=${r.stats.new} annotated=${r.stats.annotated} updated=${r.stats.updated}   balance snapshots: ${r.balances}`);
        for (const a of r.accounts) console.log(`  account ${a.externalId} → #${a.accountId} (${a.institutionId})${a.created ? ' new' : ''}  txns=${a.txns}`);
        if (r.error) {
          console.error(`error: ${r.error}`);
          process.exitCode = 1;
        }
      } finally {
        db.$client.close();
      }
    });

  imp
    .command('file <path>')
    .description('Import an Excel/CSV statement export (fallback when a scraper is down)')
    .option('-i, --institution <id>', `force a mapping: ${Object.keys(MAPPINGS).join('|')} (default: auto-detect)`)
    .option('-a, --account <label>', 'account label when the file has no card/account column (e.g. 6150)')
    .option('--dry-run', 'parse and show a summary; write nothing', false)
    .action(async (file: string, opts: { institution?: string; account?: string; dryRun: boolean }) => {
      const db = opts.dryRun ? null : openDb();
      try {
        const r = await importFile(db ?? openDb(':memory:'), path.resolve(file), {
          ...(opts.institution ? { institutionId: opts.institution } : {}),
          ...(opts.account ? { accountLabel: opts.account } : {}),
          dryRun: opts.dryRun,
        });
        if ('rows' in r) {
          console.log(`mapping: ${r.mapping.id}${r.mapping.verified ? '' : ' (UNVERIFIED mapping)'}  header row: ${r.headerRow + 1}  account: ${r.accountLabel}`);
          console.log(`rows: ${r.rows.length}  skipped: ${r.skipped.length}${r.lastBalance ? `  balance: ${r.lastBalance.balanceMinor / 100} @ ${r.lastBalance.date}` : ''}`);
          const dates = r.rows.map((x) => x.date).sort();
          console.log(`dates: ${dates[0]} → ${dates[dates.length - 1]}   sum: ${(r.rows.reduce((s, x) => s + x.amount, 0) / 100).toFixed(2)}`);
          for (const s of r.skipped.slice(0, 5)) console.log(`  skipped row ${s.row}: ${s.reason}`);
          return;
        }
        console.log(`imported ${path.basename(r.file)} with mapping ${r.mapping} into account #${r.accountId} (${r.accountLabel})`);
        console.log(`parsed=${r.parsed} skipped=${r.skipped} new=${r.stats.new} updated=${r.stats.updated} annotated=${r.stats.annotated}${r.balanceRecorded ? '  balance snapshot recorded' : ''}`);
      } finally {
        db?.$client.close();
      }
    });

  imp
    .command('dump <path>')
    .description('Ingest a raw scraper dump from data/dumps (what `finc spike` saved) without scraping again')
    .requiredOption('-i, --institution <id>', 'beinleumi|isracard|max')
    .action(async (file: string, opts: { institution: string }) => {
      const spec = INSTITUTIONS[opts.institution as keyof typeof INSTITUTIONS];
      if (!spec?.scraperId) throw new Error(`unknown scraped institution "${opts.institution}"`);
      const dump = JSON.parse(readFileSync(path.resolve(file), 'utf8')) as { success: boolean; errorType?: string; errorMessage?: string; accounts?: ScraperAccount[] };
      if (!dump.success) throw new Error(`dump is a failed run: ${dump.errorType} ${dump.errorMessage ?? ''}`);
      const source = scraperSource(spec.scraperId);
      const db = openDb();
      try {
        const runId = startRun(db, { institutionId: spec.id, source, trigger: 'import' });
        const total: IngestStats = { seen: 0, new: 0, updated: 0, completed: 0, voided: 0, annotated: 0 };
        for (const acc of dump.accounts ?? []) {
          const { accountId, created } = ensureAccount(db, {
            institutionId: spec.id,
            institutionKind: spec.kind,
            institutionDisplayName: spec.displayName,
            scraperId: spec.scraperId,
            source,
            externalId: acc.accountNumber,
            type: spec.kind === 'bank' ? 'checking' : 'credit_card',
            last4: acc.accountNumber.slice(-4),
            displayName: `${spec.displayName} ${maskNumber(acc.accountNumber)}`,
          });
          const rows = fromScraperAccount(acc);
          const stats = ingestBatch(db, { source, runId, accountId, rows, batchIsComplete: true });
          for (const k of Object.keys(stats) as Array<keyof IngestStats>) total[k] += stats[k];
          const bal = toMinor(acc.balance);
          if (bal !== undefined) recordBalance(db, { accountId, runId, balanceMinor: bal, source, ...(acc.balanceDate ? { takenAt: new Date(acc.balanceDate).toISOString() } : {}) });
          console.log(`account ${maskNumber(acc.accountNumber)} → #${accountId}${created ? ' (new)' : ''}: ${rows.length} rows, new=${stats.new} updated=${stats.updated} completed=${stats.completed} voided=${stats.voided}`);
        }
        finishRunOk(db, runId, total, { dump: path.basename(file) });
        console.log(`run #${runId} ok: seen=${total.seen} new=${total.new} updated=${total.updated}`);
      } finally {
        db.$client.close();
      }
    });

  imp
    .command('headers <path>')
    .description('Show the first rows of a statement file and how well each mapping fits (to fix a column mapping)')
    .action(async (file: string) => {
      const { grid, sheet } = await readGrid(path.resolve(file));
      if (sheet) console.log(`sheet: ${sheet}`);
      for (let i = 0; i < Math.min(grid.length, 8); i++) console.log(`row ${i + 1}: ${grid[i]!.map((c) => (c instanceof Date ? c.toISOString().slice(0, 10) : String(c ?? ''))).join(' | ')}`);
      console.log('');
      for (const m of Object.values(MAPPINGS)) {
        let best = 0;
        let row = -1;
        for (let i = 0; i < Math.min(grid.length, 30); i++) {
          const s = mappingScore(m, grid[i]!);
          if (s > best) {
            best = s;
            row = i;
          }
        }
        console.log(`${m.id.padEnd(10)} score ${best}${row >= 0 ? ` at row ${row + 1}` : ' (no header row matches)'}`);
      }
    });
}
