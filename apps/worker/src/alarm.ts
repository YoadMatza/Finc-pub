/**
 * The alarm bot (security research P1-05, option A): a second, send-only Telegram bot whose token is kept OUTSIDE the
 * vault, in data/alarm-bot.json (owner-only), so security alerts still arrive while the vault is locked (after every
 * worker restart, until `finc unlock`). It is a separate bot from the main one, so it never sees the bank codes the
 * main bot relays. Since P1-09 it also listens to its own chat for /lockdown and /status (alarm-poller.ts), from the
 * bound chat only. The main bot's token stays in the vault and is never written here (setup refuses it).
 */
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type Db, type Vault, alertConfig, dataDir, looksLikeTelegramToken, setSetting, telegramMe, telegramSend } from '@finc/core';
import { log } from './logger.js';

export const ALARM_FILE = 'alarm-bot.json';
/** The main bot's numeric id (the part of its token before ':', not a secret), to refuse it as the alarm bot while locked. */
export const MAIN_BOT_ID_SETTING = 'telegram.mainBotId';

export interface AlarmBot {
  token: string;
  username: string | null;
  savedAt: string;
  /** The chat the test message reached at setup: the bot is used only while this is still the bound alert chat. */
  chatId: string | null;
}

export const alarmPath = (): string => path.join(dataDir(), ALARM_FILE);

/** The bot id of a token: the digits before ':'. */
export const botIdOf = (token: string): string => token.split(':')[0] ?? '';

/** The configured alarm bot, or null. A damaged or invalid file counts as none (and says so in the log, never the token). */
export function readAlarmBot(): AlarmBot | null {
  const p = alarmPath();
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<AlarmBot>;
    const token = typeof raw.token === 'string' ? raw.token.trim() : '';
    if (!looksLikeTelegramToken(token)) {
      log.warn({ file: ALARM_FILE }, 'alarm bot: the file has no valid token; ignored');
      return null;
    }
    return { token, username: typeof raw.username === 'string' ? raw.username : null, savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : '', chatId: typeof raw.chatId === 'string' && raw.chatId ? raw.chatId : null };
  } catch {
    log.warn({ file: ALARM_FILE }, 'alarm bot: the file is not valid JSON; ignored');
    return null;
  }
}

/**
 * Written through a temporary file, so a half-written file is never read. Mode 0600 protects it on a Linux disk (the
 * Pi). On this PC's Windows bind mount the mode is ignored: there the file is protected only by the NTFS permissions
 * of the data folder, like the vault and the database beside it.
 */
export function saveAlarmBot(bot: AlarmBot): void {
  const p = alarmPath();
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(bot, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600); // the mode above applies only when the file is new
  } catch {
    // a file system without POSIX modes (the Windows bind mount); see above
  }
  renameSync(tmp, p);
}

/** True when `token` belongs to the configured alarm bot (same bot id): it must never become the main bot. */
export function isAlarmBotToken(token: string): boolean {
  const alarm = readAlarmBot();
  return !!alarm && botIdOf(alarm.token) === botIdOf(token.trim());
}

export function removeAlarmBot(): boolean {
  const p = alarmPath();
  if (!existsSync(p)) return false;
  rmSync(p, { force: true });
  return true;
}

export class AlarmSetupError extends Error {
  constructor(
    readonly status: 400 | 409 | 502,
    message: string,
  ) {
    super(message);
  }
}

export interface AlarmSetupDeps {
  me: typeof telegramMe;
  send: typeof telegramSend;
}

/** The main bot's token, when the vault is open (same rules as alerts.ts telegramToken, kept here to avoid a cycle). */
function mainToken(vault: Vault | null): string | null {
  if (!vault || vault.locked) return null;
  const t = vault.get('telegram')?.fields.token?.trim();
  return t && looksLikeTelegramToken(t) ? t : null;
}

/**
 * Check a candidate alarm bot and save it only when a test message reached the alert chat:
 * a well-formed token, not the main bot, a bound chat, a token Telegram accepts, and a bot the owner has started.
 */
export async function setupAlarmBot(db: Db, vault: Vault | null, candidate: string, deps: AlarmSetupDeps = { me: telegramMe, send: telegramSend }): Promise<{ username: string | null }> {
  const token = candidate.trim();
  if (!looksLikeTelegramToken(token)) throw new AlarmSetupError(400, 'that is not a bot token: @BotFather gives one like 1234567890:AA... (digits, a colon, then 30+ letters)');
  // compared with the LIVE main token, never a remembered id (the main bot may have been replaced since)
  if (!vault || vault.locked) throw new AlarmSetupError(409, 'unlock the vault first (finc unlock), so finc can check this is not the main bot');
  const main = mainToken(vault);
  if (main) setSetting(db, MAIN_BOT_ID_SETTING, botIdOf(main));
  const mainId = main ? botIdOf(main) : null;
  if (main === token || (mainId && mainId === botIdOf(token))) {
    throw new AlarmSetupError(400, 'that is the main finc bot; the alarm bot must be a NEW bot (its token is kept outside the vault, the main one never is). Make one with @BotFather: /newbot');
  }
  const chatId = alertConfig(db).telegramChatId;
  if (!chatId) throw new AlarmSetupError(409, 'no Telegram chat is bound yet: connect the main bot first (hub, Settings > Alerts), then run this again');
  const me = await deps.me(token);
  if (!me.ok) throw new AlarmSetupError(400, `Telegram did not accept that token (${scrub(me.error ?? 'error', token)}); copy it again from @BotFather`);
  if (me.id !== undefined && mainId && String(me.id) === mainId) throw new AlarmSetupError(400, 'that is the main finc bot; the alarm bot must be a NEW bot');
  const username = me.username ?? null;
  const sent = await deps.send(token, chatId, '🔒 finc alarm bot connected: security alerts will arrive here, even while the vault is locked.', { parseMode: null });
  if (!sent.ok) {
    const who = username ? `@${username}` : 'the new bot';
    if (sent.code === 400 || sent.code === 403 || /chat not found|forbidden|initiate conversation|blocked/i.test(sent.error ?? '')) {
      throw new AlarmSetupError(409, `${who} cannot write to you yet: open ${who} in Telegram and press Start, then run this again (nothing was saved)`);
    }
    throw new AlarmSetupError(502, `Telegram refused the test message (${scrub(sent.error ?? 'error', token)}); nothing was saved`);
  }
  saveAlarmBot({ token, username, savedAt: new Date().toISOString(), chatId });
  log.info({ bot: username }, 'alarm bot: saved; security alerts go through it from now on');
  return { username };
}

/** Never let a token reach a log line or a health answer, whatever an error message carries. */
export function scrub(text: string, ...tokens: (string | null | undefined)[]): string {
  let out = text;
  for (const t of tokens) if (t) out = out.split(t).join('[token]');
  return out.replace(/\d{6,}:[A-Za-z0-9_-]{30,}/g, '[token]').replace(/\s+/g, ' ').slice(0, 300);
}
