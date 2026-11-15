import { type Db, ensureAccount, openDb, startRun, type Vault } from '@finc/core';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ScrapeRunResult } from './connectors/scrape.js';
import { configFromEnv, intFromEnv, parseSyncTimes, Scheduler, type SchedulerDeps, syncTargets } from './scheduler.js';

const cfg = { times: ['06:00'], jitterMinutes: 0, timezone: 'UTC', monthsBack: 3, backupTime: '03:40' };
const vault = { locked: false, has: () => true, get: () => ({ kind: 'scraper', fields: { username: 'u', password: 'p' }, updatedAt: '' }) } as unknown as Vault;
const dispatch: SchedulerDeps['dispatch'] = async () => undefined;
const failed = (institutionId: 'max'): ScrapeRunResult => ({ institutionId, runId: null, success: false, errorType: 'X', accounts: [], stats: { seen: 0, new: 0, updated: 0, completed: 0, voided: 0, annotated: 0 }, durationMs: 0 });
const tick = () => new Promise((r) => setTimeout(r, 0));

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
  ensureAccount(db, { institutionId: 'max', institutionKind: 'card', institutionDisplayName: 'Max', scraperId: 'max', source: 'scraper:max', externalId: 'm', type: 'credit_card' });
});

describe('scheduler: syncs are strictly serial', () => {
  it('three overlapping syncNow calls run one at a time, in call order', async () => {
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const gates: Array<() => void> = [];
    const scrape: SchedulerDeps['scrape'] = async (_db, o) => {
      active++;
      maxActive = Math.max(maxActive, active);
      order.push(`start ${o.monthsBack}`);
      await new Promise<void>((r) => gates.push(r));
      order.push(`end ${o.monthsBack}`);
      active--;
      return failed('max');
    };
    const s = new Scheduler(db, () => vault, cfg, { scrape, dispatch });
    expect(s.isRunning).toBe(false);
    const p1 = s.syncNow(['max'], 'manual', 1);
    const p2 = s.syncNow(['max'], 'manual', 2);
    const p3 = s.syncNow(['max'], 'manual', 3);
    expect(s.isRunning).toBe(true);
    for (let i = 0; i < 3; i++) {
      await tick();
      expect(gates.length).toBe(i + 1); // the next one has not started while this one holds
      gates[i]!();
    }
    await Promise.all([p1, p2, p3]);
    expect(maxActive).toBe(1);
    expect(order).toEqual(['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3']);
    expect(s.isRunning).toBe(false);
  });

  it('a sync that rejects does not block the queue or leave isRunning stuck', async () => {
    let calls = 0;
    const s = new Scheduler(db, () => vault, cfg, {
      scrape: async () => failed('max'),
      dispatch: async () => {
        calls++;
        if (calls === 1) throw new Error('dispatch exploded');
      },
    });
    await expect(s.syncNow(['max'], 'manual')).rejects.toThrow('dispatch exploded');
    expect(s.isRunning).toBe(false);
    await expect(s.syncNow(['max'], 'manual')).resolves.toHaveLength(1);
    expect(s.isRunning).toBe(false);
  });
});

describe('scheduler: a crashed sync is recorded (P1-04)', () => {
  const runs = () => db.$client.prepare(`select id, status, error_type as errorType, error from sync_run order by id`).all() as Array<{ id: number; status: string; errorType: string | null; error: string | null }>;
  const lastError = () => (db.$client.prepare(`select last_error as e from connection where institution_id = 'max'`).get() as { e: string | null }).e;

  it('a crash before any run was opened is recorded as a failed run', async () => {
    const s = new Scheduler(db, () => vault, cfg, { scrape: async () => { throw new Error('boom before startRun'); }, dispatch });
    const [r] = await s.syncNow(['max'], 'scheduled');
    expect(r).toMatchObject({ institutionId: 'max', success: false, errorType: 'CRASH', errorMessage: 'boom before startRun' });
    expect(runs()).toEqual([{ id: r!.runId, status: 'error', errorType: 'CRASH', error: 'boom before startRun' }]);
    expect(lastError()).toBe('CRASH: boom before startRun');
  });

  it('a crash that left its run running closes that run instead of adding another', async () => {
    const s = new Scheduler(db, () => vault, cfg, {
      scrape: async (d) => {
        startRun(d!, { institutionId: 'max', source: 'scraper:max', trigger: 'scheduled' });
        throw new Error('database is locked');
      },
      dispatch,
    });
    const [r] = await s.syncNow(['max'], 'scheduled');
    const all = runs();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: r!.runId, status: 'error', errorType: 'CRASH', error: 'database is locked' });
    expect(lastError()).toBe('CRASH: database is locked');
  });
});

