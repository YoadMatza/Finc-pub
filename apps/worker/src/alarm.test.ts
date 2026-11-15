import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault, getSetting, openDb, setAlertConfig, setSetting, vaultPath } from '@finc/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { alarmPath, readAlarmBot, saveAlarmBot } from './alarm.js';
import { SECURITY_SETTINGS, canSendSecurityAlerts, securityAlert, securityAlertStatus, securityChannel, sendSecurityAlert, telegramOtp } from './alerts.js';
import { createApp } from './api/app.js';
import { vaultValueProblem } from './cli/vault.js';
import { healthPayload, type WorkerState } from './server.js';

// security research P1-05: a send-only alarm bot outside the vault carries security alerts while the vault is locked

const MAIN = `111111111:${'M'.repeat(35)}`;
const ALARM = `222222222:${'A'.repeat(35)}`;
const CHAT = '424242';
const CONTROL = 'd'.repeat(64);
const RIGHT = 'right-horse-42';
const savedDataDir = process.env.FINC_DATA_DIR;
let tmp: string;

interface Sent {
  token: string;
  method: string;
  body: Record<string, unknown>;
}
let sent: Sent[] = [];
/** What Telegram answers, per call. */
let answer: (s: Sent) => Record<string, unknown> = (s) => (s.method === 'getMe' ? { ok: true, result: { id: Number(s.token.split(':')[0]), username: 'finc_alarm_bot' } } : { ok: true, result: {} });

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'finc-alarm-'));
  process.env.FINC_DATA_DIR = tmp; // never the real data folder
  const v = await Vault.create(vaultPath(), RIGHT, { ops: 1, mem: 1024 * 1024 });
  v.set('telegram', 'token', { token: MAIN });
  v.lock();
});
afterAll(() => {
  if (savedDataDir === undefined) delete process.env.FINC_DATA_DIR;
  else process.env.FINC_DATA_DIR = savedDataDir;
  rmSync(tmp, { recursive: true, force: true });
});

let state: WorkerState;
let app: ReturnType<typeof createApp>['app'];
beforeEach(() => {
  rmSync(alarmPath(), { force: true });
  sent = [];
  answer = (s) => (s.method === 'getMe' ? { ok: true, result: { id: Number(s.token.split(':')[0]), username: 'finc_alarm_bot' } } : { ok: true, result: {} });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const m = /\/bot([^/]+)\/(\w+)$/.exec(String(url));
      const s: Sent = { token: m?.[1] ?? '', method: m?.[2] ?? '', body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown> };
      sent.push(s);
      return new Response(JSON.stringify(answer(s)), { headers: { 'content-type': 'application/json' } });
    }),
  );
  const db = openDb(':memory:');
  setAlertConfig(db, { telegramChatId: CHAT });
  state = { db, vault: null, scheduler: { config: { times: [], jitterMinutes: 0, timezone: 'UTC', monthsBack: 3 }, isRunning: false, nextRun: () => null, onUnlocked: () => {} } as never, startedAt: Date.now() };
  app = createApp(state, { controlToken: CONTROL, webDist: '/nonexistent' }).app;
});
afterEach(() => vi.unstubAllGlobals());

const messages = () => sent.filter((s) => s.method === 'sendMessage');
const openVault = () => Vault.open(vaultPath(), RIGHT);
const alarmFile = (chatId: string | null = CHAT) => saveAlarmBot({ token: ALARM, username: 'finc_alarm_bot', savedAt: new Date().toISOString(), chatId });

