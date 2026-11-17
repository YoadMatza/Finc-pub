import { describe, expect, it } from 'vitest';
import { openDb } from '../db/db.js';
import { finishRunError, startRun } from '../db/runs.js';
import { registerDevice, revokeDevice } from '../hub/devices.js';
import { dispatchAlerts, setAlertConfig } from './index.js';
import { plainAlertText, pushTargets, queuePush, setDevicePushToken, takePendingPush } from './push.js';

// push alerts (research_notes/proposals/push-alerts.md): the queue per app device, and the dispatcher's push pass

const TOKEN_A = `fcm-token-a:${'x'.repeat(60)}`;
const TOKEN_B = `fcm-token-b:${'y'.repeat(60)}`;

function twoPhones() {
  const db = openDb(':memory:');
  const a = registerDevice(db, { name: 'Pixel' }).id;
  const b = registerDevice(db, { name: 'Tablet' }).id;
  expect(setDevicePushToken(db, a, TOKEN_A)).toBe(true);
  expect(setDevicePushToken(db, b, TOKEN_B)).toBe(true);
  return { db, a, b };
}

describe('push queue', () => {
  it('queues for every app device, hands each its own rows once, and a revoked device loses its push', () => {
    const { db, a, b } = twoPhones();
    const q = queuePush(db, [{ type: 'big_purchase', key: 'out:1', text: '💸 <b>Wolt</b> ₪120 &amp; more', urgent: true }]);
    expect(q).toEqual({ tokens: [TOKEN_A, TOKEN_B], devices: 2 });
    const first = takePendingPush(db, a);
    expect(first).toEqual([expect.objectContaining({ type: 'big_purchase', text: '💸 Wolt ₪120 & more', urgent: true, otpId: null })]);
    expect(takePendingPush(db, a)).toEqual([]); // delivered once
    expect(takePendingPush(db, b)).toHaveLength(1); // the other phone still has its own
    revokeDevice(db, b);
    expect(pushTargets(db).map((t) => t.deviceId)).toEqual([a]);
    expect(setDevicePushToken(db, b, TOKEN_B)).toBe(false);
    expect(setDevicePushToken(db, a, 'bad token with spaces')).toBe(false);
  });

  it('nothing queued without an app device', () => {
    const db = openDb(':memory:');
    expect(queuePush(db, [{ type: 'x', key: 'k', text: 't' }])).toEqual({ tokens: [], devices: 0 });
  });

  it('plain text for the notification', () => {
    expect(plainAlertText('🔐 <b>max</b> asks &lt;code&gt;')).toBe('🔐 max asks <code>');
  });
});

describe('dispatch: the push pass', () => {
  it('queues a due alert, wakes the devices with their tokens only, and never sends a key twice', async () => {
    const { db, a } = twoPhones();
    const run = startRun(db, { institutionId: 'max', source: 'scraper:max', trigger: 'scheduled' });
    finishRunError(db, run, 'GENERIC', 'the site changed');
    setAlertConfig(db, { quiet: 'off' });
    const pings: unknown[][] = [];
    const push = { ping: async (tokens: string[]) => (pings.push([...arguments_of(tokens)]), { ok: true }) };
    const r = await dispatchAlerts(db, { telegramToken: null, push });
    expect(r.sent.some((s) => s.type === 'sync_error')).toBe(true);
    // the wake-up gets tokens and nothing else
    expect(pings).toEqual([[[TOKEN_A, TOKEN_B]]]);
    expect(takePendingPush(db, a).map((p) => p.type)).toContain('sync_error');
    await dispatchAlerts(db, { telegramToken: null, push });
    expect(pings).toHaveLength(1);
    expect(takePendingPush(db, a)).toEqual([]);
  });

  it('push off for a type: nothing queued for it; a failed wake-up still counts as queued', async () => {
    const { db, a } = twoPhones();
    const run = startRun(db, { institutionId: 'max', source: 'scraper:max', trigger: 'scheduled' });
    finishRunError(db, run, 'GENERIC', 'down');
    setAlertConfig(db, { quiet: 'off', matrix: { sync_error: { push: false } } });
    await dispatchAlerts(db, { telegramToken: null, push: { ping: async () => ({ ok: true }) } });
    expect(takePendingPush(db, a).map((p) => p.type)).not.toContain('sync_error');
    setAlertConfig(db, { matrix: { sync_error: { push: true } } });
    const pings: string[][] = [];
    await dispatchAlerts(db, { telegramToken: null, push: { ping: async (t) => (pings.push(t), { ok: false, error: 'fcm down' }) } });
    await dispatchAlerts(db, { telegramToken: null, push: { ping: async (t) => (pings.push(t), { ok: true }) } });
    expect(pings).toHaveLength(1); // not queued twice
    expect(takePendingPush(db, a).filter((p) => p.type === 'sync_error')).toHaveLength(1);
  });
});

/** the ping's own arguments, as received */
function arguments_of(...args: unknown[]): unknown[] {
  return args;
}