describe('scheduler config validation', () => {
  it('accepts valid times and defaults', () => {
    expect(parseSyncTimes(undefined)).toEqual(['06:00', '18:00']);
    expect(parseSyncTimes('  ')).toEqual(['06:00', '18:00']);
    expect(parseSyncTimes('6:00, 23:59,00:00')).toEqual(['6:00', '23:59', '00:00']);
    expect(configFromEnv({})).toEqual({ times: ['06:00', '18:00'], jitterMinutes: 30, timezone: 'Asia/Jerusalem', monthsBack: 3, backupTime: '03:40' });
    expect(configFromEnv({ FINC_SYNC_TIMES: '07:30', FINC_SYNC_JITTER_MIN: '0', FINC_SYNC_MONTHS: '12', TZ: 'UTC', FINC_BACKUP_TIME: ' 02:05 ' })).toEqual({ times: ['07:30'], jitterMinutes: 0, timezone: 'UTC', monthsBack: 12, backupTime: '02:05' });
  });

  it('rejects a malformed backup time', () => {
    for (const bad of ['24:00', '3:60', '0340', '03:40,04:00', 'night']) expect(() => configFromEnv({ FINC_BACKUP_TIME: bad }), bad).toThrow(/FINC_BACKUP_TIME: ".*" is not a valid HH:MM time/);
  });

  it('rejects malformed times with a clear error', () => {
    for (const bad of ['24:00', '12:60', '6', '06:00,', 'noon', '06:00;18:00', '-1:00', '06:5']) {
      expect(() => parseSyncTimes(bad), bad).toThrow(/FINC_SYNC_TIMES: ".*" is not a valid HH:MM time/);
    }
  });

  it('rejects non-integer or out-of-range jitter and months', () => {
    for (const bad of ['abc', '-5', '1.5', '241', '1e3', 'NaN']) expect(() => configFromEnv({ FINC_SYNC_JITTER_MIN: bad }), bad).toThrow(/FINC_SYNC_JITTER_MIN/);
    for (const bad of ['0', '25', 'three', '']) {
      if (bad === '') expect(configFromEnv({ FINC_SYNC_MONTHS: bad }).monthsBack).toBe(3);
      else expect(() => configFromEnv({ FINC_SYNC_MONTHS: bad }), bad).toThrow(/FINC_SYNC_MONTHS/);
    }
    expect(intFromEnv('X', ' 7 ', 1, 1, 10)).toBe(7);
  });
});

