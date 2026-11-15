/**
 * Lockdown from Telegram (security research P1-09): the alarm bot (data/alarm-bot.json, outside the vault, so it works
 * while the vault is locked) also LISTENS, for two commands from the bound alert chat only:
 *
 *   /lockdown          → a one-time 6-digit code, valid 2 minutes
 *   /lockdown 123456   → the panic switch (lockdown.ts): every device revoked, every session ended, the vault locked
 *   /status            → vault locked or not, how many paired devices, the last 5 security-log events
 *
 * Messages from any other chat are ignored without a reply. Five wrong codes within 10 minutes make it ignore /lockdown
 * for 10 minutes. The command logic is a pure function (lockdownStep) with an injected clock; AlarmPoller is the I/O.
 *
 * getUpdates has one consumer per bot. The poller is the only reader of the ALARM bot's updates in finc (setting the
 * alarm bot up only sends a test message; the chat is bound through the MAIN bot, which is never polled here, so the
 * one-time-code relay keeps working). Anything that ever needs the alarm bot's updates itself, or replaces / removes
 * the bot (`finc alerts alarm setup|remove`), calls pause(): the in-flight long poll is aborted at once (its updates
 * stay unconfirmed, so nothing is lost) and no getUpdates runs until the returned resume() is called.
 */
import { randomInt, timingSafeEqual } from 'node:crypto';
import { type AlarmBot, botIdOf, scrub } from './alarm.js';
import type { PanicResult } from './lockdown.js';
import { log } from './logger.js';

export const LOCKDOWN_CODE_MS = 2 * 60_000;
export const LOCKDOWN_MAX_WRONG = 5;
export const LOCKDOWN_WRONG_WINDOW_MS = 10 * 60_000;
export const LOCKDOWN_BLOCK_MS = 10 * 60_000;

export interface LockdownState {
  pending: { code: string; expiresAt: number } | null;
  /** times of wrong codes within the window */
  wrong: number[];
  /** /lockdown is ignored until then (ms since epoch) */
  blockedUntil: number;
  /** the first /lockdown during a block got its one reply; later ones stay silent */
  blockNoticeSent: boolean;
}

export const initialLockdownState = (): LockdownState => ({ pending: null, wrong: [], blockedUntil: 0, blockNoticeSent: false });

export type LockdownAction = { kind: 'ignore'; why: 'foreign chat' | 'blocked' | 'not a command' } | { kind: 'reply'; text: string } | { kind: 'panic' } | { kind: 'status' };

export interface LockdownContext {
  boundChatId: string | null;
  now: number;
  /** a fresh 6-digit code */
  newCode: () => string;
}

export const newLockdownCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0');

const sameCode = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export const HELP_TEXT = 'finc alarm bot. /lockdown revokes every paired device and passkey, ends every session and locks the vault (you confirm with a code). /status shows the vault and devices.';

/** One message in, the new state and what to do. Pure: no clock, no randomness, no I/O of its own. */
export function lockdownStep(state: LockdownState, msg: { chatId: string; text: string }, ctx: LockdownContext): { state: LockdownState; action: LockdownAction } {
  if (!ctx.boundChatId || msg.chatId !== ctx.boundChatId) return { state, action: { kind: 'ignore', why: 'foreign chat' } };
  const m = msg.text.trim().match(/^\/([a-z]+)(?:@[A-Za-z0-9_]+)?(?:\s+(.*))?$/i);
  if (!m) return { state, action: { kind: 'ignore', why: 'not a command' } };
  const cmd = m[1]!.toLowerCase();
  const arg = (m[2] ?? '').trim();
  const { now } = ctx;
  if (cmd === 'status') return { state, action: { kind: 'status' } };
  if (cmd === 'start' || cmd === 'help') return { state, action: { kind: 'reply', text: HELP_TEXT } };
  if (cmd !== 'lockdown') return { state, action: { kind: 'ignore', why: 'not a command' } };
  if (now < state.blockedUntil) {
    if (state.blockNoticeSent) return { state, action: { kind: 'ignore', why: 'blocked' } };
    const min = Math.max(1, Math.ceil((state.blockedUntil - now) / 60_000));
    return { state: { ...state, blockNoticeSent: true }, action: { kind: 'reply', text: `too many wrong codes; try again in ${min} minute${min === 1 ? '' : 's'}` } };
  }
  const wrong = state.wrong.filter((t) => now - t < LOCKDOWN_WRONG_WINDOW_MS);
  if (!arg) {
    const code = ctx.newCode();
    return {
      state: { ...state, wrong, pending: { code, expiresAt: now + LOCKDOWN_CODE_MS } },
      action: { kind: 'reply', text: `To lock everything (revoke every paired device and passkey, end every session, lock the vault), send /lockdown ${code} within 2 minutes.` },
    };
  }
  const p = state.pending;
  if (p && now < p.expiresAt && sameCode(arg, p.code)) {
    return { state: initialLockdownState(), action: { kind: 'panic' } };
  }
  wrong.push(now);
  if (wrong.length >= LOCKDOWN_MAX_WRONG) {
    return {
      state: { pending: null, wrong: [], blockedUntil: now + LOCKDOWN_BLOCK_MS, blockNoticeSent: false },
      action: { kind: 'reply', text: `wrong or expired code. ${LOCKDOWN_MAX_WRONG} wrong codes: /lockdown is ignored for 10 minutes. From a signed-in phone or the PC you can still lock everything (Settings, or finc panic).` },
    };
  }
  // an expired code is gone; a live one stays (a typo should not force a new code)
  return { state: { ...state, wrong, blockNoticeSent: false, pending: p && now < p.expiresAt ? p : null }, action: { kind: 'reply', text: 'wrong or expired code' } };
}

