/**
 * What the phone does when it comes back to the foreground (security research P1-11). Pure decisions plus a
 * small runner with injected effects, so both can be tested without React or the plugin.
 *
 * The time away is measured natively (FincVault.awayMs, Android's elapsedRealtime since the last pause), so
 * changing the clock cannot shorten it, and reading it consumes it: at most one lock per absence. (That is what
 * fixed the 2026-11-10 lock / fingerprint loop: an "active" event with no pause before it reads 0.)
 *
 * Native code also covers the WebView on every pause; it stays up until `uncover()` is called. The React cover is
 * a second layer, raised on the 'inactive' event.
 */

/** Lock after 30 seconds away, not five minutes. */
export const LOCK_AFTER_MS = 30_000;

export type ActiveDecision = 'nolock' | 'lock' | 'uncover';

/**
 * - the phone's screen lock was removed while finc was away: 'nolock' (forget everything, refuse to run);
 * - the token is in memory ('ready') and the app was away more than 30 s: 'lock';
 * - otherwise: just 'uncover'.
 * `deviceSecure` null = the vault did not answer: an open session locks (fail closed), a locked app just uncovers.
 * Readiness is judged now, not at pause time: an unlock or pairing that finished while hidden still locks.
 */
export function decideOnActive(i: { awayMs: number; deviceSecure: boolean | null; ready: boolean; lockAfterMs?: number }): ActiveDecision {
  if (i.deviceSecure === false) return 'nolock';
  if (i.ready && i.deviceSecure === null) return 'lock';
  if (i.ready && i.awayMs > (i.lockAfterMs ?? LOCK_AFTER_MS)) return 'lock';
  return 'uncover';
}

export interface ActiveEffects {
  /** the native timer: consumed by the read; `epoch` goes back to uncover() */
  awayMs: () => Promise<{ ms: number; epoch?: number }>;
  deviceSecure: () => Promise<boolean | null>;
  isReady: () => boolean;
  /** token out of memory, React Query cache cleared */
  forgetSession: () => void;
  clearWebCache: () => Promise<void>;
  /** switch screens, committed synchronously (flushSync) */
  lock: () => void;
  noLock: () => void;
  /** resolves once the new screen has been painted (two animation frames) */
  painted: () => Promise<void>;
  /** drop the native cover; false = refused (paused again since `epoch`) */
  uncover: (epoch?: number) => Promise<boolean>;
  /** the React cover */
  setCovered: (v: boolean) => void;
}

export type ActiveRun = ActiveDecision | 'stale';

/**
 * Serializes the app-state handling (security research P1-11, races found in review):
 * - every 'active' and 'inactive' event bumps a generation; a run that is no longer the newest never uncovers
 *   and never drops the React cover (it may still lock: locking is always safe);
 * - the native timer reads are chained, and a superseded run's time away is kept for the newest one, so a
 *   consumed "away 60 s" can never be lost to an overlapping "away 0" read;
 * - after a lock / nolock the covers come down only once the new screen is painted;
 * - the epoch from the timer read goes to uncover(), so native refuses if the app was paused again meanwhile.
 */
export function activeController(e: ActiveEffects): { inactive: () => void; active: () => Promise<ActiveRun> } {
  let gen = 0;
  let reads: Promise<unknown> = Promise.resolve();
  let pendingMs = 0;
  let lastEpoch: number | undefined;
  /** the latest lock / nolock screen change being painted: every later uncover waits for it */
  let painting: Promise<void> = Promise.resolve();

  return {
    inactive() {
      gen++;
      e.setCovered(true);
    },
    async active() {
      const id = ++gen;
      const read = reads.then(async () => {
        const r = await e.awayMs();
        pendingMs = Math.max(pendingMs, r.ms);
        lastEpoch = r.epoch;
      });
      reads = read.catch(() => undefined);
      const failClosed = () => {
        pendingMs = Number.POSITIVE_INFINITY;
      };
      const [, deviceSecure] = await Promise.all([read.catch(failClosed), e.deviceSecure().catch(() => null)]);
      if (id !== gen) return 'stale'; // its time away stays in pendingMs for the newer run
      const away = pendingMs;
      const epoch = lastEpoch;
      pendingMs = 0;
      const d = decideOnActive({ awayMs: away, deviceSecure, ready: e.isReady() });
      if (d !== 'uncover') {
        e.forgetSession();
        if (d === 'lock') e.lock();
        else e.noLock();
        painting = e.painted();
        await e.clearWebCache();
      }
      await painting;
      if (id !== gen) return 'stale';
      if (!(await e.uncover(epoch))) return 'stale';
      if (id !== gen) return 'stale';
      e.setCovered(false);
      return d;
    },
  };
}

/** The lock screen's way out: after this many failed unlocks in a row it offers "Forget this pairing". */
export const FORGET_AFTER_FAILURES = 3;

/** Consecutive 'failed' unlocks; a cancel or any other outcome breaks the run. */
export function nextFailureCount(prev: number, outcome: { kind: string; message?: string | null }): number {
  return outcome.kind === 'retry' && outcome.message === 'lock_failed' ? prev + 1 : 0;
}

export const offerForget = (failures: number): boolean => failures >= FORGET_AFTER_FAILURES;
