import { chmodSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dbPath } from '../config/paths.js';

/**
 * "One writer" guard for the SQLite file (P1-13). The worker runs in Docker Desktop with data/ bind-mounted, and
 * SQLite file locks do not work across the Windows/Docker boundary, so whoever writes keeps a heartbeat owner file
 * next to the DB (`finc.db.owner`). Anyone else refuses to open the DB while a fresh owner from another host exists.
 * The worker claims with claimDb; a CLI run claims through openDb (role 'cli').
 */
export interface DbOwner {
  host: string;
  pid: number;
  role: string;
  startedAt: string;
  heartbeatAt: string;
  /** Written by a CLI's last beat when it closes: nobody holds the DB, whatever the clocks say (review round 4). */
  released?: boolean;
}

/** An owner whose heartbeat is older than this is considered dead. */
export const OWNER_STALE_MS = 30_000;
/** How often the claiming process refreshes heartbeatAt. */
export const OWNER_HEARTBEAT_MS = 10_000;
/** Mode of the owner file. It holds no secret, and a host user (e.g. on the Pi, umask 077 in the container) must read it. */
const OWNER_MODE = 0o644;

export function ownerPath(dbFile?: string): string {
  return `${dbFile ?? dbPath()}.owner`;
}

/** Milliseconds since the owner's last heartbeat. */
export function ownerAge(owner: DbOwner, now: () => number = Date.now): number {
  return now() - Date.parse(owner.heartbeatAt);
}

/** A heartbeat this far in the future means the writer's clock runs ahead of ours (WSL2 vs Windows). */
const FUTURE_SKEW_MS = 5_000;
/** Consecutive unreadable reads of the owner file after which a running claim or watcher gives up (fail closed). */
const MAX_READ_FAILURES = 3;
const unreadable = (): DbOwner => {
  const at = new Date().toISOString();
  return { host: 'unknown', pid: -1, role: 'unknown (owner file unreadable)', startedAt: at, heartbeatAt: at };
};

const isFresh = (owner: DbOwner, now: () => number) => !owner.released && ownerAge(owner, now) < OWNER_STALE_MS;

function parseOwner(raw: string): DbOwner | null {
  try {
    const o = JSON.parse(raw) as Partial<DbOwner> | null;
    if (
      !o ||
      typeof o !== 'object' ||
      typeof o.host !== 'string' ||
      typeof o.pid !== 'number' ||
      typeof o.heartbeatAt !== 'string' ||
      Number.isNaN(Date.parse(o.heartbeatAt))
    )
      return null;
    return {
      host: o.host,
      pid: o.pid,
      role: typeof o.role === 'string' ? o.role : 'unknown',
      startedAt: typeof o.startedAt === 'string' ? o.startedAt : o.heartbeatAt,
      heartbeatAt: o.heartbeatAt,
      ...(o.released === true ? { released: true } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The current owner record.
 * - Missing file (ENOENT): null.
 * - Any other read error (EACCES, EPERM, EBUSY, EISDIR...): throws, so nobody opens the DB on a guess.
 * - Unparseable content: if the file was modified within OWNER_STALE_MS it is treated as a fresh owner with host
 *   'unknown' (someone is there); otherwise null.
 */
export function readOwner(dbFile?: string, now: () => number = Date.now): DbOwner | null {
  const file = ownerPath(dbFile);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw new Error(
      `cannot read the database owner file ${file} (${code ?? String(e)}); check its permissions, or stop the finc worker, before opening the database`,
    );
  }
  const parsed = parseOwner(raw);
  if (parsed) return parsed;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return null;
  }
  if (now() - mtimeMs >= OWNER_STALE_MS) return null;
  const at = new Date(mtimeMs).toISOString();
  return { host: 'unknown', pid: -1, role: 'unknown', startedAt: at, heartbeatAt: at };
}

export class DbOwnedError extends Error {
  readonly owner: DbOwner;
  constructor(owner: DbOwner, ageMs: number) {
    const secs = Math.max(0, Math.round(ageMs / 1000));
    super(
      `the finc ${owner.role} on ${owner.host} owns the database (heartbeat ${secs}s ago); ` +
        'run the command through the launcher (.\\finc <command>), which runs it inside the container. ' +
        'Stop the worker first for a host run.',
    );
    this.name = 'DbOwnedError';
    this.owner = owner;
  }
}

/** A fresh owner from another host, with its heartbeat age; null when the DB is free for us. Throws when unreadable. */
function foreignOwner(dbFile: string | undefined, now: () => number): { owner: DbOwner; ageMs: number } | null {
  const owner = readOwner(dbFile, now);
  if (!owner || owner.host === os.hostname()) return null;
  return isFresh(owner, now) ? { owner, ageMs: ownerAge(owner, now) } : null;
}

/**
 * Throws DbOwnedError when a fresh owner (now - heartbeatAt < OWNER_STALE_MS) was written by another host, and a
 * plain Error when the owner file exists but cannot be read. Same host, stale or missing owner: returns.
 */
export function assertDbAvailable(dbFile?: string, now: () => number = Date.now): void {
  const f = foreignOwner(dbFile, now);
  if (f) throw new DbOwnedError(f.owner, f.ageMs);
}

function writeOwner(file: string, owner: DbOwner): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(owner), { mode: OWNER_MODE });
  renameSync(tmp, file);
  chmodSync(file, OWNER_MODE); // the umask may have narrowed the create mode
}

