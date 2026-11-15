import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type AlertKind,
  REMIND_EVERY_MS,
  type TlsConfig,
  type TlsProbe,
  TlsWatch,
  alertText,
  decide,
  expiringSoon,
  initialMemory,
  probeTls,
  settle,
  spkiPin,
  tlsConfigFromEnv,
} from './tlswatch.js';

// security research P1-10: the worker checks that Caddy still serves the key the phone app pins.
// The certificates under __fixtures__/tls are TEST-ONLY (a throwaway CA for finc-example.test; see TEST-ONLY.txt).

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'tls');
const CA = readFileSync(path.join(dir, 'ca.crt'), 'utf8');
const LEAF = readFileSync(path.join(dir, 'leaf.crt'), 'utf8');
const KEY = readFileSync(path.join(dir, 'leaf.key'), 'utf8');
const LEAF_PIN = spkiPin(new X509Certificate(LEAF));
const LEAF_END = Date.parse(new X509Certificate(LEAF).validTo);
const BACKUP_PIN = 'B'.repeat(43) + '=';
const OTHER_PIN = 'Z'.repeat(43) + '=';
const NAME = 'finc-example.test';

let server: tls.Server;
let port: number;
let silent: net.Server;
let silentPort: number;

const listen = (s: net.Server): Promise<number> => new Promise((r) => s.listen(0, '127.0.0.1', () => r((s.address() as net.AddressInfo).port)));

beforeAll(async () => {
  server = tls.createServer({ key: KEY, cert: LEAF }, (sock) => sock.end());
  server.on('tlsClientError', () => undefined); // a client that rejects our certificate (the wrong-CA tests)
  port = await listen(server);
  // accepts TCP and never answers: the timeout path
  silent = net.createServer(() => undefined);
  silentPort = await listen(silent);
});
afterAll(() => {
  server.close();
  silent.close();
});

const cfg = (over: Partial<TlsConfig> = {}): TlsConfig => ({ host: '127.0.0.1', port, servername: NAME, pins: [LEAF_PIN, BACKUP_PIN], ...over });

describe('tlsConfigFromEnv', () => {
  it('is disabled without pins or without a public host', () => {
    expect(tlsConfigFromEnv({ FINC_PUBLIC_HOST: NAME })).toBeNull();
    expect(tlsConfigFromEnv({ FINC_PUBLIC_HOST: NAME, FINC_TLS_PINS: ' , ' })).toBeNull();
    expect(tlsConfigFromEnv({ FINC_TLS_PINS: LEAF_PIN })).toBeNull();
    expect(tlsConfigFromEnv({ FINC_TLS_PINS: LEAF_PIN, FINC_PUBLIC_HOST: '' })).toBeNull();
  });

  it('a malformed pin disables the watch instead of raising a daily false alarm', () => {
    expect(tlsConfigFromEnv({ FINC_PUBLIC_HOST: NAME, FINC_TLS_PINS: `${LEAF_PIN},abc` })).toBeNull();
    expect(tlsConfigFromEnv({ FINC_PUBLIC_HOST: NAME, FINC_TLS_PINS: LEAF_PIN.slice(0, 40) })).toBeNull();
    expect(tlsConfigFromEnv({ FINC_PUBLIC_HOST: NAME, FINC_TLS_PINS: LEAF_PIN })).not.toBeNull();
  });
  it('reads the defaults and a comma list (plain or sha256/ form)', () => {
    expect(tlsConfigFromEnv({ FINC_PUBLIC_HOST: NAME, FINC_TLS_PINS: ` ${LEAF_PIN}, sha256/${BACKUP_PIN} ` })).toEqual({ host: 'caddy', port: 7443, servername: NAME, pins: [LEAF_PIN, BACKUP_PIN] });
    expect(tlsConfigFromEnv({ FINC_PUBLIC_HOST: NAME, FINC_TLS_PINS: LEAF_PIN, FINC_TLS_CHECK_HOST: 'edge', FINC_PUBLIC_PORT: '8443' })).toMatchObject({ host: 'edge', port: 8443 });
  });
});