describe('security alerts (P1-05)', () => {
  it('go as plain text: a hostile name arrives byte for byte, with no parse mode', async () => {
    state.vault = await openVault();
    const r = await sendSecurityAlert(state.db, state.vault, 'a passkey was added: "<a href="x">me</a> & co"');
    expect(r).toEqual({ ok: true, channel: 'main' });
    const [m] = messages();
    expect(m?.token).toBe(MAIN);
    expect(m?.body).not.toHaveProperty('parse_mode');
    expect(m?.body.text).toBe('🔒 a passkey was added: "<a href="x">me</a> & co"');
    expect(m?.body.chat_id).toBe(CHAT);
  });

  it('other messages keep HTML as the default parse mode', async () => {
    const { telegramSend } = await import('@finc/core');
    await telegramSend(MAIN, CHAT, '<b>x</b>');
    expect(messages()[0]?.body.parse_mode).toBe('HTML');
  });

  it('without an alarm bot: the main bot while unlocked, nothing while locked (the old behaviour)', async () => {
    expect(canSendSecurityAlerts(state.db, null)).toBe(false);
    expect(securityChannel(state.db, null)).toBe('none');
    expect(await sendSecurityAlert(state.db, null, 'x')).toEqual({ ok: false, channel: 'none' });
    expect(sent).toEqual([]);
    state.vault = await openVault();
    expect(securityChannel(state.db, state.vault)).toBe('main');
    // the main bot's id (not its token) is remembered, to refuse it as the alarm bot while locked
    expect(getSetting(state.db, 'telegram.mainBotId')).toBe('111111111');
  });

  it('with an alarm bot: delivered while the vault is locked, and used when unlocked too', async () => {
    alarmFile();
    expect(canSendSecurityAlerts(state.db, null)).toBe(true);
    securityAlert(state.db, null, 'the vault is locked; the scheduled sync is waiting');
    await vi.waitFor(() => expect(messages()).toHaveLength(1));
    expect(messages()[0]?.token).toBe(ALARM);
    expect(messages()[0]?.body.text).toBe('🔒 the vault is locked; the scheduled sync is waiting');
    state.vault = await openVault();
    expect(securityChannel(state.db, state.vault)).toBe('alarm');
  });

  it('no channel without a bound chat, even with an alarm bot', () => {
    alarmFile();
    setAlertConfig(state.db, { telegramChatId: null });
    expect(canSendSecurityAlerts(state.db, null)).toBe(false);
  });

  it('a failed send is retried once, then recorded for /health without the token', async () => {
    alarmFile();
    answer = () => ({ ok: false, error_code: 500, description: `Internal error for bot${ALARM}` });
    const r = await sendSecurityAlert(state.db, null, 'x', { retryDelayMs: 0 });
    expect(r.ok).toBe(false);
    expect(messages()).toHaveLength(2);
    const err = getSetting(state.db, SECURITY_SETTINGS.lastError);
    expect(err).toMatch(/^alarm bot: Internal error/);
    expect(err).not.toContain(ALARM);
    expect(getSetting(state.db, SECURITY_SETTINGS.lastErrorAt)).toBeTruthy();
    const h = healthPayload(state) as { securityAlerts: Record<string, unknown> };
    expect(h.securityAlerts).toMatchObject({ channel: 'alarm', alarmBot: 'finc_alarm_bot', lastError: err });
    expect(JSON.stringify(h)).not.toContain(ALARM.split(':')[1]);
  });

  it('a send that works on the retry records no error', async () => {
    alarmFile();
    let n = 0;
    answer = () => (n++ === 0 ? { ok: false, description: 'Too Many Requests' } : { ok: true, result: {} });
    expect((await sendSecurityAlert(state.db, null, 'x', { retryDelayMs: 0 })).ok).toBe(true);
    expect(getSetting(state.db, SECURITY_SETTINGS.lastError)).toBeNull();
  });

  it('a damaged alarm file counts as none', () => {
    saveAlarmBot({ token: 'nope', username: null, savedAt: '', chatId: CHAT });
    expect(readAlarmBot()).toBeNull();
  });

  it('a wrong master password while locked alerts at once through the alarm bot', async () => {
    alarmFile();
    const r = await app.request('/unlock', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${CONTROL}` }, body: JSON.stringify({ password: 'wrong-one' }) });
    expect(r.status).toBe(401);
    await vi.waitFor(() => expect(messages().map((m) => m.body.text)).toContainEqual(expect.stringMatching(/^🔒 a wrong master password was tried \(control port\), 1 in a row.*the vault stays locked/)));
    // and it is not reported a second time after the unlock
    sent = [];
    expect((await app.request('/unlock', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${CONTROL}` }, body: JSON.stringify({ password: RIGHT }) })).status).toBe(200);
    await new Promise((r2) => setTimeout(r2, 20));
    expect(messages().filter((m) => /while the vault was locked/.test(String(m.body.text)))).toEqual([]);
  });
});

