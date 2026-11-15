import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { getServer, setServer } from './api';
import { forgetSession, unlockOutcome } from './lockflow';
import { activeController, decideOnActive, FORGET_AFTER_FAILURES, LOCK_AFTER_MS, nextFailureCount, offerForget, type ActiveEffects } from './relock';

describe('decideOnActive (native timer, P1-11)', () => {
  it('the grace is 30 seconds', () => {
    expect(LOCK_AFTER_MS).toBe(30_000);
  });
  it('locks only when ready and away more than 30 000 ms', () => {
    expect(decideOnActive({ awayMs: 30_001, deviceSecure: true, ready: true })).toBe('lock');
    expect(decideOnActive({ awayMs: 30_000, deviceSecure: true, ready: true })).toBe('uncover');
    expect(decideOnActive({ awayMs: 0, deviceSecure: true, ready: true })).toBe('uncover');
    expect(decideOnActive({ awayMs: 10 * 60_000, deviceSecure: true, ready: false })).toBe('uncover');
  });
  it('a screen lock removed while away wins over everything', () => {
    expect(decideOnActive({ awayMs: 0, deviceSecure: false, ready: true })).toBe('nolock');
    expect(decideOnActive({ awayMs: 0, deviceSecure: false, ready: false })).toBe('nolock');
  });
  it('a vault that does not answer: an open session locks (fail closed), a locked app just uncovers', () => {
    expect(decideOnActive({ awayMs: 0, deviceSecure: null, ready: true })).toBe('lock');
    expect(decideOnActive({ awayMs: 40_000, deviceSecure: null, ready: false })).toBe('uncover');
  });
});

type Read = { ms: number; epoch?: number };

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const ticks = async (n = 10) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