describe('probeTls (a local TLS server with a test certificate)', () => {
  it('ok: the served key is pinned and the certificate is far from expiry', async () => {
    const p = await probeTls(cfg(), { ca: CA });
    expect(p).toMatchObject({ state: 'ok', servedPin: LEAF_PIN, reason: null });
    expect(p.daysLeft).toBeGreaterThan(14);
  });
  it('ok when the served key is the backup pin (second in the list)', async () => {
    expect((await probeTls(cfg({ pins: [BACKUP_PIN, LEAF_PIN] }), { ca: CA })).state).toBe('ok');
  });
  it('key_changed: a valid certificate whose key is not pinned', async () => {
    const p = await probeTls(cfg({ pins: [OTHER_PIN, BACKUP_PIN] }), { ca: CA });
    expect(p).toMatchObject({ state: 'key_changed', servedPin: LEAF_PIN });
  });
  it('cert_invalid: less than 1/6 of its lifetime left', async () => {
    const p = await probeTls(cfg(), { ca: CA, now: () => LEAF_END - 5 * 86_400_000 - 1000 });
    expect(p).toMatchObject({ state: 'cert_invalid', daysLeft: 5, reason: 'expires soon' });
    // the fixture lives ~7000 days, so 1000 days left is already under 1/6
    expect((await probeTls(cfg(), { ca: CA, now: () => LEAF_END - 1000 * 86_400_000 })).state).toBe('cert_invalid');
    expect((await probeTls(cfg(), { ca: CA, now: () => LEAF_END - 1300 * 86_400_000 })).state).toBe('ok');
  });
  it('cert_invalid: a chain the client does not trust (wrong CA)', async () => {
    const p = await probeTls(cfg());
    expect(p.state).toBe('cert_invalid');
    expect(p.servedPin).toBeNull();
    expect(p.reason).toMatch(/CERT|SIGNATURE|ISSUER|SELF_SIGNED/);
  });
  it('cert_invalid: the certificate is for another name', async () => {
    const p = await probeTls(cfg({ servername: 'someone-else.test' }), { ca: CA });
    expect(p).toMatchObject({ state: 'cert_invalid', reason: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  });
  it('unreachable: nothing listens', async () => {
    const closed = net.createServer();
    const p0 = await listen(closed);
    await new Promise((r) => closed.close(r));
    const p = await probeTls(cfg({ port: p0 }), { ca: CA });
    expect(p).toMatchObject({ state: 'unreachable', reason: 'ECONNREFUSED' });
  });
  it('unreachable: no answer within the timeout', async () => {
    const p = await probeTls(cfg({ port: silentPort }), { ca: CA, timeoutMs: 300 });
    expect(p).toMatchObject({ state: 'unreachable', reason: 'timeout' });
  });
});

describe('expiringSoon (1/6 of the lifetime)', () => {
  const D = 86_400_000;
  it('a 90-day certificate warns under 15 days left', () => {
    expect(expiringSoon(0, 90 * D, 90 * D - 16 * D)).toBe(false);
    expect(expiringSoon(0, 90 * D, 90 * D - 15 * D)).toBe(false);
    expect(expiringSoon(0, 90 * D, 90 * D - 14.9 * D)).toBe(true);
    expect(expiringSoon(0, 90 * D, 90 * D - 30 * D)).toBe(false); // Caddy's renewal point is still fine
  });
  it('a 45-day certificate warns under 7.5 days left', () => {
    expect(expiringSoon(0, 45 * D, 45 * D - 8 * D)).toBe(false);
    expect(expiringSoon(0, 45 * D, 45 * D - 7 * D)).toBe(true);
  });
  it('an expired certificate is expiring', () => {
    expect(expiringSoon(0, 90 * D, 91 * D)).toBe(true);
  });
});

describe('decide (dedupe and recovery)', () => {
  const H = 60 * 60 * 1000;
  const run = (states: TlsProbe['state'][], step = 6 * H) => {
    let mem = initialMemory();
    return states.map((state, i) => {
      const r = decide(mem, { state }, i * step);
      mem = r.mem;
      return r.alert;
    });
  };

  it('ok from the start says nothing', () => {
    expect(run(['ok', 'ok', 'ok'])).toEqual([null, null, null]);
  });
  it('alerts on entering a bad state, reminds once per 24 h, recovers once', () => {
    // 6 h steps: alert at 0 h, quiet at 6/12/18 h, reminder at 24 h, quiet at 30 h, then recovered
    expect(run(['key_changed', 'key_changed', 'key_changed', 'key_changed', 'key_changed', 'key_changed', 'ok', 'ok'])).toEqual([
      { kind: 'bad', state: 'key_changed', reminder: false },
      null,
      null,
      null,
      { kind: 'bad', state: 'key_changed', reminder: true },
      null,
      { kind: 'recovered' },
      null,
    ]);
  });
  it('a different bad state alerts at once', () => {
    expect(run(['cert_invalid', 'key_changed'], H)).toEqual([
      { kind: 'bad', state: 'cert_invalid', reminder: false },
      { kind: 'bad', state: 'key_changed', reminder: false },
    ]);
  });
  it('unreachable alerts only after 3 failures in a row', () => {
    expect(run(['unreachable', 'unreachable', 'ok', 'unreachable', 'unreachable', 'unreachable', 'unreachable', 'ok'])).toEqual([
      null,
      null,
      null, // never alerted, so no "recovered"
      null,
      null,
      { kind: 'bad', state: 'unreachable', reminder: false },
      null,
      { kind: 'recovered' },
    ]);
  });
  it('a short unreachable blip inside a bad state neither alerts nor resets it', () => {
    expect(run(['key_changed', 'unreachable', 'key_changed'], H)).toEqual([{ kind: 'bad', state: 'key_changed', reminder: false }, null, null]);
  });
  it('the reminder is exactly 24 h after the last alert', () => {
    let mem = decide(initialMemory(), { state: 'cert_invalid' }, 0).mem;
    expect(decide(mem, { state: 'cert_invalid' }, REMIND_EVERY_MS - 1).alert).toBeNull();
    mem = decide(mem, { state: 'cert_invalid' }, REMIND_EVERY_MS - 1).mem;
    expect(decide(mem, { state: 'cert_invalid' }, REMIND_EVERY_MS).alert).toEqual({ kind: 'bad', state: 'cert_invalid', reminder: true });
  });
});

describe('settle (undelivered alerts are retried at the next check)', () => {
  const H = 3_600_000;
  it('an undelivered first alert is sent again at the next check, not 24 h later', () => {
    const prev = initialMemory();
    const r = decide(prev, { state: 'key_changed' }, 0);
    const mem = settle(prev, r.mem, false);
    expect(decide(mem, { state: 'key_changed' }, 6 * H).alert).toEqual({ kind: 'bad', state: 'key_changed', reminder: false });
  });
  it('an undelivered reminder is retried at the next check', () => {
    let mem = decide(initialMemory(), { state: 'cert_invalid' }, 0).mem;
    const r = decide(mem, { state: 'cert_invalid' }, 24 * H);
    expect(r.alert).toMatchObject({ reminder: true });
    mem = settle(mem, r.mem, false);
    expect(decide(mem, { state: 'cert_invalid' }, 30 * H).alert).toMatchObject({ kind: 'bad', reminder: true });
  });
  it('an undelivered "recovered" is retried at the next ok check', () => {
    let mem = decide(initialMemory(), { state: 'key_changed' }, 0).mem;
    const r = decide(mem, { state: 'ok' }, 6 * H);
    expect(r.alert).toEqual({ kind: 'recovered' });
    mem = settle(mem, r.mem, false);
    expect(decide(mem, { state: 'ok' }, 12 * H).alert).toEqual({ kind: 'recovered' });
  });
  it('a delivered alert is not repeated', () => {
    const prev = initialMemory();
    const r = decide(prev, { state: 'key_changed' }, 0);
    expect(decide(settle(prev, r.mem, true), { state: 'key_changed' }, 6 * H).alert).toBeNull();
  });
});

describe('alert texts', () => {
  const probes: TlsProbe[] = [
    { state: 'key_changed', servedPin: OTHER_PIN, daysLeft: 80, reason: 'key not pinned' },
    { state: 'cert_invalid', servedPin: LEAF_PIN, daysLeft: 5, reason: 'expires soon' },
    { state: 'cert_invalid', servedPin: null, daysLeft: null, reason: 'CERT_HAS_EXPIRED' },
    { state: 'unreachable', servedPin: null, daysLeft: null, reason: 'ECONNREFUSED' },
    { state: 'ok', servedPin: LEAF_PIN, daysLeft: 80, reason: null },
  ];
  const kinds = (p: TlsProbe): AlertKind[] => (p.state === 'ok' ? [{ kind: 'recovered' }] : [{ kind: 'bad', state: p.state, reminder: false }, { kind: 'bad', state: p.state, reminder: true }]);

  it('never carry a full pin (served or configured), in either language', () => {
    for (const p of probes)
      for (const k of kinds(p))
        for (const he of [true, false]) {
          const t = alertText(k, p, cfg(), he);
          for (const pin of [LEAF_PIN, BACKUP_PIN, OTHER_PIN]) expect(t).not.toContain(pin);
          if (k.kind === 'bad') expect(t).toMatch(/README/);
        }
  });
  it('say what the phone will do and show only an 8-character prefix', () => {
    const t = alertText({ kind: 'bad', state: 'key_changed', reminder: false }, probes[0]!, cfg(), false);
    expect(t).toContain('The phone app will refuse to connect');
    expect(t).toContain(`${OTHER_PIN.slice(0, 8)}…`);
    expect(t).not.toContain(OTHER_PIN.slice(0, 9));
    expect(t).toContain('README: Phone pinning');
    expect(alertText({ kind: 'bad', state: 'cert_invalid', reminder: false }, probes[1]!, cfg(), false)).toContain('expires in 5 days');
    expect(alertText({ kind: 'bad', state: 'unreachable', reminder: true }, probes[3]!, cfg(), false)).toContain('(still)');
    expect(alertText({ kind: 'bad', state: 'key_changed', reminder: false }, probes[0]!, cfg(), true)).toContain('אפליקציית הטלפון תסרב להתחבר');
  });
});

describe('TlsWatch', () => {
  it('disabled: no timers, no checks, no messages; status says disabled', async () => {
    const send = vi.fn(async () => true);
    const probe = vi.fn();
    const w = new TlsWatch(null, { send, hebrew: () => false, probe });
    w.start();
    expect(await w.check()).toBeNull();
    w.stop();
    expect(probe).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(w.status()).toEqual({ state: 'disabled', checkedAt: null, daysLeft: null, servedPinPrefix: null });
  });

  it('runs the real probe, alerts once, dedupes, recovers; status shows a prefix only', async () => {
    let now = Date.UTC(2026, 10, 11);
    const sent: string[] = [];
    let pins = [OTHER_PIN, BACKUP_PIN];
    const w = new TlsWatch(cfg(), {
      send: async (t) => {
        sent.push(t);
        return true;
      },
      hebrew: () => false,
      probe: (c) => probeTls({ ...c, pins }, { ca: CA }),
      now: () => now,
    });
    expect(w.status()).toBeNull(); // before the first check
    expect((await w.check())?.state).toBe('key_changed');
    now += 6 * 3_600_000;
    await w.check();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/not pinned/);
    const st = w.status()!;
    expect(st).toMatchObject({ state: 'key_changed', checkedAt: new Date(now).toISOString(), servedPinPrefix: `${LEAF_PIN.slice(0, 8)}…` });
    expect(JSON.stringify(st)).not.toContain(LEAF_PIN);
    pins = [LEAF_PIN, BACKUP_PIN];
    now += 6 * 3_600_000;
    expect((await w.check())?.state).toBe('ok');
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatch(/pinned one again/);
  });

  it('timers start after the first delay, are unref’d, and stop', async () => {
    vi.useFakeTimers();
    try {
      const probe = vi.fn(async (): Promise<TlsProbe> => ({ state: 'ok', servedPin: LEAF_PIN, daysLeft: 90, reason: null }));
      const w = new TlsWatch(cfg(), { send: async () => true, hebrew: () => false, probe, firstCheckMs: 60_000, intervalMs: 6 * 3_600_000 });
      w.start();
      await vi.advanceTimersByTimeAsync(59_000);
      expect(probe).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(probe).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(6 * 3_600_000);
      expect(probe).toHaveBeenCalledTimes(2);
      w.stop();
      await vi.advanceTimersByTimeAsync(24 * 3_600_000);
      expect(probe).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failing send never throws out of a check, and is retried at the next check', async () => {
    let calls = 0;
    const w = new TlsWatch(cfg(), {
      send: async () => {
        calls += 1;
        throw new Error('telegram down');
      },
      hebrew: () => true,
      probe: async () => ({ state: 'key_changed', servedPin: OTHER_PIN, daysLeft: 50, reason: 'key not pinned' }),
    });
    await expect(w.check()).resolves.toMatchObject({ state: 'key_changed' });
    await w.check();
    expect(calls).toBe(2);
  });

  it('an alert the channel refused ({ok:false}) is sent again at the next check; once delivered, it is not', async () => {
    const results = [false, false, true];
    const sent: string[] = [];
    let now = 0;
    const w = new TlsWatch(cfg(), {
      send: async (t) => {
        sent.push(t);
        return results.shift() ?? true;
      },
      hebrew: () => false,
      probe: async () => ({ state: 'key_changed', servedPin: OTHER_PIN, daysLeft: 50, reason: 'key not pinned' }),
      now: () => now,
    });
    for (let i = 0; i < 5; i++) {
      await w.check();
      now += 6 * 3_600_000;
    }
    expect(sent).toHaveLength(3); // two refused, the third delivered, then quiet (the 24 h reminder is at check 7)
    expect(new Set(sent).size).toBe(1); // each retry is the first alert again, not a "(still)" reminder
  });
});
