import { type ConnectionHealth, FINC_VERSION, PINNED, Vault, connectionHealth, dataDir, openDb, recentRuns, reconcileAll, setEnabled, vaultPath } from '@finc/core';
import type { Command } from 'commander';
import { askMasterPassword } from './vault.js';
import { workerHealth, workerPost } from './worker-client.js';

const money = (minor: number): string => (minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = (iso: string | null | undefined): string => (iso ? iso.replace('T', ' ').slice(0, 16) : '-');

export function printConnections(conns: ConnectionHealth[]): void {
  for (const c of conns) {
    const state = !c.lastRun ? 'not configured' : c.consecutiveFailures > 0 ? `FAILING x${c.consecutiveFailures}` : 'ok';
    console.log(`${c.institutionId.padEnd(11)} ${state.padEnd(14)} last ok ${when(c.lastOkAt).padEnd(16)} next ${when(c.nextRunAt).padEnd(16)}${c.lastError ? `  last error: ${c.lastError.slice(0, 80)}` : ''}`);
    for (const a of c.accounts) {
      const bal = a.latestBalance ? `balance ${money(a.latestBalance.balance)} @ ${when(a.latestBalance.takenAt)}` : 'no balance';
      console.log(`    #${a.id} ${(a.displayName ?? a.type).padEnd(28)} txns ${String(a.txns).padStart(5)}  pending ${String(a.pending).padStart(3)}  ${a.oldestTxnDate ?? '-'} → ${a.newestTxnDate ?? '-'}  ${bal}`);
    }
  }
}

export function registerHealthCommands(program: Command): void {
  program
    .command('health')
    .description('Connection health: last success, last error, next run, accounts, balances')
    .option('--json', 'machine-readable output', false)
    .action(async (opts: { json: boolean }) => {
      const live = (await workerHealth()) as { vault: string; nextRunAt: string | null; syncRunning: boolean; uptimeSec: number; connections: ConnectionHealth[] } | null;
      if (opts.json) {
        if (live) return console.log(JSON.stringify(live, null, 2));
        const db = openDb();
        try {
          return console.log(JSON.stringify({ worker: 'not running', connections: connectionHealth(db) }, null, 2));
        } finally {
          db.$client.close();
        }
      }
      console.log(`finc ${FINC_VERSION}  node ${process.version}  scrapers ${PINNED.israeliBankScrapers}  data ${dataDir()}`);
      if (live) {
        console.log(`worker:   running (up ${Math.round(live.uptimeSec / 60)} min)  vault ${live.vault}  ${live.syncRunning ? 'SYNC RUNNING' : `next run ${when(live.nextRunAt)}`}`);
        printConnections(live.connections);
        return;
      }
      console.log(`worker:   not running (start with: pnpm worker, or docker compose up -d)  vault ${Vault.exists(vaultPath()) ? 'present' : 'not created'}`);
      const db = openDb();
      try {
        printConnections(connectionHealth(db));
      } finally {
        db.$client.close();
      }
    });

  program
    .command('runs')
    .description('Recent sync runs')
    .option('-n, --limit <n>', 'how many', '20')
    .action((opts: { limit: string }) => {
      const db = openDb();
      try {
        for (const r of recentRuns(db, Number(opts.limit))) {
          const dur = r.endedAt ? `${Math.round((new Date(r.endedAt).getTime() - new Date(r.startedAt).getTime()) / 1000)}s` : '…';
          console.log(`#${String(r.id).padStart(4)} ${when(r.startedAt)} ${r.institutionId.padEnd(10)} ${r.trigger.padEnd(9)} ${r.status.padEnd(12)} ${dur.padStart(5)}  seen=${r.rowsSeen} new=${r.rowsNew} upd=${r.rowsUpdated} done=${r.rowsCompleted} void=${r.rowsVoided} ann=${r.rowsAnnotated}${r.errorType ? `  ${r.errorType}: ${(r.error ?? '').slice(0, 60)}` : ''}`);
        }
      } finally {
        db.$client.close();
      }
    });

  program
    .command('unlock')
    .description('Unlock the vault inside the running worker (password stays in worker memory only)')
    .action(async () => {
      if (!(await workerHealth())) throw new Error('worker is not running (pnpm worker, or docker compose up -d)');
      const password = await askMasterPassword('Master password (sent to the local worker on 127.0.0.1)');
      const r = await workerPost<{ unlocked?: boolean; entries?: string[]; error?: string }>('/unlock', { password }, 60_000);
      if (r.status !== 200) throw new Error(r.body.error ?? `unlock failed (${r.status})`);
      console.log(`unlocked; credentials available for: ${r.body.entries?.join(', ') || '(none yet)'}`);
    });

  program
    .command('lock')
    .description('Lock the vault inside the running worker')
    .action(async () => {
      const r = await workerPost('/lock', {});
      console.log(r.status === 200 ? 'locked' : `failed (${r.status})`);
    });

  program
    .command('enable <institution>')
    .description('Include an institution in scheduled syncs')
    .action((id: string) => toggle(id, true));
  program
    .command('disable <institution>')
    .description('Exclude an institution from scheduled syncs')
    .action((id: string) => toggle(id, false));

  program
    .command('reconcile')
    .description('Check: bank balance change equals the sum of completed transactions between the first and last snapshot')
    .option('--source <source>', 'only use snapshots from this source, e.g. scraper:beinleumi')
    .option('--tolerance <ils>', 'allowed difference in ILS', '0')
    .action((opts: { source?: string; tolerance: string }) => {
      const db = openDb();
      try {
        const results = reconcileAll(db, { ...(opts.source ? { source: opts.source } : {}), toleranceMinor: Math.round(Number(opts.tolerance) * 100) });
        if (!results.length) {
          console.log('nothing to reconcile yet: a bank account needs two balance snapshots on different days');
          return;
        }
        let allOk = true;
        for (const r of results) {
          allOk &&= r.ok;
          console.log(`account #${r.accountId} ${r.displayName ?? ''}: ${r.ok ? 'OK' : 'MISMATCH'} (${r.explanation})`);
          console.log(`  balance ${money(r.from.balance)} (${r.from.date}, ${r.from.source}) → ${money(r.to.balance)} (${r.to.date}, ${r.to.source})   delta ${money(r.balanceDelta)}`);
          console.log(`  ${r.txnCount} completed transactions in window sum to ${money(r.txnSum)}   pending ignored: ${r.pendingInWindow}   diff ${money(r.diff)}`);
          if (!r.ok && r.boundary.length) {
            console.log('  boundary-day rows (usual cause of a diff):');
            for (const b of r.boundary) console.log(`    ${b.date} ${money(b.amount).padStart(12)} ${b.status.padEnd(9)} ${b.description}`);
          }
        }
        if (!allOk) process.exitCode = 2;
      } finally {
        db.$client.close();
      }
    });
}

function toggle(id: string, enabled: boolean): void {
  const db = openDb();
  try {
    setEnabled(db, id, enabled);
    console.log(`${id}: ${enabled ? 'enabled' : 'disabled'}`);
  } finally {
    db.$client.close();
  }
}
