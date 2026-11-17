import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FcmSender, parseServiceAccount } from './push-fcm.js';

// what Firebase receives (push-alerts.md): a token, a random id, high priority. Never an alert. Made-up key.

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const CREDS = { projectId: 'finc-demo', clientEmail: 'push@finc-demo.iam.gserviceaccount.com', privateKey: PEM };
const quiet = { info() {}, warn() {} };

describe('FCM sender', () => {
  it('mints one access token, then sends data-only messages that carry nothing about the alert', async () => {
    const calls: Array<{ url: string; body: string; auth?: string }> = [];
    const fetchFake = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: String(init.body), ...((init.headers as Record<string, string>)?.authorization ? { auth: (init.headers as Record<string, string>).authorization } : {}) });
      if (String(url).includes('oauth2')) return new Response(JSON.stringify({ access_token: 'ya29.test', expires_in: 3600 }), { status: 200 });
      if (String(init.body).includes('gone-token')) return new Response(JSON.stringify({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }), { status: 404 });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const s = new FcmSender({ creds: () => CREDS, fetch: fetchFake, now: () => 1_800_000_000_000, log: quiet });
    const r = await s.ping(['good-token', 'gone-token']);
    expect(r).toEqual({ ok: true, invalid: ['gone-token'] });
    await s.ping(['good-token']);
    expect(calls.filter((c) => c.url.includes('oauth2'))).toHaveLength(1); // cached
    const msg = JSON.parse(calls.find((c) => c.url.includes('messages:send'))!.body);
    expect(Object.keys(msg.message).sort()).toEqual(['android', 'data', 'token']);
    expect(Object.keys(msg.message.data)).toEqual(['w']);
    expect(msg.message.android).toEqual({ priority: 'high', ttl: '900s', collapse_key: 'finc' });
    expect(msg.message.notification).toBeUndefined();
    expect(calls.find((c) => c.url.includes('messages:send'))!.url).toBe('https://fcm.googleapis.com/v1/projects/finc-demo/messages:send');
    expect(calls.find((c) => c.url.includes('messages:send'))!.auth).toBe('Bearer ya29.test');
    // the token request is a signed JWT bearer grant
    expect(new URLSearchParams(calls[0]!.body).get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
  });

  it('not set up: nothing is sent', async () => {
    let called = false;
    const s = new FcmSender({ creds: () => null, fetch: (async () => ((called = true), new Response('{}'))) as typeof fetch, log: quiet });
    expect(await s.ping(['t'])).toMatchObject({ ok: false });
    expect(called).toBe(false);
  });

  it('a service-account key file is checked before it is stored', () => {
    const file = { type: 'service_account', project_id: 'finc-demo', client_email: CREDS.clientEmail, private_key: PEM, private_key_id: 'x' };
    expect(parseServiceAccount(file)).toEqual(CREDS);
    expect(parseServiceAccount({ ...file, type: 'authorized_user' })).toBeNull();
    expect(parseServiceAccount({ ...file, client_email: 'me@gmail.com' })).toBeNull();
    expect(parseServiceAccount({ ...file, private_key: 'nope' })).toBeNull();
  });
});
