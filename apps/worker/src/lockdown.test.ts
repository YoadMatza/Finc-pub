import { listDevices, openDb, registerDevice, setDeviceIdleDays } from '@finc/core';
import { describe, expect, it, vi } from 'vitest';
import { type PanicSteps, runPanic, sweepIdleDevices } from './lockdown.js';

// security research P1-09: the panic switch runs every step even when one fails, and the idle sweep

function steps(over: Partial<PanicSteps> = {}): PanicSteps & { calls: string[]; texts: string[] } {
  const calls: string[] = [];
  const texts: string[] = [];
  return {
    calls,
    texts,
    revokeDevices: () => (calls.push('devices'), 2),
    revokePasskeys: () => (calls.push('passkeys'), 1),
    endSessions: () => (calls.push('sessions'), 3),
    lockVault: () => (calls.push('vault'), true),
    alert: async (t) => (calls.push('alert'), texts.push(t), true),
    ...over,
  };
}

describe('runPanic', () => {
  it('runs every step in order and says who did it', async () => {
    const s = steps();
    const r = await runPanic(s, 'device "Phone A"');
    expect(s.calls).toEqual(['devices', 'passkeys', 'sessions', 'vault', 'alert']);
    expect(r).toEqual({ ok: true, devices: 2, passkeys: 1, sessions: 3, vaultLocked: true, alerted: true });
    expect(s.texts[0]).toContain('LOCKDOWN by device "Phone A": 2 device(s) revoked, 1 passkey(s) revoked, 3 session(s) ended, vault locked');
  });

  it('keeps going when a step throws, and reports every failure', async () => {
    const calls: string[] = [];
    const texts: string[] = [];
    const r = await runPanic(
      {
        revokeDevices: () => {
          calls.push('devices');
          throw new Error('database is locked');
        },
        revokePasskeys: () => {
          calls.push('passkeys');
          throw new Error('passkey table gone');
        },
        endSessions: () => (calls.push('sessions'), 1),
        lockVault: () => {
          calls.push('vault');
          throw new Error('lock exploded');
        },
        alert: async (t) => (calls.push('alert'), texts.push(t), true),
      },
      'Telegram (/lockdown)',
    );
    expect(calls).toEqual(['devices', 'passkeys', 'sessions', 'vault', 'alert']);
    expect(r).toMatchObject({ ok: false, devices: 0, passkeys: 0, sessions: 1, vaultLocked: false, alerted: true });
    // P2-09: the step and the error kind; the error text stays in the log
    expect(r.errors).toEqual(['revoking devices failed (other)', 'revoking passkeys failed (other)', 'locking the vault failed (other)']);
    expect(texts[0]).toContain('vault NOT locked');
    expect(texts[0]).toContain('revoking devices failed (other)');
    expect(texts[0]).not.toContain('database is locked');
  });

  it('a failing alert is reported, and does not undo the rest', async () => {
    const s = steps({
      alert: async () => {
        throw new Error('network down');
      },
    });
    const r = await runPanic(s, 'the CLI (finc panic)');
    expect(r).toMatchObject({ ok: false, devices: 2, passkeys: 1, sessions: 3, vaultLocked: true, alerted: false, errors: ['the alert failed (network)'] });
    // undelivered without an error (no channel) is not a failure of the lockdown
    const quiet = await runPanic(steps({ alert: async () => false }), 'the PC');
    expect(quiet).toEqual({ ok: true, devices: 2, passkeys: 1, sessions: 3, vaultLocked: true, alerted: false });
  });
});

describe('sweepIdleDevices', () => {
  const now = new Date('2026-06-30T12:00:00Z');
  const seen = (db: ReturnType<typeof openDb>, name: string, daysAgo: number) => {
    const d = registerDevice(db, { name });
    db.$client.prepare('update device set last_seen_at = ? where id = ?').run(new Date(now.getTime() - daysAgo * 86_400_000).toISOString(), d.id);
  };

  it('expires idle devices and sends ONE alert for all of them', () => {
    const db = openDb(':memory:');
    seen(db, 'Active', 1);
    seen(db, 'Old Phone', 45);
    seen(db, 'Old Tablet', 31);
    const alert = vi.fn();
    expect(sweepIdleDevices(db, null, now, alert)).toBe(2);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0]![2]).toMatch(/^2 devices expired after going unused: /);
    expect(alert.mock.calls[0]![2]).toContain('"Old Phone" (45 days)');
    expect(listDevices(db).map((d) => d.name)).toEqual(['Active']);
    expect(sweepIdleDevices(db, null, now, alert)).toBe(0);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it('one device gets the plain sentence; 0 days turns it off', () => {
    const db = openDb(':memory:');
    seen(db, 'Old Phone', 40);
    const alert = vi.fn();
    setDeviceIdleDays(db, 0);
    expect(sweepIdleDevices(db, null, now, alert)).toBe(0);
    setDeviceIdleDays(db, 30);
    expect(sweepIdleDevices(db, null, now, alert)).toBe(1);
    expect(alert.mock.calls[0]![2]).toBe('device "Old Phone" expired after 40 days unused');
  });

  it('warns once per device that expires within 3 days, and again after it was used and went idle again', () => {
    const db = openDb(':memory:');
    seen(db, 'Phone A', 28); // 2 days left
    seen(db, 'Tablet B', 26.5); // 3.5 days left: not yet
    seen(db, 'Phone C', 29.5); // 0.5 days left
    const alert = vi.fn();
    expect(sweepIdleDevices(db, null, now, alert)).toBe(0);
    expect(alert.mock.calls.map((c) => c[2]).sort()).toEqual([
      'paired device "Phone A" will be removed in 2 days unless it\'s used; open the app once to keep it',
      'paired device "Phone C" will be removed in 1 day unless it\'s used; open the app once to keep it',
    ]);
    // the next day: Tablet B enters the window; A was warned already; C has now expired (its own alert)
    alert.mockClear();
    const tomorrow = new Date(now.getTime() + 86_400_000);
    expect(sweepIdleDevices(db, null, tomorrow, alert)).toBe(1);
    expect(alert.mock.calls.map((c) => c[2])).toEqual([expect.stringContaining('"Tablet B" will be removed in 3 days'), 'device "Phone C" expired after 30 days unused']);
    // Phone A is used: a new window, and a new warning once it is idle again
    alert.mockClear();
    db.$client.prepare("update device set last_seen_at = ? where name = 'Phone A'").run(new Date(tomorrow.getTime() - 28 * 86_400_000 + 3600_000).toISOString());
    sweepIdleDevices(db, null, tomorrow, alert);
    expect(alert.mock.calls.map((c) => c[2])).toEqual([expect.stringContaining('"Phone A" will be removed in 3 days')]); // 2 days and an hour left
    // expiry off: no warnings
    alert.mockClear();
    setDeviceIdleDays(db, 0);
    db.$client.prepare("update device set last_seen_at = ? where name = 'Phone A'").run(new Date(now.getTime() - 29 * 86_400_000).toISOString());
    sweepIdleDevices(db, null, tomorrow, alert);
    expect(alert).not.toHaveBeenCalled();
  });

  it('never throws (a scheduler job)', () => {
    const db = openDb(':memory:');
    db.$client.close();
    expect(sweepIdleDevices(db, null, now, vi.fn())).toBe(0);
  });
});
