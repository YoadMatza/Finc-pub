import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault, openDb, vaultPath } from '@finc/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerState } from '../server.js';
import { createApp } from './app.js';

// security research P1-01: counted before the slow check, one check at a time, home only, alerts
vi.mock('../alerts.js', async (orig) => ({ ...(await orig<typeof import('../alerts.js')>()), securityAlert: vi.fn() }));
const { securityAlert } = await import('../alerts.js');
const alerts = () => vi.mocked(securityAlert).mock.calls.map((c) => c[2]);

const TOKEN = 'c'.repeat(64);
const RIGHT = 'right-horse-42';
const savedDataDir = process.env.FINC_DATA_DIR;
let tmp: string;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'finc-unlock-'));
  process.env.FINC_DATA_DIR = tmp;
  const v = await Vault.create(vaultPath(), RIGHT, { ops: 1, mem: 1024 * 1024 });
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
  vi.mocked(securityAlert).mockClear();
  state = { db: openDb(':memory:'), vault: null, scheduler: { config: { times: [], jitterMinutes: 0, timezone: 'UTC', monthsBack: 3 }, isRunning: false, nextRun: () => null, onUnlocked: () => {} } as never, startedAt: Date.now() };
  app = createApp(state, { controlToken: TOKEN, webDist: '/nonexistent' }).app;
});

const unlock = (password: string, headers: Record<string, string> = {}) =>
  app.request('/unlock', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...headers }, body: JSON.stringify({ password }) }).then((r) => r.status);

describe('vault unlock (P1-01)', () => {
  it('is refused from the internet, even with the control token', async () => {
    expect(await unlock(RIGHT, { 'x-finc-edge': 'public', 'x-forwarded-for': '172.18.0.1' })).toBe(403);
    expect(await unlock(RIGHT, { 'x-forwarded-for': '203.0.113.7' })).toBe(403);
    expect(state.vault).toBeNull();
  });

  it('a burst of parallel guesses gets at most a handful of password checks, the rest are refused', async () => {
    const statuses = await Promise.all(Array.from({ length: 20 }, (_, i) => unlock(`guess-${i}`)));
    const checked = statuses.filter((s) => s === 401).length;
    expect(checked).toBeGreaterThanOrEqual(1);
    expect(checked).toBeLessThanOrEqual(5); // the per-client limit, counted before any await
    expect(statuses.filter((s) => s === 429).length).toBe(20 - checked);
  });

  it('wrong passwords escalate to a global pause that holds even for the right password', async () => {
    for (let i = 0; i < 4; i++) expect(await unlock(`wrong-${i}`, { 'x-forwarded-for': `192.168.1.${10 + i}` })).toBe(401);
    // a different client, the right password: still paused (every internet client looks the same anyway)
    expect(await unlock(RIGHT, { 'x-forwarded-for': '192.168.1.99' })).toBe(429);
    expect(state.vault).toBeNull();
  });

  it('failures while locked are reported once, right after the next unlock', async () => {
    expect(await unlock('wrong-a')).toBe(401);
    expect(await unlock('wrong-b')).toBe(401);
    expect(alerts().filter((t) => /master password/.test(t))).toEqual([]); // no Telegram token while locked
    expect(await unlock(RIGHT)).toBe(200);
    expect(state.vault?.locked).toBe(false);
    const sent = alerts().filter((t) => /master password/.test(t));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^2 wrong master password attempt\(s\) while the vault was locked/);
    // reported once only
    expect(await unlock(RIGHT)).toBe(200);
    expect(alerts().filter((t) => /master password/.test(t))).toHaveLength(1);
  });

  it('a wrong password while unlocked alerts at once', async () => {
    expect(await unlock(RIGHT)).toBe(200);
    vi.mocked(securityAlert).mockClear();
    expect(await unlock('nope')).toBe(401);
    expect(alerts()).toEqual([expect.stringMatching(/^a wrong master password was tried \(control port\), 1 in a row/)]);
    expect(state.vault?.locked).toBe(false); // the open vault is left as it was
  });

  it('a phone device token is refused at home and from the internet; /unlock takes only the control token', async () => {
    const json = { 'content-type': 'application/json' };
    const setup = await app.request('/api/auth/setup', { method: 'POST', headers: json, body: JSON.stringify({ pin: 'kiwi-2048' }) });
    const cookie = setup.headers.get('set-cookie')!.split(';')[0]!;
    const pairing = (await (await app.request('/api/devices/pairings', { method: 'POST', headers: { ...json, cookie }, body: JSON.stringify({ name: 'Galaxy' }) })).json()) as { code: string };
    const paired = (await (await app.request('/api/devices/pair', { method: 'POST', headers: json, body: JSON.stringify({ code: pairing.code }) })).json()) as { token: string };
    const dev = { ...json, authorization: `Bearer ${paired.token}` };
    const body = JSON.stringify({ password: RIGHT });
    expect((await app.request('/api/vault/unlock', { method: 'POST', headers: { ...dev, 'x-finc-edge': 'public', 'x-forwarded-for': '172.18.0.1' }, body })).status).toBe(403);
    expect((await app.request('/api/vault/unlock', { method: 'POST', headers: { ...dev, 'x-forwarded-for': '192.168.1.7' }, body })).status).toBe(403);
    expect((await app.request('/unlock', { method: 'POST', headers: dev, body })).status).toBe(401);
    expect((await app.request('/unlock', { method: 'POST', headers: { ...json, cookie }, body })).status).toBe(401);
    expect(state.vault).toBeNull();
    // the PC's browser session at home can
    expect((await app.request('/api/vault/unlock', { method: 'POST', headers: { ...json, cookie }, body })).status).toBe(200);
  });

  it('every attempt is counted before the body is read, and a bad body never holds the gate', async () => {
    const bad = () => app.request('/unlock', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: '{not json' }).then((r) => r.status);
    expect(await bad()).toBe(400);
    expect(await unlock(RIGHT, { 'x-forwarded-for': '192.168.1.50' })).toBe(200); // the gate is free again
    for (let i = 0; i < 4; i++) expect(await bad()).toBe(400);
    expect(await unlock(RIGHT)).toBe(429); // five counted attempts from this client in 10 minutes, none a password check
  });

  it('refuses an empty or huge password without checking it', async () => {
    expect(await unlock('')).toBe(400);
    expect(await unlock('x'.repeat(1025))).toBe(400);
    const r = await app.request('/api/vault/unlock', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ password: 'x'.repeat(1025) }) });
    expect(r.status).toBe(400);
  });
});

describe('PIN sign-in (P1-01)', () => {
  it('a burst of parallel wrong PINs is counted before the hash check', async () => {
    const setup = await app.request('/api/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: 'kiwi-2048' }) });
    expect(setup.status).toBe(200);
    const statuses = await Promise.all(Array.from({ length: 20 }, () => app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: 'nope-1' }) }).then((r) => r.status)));
    expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(5);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(15);
  });
});
