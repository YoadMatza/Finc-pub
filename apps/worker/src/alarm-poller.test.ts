import { describe, expect, it, vi } from 'vitest';
import type { AlarmBot } from './alarm.js';
import { AlarmPoller, LOCKDOWN_BLOCK_MS, LOCKDOWN_CODE_MS, type LockdownState, initialLockdownState, lockdownStep, panicReplyText } from './alarm-poller.js';
import type { PanicResult } from './lockdown.js';

// security research P1-09: /lockdown through the alarm bot

const CHAT = '424242';
const OTHER = '999001';
const ALARM = `222222222:${'A'.repeat(35)}`;
const T0 = Date.UTC(2026, 5, 30, 12, 0, 0);

describe('lockdownStep (pure)', () => {
  const ctx = (now: number, code = '123456') => ({ boundChatId: CHAT, now, newCode: () => code });
  const run = (s: LockdownState, text: string, now: number, chatId = CHAT, code?: string) => lockdownStep(s, { chatId, text }, ctx(now, code));

  it('asks for a code, then panics on the right code within 2 minutes, once', () => {
    let r = run(initialLockdownState(), '/lockdown', T0);
    expect(r.action).toEqual({ kind: 'reply', text: expect.stringContaining('send /lockdown 123456 within 2 minutes') });
    r = run(r.state, '/lockdown 123456', T0 + LOCKDOWN_CODE_MS - 1);
    expect(r.action).toEqual({ kind: 'panic' });
    // single use
    expect(run(r.state, '/lockdown 123456', T0 + 1000).action).toEqual({ kind: 'reply', text: 'wrong or expired code' });
  });

  it('a code is dead after 2 minutes; a wrong code keeps a live one; a new /lockdown replaces it', () => {
    let r = run(initialLockdownState(), '/lockdown', T0);
    expect(run(r.state, '/lockdown 123456', T0 + LOCKDOWN_CODE_MS).action).toEqual({ kind: 'reply', text: 'wrong or expired code' });
    r = run(r.state, '/lockdown 654321', T0 + 1000);
    expect(r.action).toEqual({ kind: 'reply', text: 'wrong or expired code' });
    expect(run(r.state, '/lockdown 123456', T0 + 2000).action).toEqual({ kind: 'panic' });
    r = run(r.state, '/lockdown', T0 + 3000, CHAT, '777777');
    expect(run(r.state, '/lockdown 123456', T0 + 4000).action).toEqual({ kind: 'reply', text: 'wrong or expired code' });
    expect(run(r.state, '/lockdown 777777', T0 + 4000).action).toEqual({ kind: 'panic' });
    // a code without asking first is wrong too; Telegram's /cmd@bot form works
    expect(run(initialLockdownState(), '/lockdown 123456', T0).action).toEqual({ kind: 'reply', text: 'wrong or expired code' });
    r = run(initialLockdownState(), '/lockdown@finc_alarm_bot', T0);
    expect(run(r.state, '/LOCKDOWN@finc_alarm_bot   123456 ', T0 + 1).action).toEqual({ kind: 'panic' });
  });

  it('5 wrong codes in 10 minutes: /lockdown is ignored for 10 minutes', () => {
    let s = run(initialLockdownState(), '/lockdown', T0).state;
    for (let i = 0; i < 4; i++) {
      const r = run(s, '/lockdown 000000', T0 + i * 60_000);
      expect(r.action).toEqual({ kind: 'reply', text: 'wrong or expired code' });
      s = r.state;
    }
    const fifth = run(s, '/lockdown 000000', T0 + 4 * 60_000);
    expect(fifth.action).toEqual({ kind: 'reply', text: expect.stringContaining('ignored for 10 minutes') });
    s = fifth.state;
    const blockedAt = T0 + 4 * 60_000;
    // the first /lockdown during the block gets ONE reply; later ones (even the right code) stay silent
    const first = run(s, '/lockdown 123456', blockedAt + 1000);
    expect(first.action).toEqual({ kind: 'reply', text: 'too many wrong codes; try again in 10 minutes' });
    s = first.state;
    expect(run(s, '/lockdown 123456', blockedAt + 2000).action).toEqual({ kind: 'ignore', why: 'blocked' });
    expect(run(s, '/lockdown', blockedAt + LOCKDOWN_BLOCK_MS - 1).action).toEqual({ kind: 'ignore', why: 'blocked' });
    // /status still answers
    expect(run(s, '/status', blockedAt + 1000).action).toEqual({ kind: 'status' });
    // after the block a fresh code works
    const again = run(s, '/lockdown', blockedAt + LOCKDOWN_BLOCK_MS, CHAT, '246810');
    expect(again.action.kind).toBe('reply');
    expect(run(again.state, '/lockdown 246810', blockedAt + LOCKDOWN_BLOCK_MS + 1).action).toEqual({ kind: 'panic' });
  });

  it('wrong codes spread over more than 10 minutes do not block', () => {
    let s = initialLockdownState();
    for (let i = 0; i < 8; i++) {
      const r = run(s, '/lockdown 000000', T0 + i * 3 * 60_000);
      expect(r.action).toEqual({ kind: 'reply', text: 'wrong or expired code' });
      s = r.state;
    }
  });

  it('ignores other chats (no reply), plain text and unknown commands; /status and /help answer', () => {
    const s = run(initialLockdownState(), '/lockdown', T0).state;
    expect(run(s, '/lockdown 123456', T0 + 1, OTHER).action).toEqual({ kind: 'ignore', why: 'foreign chat' });
    expect(run(initialLockdownState(), '/lockdown', T0, OTHER).action).toEqual({ kind: 'ignore', why: 'foreign chat' });
    expect(lockdownStep(s, { chatId: CHAT, text: '/lockdown 123456' }, { boundChatId: null, now: T0, newCode: () => '1' }).action).toEqual({ kind: 'ignore', why: 'foreign chat' });
    expect(run(s, 'hello', T0).action).toEqual({ kind: 'ignore', why: 'not a command' });
    expect(run(s, '/rm -rf', T0).action).toEqual({ kind: 'ignore', why: 'not a command' });
    expect(run(s, '/status', T0).action).toEqual({ kind: 'status' });
    expect(run(s, '/start', T0).action.kind).toBe('reply');
    // a foreign chat does not even count as a wrong code
    expect(run(s, '/lockdown 000000', T0, OTHER).state).toBe(s);
  });

  it('the reply after a lockdown says what happened', () => {
    const ok: PanicResult = { ok: true, devices: 2, passkeys: 1, sessions: 1, vaultLocked: true, alerted: true };
    expect(panicReplyText(ok)).toMatch(/^Lockdown done: 2 device\(s\) revoked, 1 passkey\(s\) revoked, 1 session\(s\) ended, vault locked\./);
    expect(panicReplyText({ ...ok, ok: false, vaultLocked: false, errors: ['locking the vault failed: x'] })).toMatch(/WITH ERRORS.*vault NOT locked.*locking the vault failed/);
  });
});

