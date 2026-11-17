import { openDb, queuePush, registerDevice, revokeDevice } from '@finc/core';
import { afterEach, describe, expect, it } from 'vitest';
import { setPushSender } from '../alerts.js';
import { otpBroker } from '../otp-broker.js';
import type { WorkerState } from '../server.js';
import { createApp } from './app.js';

// push alerts (research_notes/proposals/push-alerts.md): the phone's token, its queue, test pushes, one-time codes

const TOKEN = 'p'.repeat(64);
const HOME = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const FCM = `fcm-token:${'z'.repeat(80)}`;

function setup() {
  const db = openDb(':memory:');
  const state = { db, vault: null, scheduler: { config: { times: [], jitterMinutes: 0, timezone: 'UTC', monthsBack: 3 }, isRunning: false, nextRun: () => null }, startedAt: Date.now() } as unknown as WorkerState;
  const { app } = createApp(state, { controlToken: TOKEN, webDist: '/nonexistent' });
  const phone = registerDevice(db, { name: 'Pixel' });
  const PHONE = { authorization: `Bearer ${phone.token}`, 'content-type': 'application/json' };
  const req = async (path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) => {
    const res = await app.request(path, { method: init.method ?? 'GET', headers: init.headers ?? {}, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
  };
  return { db, req, PHONE, phoneId: phone.id };
}

afterEach(() => setPushSender(null));

describe('push alerts API', () => {
  it('only the paired phone registers a push token and fetches its alerts, once', async () => {
    const env = setup();
    expect((await env.req('/api/devices/me/push-token', { method: 'POST', headers: HOME, body: { token: FCM } })).status).toBe(403);
    expect((await env.req('/api/devices/me/push-token', { method: 'POST', headers: env.PHONE, body: { token: 'bad token' } })).status).toBe(400);
    expect((await env.req('/api/devices/me/push-token', { method: 'POST', headers: env.PHONE, body: { token: FCM } })).status).toBe(200);
    queuePush(env.db, [{ type: 'big_purchase', key: 'out:1', text: '💸 <b>Wolt</b> ₪120' }]);
    expect((await env.req('/api/alerts/pending', { headers: HOME })).status).toBe(403);
    const got = await env.req('/api/alerts/pending', { headers: env.PHONE });
    expect(got.body.items).toEqual([expect.objectContaining({ type: 'big_purchase', text: '💸 Wolt ₪120' })]);
    expect((await env.req('/api/alerts/pending', { headers: env.PHONE })).body.items).toEqual([]);
    // revoked: no more push, and its token is useless
    revokeDevice(env.db, env.phoneId);
    expect((await env.req('/api/alerts/pending', { headers: env.PHONE })).status).toBe(401);
  });

  it("the background receiver's push secret: its own alerts and its token, nothing else; revoking ends it", async () => {
    const env = setup();
    const reg = await env.req('/api/devices/me/push-token', { method: 'POST', headers: env.PHONE, body: { token: FCM } });
    const secret = reg.body.pushSecret as string;
    expect(secret).toMatch(/^finc_push_/);
    const SECRET = { authorization: `Bearer ${secret}`, 'content-type': 'application/json' };
    queuePush(env.db, [{ type: 'unusual_charge', key: 'u:1', text: 'x' }]);
    expect((await env.req('/push/pending', { headers: SECRET })).body.items).toHaveLength(1);
    expect((await env.req('/push/pending', { headers: env.PHONE })).status).toBe(401); // the device token does not work here
    expect((await env.req('/api/alerts', { headers: SECRET })).status).toBe(401); // and the secret works nowhere else
    expect((await env.req('/push/token', { method: 'POST', headers: SECRET, body: { token: `${FCM}-new` } })).status).toBe(200);
    // registering again rotates the secret
    const again = await env.req('/api/devices/me/push-token', { method: 'POST', headers: env.PHONE, body: { token: FCM } });
    expect(again.body.pushSecret).not.toBe(secret);
    expect((await env.req('/push/pending', { headers: SECRET })).status).toBe(401);
    revokeDevice(env.db, env.phoneId);
    expect((await env.req('/push/pending', { headers: { authorization: `Bearer ${again.body.pushSecret}` } })).status).toBe(401);
  });

  it('a test push wakes the devices with their tokens only; the status says how many', async () => {
    const env = setup();
    await env.req('/api/devices/me/push-token', { method: 'POST', headers: env.PHONE, body: { token: FCM } });
    expect((await env.req('/api/alerts/push-test', { method: 'POST', headers: HOME })).body).toMatchObject({ ok: false, devices: 0 });
    const pings: string[][] = [];
    setPushSender({ ping: async (tokens) => (pings.push(tokens), { ok: true, invalid: [] }) });
    expect((await env.req('/api/alerts', { headers: HOME })).body.push).toEqual({ configured: true, devices: 1 });
    expect((await env.req('/api/alerts/push-test', { method: 'POST', headers: HOME })).body).toEqual({ ok: true, devices: 1 });
    expect(pings).toEqual([[FCM]]);
    expect((await env.req('/api/alerts/pending', { headers: env.PHONE })).body.items[0].type).toBe('test');
    // a token Firebase no longer knows is dropped
    setPushSender({ ping: async (tokens) => ({ ok: false, error: 'fcm UNREGISTERED', invalid: tokens }) });
    await env.req('/api/alerts/push-test', { method: 'POST', headers: HOME });
    expect((await env.req('/api/alerts', { headers: HOME })).body.push.devices).toBe(0);
  });

  it('the matrix takes a push column', async () => {
    const env = setup();
    expect((await env.req('/api/alerts', { method: 'PATCH', headers: HOME, body: { matrix: { big_purchase: { push: false } } } })).status).toBe(200);
    expect((await env.req('/api/alerts', { headers: HOME })).body.config.matrix.big_purchase).toEqual({ telegram: true, push: false });
  });

  it('one-time codes: a waiting sync gets the code typed in the app', async () => {
    const env = setup();
    const r = otpBroker.request('max', 60_000);
    const list = await env.req('/api/otp/pending', { headers: env.PHONE });
    expect(list.body.requests).toEqual([expect.objectContaining({ id: r.id, institutionId: 'max' })]);
    expect((await env.req(`/api/otp/${r.id}`, { method: 'POST', headers: env.PHONE, body: { code: '12' } })).status).toBe(400);
    expect((await env.req(`/api/otp/${r.id}`, { method: 'POST', headers: env.PHONE, body: { code: '123456' } })).status).toBe(200);
    await expect(r.code).resolves.toBe('123456');
    expect((await env.req(`/api/otp/${r.id}`, { method: 'POST', headers: env.PHONE, body: { code: '123456' } })).status).toBe(404);
  });
});