export interface ClaimSyncOptions {
  dbFile?: string;
  role?: string;
  intervalMs?: number;
  now?: () => number;
  /**
   * Called (once, heartbeat stopped, file left alone) when a beat finds a fresh owner from ANOTHER host (or 'unknown')
   * in the file. A same-host owner is not a conflict: same kernel, SQLite locking works there.
   */
  onConflict?: (other: DbOwner) => void;
  /**
   * role 'cli' only: called (once, heartbeat stopped quietly, file left alone) when a beat finds a fresh owner from
   * this host with another pid. Any other role keeps beating and re-takes the file.
   */
  onYield?: (other: DbOwner) => void;
}
export interface ClaimOptions extends ClaimSyncOptions {
  /** How long to wait for a fresh foreign owner to go stale before rejecting. Default 0. */
  waitMs?: number;
}
export interface DbClaim {
  release(): void;
}

/** Write the owner file now and keep it fresh. The caller has already checked availability. */
function startClaim(opts: ClaimSyncOptions): DbClaim {
  const now = opts.now ?? Date.now;
  const file = ownerPath(opts.dbFile);
  const host = os.hostname();
  const pid = process.pid;
  const role = opts.role ?? 'worker';
  const startedAt = new Date(now()).toISOString();
  const beat = (released = false) =>
    writeOwner(file, { host, pid, role, startedAt, heartbeatAt: new Date(now()).toISOString(), ...(released ? { released: true } : {}) });
  beat();

  let stopped = false;
  let readFailures = 0;
  const timer = setInterval(() => {
    if (stopped) return;
    let cur: DbOwner | null;
    try {
      cur = readOwner(opts.dbFile, now);
      readFailures = 0;
    } catch {
      // unreadable right now: do not overwrite blindly; the next beat retries, but not forever (fail closed)
      if (++readFailures >= MAX_READ_FAILURES) {
        stopped = true;
        clearInterval(timer);
        opts.onConflict?.(unreadable());
      }
      return;
    }
    if (cur && (cur.host !== host || cur.pid !== pid) && isFresh(cur, now)) {
      if (cur.host !== host) {
        stopped = true;
        clearInterval(timer);
        opts.onConflict?.(cur);
        return;
      }
      if (role === 'cli') {
        stopped = true;
        clearInterval(timer);
        opts.onYield?.(cur);
        return;
      }
      // Same host, another pid, and we are the worker: SQLite locking works here, so keep the file ours.
    }
    try {
      beat();
    } catch {
      // A missed beat is not fatal; the next one retries. Staleness only matters after OWNER_STALE_MS.
    }
  }, opts.intervalMs ?? OWNER_HEARTBEAT_MS);
  timer.unref();

  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      stopped = true;
      clearInterval(timer);
      let cur: DbOwner | null = null;
      try {
        cur = readOwner(opts.dbFile, now);
      } catch {
        return;
      }
      if (cur && cur.host === host && cur.pid === pid) {
        try {
          // A CLI does not delete its file: it marks it released. Another CLI on this host may still have the database
          // open (watching, not claiming) and claims at once on seeing it; a worker starting right now runs the
          // clock-free change check (~15 s) instead of finding no owner at all (review rounds 3 and 4).
          if (role === 'cli') beat(true);
          else unlinkSync(file);
        } catch {
          // already gone
        }
      }
    },
  };
}

/**
 * Claim the DB synchronously: throws DbOwnedError if a fresh owner from another host holds it, otherwise writes the
 * owner file and keeps it fresh. Does not wait. Note it does not check for a same-host owner; openDb does that.
 */
