/**
 * `finc push setup <file>`: stores a Firebase service-account key in the vault (entry push_fcm: projectId,
 * clientEmail, privateKey), then deletes the file (research_notes/proposals/push-alerts.md). The file is read from the
 * data folder (put it there first); nothing of it is printed. The running worker sees the new entry after the vault is
 * locked and unlocked again.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { dataDir } from '@finc/core';
import type { Command } from 'commander';
import { PUSH_VAULT_ENTRY, parseServiceAccount } from '../push-fcm.js';
import { openVaultInteractive } from './vault.js';

export function registerPushCommands(program: Command): void {
  const push = program.command('push').description('Push alerts to the phone app (Firebase)');
  push
    .command('setup <file>')
    .description('Store a Firebase service-account key (JSON in the data folder) in the vault, then delete the file')
    .action(async (file: string) => {
      const base = dataDir();
      const full = path.resolve(base, file);
      if (!full.startsWith(base + path.sep)) throw new Error('put the key file in the data folder and give its name, e.g. fcm-key.json');
      if (!existsSync(full)) throw new Error(`no file ${file} in the data folder`);
      let creds: ReturnType<typeof parseServiceAccount> = null;
      try {
        creds = parseServiceAccount(JSON.parse(readFileSync(full, 'utf8')));
      } catch {
        creds = null;
      }
      if (!creds) throw new Error('this is not a Firebase service-account key (Project settings → Service accounts → Generate new private key)');
      const v = await openVaultInteractive();
      try {
        v.set(PUSH_VAULT_ENTRY, 'generic', { projectId: creds.projectId, clientEmail: creds.clientEmail, privateKey: creds.privateKey });
      } finally {
        v.lock();
      }
      rmSync(full, { force: true });
      console.log(`Saved "${PUSH_VAULT_ENTRY}" for project ${creds.projectId}; the key file is deleted.`);
      console.log('Lock and unlock the vault (Settings) so the worker reads it, then send a test push from Settings → Alerts.');
    });
}
