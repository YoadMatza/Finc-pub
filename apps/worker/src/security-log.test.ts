import { listSecurityEvents, openDb, registerDevice, recordSecurityEvent } from '@finc/core';
import { describe, expect, it, vi } from 'vitest';
import { AlarmPoller, statusText } from './alarm-poller.js';
import { formatEventsTable } from './cli/events.js';
import { sweepIdleDevices } from './lockdown.js';
import { TlsWatch, type TlsProbe } from './tlswatch.js';

// security research P1-08: the worker-side writers and readers of the security log, outside the HTTP API

const CHAT = '424242';
const ALARM = `222222222:${'A'.repeat(35)}`;
const T0 = Date.UTC(2026, 10, 11, 9, 30, 0);
const DAY = 86_400_000;

describe('/status on the alarm bot', () => {
  it('lists the last 5 events: time, kind, actor and name, never an address or a detail', () => {
    const events = Array.from({ length: 7 }, (_, i) => ({ at: new Date(T0 - i * 60_000).toISOString(), kind: i === 0 ? 'device.paired' : 'auth.pin_ok', actor: i === 0 ? 'device:4' : 'pc', actorName: i === 0 ? 'Phone B' : null, address: '203.0.113.9', detail: '{"device":4}' }));
    const text = statusText({ vaultUnlocked: false, devices: 2, events }, 'UTC');
    const lines = text.split('\n');
    expect(lines[0]).toBe('finc: vault locked; 2 paired device(s) active');
    expect(lines[1]).toBe('last events:');
    expect(lines).toHaveLength(7);
    expect(lines[2]).toBe('11/11 09:30 device.paired device:4 "Phone B"');
    expect(lines[3]).toBe('11/11 09:29 auth.pin_ok pc');
    expect(text).not.toContain('203.0.113.9');
    expect(text).not.toContain('{"device"');
    expect(statusText({ vaultUnlocked: true, devices: 0, events: [] })).toBe('finc: vault unlocked; 0 paired device(s) active\nno security events yet');
  });

  it('the poller records /lockdown asked, wrong codes and the block (never the code), and /status shows the log', async () => {
    const db = openDb(':memory:');
    recordSecurityEvent(db, { kind: 'vault.lock', actor: 'pc', address: '10.0.0.2' });
    const sent: string[] = [];
    const batches: unknown[][] = [];
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      const method = url.split('/').at(-1)!;
      if (method === 'getUpdates') return new Response(JSON.stringify({ ok: true, result: batches.shift() ?? [] }));
      sent.push(JSON.parse(String(init.body)).text as string);
      return new Response(JSON.stringify({ ok: true, result: {} }));
    });
    const msg = (id: number, text: string) => ({ update_id: id, message: { date: Math.floor(T0 / 1000), text, chat: { id: Number(CHAT) } } });
    const p = new AlarmPoller({
      readBot: () => ({ token: ALARM, username: 'finc_alarm_bot', savedAt: '', chatId: CHAT }),
      boundChatId: () => CHAT,
      mainBotId: () => '111111111',
      panic: async () => ({ ok: true, devices: 0, passkeys: 0, sessions: 0, vaultLocked: true, alerted: true }),
      status: () => statusText({ vaultUnlocked: false, devices: 0, events: listSecurityEvents(db, { limit: 5 }).events }, 'UTC'),
      record: (kind, detail) => recordSecurityEvent(db, { kind, actor: 'telegram', detail: detail ?? null }),
      fetch: fetchFn as unknown as typeof fetch,
      now: () => T0,
      newCode: () => '135790',
    });
    batches.push([msg(1, '/lockdown'), ...[2, 3, 4, 5, 6].map((i) => msg(i, '/lockdown 000000')), msg(7, '/lockdown'), msg(8, '/status')]);
    await p.tick();
    const kinds = listSecurityEvents(db).events.map((e) => e.kind).reverse();
    expect(kinds).toEqual(['vault.lock', 'lockdown.requested', 'lockdown.wrong_code', 'lockdown.wrong_code', 'lockdown.wrong_code', 'lockdown.wrong_code', 'lockdown.wrong_code', 'lockdown.blocked']);
    const rows = listSecurityEvents(db).events;
    expect(rows.every((e) => e.kind === 'vault.lock' || e.actor === 'telegram')).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(/135790|000000/);
    expect(JSON.parse(rows.find((e) => e.kind === 'lockdown.wrong_code')!.detail!)).toEqual({ wrong: 5, blocked: true });
    // the /status reply lists the newest events, without the address
    const status = sent.at(-1)!;
    expect(status).toContain('lockdown.blocked telegram');
    expect(status).not.toContain('10.0.0.2');
  });
});

