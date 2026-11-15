/**
 * The worker side of alerts: where the Telegram token comes from (the vault), when dispatch runs
 * (after every sync and once an hour), and the one-time-code relay that lets the owner answer a bank's
 * SMS challenge from Telegram while the scraper waits.
 */
import { type Db, type SecurityEventInput, type Vault, alertConfig, cleanErrorText, dispatchAlerts, getSetting, looksLikeTelegramToken, recordSecurityEvent, setSetting, telegramSend, telegramWaitForReply } from '@finc/core';
import { Cron } from 'croner';
import { MAIN_BOT_ID_SETTING, botIdOf, readAlarmBot, scrub } from './alarm.js';
import type { OtpProvider } from './connectors/otp.js';
import { log } from './logger.js';

export function telegramToken(vault: Vault | null): string | null {
  if (!vault || vault.locked) return null;
  const t = vault.get('telegram')?.fields.token?.trim();
  return t && looksLikeTelegramToken(t) ? t : null;
}

/**
 * One dispatch at a time: the hourly tick and the dispatch after a sync can fire together, and both would check
 * "already sent?" before either logged the send, so one alert could go out twice (independent review 2026-11-10).
 */
let dispatchQueue: Promise<void> = Promise.resolve();

export function runDispatch(db: Db, vault: Vault | null, reason: string, force = false): Promise<void> {
  const next = dispatchQueue.then(() => dispatchOnce(db, vault, reason, force));
  dispatchQueue = next.catch(() => undefined);
  return next;
}

async function dispatchOnce(db: Db, vault: Vault | null, reason: string, force: boolean): Promise<void> {
  try {
    const r = await dispatchAlerts(db, { telegramToken: telegramToken(vault), force });
    if (r.sent.length || r.skipped.some((s) => s.reason !== 'off')) log.info({ reason, sent: r.sent.map((s) => s.type), skipped: r.skipped.filter((s) => s.reason !== 'off').map((s) => `${s.type}:${s.reason}`) }, 'alerts: dispatched');
  } catch (e) {
    log.error({ err: e instanceof Error ? e.message : String(e) }, 'alerts: dispatch failed');
  }
}

/** Hourly tick: catches the weekly summary slot and anything held back by quiet hours. */
export function startAlertTicker(db: Db, getVault: () => Vault | null, timezone: string): Cron {
  return new Cron('5 * * * *', { timezone, name: 'alerts-tick' }, () => void runDispatch(db, getVault(), 'hourly'));
}

/**
 * When a bank asks for a one-time code during an unattended sync, ask on Telegram and wait up to
 * four minutes for the reply. Falls back to failing the sync (which raises a sync_error alert).
 */
export function telegramOtp(db: Db, getVault: () => Vault | null): OtpProvider {
  return async ({ institutionId }) => {
    const token = telegramToken(getVault());
    const chatId = alertConfig(db).telegramChatId;
    if (!token || !chatId) throw new Error(`${institutionId} asked for a one-time code and Telegram is not set up to relay it`);
    const lang = (db.$client.prepare(`select value from setting where key = 'ui.language'`).get() as { value: string } | undefined)?.value ?? 'he';
    const text = lang === 'he' ? `🔐 <b>${institutionId}</b> מבקש קוד חד־פעמי. ענה כאן עם הקוד (יש 4 דקות).` : `🔐 <b>${institutionId}</b> asks for a one-time code. Reply here with the code (4 minutes).`;
    const sent = await telegramSend(token, chatId, text);
    if (!sent.ok) throw new Error(`${institutionId} asked for a one-time code and Telegram refused the message: ${sent.error}`);
    log.info({ institution: institutionId }, 'otp: asked on Telegram, waiting for the reply');
    const code = await telegramWaitForReply(token, chatId, { timeoutMs: 4 * 60_000, pattern: /^\d{4,8}$/ });
    if (!code) throw new Error(`${institutionId} asked for a one-time code and none arrived on Telegram within 4 minutes`);
    return code;
  };
}

// --- security alerts (audit H1; security research P1-05)

export const SECURITY_SETTINGS = {
  lastError: 'alerts.securityLastError',
  lastErrorAt: 'alerts.securityLastErrorAt',
  lastOkAt: 'alerts.securityLastOkAt',
  /** 'alarm', 'main' (also when the main bot stood in for a failing alarm bot) or 'failed' */
  lastChannel: 'alerts.securityLastChannel',
} as const;

export type SecurityChannel = 'alarm' | 'main' | 'none';

interface Route {
  channel: 'alarm' | 'main';
  token: string;
  chatId: string;
  /** the main bot, when it can stand in for a failing alarm bot (vault open) */
  fallback: string | null;
}

function mainToken(db: Db, vault: Vault | null): string | null {
  const main = telegramToken(vault);
  // the main bot's id (not a secret), kept for diagnostics; setup compares with the live token
  if (main && getSetting(db, MAIN_BOT_ID_SETTING) !== botIdOf(main)) setSetting(db, MAIN_BOT_ID_SETTING, botIdOf(main));
  return main;
}

/**
 * Which bot carries security alerts: the alarm bot (data/alarm-bot.json) while the chat it was tested with at setup is
 * still the bound chat, locked or not; otherwise the main bot from the vault while it is open; otherwise none. A
 * rebound chat makes the alarm bot stale: the owner may never have pressed Start in it there (review 2026-11-10).
 */