/** One security-log event as /status lists it: kind, time, actor (never an address). */
export interface StatusEvent {
  at: string;
  kind: string;
  actor: string;
  actorName: string | null;
}

/**
 * The /status reply: the vault, the paired devices, and the last security-log events (P1-08), newest first, as
 * `dd/mm hh:mm kind actor "name"`. No addresses, no details.
 */
export function statusText(s: { vaultUnlocked: boolean; devices: number; events: StatusEvent[] }, timeZone?: string): string {
  const head = `finc: vault ${s.vaultUnlocked ? 'unlocked' : 'locked'}; ${s.devices} paired device(s) active`;
  if (!s.events.length) return `${head}\nno security events yet`;
  const when = (iso: string): string => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso.slice(0, 16);
    return d.toLocaleString('en-GB', { ...(timeZone ? { timeZone } : {}), day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', '');
  };
  const lines = s.events.slice(0, 5).map((e) => `${when(e.at)} ${e.kind} ${e.actor}${e.actorName ? ` "${e.actorName.slice(0, 30)}"` : ''}`);
  return `${head}\nlast events:\n${lines.join('\n')}`;
}

/** What the reply to a finished lockdown says. */
export function panicReplyText(r: PanicResult): string {
  const head = r.ok ? 'Lockdown done' : 'Lockdown finished WITH ERRORS';
  return `${head}: ${r.devices} device(s) revoked, ${r.passkeys} passkey(s) revoked, ${r.sessions} session(s) ended, vault ${r.vaultLocked ? 'locked' : 'NOT locked'}.${r.errors?.length ? ` ${r.errors.join('; ')}` : ''} Pair again, re-enrol passkeys and unlock from the PC at home.`;
}

// --- the poller

interface TgUpdate {
  update_id: number;
  message?: { date: number; text?: string; chat: { id: number } };
}

export interface AlarmPollerDeps {
  readBot: () => AlarmBot | null;
  /** the bound alert chat (alertConfig(db).telegramChatId) */
  boundChatId: () => string | null;
  /** the main bot's id (setting telegram.mainBotId): never poll a bot with that id, its updates carry the bank codes */
  mainBotId: () => string | null;
  panic: (who: string) => Promise<PanicResult>;
  status: () => string;
  /** the security log (P1-08): /lockdown asked, a wrong code, the block; the lockdown itself is recorded by the panic */
  record?: (kind: string, detail?: Record<string, unknown> | null) => void;
  fetch?: typeof fetch;
  now?: () => number;
  newCode?: () => string;
  /** how often to look again while no bot is configured / bound, or while paused (default 60 s) */
  idleCheckMs?: number;
  /** getUpdates long-poll timeout, seconds (default 25) */
  pollTimeoutSec?: number;
  /** backoff after errors: base, doubling up to max (default 5 s .. 5 min) */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** messages older than this (sent while the worker was down) are skipped (default 120 s) */
  maxAgeSec?: number;
  /** a round shorter than this is padded with a sleep, so a Telegram that answers at once cannot spin the loop (default 1 s) */
  minRoundMs?: number;
}

export type TickResult = 'idle' | 'paused' | 'stopped' | 'aborted' | 'polled';

class TelegramError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

export class AlarmPoller {
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private state: LockdownState = initialLockdownState();
  private token: string | null = null;
  /** the next update_id to ask for; null until the first answer for this bot */
  private offset: number | null = null;
  private paused = 0;
  /** set by stop(), for good */
  private stopped = false;
  private inflight: AbortController | null = null;
  private wake: (() => void) | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly deps: AlarmPollerDeps) {
    this.fetch = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.running || this.stopped) return;
    this.running = this.loop().catch((e: unknown) => log.error({ err: this.clean(e) }, 'alarm poller: stopped by an error'));
  }

  /** Stops for good (shutdown, a database-owner conflict): aborts the long poll, wakes the sleep. */
  stop(): Promise<void> {
    this.stopped = true;
    this.inflight?.abort();
    this.wake?.();
    return this.running ?? Promise.resolve();
  }

  /** No getUpdates until the returned function is called (once). Aborts the poll in flight. */
  pause(): () => void {
    this.paused++;
    this.inflight?.abort();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.paused = Math.max(0, this.paused - 1);
      if (!this.paused) this.wake?.();
    };
  }

  async pauseWhile<T>(fn: () => Promise<T>): Promise<T> {
    const resume = this.pause();
    try {
      return await fn();
    } finally {
      resume();
    }
  }

  get isPaused(): boolean {
    return this.paused > 0;
  }

  /** The offset the next getUpdates sends (tests). */
  get nextOffset(): number | null {
    return this.offset;
  }

  /** The alarm bot this poller would use now, or null (none, not bound to the alert chat, or the main bot's id). */
  private eligibleBot(): AlarmBot | null {
    const bot = this.deps.readBot();
    const chat = this.deps.boundChatId();
    if (!bot || !chat || bot.chatId !== chat) return null; // only a bound alarm bot, like the alert route
    const mainId = this.deps.mainBotId();
    if (mainId && mainId === botIdOf(bot.token)) return null;
    return bot;
  }

  /** /lockdown works right now: started, not stopped, and an alarm bot configured and bound (GET /api/settings). */
  get live(): boolean {
    if (!this.running || this.stopped) return false;
    try {
      return this.eligibleBot() !== null;
    } catch {
      return false;
    }
  }

  /** One round: a long poll on the alarm bot and the handling of what it returned. Throws on a Telegram or network error. */
  async tick(): Promise<TickResult> {
    if (this.stopped) return 'stopped';
    if (this.paused) return 'paused';
    const bot = this.eligibleBot();
    if (!bot) return 'idle';
    if (bot.token !== this.token) {
      // a new or replaced bot: its own offsets, and no code carried over
      this.token = bot.token;
      this.offset = null;
      this.state = initialLockdownState();
    }
    const timeout = this.deps.pollTimeoutSec ?? 25;
    const ctl = new AbortController();
    this.inflight = ctl;
    const timer = setTimeout(() => ctl.abort(), (timeout + 15) * 1000);
    timer.unref?.();
    let updates: TgUpdate[];
    try {
      const body = { timeout, allowed_updates: ['message'], ...(this.offset !== null ? { offset: this.offset } : {}) };
      const res = await this.call<TgUpdate[]>(bot.token, 'getUpdates', body, ctl.signal);
      updates = res;
    } catch (e) {
      if (ctl.signal.aborted && (this.paused || this.stopped)) return 'aborted';
      throw e;
    } finally {
      clearTimeout(timer);
      if (this.inflight === ctl) this.inflight = null;
    }
    // paused or stopped while the answer was on its way: drop it unconfirmed (it comes back on the next poll)
    if (this.paused || this.stopped) return 'aborted';
    for (const u of [...updates].sort((a, b) => a.update_id - b.update_id)) {
      if (this.offset !== null && u.update_id < this.offset) continue; // never handled twice
      this.offset = u.update_id + 1;
      await this.handle(bot, u);
    }
    return 'polled';
  }

  private async handle(bot: AlarmBot, u: TgUpdate): Promise<void> {
    const m = u.message;
    if (!m || typeof m.text !== 'string') return;
    const chatId = String(m.chat.id);
    const now = this.now();
    if (chatId !== bot.chatId) {
      log.debug({ update: u.update_id }, 'alarm poller: a message from another chat, ignored');
      return;
    }
    if (m.date < Math.floor(now / 1000) - (this.deps.maxAgeSec ?? 120)) {
      log.debug({ update: u.update_id }, 'alarm poller: an old message (sent while the worker was down), skipped');
      return;
    }
    const step = lockdownStep(this.state, { chatId, text: m.text }, { boundChatId: bot.chatId, now, newCode: this.deps.newCode ?? newLockdownCode });
    this.state = step.state;
    const a = step.action;
    try {
      if (a.kind === 'ignore') {
        if (a.why === 'blocked') {
          log.warn('alarm poller: /lockdown ignored (too many wrong codes)');
          this.record('lockdown.blocked', { ignored: true });
        }
        return;
      }
      if (a.kind === 'reply') {
        if (a.text.startsWith('wrong')) {
          const blocked = this.state.blockedUntil > now;
          const wrong = blocked ? LOCKDOWN_MAX_WRONG : this.state.wrong.length; // the block starts a fresh count
          log.warn({ wrong, blocked }, 'alarm poller: wrong lockdown code');
          this.record('lockdown.wrong_code', { wrong, blocked });
        } else if (a.text.startsWith('To lock everything')) this.record('lockdown.requested');
        else if (a.text.startsWith('too many wrong codes')) this.record('lockdown.blocked');
        await this.reply(bot, a.text);
        return;
      }
      if (a.kind === 'status') {
        await this.reply(bot, this.deps.status());
        return;
      }
      log.warn('alarm poller: lockdown confirmed from Telegram');
      const r = await this.deps.panic('Telegram (/lockdown)');
      await this.reply(bot, panicReplyText(r));
    } catch (e) {
      log.error({ err: this.clean(e) }, 'alarm poller: handling a command failed');
    }
  }

  private record(kind: string, detail: Record<string, unknown> | null = null): void {
    try {
      this.deps.record?.(kind, detail);
    } catch (e) {
      log.warn({ err: this.clean(e) }, 'alarm poller: the security log write failed');
    }
  }

  private async reply(bot: AlarmBot, text: string): Promise<void> {
    if (!bot.chatId) return;
    try {
      await this.call(bot.token, 'sendMessage', { chat_id: bot.chatId, text, disable_web_page_preview: true }, AbortSignal.timeout(15_000));
    } catch (e) {
      log.warn({ err: this.clean(e) }, 'alarm poller: the reply did not go out');
    }
  }

  private async call<T>(token: string, method: string, body: Record<string, unknown>, signal: AbortSignal): Promise<T> {
    const res = await this.fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
    const json = (await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }))) as { ok: boolean; result?: T; description?: string; error_code?: number };
    if (!json.ok) throw new TelegramError(json.description ?? `HTTP ${res.status}`, json.error_code ?? res.status);
    return json.result as T;
  }

  private clean(e: unknown): string {
    return scrub(e instanceof Error ? e.message : String(e), this.token);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      t.unref?.();
      function done(): void {
        clearTimeout(t);
        resolve();
      }
      this.wake = () => {
        this.wake = null;
        done();
      };
    });
  }

  private async loop(): Promise<void> {
    let failures = 0;
    const idle = this.deps.idleCheckMs ?? 60_000;
    const base = this.deps.backoffBaseMs ?? 5_000;
    const max = this.deps.backoffMaxMs ?? 5 * 60_000;
    const minRound = this.deps.minRoundMs ?? 1000;
    while (!this.stopped) {
      let r: TickResult;
      const began = Date.now();
      try {
        r = await this.tick();
        failures = 0;
      } catch (e) {
        failures++;
        const code = e instanceof TelegramError ? e.code : undefined;
        // 401: the bot token was revoked; 409: another consumer (a webhook, another worker) has the updates
        const wait = code === 401 ? max : Math.min(max, base * 2 ** Math.min(failures - 1, 16));
        log.warn({ err: this.clean(e), code, failures, retryInSec: Math.round(wait / 1000) }, 'alarm poller: getUpdates failed; backing off');
        await this.sleep(wait);
        continue;
      }
      if (r === 'idle' || r === 'paused') await this.sleep(idle);
      else if (Date.now() - began < minRound) await this.sleep(minRound - (Date.now() - began));
    }
  }
}