describe('the alarm endpoints (P1-05)', () => {
  const control = { 'content-type': 'application/json', authorization: `Bearer ${CONTROL}` };
  const setup = (token: string, headers: Record<string, string> = control) => app.request('/alarm/setup', { method: 'POST', headers, body: JSON.stringify({ token }) });
  const errorOf = async (r: Response) => ((await r.json()) as { error?: string }).error ?? '';

  it('setup checks the bot, sends a test message, and only then saves the file (owner-only)', async () => {
    state.vault = await openVault();
    const r = await setup(ALARM);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, bot: 'finc_alarm_bot' });
    expect(readAlarmBot()?.token).toBe(ALARM);
    if (process.platform !== 'win32') expect(statSync(alarmPath()).mode & 0o777).toBe(0o600);
    const test = messages().find((m) => m.token === ALARM);
    expect(test?.body.chat_id).toBe(CHAT);
    expect(test?.body).not.toHaveProperty('parse_mode');
    const status = (await (await app.request('/alarm', { headers: control })).json()) as Record<string, unknown>;
    expect(status).toMatchObject({ configured: true, bot: 'finc_alarm_bot', channel: 'alarm', chatBound: true });
    expect(JSON.stringify(status)).not.toContain(ALARM);
  });

  it('refuses the main bot: the same token, or the same bot id with another secret', async () => {
    state.vault = await openVault();
    const r = await setup(MAIN);
    expect(r.status).toBe(400);
    expect(await errorOf(r)).toMatch(/main finc bot/);
    expect((await setup(`111111111:${'Z'.repeat(35)}`)).status).toBe(400);
    expect(sent).toEqual([]);
    expect(existsSync(alarmPath())).toBe(false);
  });

  it('refuses while the vault is locked, whatever main-bot id was remembered', async () => {
    setSetting(state.db, 'telegram.mainBotId', '999999999'); // stale: compared with the live token only
    const r = await setup(ALARM);
    expect(r.status).toBe(409);
    expect(await errorOf(r)).toMatch(/unlock the vault first/);
    expect(existsSync(alarmPath())).toBe(false);
  });

  it('saves the chat it was tested with', async () => {
    state.vault = await openVault();
    expect((await setup(ALARM)).status).toBe(200);
    expect(readAlarmBot()?.chatId).toBe(CHAT);
  });

  it('refuses a malformed token and a missing chat, without calling Telegram', async () => {
    state.vault = await openVault();
    expect((await setup('12345:short')).status).toBe(400);
    setAlertConfig(state.db, { telegramChatId: null });
    const r = await setup(ALARM);
    expect(r.status).toBe(409);
    expect(await errorOf(r)).toMatch(/no Telegram chat is bound/);
    expect(sent).toEqual([]);
    expect(existsSync(alarmPath())).toBe(false);
  });

  it('does not save when the test message fails, and says to press Start', async () => {
    state.vault = await openVault();
    answer = (s) => (s.method === 'getMe' ? { ok: true, result: { id: 222222222, username: 'finc_alarm_bot' } } : { ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" });
    const r = await setup(ALARM);
    expect(r.status).toBe(409);
    expect(await errorOf(r)).toMatch(/open @finc_alarm_bot in Telegram and press Start/);
    expect(existsSync(alarmPath())).toBe(false);
    answer = () => ({ ok: false, description: 'Unauthorized' });
    expect((await setup(ALARM)).status).toBe(400); // getMe refused the token
    expect(existsSync(alarmPath())).toBe(false);
  });

  it('test and remove work through the alarm bot; remove deletes the file', async () => {
    alarmFile();
    const t = await app.request('/alarm/test', { method: 'POST', headers: control });
    expect(await t.json()).toEqual({ ok: true, channel: 'alarm' });
    const d = await app.request('/alarm', { method: 'DELETE', headers: control });
    expect(await d.json()).toEqual({ ok: true, removed: true });
    expect(existsSync(alarmPath())).toBe(false);
    expect(messages().map((m) => m.body.text)).toContainEqual(expect.stringMatching(/alarm bot was removed/));
    expect((await app.request('/alarm/test', { method: 'POST', headers: control })).status).toBe(409); // locked, no alarm bot
  });

  it('refuse a session cookie, a device token, no token, and the public edge even with the control token', async () => {
    alarmFile();
    const json = { 'content-type': 'application/json' };
    const s = await app.request('/api/auth/setup', { method: 'POST', headers: json, body: JSON.stringify({ pin: 'kiwi-2048' }) });
    const cookie = s.headers.get('set-cookie')!.split(';')[0]!;
    const pairing = (await (await app.request('/api/devices/pairings', { method: 'POST', headers: { ...json, cookie }, body: JSON.stringify({ name: 'Galaxy' }) })).json()) as { code: string };
    const paired = (await (await app.request('/api/devices/pair', { method: 'POST', headers: json, body: JSON.stringify({ code: pairing.code }) })).json()) as { token: string };
    await new Promise((r) => setTimeout(r, 20)); // the pairing's own security alerts
    sent = [];
    const variants: Record<string, string>[] = [json, { ...json, cookie }, { ...json, authorization: `Bearer ${paired.token}` }, { ...control, 'x-finc-edge': 'public', 'x-forwarded-for': '172.18.0.1' }, { ...control, 'x-forwarded-for': '203.0.113.7' }];
    for (const headers of variants) {
      expect([401, 403]).toContain((await setup(ALARM, headers)).status);
      expect([401, 403]).toContain((await app.request('/alarm', { headers })).status);
      expect([401, 403]).toContain((await app.request('/alarm/test', { method: 'POST', headers })).status);
      expect([401, 403]).toContain((await app.request('/alarm', { method: 'DELETE', headers })).status);
    }
    expect(existsSync(alarmPath())).toBe(true);
    expect(sent).toEqual([]);
  });
});