function securityRoute(db: Db, vault: Vault | null, mainOverride?: string | null): { route: Route | null; alarmStale: boolean; alarmBot: string | null } {
  const chatId = alertConfig(db).telegramChatId;
  if (!chatId) return { route: null, alarmStale: false, alarmBot: null }; // no file is read before a chat is bound
  const alarm = readAlarmBot();
  const main = mainOverride ?? mainToken(db, vault);
  if (alarm && alarm.chatId === chatId) return { route: { channel: 'alarm', token: alarm.token, chatId, fallback: main }, alarmStale: false, alarmBot: alarm.username };
  const stale = !!alarm;
  if (!main) return { route: null, alarmStale: stale, alarmBot: alarm?.username ?? null };
  return { route: { channel: 'main', token: main, chatId, fallback: null }, alarmStale: stale, alarmBot: alarm?.username ?? null };
}

export function securityChannel(db: Db, vault: Vault | null): SecurityChannel {
  return securityRoute(db, vault).route?.channel ?? 'none';
}

/** True when a security alert sent now would reach Telegram (an alarm bot, or the main bot with the vault open). */
export function canSendSecurityAlerts(db: Db, vault: Vault | null): boolean {
  return securityRoute(db, vault).route !== null;
}

/**
 * For /health: the channel and the last failure (never a token). `alarmStale`: an alarm bot exists but was set up for
 * another chat, so it is not used until `finc alerts alarm setup` runs again.
 */
export function securityAlertStatus(db: Db, vault: Vault | null): { channel: SecurityChannel; alarmBot: string | null; alarmStale: boolean; lastChannel: string | null; lastError: string | null; lastErrorAt: string | null; lastOkAt: string | null } {
  const r = securityRoute(db, vault);
  return {
    channel: r.route?.channel ?? 'none',
    alarmBot: r.alarmBot,
    alarmStale: r.alarmStale,
    lastChannel: getSetting(db, SECURITY_SETTINGS.lastChannel),
    lastError: getSetting(db, SECURITY_SETTINGS.lastError),
    lastErrorAt: getSetting(db, SECURITY_SETTINGS.lastErrorAt),
    lastOkAt: getSetting(db, SECURITY_SETTINGS.lastOkAt),
  };
}

/**
 * Send one security alert and wait for the answer: plain text (no parse mode, so a name like `<a href="x">` arrives
 * exactly as typed and cannot break or inject anything), one retry after a short pause, and a failure that is
 * recorded for /health and the log. Resolves to what happened; never throws.
 */
export async function sendSecurityAlert(db: Db, vault: Vault | null, text: string, opts: { retryDelayMs?: number; mainToken?: string | null } = {}): Promise<{ ok: boolean; channel: SecurityChannel; fallback?: boolean; error?: string }> {
  // mainToken: the main bot's token read just before the vault was locked (the panic switch), so the main bot can still
  // carry the alert that says the vault was locked
  const { route } = securityRoute(db, vault, opts.mainToken);
  if (!route) return { ok: false, channel: 'none' };
  const message = `🔒 ${text}`;
  const send = (token: string) => telegramSend(token, route.chatId, message, { parseMode: null });
  let r = await send(route.token);
  if (!r.ok) {
    await new Promise((res) => setTimeout(res, opts.retryDelayMs ?? 3000));
    r = await send(route.token);
  }
  const errors: string[] = [];
  let channel: SecurityChannel = route.channel;
  let fallback = false;
  if (!r.ok) {
    errors.push(`${route.channel} bot: ${scrub(r.error ?? 'telegram error', route.token, route.fallback)}`);
    // a failing alarm bot (revoked, blocked): the main bot stands in once while the vault is open (review 2026-11-10)
    if (route.channel === 'alarm' && route.fallback) {
      r = await send(route.fallback);
      channel = 'main';
      fallback = true;
      if (!r.ok) errors.push(`main bot: ${scrub(r.error ?? 'telegram error', route.token, route.fallback)}`);
    }
  }
  const at = new Date().toISOString();
  try {
    setSetting(db, SECURITY_SETTINGS.lastChannel, r.ok ? channel : 'failed');
    if (r.ok) setSetting(db, SECURITY_SETTINGS.lastOkAt, at);
    if (errors.length) {
      setSetting(db, SECURITY_SETTINGS.lastError, cleanErrorText(r.ok ? `${errors.join('; ')}; delivered through the main bot instead` : errors.join('; ')));
      setSetting(db, SECURITY_SETTINGS.lastErrorAt, at);
    }
  } catch {
    // the database may be closing (shutdown); the log line below still says it
  }
  if (r.ok) {
    if (fallback) log.warn({ err: errors.join('; ') }, 'security alert: the alarm bot failed; delivered through the main bot');
    return { ok: true, channel, ...(fallback ? { fallback } : {}) };
  }
  const error = errors.join('; ');
  log.error({ channel, err: error }, 'security alert: telegram refused it on every channel');
  return { ok: false, channel, ...(fallback ? { fallback } : {}), error };
}

/**
 * Security events worth a message at once (audit H1): repeated wrong PINs, a new pairing code, a device
 * paired, a wrong master password. Fire and forget; without a channel (no alarm bot and the vault locked,
 * or no chat bound) they only reach the log.
 *
 * Every alert also lands in the security log (P1-08): `event` is what gets recorded (a kind, an actor and a small
 * structured detail, never the alert text). `null` only where the caller has already recorded the event itself (an
 * aggregated failure, one row per expired device, a settings change that lists its keys), so nothing is written twice.
 * The event is required, so a new alert cannot skip the log by accident.
 */
export function securityAlert(db: Db, vault: Vault | null, text: string, event: SecurityEventInput | null): void {
  if (event) recordSecurityEvent(db, event);
  log.warn({ text }, 'security');
  void sendSecurityAlert(db, vault, text);
}

/** The shape of securityAlert, for jobs that take it as a dependency (tests pass their own). */
export type SecurityAlertFn = (db: Db, vault: Vault | null, text: string, event: SecurityEventInput | null) => void;