export function claimDbSync(opts: ClaimSyncOptions = {}): DbClaim {
  assertDbAvailable(opts.dbFile, opts.now);
  return startClaim(opts);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The owner file's raw bytes, null when missing; other read errors throw like readOwner. */
function readRaw(dbFile: string | undefined): string | null {
  try {
    return readFileSync(ownerPath(dbFile), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    readOwner(dbFile); // throws the standard "cannot read the database owner file" error
    throw e;
  }
}

/**
 * The worker claims the DB. Asserts availability, optionally waiting up to waitMs (polling) for a foreign owner to
 * go stale: a recreated container has a new hostname and the old one may have died without releasing.
 * Clock-free liveness: a foreign owner that only LOOKS stale by its heartbeat age is watched for ~1.5 x intervalMs;
 * if its file changes it is alive (its clock is skewed) and we keep waiting under the same deadline.
 * Then writes the owner file atomically (temp + rename, mode 0644) and refreshes heartbeatAt every intervalMs with an
 * unref'd timer. release() stops the timer and deletes the file only if it is still ours (same host + pid).
 */
export async function claimDb(opts: ClaimOptions = {}): Promise<DbClaim> {
  const now = opts.now ?? Date.now;
  const intervalMs = opts.intervalMs ?? OWNER_HEARTBEAT_MS;
  const deadline = now() + (opts.waitMs ?? 0);
  const host = os.hostname();
  for (;;) {
    const cur = readOwner(opts.dbFile, now);
    if (!cur || cur.host === host) break;
    // fresh by its clock and not dated in the future (a clock running ahead would keep it "fresh" for minutes)
    if (isFresh(cur, now) && ownerAge(cur, now) > -FUTURE_SKEW_MS) {
      const left = deadline - now();
      if (left <= 0) throw new DbOwnedError(cur, ownerAge(cur, now));
      // Sleep until it would go stale, capped by the deadline and a 1s poll so a release is noticed quickly.
      await sleep(Math.max(10, Math.min(left, OWNER_STALE_MS - ownerAge(cur, now), 1000)));
      continue;
    }
    // Looks stale, released, or dated in the future: is it still beating? (clock-free)
    const before = readRaw(opts.dbFile);
    await sleep(Math.round(intervalMs * 1.5));
    if (readRaw(opts.dbFile) === before) break; // dead: claim
    if (deadline - now() <= 0) throw new DbOwnedError(cur, ownerAge(cur, now));
  }
  return startClaim({ ...opts, intervalMs });
}

/** openDb's CLI claim lost the file to another writer: stop before both write. */
export function exitOnOwnerConflict(other: DbOwner): void {
  process.stderr.write(
    `finc: the ${other.role} on ${other.host} (pid ${other.pid}) took over the database while this command was running; ` +
      'stopping now so there are never two writers. Run the command through the launcher (.\\finc <command>).\n',
  );
  process.exit(75);
}

/**
 * The claim openDb takes for a CLI run (call after assertDbAvailable).
 * - No fresh owner: a 'cli' claim through claimDbSync.
 * - A fresh owner (same host: the worker in this container, or another CLI): no claim, but an unref'd watcher every
 *   intervalMs. When the file goes missing or stale, the watcher claims; a fresh foreign owner calls onConflict.
 * - A cli claim that yields to another same-host process falls back to the watcher.
 * Released (claim and watcher) by release(), which openDb calls on close, and on process exit.
 */
export function claimForOpen(
  file: string,
  opts: { intervalMs?: number; now?: () => number; onConflict?: (other: DbOwner) => void } = {},
): DbClaim {
  const now = opts.now ?? Date.now;
  const intervalMs = opts.intervalMs ?? OWNER_HEARTBEAT_MS;
  const onConflict = opts.onConflict ?? exitOnOwnerConflict;
  const host = os.hostname();
  let claim: DbClaim | null = null;
  let watcher: ReturnType<typeof setInterval> | null = null;
  let done = false;

  const stopWatch = () => {
    if (watcher) clearInterval(watcher);
    watcher = null;
  };
  const take = () => {
    claim = claimDbSync({
      dbFile: file,
      role: 'cli',
      intervalMs,
      now,
      onConflict,
      onYield: () => {
        claim = null;
        watch();
      },
    });
  };
  let readFailures = 0;
  const check = () => {
    if (done) return;
    let cur: DbOwner | null;
    try {
      cur = readOwner(file, now);
      readFailures = 0;
    } catch {
      // unreadable right now; try again next tick, but not forever (fail closed)
      if (++readFailures >= MAX_READ_FAILURES) {
        stopWatch();
        onConflict(unreadable());
      }
      return;
    }
    if (cur && isFresh(cur, now)) {
      if (cur.host !== host) {
        stopWatch();
        onConflict(cur);
      }
      return;
    }
    try {
      take();
      stopWatch();
    } catch (e) {
      if (e instanceof DbOwnedError) {
        stopWatch();
        onConflict(e.owner);
      }
    }
  };
  function watch() {
    if (done || watcher) return;
    watcher = setInterval(check, intervalMs);
    watcher.unref();
  }

  const cur = readOwner(file, now);
  // the worker's own claim in this very process (main.ts claims, then openDb): no second claim, and no watcher whose
  // exit(75) could race the worker's graceful onConflict (review round 4)
  // (only a non-cli claim: a CLI opening a second handle must keep its own claim, or closing the first would mark
  // the file released while the second still writes; review round 4)
  if (cur && cur.host === host && cur.pid === process.pid && !cur.released && cur.role !== 'cli') return { release: () => {} };
  if (cur && isFresh(cur, now)) watch();
  else take();

  const release = () => {
    if (done) return;
    done = true;
    process.off('exit', release);
    stopWatch();
    const c: DbClaim | null = claim;
    claim = null;
    c?.release();
  };
  process.once('exit', release);
  return { release };
}
