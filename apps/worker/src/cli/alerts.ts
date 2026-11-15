/**
 * `finc alerts alarm setup | test | status | remove` (security research P1-05): the send-only alarm bot that carries
 * security alerts while the vault is locked. Runs inside the container and talks to the worker's control port with
 * data/control.token; the worker checks the token, sends a test message and only then saves data/alarm-bot.json.
 * The token is typed at a masked prompt and never printed.
 */
import { confirm, password } from '@inquirer/prompts';
import type { Command } from 'commander';
import { localTime, workerAnswers } from './backup.js';
import { workerPost, workerRequest } from './worker-client.js';

interface AlarmView {
  configured?: boolean;
  bot?: string | null;
  savedAt?: string | null;
  chatBound?: boolean;
  channel?: 'alarm' | 'main' | 'none';
  lastError?: string | null;
  lastErrorAt?: string | null;
  lastOkAt?: string | null;
  alarmStale?: boolean;
  lastChannel?: string | null;
  error?: string;
}

async function requireWorker(): Promise<void> {
  if (!(await workerAnswers())) throw new Error('the worker is not running; start it with: docker compose start worker');
}

const CHANNEL_TEXT: Record<string, string> = {
  alarm: 'the alarm bot (works while the vault is locked)',
  main: 'the main bot (only while the vault is unlocked)',
  none: 'none: security alerts reach only the worker log right now',
};

export function formatAlarmStatus(v: AlarmView): string[] {
  const lines = [`alarm bot:      ${v.configured ? (v.bot ? `@${v.bot}` : 'configured') : 'not set up (finc alerts alarm setup)'}${v.savedAt ? `  (saved ${localTime(v.savedAt)})` : ''}`];
  lines.push(`alert chat:     ${v.chatBound ? 'bound' : 'not bound yet (hub: Settings > Alerts)'}`);
  lines.push(`security alerts go through: ${CHANNEL_TEXT[v.channel ?? 'none'] ?? v.channel}`);
  if (v.alarmStale) lines.push('WARNING: the alarm bot was set up for another chat and is NOT used now. Run: finc alerts alarm setup (press Start in the alarm bot first)');
  if (v.lastOkAt) lines.push(`last delivered: ${localTime(v.lastOkAt)}${v.lastChannel && v.lastChannel !== 'failed' ? ` (${v.lastChannel} bot)` : ''}`);
  if (v.lastChannel === 'failed') lines.push('the last security alert reached NO bot');
  if (v.lastError) lines.push(`last failure:   ${v.lastErrorAt ? localTime(v.lastErrorAt) : '?'}  ${v.lastError}`);
  return lines;
}

export function registerAlertCommands(program: Command): void {
  const alerts = program.command('alerts').description('Telegram alerts');
  const alarm = alerts.command('alarm').description('The alarm bot: security alerts even while the vault is locked');

  alarm
    .command('setup')
    .description('Connect a second, send-only Telegram bot for security alerts')
    .action(async () => {
      await requireWorker();
      const cur = await workerRequest<AlarmView>('GET', '/alarm', undefined, 15_000);
      if (cur.status !== 200) throw new Error(cur.body.error ?? `the worker refused (${cur.status})`);
      if (cur.body.configured && !(await confirm({ message: `An alarm bot is already set up (${cur.body.bot ? `@${cur.body.bot}` : 'unknown name'}). Replace it?`, default: false }))) {
        console.log('cancelled; nothing changed');
        return;
      }
      console.log('');
      console.log('The alarm bot is a SECOND bot, used only to send security alerts. Its token is kept outside the vault');
      console.log('(data/alarm-bot.json), so alerts still arrive while the vault is locked. Never use the main finc bot here.');
      console.log('');
      console.log('  1. In Telegram, open @BotFather, send /newbot and follow the questions.');
      console.log('  2. Open the new bot (the t.me link BotFather gives) and press Start.');
      console.log('  3. Paste the new bot\'s token below (it is not shown while you type).');
      console.log('');
      const token = (await password({ message: 'Alarm bot token', mask: '*' })).trim();
      if (!token) {
        console.log('cancelled; nothing was saved');
        return;
      }
      const r = await workerPost<{ ok?: boolean; bot?: string | null; error?: string }>('/alarm/setup', { token }, 60_000);
      if (r.status !== 200 || !r.body.ok) throw new Error(r.body.error ?? `setup failed (${r.status})`);
      console.log(`saved: ${r.body.bot ? `@${r.body.bot}` : 'the alarm bot'} sent you a test message and carries every security alert from now on, locked or not.`);
    });

  alarm
    .command('test')
    .description('Send a test security alert through the current channel')
    .action(async () => {
      await requireWorker();
      const r = await workerPost<{ ok?: boolean; channel?: string; error?: string }>('/alarm/test', {}, 60_000);
      if (r.status !== 200 || !r.body.ok) throw new Error(r.body.error ?? `the test failed (${r.status})`);
      console.log(`sent through ${CHANNEL_TEXT[r.body.channel ?? ''] ?? r.body.channel}; check Telegram`);
    });

  alarm
    .command('status')
    .description('Which bot carries security alerts, and the last failure')
    .action(async () => {
      await requireWorker();
      const r = await workerRequest<AlarmView>('GET', '/alarm', undefined, 15_000);
      if (r.status !== 200) throw new Error(r.body.error ?? `the worker refused (${r.status})`);
      for (const l of formatAlarmStatus(r.body)) console.log(l);
    });

  alarm
    .command('remove')
    .description('Remove the alarm bot (security alerts then need the vault unlocked)')
    .action(async () => {
      await requireWorker();
      if (!(await confirm({ message: 'Remove the alarm bot? While the vault is locked, security alerts will then reach only the log.', default: false }))) {
        console.log('cancelled');
        return;
      }
      const r = await workerRequest<{ ok?: boolean; removed?: boolean; error?: string }>('DELETE', '/alarm', undefined, 60_000);
      if (r.status !== 200 || !r.body.ok) throw new Error(r.body.error ?? `remove failed (${r.status})`);
      console.log(r.body.removed ? 'removed. You can also delete the bot itself in @BotFather (/deletebot).' : 'there was no alarm bot');
    });
}
