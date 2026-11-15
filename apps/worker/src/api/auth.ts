/**
 * Who may talk to the worker.
 *  - The browser at home (or over Tailscale): a PIN (hashed in the DB) exchanged for an HttpOnly session
 *    cookie, persisted hashed and tied to that PIN. From the internet only paired-device tokens count.
 *  - The `finc` CLI: a random control token the worker writes to data/control.token (0600) at start;
 *    the CLI reads it from the same data dir (shared with the container through the volume).
 * Both PIN and unlock attempts are rate limited: 5 per 10 minutes.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { controlTokenPath } from '@finc/core';

const SESSION_TTL_MS = 30 * 86_400_000;
const MAX_SESSIONS = 50;
/** A passkey session lives this long from its creation, never extended by use. */
export const PASSKEY_SESSION_MS = 12 * 3_600_000;

export interface SessionEntry {
  createdAt: number;
  lastSeen: number;
  agent: string;
  /** pinStamp of the PIN this session was opened with; a session without one (before 2026-11-10) is not honoured. */
  pin?: string;
  /** 'pin' (the default, home only) or 'passkey' (honoured from outside too, fixed lifetime). */
  kind?: 'pin' | 'passkey';
  /** the passkey that opened it, so revoking the passkey ends the session */
  passkeyId?: number;
  /** hard end (ms since epoch); set for passkey sessions */
  expiresAt?: number;
}

/** Where sessions outlive the process: keyed by the SHA-256 of the cookie, never the cookie itself. */
export interface SessionStore {
  load(): Record<string, SessionEntry>;
  save(entries: Record<string, SessionEntry>): void;
}

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/**
 * Browser sessions. With a store they survive a worker restart (a redeploy no longer logs every
 * browser out); without one they live in memory, as in tests. lastSeen is persisted at most hourly.
 */
export class Sessions {
  private readonly map = new Map<string, SessionEntry>();
  private lastSaved = 0;

  constructor(
    private readonly store?: SessionStore,
    private readonly now: () => number = Date.now,
  ) {
    if (store) {
      const t = now();
      for (const [k, v] of Object.entries(store.load())) if (t - v.lastSeen <= SESSION_TTL_MS && !(v.expiresAt !== undefined && v.expiresAt <= t)) this.map.set(k, v);
    }
  }

  create(agent: string, pinStamp: string): string {
    return this.open({ createdAt: this.now(), lastSeen: this.now(), agent: agent.slice(0, 120), pin: pinStamp });
  }

  /** A passkey session: tied to the PIN like any other, but with a fixed lifetime of PASSKEY_SESSION_MS. */
  createPasskey(agent: string, pinStamp: string, passkeyId: number): { token: string; expiresAt: number } {
    const t = this.now();
    const expiresAt = t + PASSKEY_SESSION_MS;
    const token = this.open({ createdAt: t, lastSeen: t, agent: agent.slice(0, 120), pin: pinStamp, kind: 'passkey', passkeyId, expiresAt });
    return { token, expiresAt };
  }

  private open(entry: SessionEntry): string {
    const token = randomBytes(32).toString('base64url');
    this.map.set(hashToken(token), entry);
    if (this.map.size > MAX_SESSIONS) {
      const oldest = [...this.map.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
      if (oldest) this.map.delete(oldest[0]);
    }
    this.persist(true);
    return token;
  }

  /** Valid only for the PIN it was opened with (security research P0-04); a mismatch drops the session for good. */
  valid(token: string | undefined, pinStamp: string | null): boolean {
    return this.check(token, pinStamp) !== null;
  }

  /** The live session for this cookie, or null; expired or mismatched sessions are dropped for good. */
  check(token: string | undefined, pinStamp: string | null): Readonly<SessionEntry> | null {
    if (!token) return null;
    const key = hashToken(token);
    const s = this.map.get(key);
    if (!s) return null;
    const t = this.now();
    const expired = t - s.lastSeen > SESSION_TTL_MS || (s.kind === 'passkey' && (s.expiresAt === undefined || s.expiresAt <= t));
    if (expired || !pinStamp || s.pin !== pinStamp) {
      this.map.delete(key);
      this.persist(true);
      return null;
    }
    s.lastSeen = t;
    this.persist(false);
    return s;
  }

  /** Ends every session the predicate picks (e.g. all sessions opened with a revoked passkey); returns how many. */
  revokeWhere(pick: (s: Readonly<SessionEntry>) => boolean): number {
    let n = 0;
    for (const [k, v] of this.map) {
      if (pick(v)) {
        this.map.delete(k);
        n++;
      }
    }
    if (n) this.persist(true);
    return n;
  }

  revoke(token: string | undefined): void {
    if (!token) return;
    this.map.delete(hashToken(token));
    this.persist(true);
  }

  /** Ends every session, PIN and passkey alike (the panic switch, P1-09); returns how many there were. */
  revokeAll(): number {
    const n = this.map.size;
    this.map.clear();
    this.persist(true);
    return n;
  }

  get count(): number {
    return this.map.size;
  }

  private persist(force: boolean): void {
    if (!this.store) return;
    if (!force && this.now() - this.lastSaved < 3_600_000) return;
    this.store.save(Object.fromEntries(this.map));
    this.lastSaved = this.now();
  }
}

/** N attempts per window, keyed by purpose + client. Old keys are pruned and the map is capped (audit L5). */
export class Attempts {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly max = 5,
    private readonly windowMs = 10 * 60_000,
    private readonly maxKeys = 5000,
  ) {}

