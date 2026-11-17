#!/usr/bin/env node
import os from 'node:os';
import { Command } from 'commander';
import { type DbOwner, FINC_VERSION, ownerAge, readOwner, scrubSecretEnv } from '@finc/core';

// Secrets come from the vault only: drop every API key / token / password this process inherited
// from the machine's environment before any command or library can see it.
scrubSecretEnv();
// New files (debug dumps, failure screenshots the scraper library writes) are owner-only, as in the worker (P2-06, P2-10).
process.umask(0o077);
import { registerAiCommands } from './cli/ai.js';
import { registerAlertCommands } from './cli/alerts.js';
import { registerBackupCommands } from './cli/backup.js';
import { registerCategoryCommands } from './cli/cat.js';
import { registerChatEvalCommands } from './cli/chat-eval.js';
import { registerDbCommands } from './cli/db.js';
import { registerEngineCommands } from './cli/engine.js';
import { registerEventsCommands } from './cli/events.js';
import { guardHostRun } from './cli/guard.js';
import { workerUp } from './cli/worker-client.js';
import { registerHealthCommands } from './cli/health.js';
import { registerImportCommands } from './cli/import.js';
import { registerMcpCommands } from './cli/mcp.js';
import { registerMonthCommands } from './cli/month.js';
import { registerPanicCommands } from './cli/panic.js';
import { registerRecurringCommands } from './cli/recurring.js';
import { registerSyncCommands } from './cli/sync.js';
import { registerUiCommands } from './cli/ui.js';
import { registerVaultCommands } from './cli/vault.js';

const program = new Command();
program.name('finc').description('finc: personal finance hub').version(FINC_VERSION);

// One writer per database, one Chromium per profile (P1-13): a host run never starts while another host's worker owns
// data/. No owner file means no worker: no HTTP call, carry on. Host runs that only talk HTTP to the worker
// (FINC_HOST=1 health, unlock, backup nas status) are refused too while it runs; the launcher (.\finc) sends those
// into the container anyway, where the hostname matches and they pass.
program.hook('preAction', async () => {
  let owner: DbOwner | null;
  try {
    owner = readOwner();
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  const verdict = await guardHostRun(owner, os.hostname(), owner ? ownerAge(owner) : 0, () => workerUp());
  if (!verdict.allow) {
    console.error(`error: ${verdict.message}`);
    process.exit(1);
  }
});

program
  .command('worker')
  .description('Run the long-lived worker: scheduler + control port (same as `pnpm worker`)')
  .action(async () => {
    await import('./main.js');
    await new Promise(() => undefined); // main.js owns the process until SIGINT/SIGTERM
  });

registerHealthCommands(program);
registerVaultCommands(program);
registerUiCommands(program);
registerSyncCommands(program);
registerImportCommands(program);
registerDbCommands(program);
registerEngineCommands(program);
registerMonthCommands(program);
registerCategoryCommands(program);
registerRecurringCommands(program);
registerAiCommands(program);
registerChatEvalCommands(program);
registerBackupCommands(program);
registerAlertCommands(program);
registerPanicCommands(program);
registerEventsCommands(program);
registerMcpCommands(program);

try {
  await program.parseAsync(process.argv);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  // Ctrl-C inside an inquirer prompt surfaces as ExitPromptError; exit quietly.
  if (e instanceof Error && e.name === 'ExitPromptError') process.exit(130);
  console.error(`error: ${msg}`);
  process.exit(1);
}