describe('alarm bot fallbacks (review 2026-11-10)', () => {
  const control = { 'content-type': 'application/json', authorization: `Bearer ${CONTROL}` };
  const unlockWith = (password: string) => app.request('/unlock', { method: 'POST', headers: control, body: JSON.stringify({ password }) });

  it('a chat rebound after setup makes the alarm bot stale: the main bot carries alerts, and status says so', async () => {
    alarmFile('111'); // tested with another chat
    expect(securityChannel(state.db, null)).toBe('none'); // never sent to a chat the alarm bot was not started in
    expect(securityAlertStatus(state.db, null)).toMatchObject({ channel: 'none', alarmStale: true, alarmBot: 'finc_alarm_bot' });
    state.vault = await openVault();
    expect(securityAlertStatus(state.db, state.vault)).toMatchObject({ channel: 'main', alarmStale: true });
    await sendSecurityAlert(state.db, state.vault, 'x');
    expect(messages().map((m) => m.token)).toEqual([MAIN]);
    const status = (await (await app.request('/alarm', { headers: control })).json()) as Record<string, unknown>;
    expect(status).toMatchObject({ configured: true, channel: 'main', alarmStale: true });
  });

  it('rebinding the chat in the hub says the alarm bot needs setup again', async () => {
    alarmFile();
    state.vault = await openVault();
    const json = { 'content-type': 'application/json' };
    const s = await app.request('/api/auth/setup', { method: 'POST', headers: json, body: JSON.stringify({ pin: 'kiwi-2048' }) });
    const cookie = s.headers.get('set-cookie')!.split(';')[0]!;
    const { code } = (await (await app.request('/api/alerts/telegram/code', { method: 'POST', headers: { ...json, cookie } })).json()) as { code: string };
    answer = (q) => (q.method === 'getUpdates' ? { ok: true, result: [{ update_id: 7, message: { message_id: 1, date: Math.floor(Date.now() / 1000), text: `/start ${code}`, chat: { id: 555, type: 'private', first_name: 'Dana' } } }] } : { ok: true, result: { id: 111111111, username: 'finc_main_bot' } });
    const r = (await (await app.request('/api/alerts/telegram/discover', { method: 'POST', headers: { ...json, cookie } })).json()) as Record<string, unknown>;
    expect(r).toMatchObject({ ok: true, alarmNeedsSetup: true });
    expect(String(r.note)).toMatch(/finc alerts alarm setup/);
    expect(securityAlertStatus(state.db, state.vault)).toMatchObject({ channel: 'main', alarmStale: true });
  });

  it('a failing alarm bot falls back to the main bot while the vault is open, and records it', async () => {
    alarmFile();
    state.vault = await openVault();
    answer = (q) => (q.token === ALARM ? { ok: false, error_code: 401, description: 'Unauthorized' } : { ok: true, result: {} });
    const r = await sendSecurityAlert(state.db, state.vault, 'x', { retryDelayMs: 0 });
    expect(r).toEqual({ ok: true, channel: 'main', fallback: true });
    expect(messages().map((m) => m.token)).toEqual([ALARM, ALARM, MAIN]);
    expect(messages()[2]?.body).not.toHaveProperty('parse_mode');
    expect(getSetting(state.db, SECURITY_SETTINGS.lastChannel)).toBe('main');
    expect(getSetting(state.db, SECURITY_SETTINGS.lastError)).toMatch(/^alarm bot: Unauthorized; delivered through the main bot instead$/);
    // every channel failing is recorded as such
    answer = () => ({ ok: false, description: 'Bad Gateway' });
    expect((await sendSecurityAlert(state.db, state.vault, 'y', { retryDelayMs: 0 })).ok).toBe(false);
    expect(getSetting(state.db, SECURITY_SETTINGS.lastChannel)).toBe('failed');
    expect(getSetting(state.db, SECURITY_SETTINGS.lastError)).toBe('alarm bot: Bad Gateway; main bot: Bad Gateway');
  });

  it('a wrong master password whose alert fails while locked is reported after the next unlock', async () => {
    alarmFile();
    answer = () => ({ ok: false, description: 'Bad Gateway' });
    expect((await unlockWith('wrong-one')).status).toBe(401); // answered at once, before the alert's retry
    await vi.waitFor(() => expect(getSetting(state.db, SECURITY_SETTINGS.lastChannel)).toBe('failed'), { timeout: 8000 });
    await new Promise((r) => setTimeout(r, 20));
    answer = () => ({ ok: true, result: {} });
    sent = [];
    expect((await unlockWith(RIGHT)).status).toBe(200);
    await vi.waitFor(() => expect(messages().map((m) => m.body.text)).toContainEqual(expect.stringMatching(/^🔒 1 wrong master password attempt\(s\) while the vault was locked/)));
  });

  it('finc vault set telegram refuses the alarm bot', () => {
    expect(vaultValueProblem('telegram', ALARM)).toBeNull(); // no alarm bot yet
    alarmFile();
    expect(vaultValueProblem('telegram', ALARM)).toMatch(/alarm bot/);
    expect(vaultValueProblem('telegram', `222222222:${'Q'.repeat(35)}`)).toMatch(/alarm bot/); // same bot id
    expect(vaultValueProblem('telegram', MAIN)).toBeNull();
    expect(vaultValueProblem('ai_openai', ALARM)).toBeNull();
  });

  it('the OTP relay (main bot) still sends HTML', async () => {
    state.vault = await openVault();
    let polls = 0;
    answer = (q) => (q.method === 'getUpdates' ? { ok: true, result: polls++ === 0 ? [] : [{ update_id: 3, message: { message_id: 2, date: 0, text: '123456', chat: { id: Number(CHAT), type: 'private' } } }] } : { ok: true, result: {} });
    const code = await telegramOtp(state.db, () => state.vault)({ institutionId: 'max' } as never);
    expect(code).toBe('123456');
    const m = messages()[0];
    expect(m?.token).toBe(MAIN);
    expect(m?.body.parse_mode).toBe('HTML');
    expect(String(m?.body.text)).toContain('<b>max</b>');
  });
});