// --- the poller, with a fake Telegram

interface Call {
  method: string;
  body: Record<string, any>;
  url: string;
}

function fakeTelegram() {
  const calls: Call[] = [];
  /** queued getUpdates answers; an empty queue answers [] */
  const batches: Array<Array<Record<string, unknown>> | { error: number; description: string } | 'hang'> = [];
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    const method = url.split('/').at(-1)!;
    const body = JSON.parse(String(init.body)) as Record<string, any>;
    calls.push({ method, body, url });
    if (method === 'getUpdates') {
      const next = batches.shift() ?? [];
      if (next === 'hang') {
        // a long poll that only ends when aborted
        return new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
        });
      }
      if (!Array.isArray(next)) return new Response(JSON.stringify({ ok: false, error_code: next.error, description: next.description }), { status: next.error });
      return new Response(JSON.stringify({ ok: true, result: next }));
    }
    return new Response(JSON.stringify({ ok: true, result: {} }));
  });
  return { calls, batches, fetch: fetchFn as unknown as typeof fetch };
}

const msg = (id: number, text: string, chatId = CHAT, date = Math.floor(T0 / 1000)) => ({ update_id: id, message: { message_id: id, date, text, chat: { id: Number(chatId), type: 'private' } } });

function poller(over: { bot?: AlarmBot | null; bound?: string | null; mainId?: string | null; panic?: () => Promise<PanicResult> } = {}) {
  const tg = fakeTelegram();
  const clock = { t: T0 };
  const panic = vi.fn(over.panic ?? (async () => ({ ok: true, devices: 1, passkeys: 0, sessions: 2, vaultLocked: true, alerted: true })));
  const bot: AlarmBot | null = over.bot === undefined ? { token: ALARM, username: 'finc_alarm_bot', savedAt: '', chatId: CHAT } : over.bot;
  const p = new AlarmPoller({
    readBot: () => bot,
    boundChatId: () => (over.bound === undefined ? CHAT : over.bound),
    mainBotId: () => over.mainId ?? '111111111',
    panic,
    status: () => 'finc: vault locked; 0 paired device(s) active',
    fetch: tg.fetch,
    now: () => clock.t,
    newCode: () => '135790',
    pollTimeoutSec: 1,
    idleCheckMs: 5,
    backoffBaseMs: 5,
    backoffMaxMs: 20,
    minRoundMs: 5,
  });
  const replies = () => tg.calls.filter((c) => c.method === 'sendMessage').map((c) => c.body.text as string);
  return { p, tg, clock, panic, replies };
}