  allowed(key: string): boolean {
    const now = Date.now();
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length) this.hits.set(key, arr);
    else this.hits.delete(key);
    if (this.hits.size > this.maxKeys) this.prune(now);
    return arr.length < this.max;
  }

  private prune(now: number): void {
    for (const [k, v] of this.hits) if (!v.some((t) => now - t < this.windowMs)) this.hits.delete(k);
    while (this.hits.size > this.maxKeys) {
      const first = this.hits.keys().next().value;
      if (first === undefined) break;
      this.hits.delete(first);
    }
  }

  record(key: string): void {
    this.hits.set(key, [...(this.hits.get(key) ?? []), Date.now()]);
  }

  /**
   * Check and count in one synchronous step, BEFORE the request body is read or a password is checked (security
   * research P1-01: checking first and recording only after the slow check let parallel requests all pass).
   * A success calls reset(key).
   */
  take(key: string): boolean {
    if (!this.allowed(key)) return false;
    this.record(key);
    return true;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}

export function ensureControlToken(): string {
  const file = controlTokenPath();
  if (existsSync(file)) {
    const t = readFileSync(file, 'utf8').trim();
    if (t.length >= 32) return t;
  }
  const token = randomBytes(32).toString('hex');
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows */
  }
  return token;
}

export function readControlToken(): string | null {
  const file = controlTokenPath();
  if (!existsSync(file)) return null;
  const t = readFileSync(file, 'utf8').trim();
  return t.length >= 32 ? t : null;
}

export function tokenMatches(given: string | undefined, expected: string): boolean {
  if (!given || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/**
 * One-time pairing codes for the Android app: created from a trusted network by someone already
 * signed in, valid for 5 minutes, redeemed once. In memory only, like the sessions.
 */
export class Pairings {
  private readonly codes = new Map<string, { name: string; expiresAt: number }>();
  constructor(private readonly ttlMs = 5 * 60_000) {}

  create(name: string): { code: string; expiresAt: string } {
    this.prune();
    while (this.codes.size >= 5) {
      const oldest = [...this.codes.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
      if (!oldest) break;
      this.codes.delete(oldest[0]);
    }
    const code = randomBytes(16).toString('base64url');
    const expiresAt = Date.now() + this.ttlMs;
    this.codes.set(code, { name, expiresAt });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Returns the suggested device name once; the code is gone afterwards. */
  redeem(code: string | undefined): { name: string } | null {
    this.prune();
    if (!code) return null;
    const entry = this.codes.get(code);
    if (!entry) return null;
    this.codes.delete(code);
    return { name: entry.name };
  }

  get pending(): number {
    this.prune();
    return this.codes.size;
  }

  /** Every pending pairing code gone (the panic switch, P1-09). */
  clear(): void {
    this.codes.clear();
  }

  private prune(): void {
    const now = Date.now();
    for (const [k, v] of this.codes) if (v.expiresAt <= now) this.codes.delete(k);
  }
}

/**
 * One password or PIN check at a time for the whole worker (P1-01): each master-password check is ~1 s of CPU and
 * ~256 MB, so a burst would stall the scheduler and the hub. A second check arriving meanwhile is refused, not queued.
 */
export const BUSY: unique symbol = Symbol('busy');
export class OneAtATime {
  private busy = false;
  async run<T>(fn: () => Promise<T>): Promise<T | typeof BUSY> {
    if (this.busy) return BUSY;
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.busy = false;
    }
  }
}

/**
 * Wrong master passwords counted while the vault is locked: Telegram's token is inside the vault, so those cannot be
 * reported at once (P1-05). They are reported in one message right after the next successful unlock.
 */
export class LockedFailures {
  private n = 0;
  private since: number | null = null;
  record(now = Date.now()): void {
    this.n++;
    this.since ??= now;
  }
  /** the pending report (and clears it), or null when there was none */
  take(): { count: number; since: number } | null {
    if (!this.n || this.since === null) return null;
    const r = { count: this.n, since: this.since };
    this.n = 0;
    this.since = null;
    return r;
  }
}

/**
 * One guard for the PIN as a whole, on top of the per-client limiter: behind Docker Desktop every client
 * looks the same, and on the Pi an attacker can rotate addresses (audit H1). After `free` failures each
 * further failure doubles a lock, up to an hour; a correct PIN resets it.
 */
export class PinGuard {
  private failures = 0;
  private lockedUntil = 0;
  constructor(
    private readonly free = 3,
    private readonly maxLockMs = 60 * 60_000,
  ) {}

  /** milliseconds until the next attempt is accepted; 0 when open */
  retryAfterMs(now = Date.now()): number {
    return Math.max(0, this.lockedUntil - now);
  }

  record(now = Date.now()): { failures: number; lockMs: number } {
    this.failures++;
    const over = this.failures - this.free;
    const lockMs = over > 0 ? Math.min(this.maxLockMs, 30_000 * 2 ** (over - 1)) : 0;
    if (lockMs) this.lockedUntil = now + lockMs;
    return { failures: this.failures, lockMs };
  }

  reset(): void {
    this.failures = 0;
    this.lockedUntil = 0;
  }

  get count(): number {
    return this.failures;
  }
}