describe('activeController', () => {
  /** `away` items are read in order; a function lets a test hold a read open */
  const effects = (o: { away: (Read | (() => Promise<Read>))[]; secure?: boolean | null; ready: () => boolean; uncoverOk?: boolean }) => {
    const log: string[] = [];
    const queue = [...o.away];
    const qc = new QueryClient();
    const e: ActiveEffects = {
      // the plugin consumes the value: a read with no pause since is 0
      awayMs: async () => {
        const next = queue.shift() ?? { ms: 0 };
        return typeof next === 'function' ? next() : next;
      },
      deviceSecure: async () => (o.secure === undefined ? true : o.secure),
      isReady: o.ready,
      forgetSession: () => {
        log.push('forget');
        forgetSession(qc);
      },
      clearWebCache: async () => void log.push('clearWebCache'),
      lock: () => void log.push('lock'),
      noLock: () => void log.push('nolock'),
      painted: async () => void log.push('painted'),
      uncover: async (epoch) => {
        log.push(`uncover:${epoch ?? '-'}`);
        return o.uncoverOk ?? true;
      },
      setCovered: (v) => void log.push(`covered:${v}`),
    };
    return { e, log, qc };
  };

  it('away > 30 s while ready: forget (token, query cache), lock, paint, web cache, then uncover', async () => {
    const { e, log, qc } = effects({ away: [{ ms: 30_001, epoch: 7 }], ready: () => true });
    setServer({ url: 'https://hub', token: 'tok' });
    qc.setQueryData(['hub'], { balance: 1 });
    expect(await activeController(e).active()).toBe('lock');
    expect(log).toEqual(['forget', 'lock', 'painted', 'clearWebCache', 'uncover:7', 'covered:false']);
    expect(getServer()).toBeNull();
    expect(qc.getQueryCache().getAll()).toHaveLength(0);
  });

  it('within 30 s: only uncover, with the epoch from awayMs passed through', async () => {
    const { e, log } = effects({ away: [{ ms: 29_000, epoch: 42 }], ready: () => true });
    expect(await activeController(e).active()).toBe('uncover');
    expect(log).toEqual(['uncover:42', 'covered:false']);
  });

  it('not ready (lock or pair screen): never locks, always uncovers', async () => {
    const { e, log } = effects({ away: [{ ms: 5 * 60_000 }], ready: () => false });
    expect(await activeController(e).active()).toBe('uncover');
    expect(log).toEqual(['uncover:-', 'covered:false']);
  });

  it('readiness is judged on return: an unlock that finished while hidden still locks', async () => {
    let ready = false;
    const { e, log } = effects({ away: [{ ms: 45_000 }], ready: () => ready });
    ready = true;
    expect(await activeController(e).active()).toBe('lock');
    expect(log).toContain('lock');
  });

  it('one lock per absence: the next active event with no pause reads 0 and only uncovers', async () => {
    const { e, log } = effects({ away: [{ ms: 60_000 }], ready: () => true });
    const ctl = activeController(e);
    expect(await ctl.active()).toBe('lock');
    expect(await ctl.active()).toBe('uncover');
    expect(log.filter((l) => l === 'lock')).toHaveLength(1);
  });

  it('screen lock removed: forget the session and go to nolock, paint, then uncover', async () => {
    const { e, log } = effects({ away: [{ ms: 0, epoch: 1 }], secure: false, ready: () => true });
    setServer({ url: 'https://hub', token: 'tok' });
    expect(await activeController(e).active()).toBe('nolock');
    expect(log).toEqual(['forget', 'nolock', 'painted', 'clearWebCache', 'uncover:1', 'covered:false']);
    expect(getServer()).toBeNull();
  });

  it('awayMs and the screen-lock check run on every active event', async () => {
    const { e } = effects({ away: [], ready: () => true });
    const away = vi.spyOn(e, 'awayMs');
    const secure = vi.spyOn(e, 'deviceSecure');
    const ctl = activeController(e);
    await ctl.active();
    await ctl.active();
    expect(away).toHaveBeenCalledTimes(2);
    expect(secure).toHaveBeenCalledTimes(2);
  });

  it("'inactive' raises the cover, and a stale run never uncovers or drops it", async () => {
    const held = deferred<Read>();
    const { e, log } = effects({ away: [() => held.promise], ready: () => true });
    const ctl = activeController(e);
    const run = ctl.active();
    ctl.inactive(); // paused again while the run waited on the native timer
    held.resolve({ ms: 1_000, epoch: 3 });
    expect(await run).toBe('stale');
    expect(log).toEqual(['covered:true']);
  });

  it("an 'inactive' during the lock paint: the lock stays, nothing uncovers", async () => {
    const { e, log } = effects({ away: [{ ms: 60_000 }], ready: () => true });
    const paint = deferred<void>();
    e.painted = () => paint.promise;
    const ctl = activeController(e);
    const run = ctl.active();
    await ticks();
    expect(log).toContain('lock');
    ctl.inactive();
    paint.resolve();
    expect(await run).toBe('stale');
    expect(log.some((l) => l.startsWith('uncover'))).toBe(false);
    expect(log).not.toContain('covered:false');
  });

  it('two overlapping actives: the later run decides, and a consumed "away 60 s" still locks', async () => {
    let ready = true;
    const first = deferred<Read>();
    const { e, log } = effects({ away: [() => first.promise, { ms: 0, epoch: 9 }], ready: () => ready });
    e.lock = () => {
      ready = false;
      log.push('lock');
    };
    const ctl = activeController(e);
    const a = ctl.active(); // reads 60 s (held open)
    const b = ctl.active(); // the newer event; its read is queued behind the first
    first.resolve({ ms: 60_000, epoch: 8 });
    expect(await a).toBe('stale');
    expect(await b).toBe('lock');
    expect(log.filter((l) => l === 'lock')).toHaveLength(1);
    expect(log.filter((l) => l.startsWith('uncover'))).toEqual(['uncover:9']);
    expect(log.indexOf('uncover:9')).toBeGreaterThan(log.indexOf('painted'));
  });

  it('a later "uncover" run waits until an earlier lock is painted, and the lock is never undone', async () => {
    let ready = true;
    const { e, log } = effects({ away: [{ ms: 60_000, epoch: 1 }, { ms: 0, epoch: 2 }], ready: () => ready });
    const paint = deferred<void>();
    e.lock = () => {
      ready = false;
      log.push('lock');
    };
    e.painted = () => paint.promise.then(() => void log.push('painted'));
    const ctl = activeController(e);
    const a = ctl.active();
    await ticks();
    expect(log).toContain('lock');
    const b = ctl.active(); // a newer event while the lock screen is still being painted
    await ticks();
    expect(log.some((l) => l.startsWith('uncover'))).toBe(false);
    paint.resolve();
    expect(await a).toBe('stale');
    expect(await b).toBe('uncover'); // on the lock screen now: just uncover it
    expect(ready).toBe(false);
    expect(log.indexOf('uncover:2')).toBeGreaterThan(log.indexOf('painted'));
    expect(log).not.toContain('uncover:1');
  });

  it('native refused the uncover (paused since the epoch): the React cover stays', async () => {
    const { e, log } = effects({ away: [{ ms: 0, epoch: 5 }], ready: () => true, uncoverOk: false });
    expect(await activeController(e).active()).toBe('stale');
    expect(log).toEqual(['uncover:5']);
  });
});

describe('forget-pairing way out after failed unlocks', () => {
  const failed = unlockOutcome({ reason: 'failed' });
  const cancelled = unlockOutcome({ reason: 'cancelled' });

  it('offered after three failed unlocks in a row, not before', () => {
    expect(FORGET_AFTER_FAILURES).toBe(3);
    let n = 0;
    n = nextFailureCount(n, failed);
    n = nextFailureCount(n, failed);
    expect(offerForget(n)).toBe(false);
    n = nextFailureCount(n, failed);
    expect(offerForget(n)).toBe(true);
  });

  it('a cancel breaks the run', () => {
    let n = 0;
    n = nextFailureCount(n, failed);
    n = nextFailureCount(n, failed);
    n = nextFailureCount(n, cancelled);
    n = nextFailureCount(n, failed);
    expect(n).toBe(1);
    expect(offerForget(n)).toBe(false);
  });
});