describe('AlarmPoller', () => {
  it('polls with an offset past everything it saw, never handling an update twice', async () => {
    const { p, tg, replies } = poller();
    tg.batches.push([msg(10, '/status'), msg(11, 'hello')]);
    tg.batches.push([msg(11, '/status'), msg(12, '/status')]); // 11 again (should not happen, but must not be handled twice)
    expect(await p.tick()).toBe('polled');
    expect(tg.calls[0]!.body).toMatchObject({ timeout: 1, allowed_updates: ['message'] });
    expect(tg.calls[0]!.body.offset).toBeUndefined();
    expect(p.nextOffset).toBe(12);
    await p.tick();
    const polls = tg.calls.filter((c) => c.method === 'getUpdates');
    expect(polls[1]!.body.offset).toBe(12);
    expect(p.nextOffset).toBe(13);
    expect(replies()).toEqual(['finc: vault locked; 0 paired device(s) active', 'finc: vault locked; 0 paired device(s) active']);
    // the reply goes to the bound chat through the alarm bot, as plain text
    const send = tg.calls.find((c) => c.method === 'sendMessage')!;
    expect(send.body.chat_id).toBe(CHAT);
    expect(send.body.parse_mode).toBeUndefined();
    expect(send.url).toContain(`/bot${ALARM}/sendMessage`);
  });

  it('runs the lockdown on the right code and replies with the result; other chats get nothing', async () => {
    const { p, tg, panic, replies } = poller();
    tg.batches.push([msg(1, '/lockdown'), msg(2, '/lockdown 135790', OTHER)]);
    await p.tick();
    expect(replies()).toEqual([expect.stringContaining('/lockdown 135790')]);
    expect(panic).not.toHaveBeenCalled();
    tg.batches.push([msg(3, '/lockdown 135790')]);
    await p.tick();
    expect(panic).toHaveBeenCalledWith('Telegram (/lockdown)');
    expect(replies().at(-1)).toMatch(/^Lockdown done: 1 device\(s\) revoked, 0 passkey\(s\) revoked, 2 session\(s\) ended, vault locked/);
    expect(tg.calls.filter((c) => c.method === 'sendMessage').every((c) => c.body.chat_id === CHAT)).toBe(true);
  });

  it('skips messages sent long before (while the worker was down)', async () => {
    const { p, tg, replies } = poller();
    tg.batches.push([msg(1, '/lockdown', CHAT, Math.floor(T0 / 1000) - 3600)]);
    await p.tick();
    expect(replies()).toEqual([]);
    expect(p.nextOffset).toBe(2);
  });

  it('stays idle without a bound alarm bot, for a stale chat, or for a bot with the main bot id', async () => {
    for (const over of [{ bot: null }, { bound: null }, { bound: OTHER }, { mainId: '222222222' }]) {
      const { p, tg } = poller(over);
      expect(await p.tick(), JSON.stringify(over)).toBe('idle');
      expect(tg.calls).toEqual([]);
      p.start();
      expect(p.live, JSON.stringify(over)).toBe(false);
      await p.stop();
    }
  });

  it('is live only while started, configured and bound', async () => {
    const { p } = poller();
    expect(p.live).toBe(false);
    p.start();
    expect(p.live).toBe(true);
    await p.stop();
    expect(p.live).toBe(false);
  });

  it('pause aborts the poll in flight, drops its answer unconfirmed, and polls again only after resume', async () => {
    const { p, tg } = poller();
    tg.batches.push('hang');
    const running = p.tick();
    await vi.waitFor(() => expect(tg.calls).toHaveLength(1));
    const resume = p.pause();
    expect(await running).toBe('aborted');
    expect(p.isPaused).toBe(true);
    expect(await p.tick()).toBe('paused');
    expect(tg.calls).toHaveLength(1);
    // a second pause (nested) keeps it paused until both resume
    const resume2 = p.pause();
    resume();
    resume(); // idempotent
    expect(await p.tick()).toBe('paused');
    resume2();
    tg.batches.push([msg(5, '/status')]);
    expect(await p.tick()).toBe('polled');
    expect(p.nextOffset).toBe(6);
    // pauseWhile resumes even when the work throws
    await expect(p.pauseWhile(async () => Promise.reject(new Error('setup failed')))).rejects.toThrow('setup failed');
    expect(p.isPaused).toBe(false);
  });

  it('the loop backs off on errors, never logs the token, and stops cleanly', async () => {
    const { p, tg } = poller();
    tg.batches.push({ error: 409, description: `Conflict: terminated by other getUpdates request; bot${ALARM}` }, { error: 502, description: 'Bad Gateway' });
    tg.batches.push([msg(7, '/status')]);
    const { log } = await import('./logger.js');
    const warn = vi.spyOn(log, 'warn');
    p.start();
    await vi.waitFor(() => expect(tg.calls.some((c) => c.method === 'sendMessage')).toBe(true), { timeout: 2000 });
    await p.stop();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('backing off');
    expect(logged).not.toContain(ALARM);
    warn.mockRestore();
    const n = tg.calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(tg.calls.length).toBe(n);
  });

  it('a failing lockdown or reply never breaks the poller', async () => {
    const { p, tg } = poller({
      panic: async () => {
        throw new Error('boom');
      },
    });
    tg.batches.push([msg(1, '/lockdown')], [msg(2, '/lockdown 135790')]);
    await p.tick();
    expect(await p.tick()).toBe('polled');
    expect(p.nextOffset).toBe(3);
  });
});
