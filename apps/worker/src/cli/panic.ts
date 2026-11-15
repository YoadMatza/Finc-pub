/**
 * `finc panic` (security research P1-09): lock everything in the running worker. Every paired device and passkey is revoked,
 * every browser and passkey session ends, the vault is locked, and a security alert goes out. Talks to the worker's
 * /api/panic with data/control.token, like `finc lock`. Asks to type LOCK first, unless --yes.
 */
import { input } from '@inquirer/prompts';
import type { Command } from 'commander';
import type { PanicResult } from '../lockdown.js';
import { workerHealth, workerPost } from './worker-client.js';

export function formatPanicResult(r: Partial<PanicResult>): string[] {
  const lines = [
    `${r.ok ? 'locked down' : 'locked down WITH ERRORS'}: ${r.devices ?? 0} device(s) revoked, ${r.passkeys ?? 0} passkey(s) revoked, ${r.sessions ?? 0} session(s) ended, vault ${r.vaultLocked ? 'locked' : 'NOT locked'}`,
    r.alerted ? 'the security alert went out on Telegram' : 'the security alert did NOT reach Telegram (see the worker log)',
  ];
  for (const e of r.errors ?? []) lines.push(`error: ${e}`);
  lines.push('to recover: pair the phone again and re-enrol passkeys (Settings at home), then run finc unlock');
  return lines;
}

export function registerPanicCommands(program: Command): void {
  program
    .command('panic')
    .description('Lock everything: revoke every paired device and passkey, end every session, lock the vault, send a security alert')
    .option('--yes', 'do not ask to type LOCK', false)
    .action(async (opts: { yes: boolean }) => {
      if (!(await workerHealth())) throw new Error('worker is not running (docker compose up -d); with no worker nothing is unlocked or reachable');
      if (!opts.yes) {
        if (!process.stdin.isTTY) throw new Error('type LOCK at the prompt, or pass --yes');
        const typed = await input({ message: 'This revokes every paired device and passkey, ends every session and locks the vault. Type LOCK to confirm' });
        if (typed.trim() !== 'LOCK') {
          console.log('cancelled; nothing changed');
          return;
        }
      }
      const r = await workerPost<Partial<PanicResult> & { error?: string }>('/api/panic', { confirm: 'LOCK' }, 60_000);
      if (r.status !== 200) throw new Error(r.body.error ?? `the worker refused (${r.status})`);
      for (const line of formatPanicResult(r.body)) console.log(line);
      if (!r.body.ok) process.exitCode = 1;
    });
}