describe('scheduler: dump and dry run from the control port (P1-13)', () => {
  const runCount = () => (db.$client.prepare(`select count(*) as n from sync_run`).get() as { n: number }).n;

  it('a dry run hands the scraper no database, passes dump, and records nothing (no engine, no alerts)', async () => {
    const seen: Array<{ db: unknown; dump: boolean; dryRun: boolean | undefined }> = [];
    let dispatched = 0;
    const s = new Scheduler(db, () => vault, cfg, {
      scrape: async (d, o) => {
        seen.push({ db: d, dump: o.dump, dryRun: o.dryRun });
        return { ...failed('max'), success: true };
      },
      dispatch: async () => {
        dispatched++;
      },
    });
    const results = await s.syncNow(['max'], 'manual', 2, { dryRun: true, dump: true });
    expect(results).toHaveLength(1);
    expect(seen).toEqual([{ db: null, dump: true, dryRun: true }]);
    expect(dispatched).toBe(0);
    expect(s.lastResults).toEqual([]);
    expect(runCount()).toBe(0);
  });

  it('a crashing dry run is returned as a failure and not recorded; a locked vault records nothing either', async () => {
    const s = new Scheduler(db, () => vault, cfg, { scrape: async () => { throw new Error('boom'); }, dispatch });
    const [r] = await s.syncNow(['max'], 'manual', undefined, { dryRun: true });
    expect(r).toMatchObject({ institutionId: 'max', runId: null, success: false, errorType: 'CRASH', errorMessage: 'boom' });
    const locked = new Scheduler(db, () => ({ ...vault, locked: true }) as unknown as Vault, cfg, { scrape: async () => failed('max'), dispatch });
    const [l] = await locked.syncNow(['max'], 'manual', undefined, { dryRun: true });
    expect(l).toMatchObject({ success: false, errorType: 'LOCKED' });
    expect(runCount()).toBe(0);
  });

  it('dump alone is a normal sync with the dump on; without options dump stays off', async () => {
    const seen: Array<{ db: unknown; dump: boolean; dryRun: boolean | undefined }> = [];
    const s = new Scheduler(db, () => vault, cfg, {
      scrape: async (d, o) => {
        seen.push({ db: d, dump: o.dump, dryRun: o.dryRun });
        return failed('max');
      },
      dispatch,
    });
    await s.syncNow(['max'], 'manual', undefined, { dump: true });
    await s.syncNow(['max'], 'manual');
    expect(seen).toEqual([
      { db, dump: true, dryRun: undefined },
      { db, dump: false, dryRun: undefined },
    ]);
  });

  it('dry runs queue behind other syncs like any sync', async () => {
    const order: string[] = [];
    const gates: Array<() => void> = [];
    const s = new Scheduler(db, () => vault, cfg, {
      scrape: async (_d, o) => {
        order.push(`start ${o.dryRun ? 'dry' : 'real'}`);
        await new Promise<void>((r) => gates.push(r));
        order.push(`end ${o.dryRun ? 'dry' : 'real'}`);
        return failed('max');
      },
      dispatch,
    });
    const p1 = s.syncNow(['max'], 'manual');
    const p2 = s.syncNow(['max'], 'manual', undefined, { dryRun: true });
    await tick();
    expect(gates).toHaveLength(1);
    gates[0]!();
    await tick();
    await tick();
    expect(gates).toHaveLength(2);
    gates[1]!();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['start real', 'end real', 'start dry', 'end dry']);
  });
});

describe('scheduler: each institution at most once per sync (P2-02 review)', () => {
  it('syncTargets dedupes, keeps the order and drops unknown ids', () => {
    expect(syncTargets(['max', 'max', 'isracard', 'max', 'evilbank', 'riseup'])).toEqual(['max', 'isracard']);
    expect(syncTargets('all').sort()).toEqual(['beinleumi', 'isracard', 'max']);
    expect(syncTargets([])).toEqual([]);
  });

  it('syncNow called directly with repeated ids logs in once (real and dry runs)', async () => {
    const seen: string[] = [];
    const scrape: SchedulerDeps['scrape'] = async (_db, o) => {
      seen.push(o.institutionId);
      return failed('max');
    };
    const s = new Scheduler(db, () => vault, cfg, { scrape, dispatch });
    await s.syncNow(Array(50).fill('max'), 'manual');
    expect(seen).toEqual(['max']);
    await s.syncNow(['max', 'max', 'unknown' as never], 'manual', undefined, { dryRun: true });
    expect(seen).toEqual(['max', 'max']);
  });
});

describe('scheduler: the holding rules follow a successful sync', () => {
  it('onSynced runs after a sync with a success, not after a failed one or a dry run; a throwing hook does not fail the sync', async () => {
    let ok = true;
    const s = new Scheduler(db, () => vault, cfg, { scrape: async () => (ok ? { ...failed('max'), success: true } : failed('max')), dispatch });
    let calls = 0;
    s.onSynced = () => {
      calls++;
    };
    await s.syncNow(['max'], 'manual');
    expect(calls).toBe(1);
    ok = false;
    await s.syncNow(['max'], 'manual');
    expect(calls).toBe(1);
    ok = true;
    await s.syncNow(['max'], 'manual', undefined, { dryRun: true });
    expect(calls).toBe(1);
    s.onSynced = () => {
      throw new Error('boom');
    };
    await expect(s.syncNow(['max'], 'scheduled')).resolves.toHaveLength(1);
  });
});