describe('finc events', () => {
  it('prints a compact table, newest first, with a paging hint', () => {
    const lines = formatEventsTable(
      [
        { id: 12, at: '2026-11-11T09:30:00.000Z', kind: 'auth.pin_failed', actor: 'pc', actorName: null, address: '192.168.1.50', detail: '{"failures":2}' },
        { id: 11, at: '2026-11-11T09:00:00.000Z', kind: 'device.paired', actor: 'device:3', actorName: 'Phone A', address: null, detail: null },
      ],
      11,
    );
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^ #\s+time\s+kind\s+actor\s+address\s+detail$/);
    expect(lines[1]).toMatch(/^12 {2}\d{4}-\d{2}-\d{2} \d{2}:\d{2} {2}auth\.pin_failed {2}pc\s+192.168.1.50 {2}\{"failures":2\}$/);
    expect(lines[2]).toContain('device:3 "Phone A"');
    expect(lines[2]).toMatch(/ - +$/);
    expect(lines[3]).toBe('older: finc events --before 11');
    expect(formatEventsTable([])).toEqual(['no security events']);
  });
});

describe('writers outside the API', () => {
  it('the idle sweep records each expired device and each warning', () => {
    const db = openDb(':memory:');
    const now = new Date(T0);
    const old = registerDevice(db, { name: 'Old Phone', address: '10.0.0.3' });
    const soon = registerDevice(db, { name: 'Tablet', address: '10.0.0.4' });
    db.$client.prepare('update device set last_seen_at = ?, created_at = ? where id = ?').run(new Date(T0 - 40 * DAY).toISOString(), new Date(T0 - 40 * DAY).toISOString(), old.id);
    db.$client.prepare('update device set last_seen_at = ?, created_at = ? where id = ?').run(new Date(T0 - 29 * DAY).toISOString(), new Date(T0 - 29 * DAY).toISOString(), soon.id);
    const alert = vi.fn((d: typeof db, _v: unknown, _t: string, e: Parameters<typeof recordSecurityEvent>[1] | null) => {
      if (e) recordSecurityEvent(d, e);
    });
    expect(sweepIdleDevices(db, null, now, alert)).toBe(1);
    const rows = listSecurityEvents(db).events;
    const expired = rows.find((e) => e.kind === 'device.expired')!;
    expect(expired.actor).toBe('system');
    expect(JSON.parse(expired.detail!)).toMatchObject({ device: old.id, name: 'Old Phone', via: 'sweep' });
    expect(JSON.parse(rows.find((e) => e.kind === 'device.expiry_warning')!.detail!)).toMatchObject({ device: soon.id, name: 'Tablet' });
    expect(rows.some((e) => e.detail?.includes('finc_dev_'))).toBe(false);
  });

  it('the TLS watch records each state change once', async () => {
    const changes: unknown[] = [];
    let state: TlsProbe['state'] = 'ok';
    const w = new TlsWatch(
      { host: 'caddy', port: 443, servername: 'finc-example.duckdns.org', pins: ['x'] },
      { send: async () => true, hebrew: () => false, probe: async () => ({ state, servedPin: null, daysLeft: 60, reason: state === 'ok' ? null : 'key not pinned' }), record: (c) => changes.push(c), now: () => T0 },
    );
    await w.check();
    await w.check();
    state = 'key_changed';
    await w.check();
    await w.check();
    state = 'ok';
    await w.check();
    expect(changes).toEqual([
      { from: null, to: 'ok', reason: null },
      { from: 'ok', to: 'key_changed', reason: 'key not pinned' },
      { from: 'key_changed', to: 'ok', reason: null },
    ]);
  });
});
