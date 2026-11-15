import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from './db.js';
import {
  DbOwnedError,
  OWNER_STALE_MS,
  assertDbAvailable,
  claimDb,
  claimDbSync,
  claimForOpen,
  ownerAge,
  ownerPath,
  readOwner,
  type DbOwner,
} from './owner.js';

const dirs: string[] = [];
const releases: Array<() => void> = [];
const tmpDb = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'finc-owner-test-'));
  dirs.push(d);
  return path.join(d, 'finc.db');
};
afterEach(() => {
  for (const r of releases.splice(0)) r();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const writeOwnerFile = (dbFile: string, o: Partial<DbOwner> & { heartbeatAt: string }) =>
  writeFileSync(
    ownerPath(dbFile),
    JSON.stringify({ host: 'other-host', pid: 4242, role: 'worker', startedAt: o.heartbeatAt, ...o }),
  );
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('db owner file (P1-13)', () => {
  it('ownerPath appends .owner', () => {
    expect(ownerPath('/x/finc.db')).toBe('/x/finc.db.owner');
  });

  it('a fresh foreign owner blocks assertDbAvailable and openDb, without creating the DB file', () => {
    const db = tmpDb();
    writeOwnerFile(db, { heartbeatAt: ago(2000) });
    expect(() => assertDbAvailable(db)).toThrow(DbOwnedError);
    let err: unknown;
    try {
      openDb(db);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DbOwnedError);
    expect((err as DbOwnedError).owner.host).toBe('other-host');
    expect((err as Error).message).toMatch(/worker on other-host owns the database \(heartbeat 2s ago\)/);
    expect((err as Error).message).toContain('.\\finc <command>');
    expect(existsSync(db)).toBe(false);
  });

  it('a stale foreign owner is allowed', () => {
    const db = tmpDb();
    writeOwnerFile(db, { heartbeatAt: ago(OWNER_STALE_MS + 1000) });
    expect(() => assertDbAvailable(db)).not.toThrow();
    const d = openDb(db);
    d.$client.close();
    expect(existsSync(db)).toBe(true);
  });

  it('a fresh owner from this host is allowed', () => {
    const db = tmpDb();
    writeOwnerFile(db, { host: os.hostname(), heartbeatAt: ago(0) });
    expect(() => assertDbAvailable(db)).not.toThrow();
  });

  it('a missing owner file, or an old incomplete one, is allowed', () => {
    const db = tmpDb();
    expect(readOwner(db)).toBeNull();
    expect(() => assertDbAvailable(db)).not.toThrow();
    writeFileSync(ownerPath(db), JSON.stringify({ host: 'other-host' }));
    const old = new Date(Date.now() - OWNER_STALE_MS - 5000);
    utimesSync(ownerPath(db), old, old);
    expect(readOwner(db)).toBeNull();
    expect(() => assertDbAvailable(db)).not.toThrow();
  });

  it('honours an injected clock', () => {
    const db = tmpDb();
    const t = Date.parse('2026-11-10T10:00:00Z');
    writeOwnerFile(db, { heartbeatAt: new Date(t).toISOString() });
    expect(() => assertDbAvailable(db, () => t + 5000)).toThrow(DbOwnedError);
    expect(() => assertDbAvailable(db, () => t + OWNER_STALE_MS)).not.toThrow();
  });

  it('claimDb writes the owner file, beats, and release removes it', async () => {
    const db = tmpDb();
    const claim = await claimDb({ dbFile: db, role: 'worker', intervalMs: 20 });
    releases.push(claim.release);
    const first = readOwner(db);
    expect(first).toMatchObject({ host: os.hostname(), pid: process.pid, role: 'worker' });
    await sleep(80);
    const later = readOwner(db);
    expect(later).not.toBeNull();
    expect(Date.parse(later!.heartbeatAt)).toBeGreaterThan(Date.parse(first!.heartbeatAt));
    expect(later!.startedAt).toBe(first!.startedAt);
    claim.release();
    expect(existsSync(ownerPath(db))).toBe(false);
  });

  it('release does not remove an owner file rewritten by someone else', async () => {
    const db = tmpDb();
    const claim = await claimDb({ dbFile: db, intervalMs: 60_000 });
    releases.push(claim.release);
    writeOwnerFile(db, { heartbeatAt: ago(0) });
    claim.release();
    expect(readOwner(db)?.host).toBe('other-host');
  });

  it('claimDb without waitMs rejects on a fresh foreign owner', async () => {
    const db = tmpDb();
    writeOwnerFile(db, { heartbeatAt: ago(1000) });
    await expect(claimDb({ dbFile: db })).rejects.toBeInstanceOf(DbOwnedError);
    expect(readOwner(db)?.host).toBe('other-host');
  });

  it('claimDb with waitMs waits for a foreign owner to go stale, then claims', async () => {
    const db = tmpDb();
    // Fresh for another ~150ms of real time.
    writeOwnerFile(db, { heartbeatAt: ago(OWNER_STALE_MS - 150) });
    const t0 = Date.now();
    const claim = await claimDb({ dbFile: db, waitMs: 5000, intervalMs: 20 });
    releases.push(claim.release);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
    expect(readOwner(db)).toMatchObject({ host: os.hostname(), pid: process.pid });
  });

  it('a CLI openDb claims as cli; close() stops beating and leaves a fresh file to go stale', () => {
    const db = tmpDb();
    const d = openDb(db);
    expect(readOwner(db)).toMatchObject({ host: os.hostname(), pid: process.pid, role: 'cli' });
    d.$client.close();
    expect(readOwner(db)).toMatchObject({ pid: process.pid, role: 'cli' }); // a CLI leaves its file to go stale (round 3)
  });

  it('a CLI openDb takes over a stale foreign owner and releases it on close', () => {
    const db = tmpDb();
    writeOwnerFile(db, { heartbeatAt: ago(OWNER_STALE_MS + 1000) });
    const d = openDb(db);
    expect(readOwner(db)).toMatchObject({ host: os.hostname(), role: 'cli' });
    d.$client.close();
    expect(readOwner(db)).toMatchObject({ pid: process.pid, role: 'cli' }); // a CLI leaves its file to go stale (round 3)
  });

  it('openDb leaves a fresh same-host owner (the worker in this container) alone', () => {
    const db = tmpDb();
    writeOwnerFile(db, { host: os.hostname(), pid: 999_999, heartbeatAt: ago(1000) });
    const before = readFileSync(ownerPath(db), 'utf8');
    const d = openDb(db);
    expect(readFileSync(ownerPath(db), 'utf8')).toBe(before);
    d.$client.close();
    expect(readFileSync(ownerPath(db), 'utf8')).toBe(before);
  });

  it('openDb after the worker claimed in this process does not claim twice', async () => {
    const db = tmpDb();
    const claim = await claimDb({ dbFile: db, role: 'worker', intervalMs: 60_000 });
    releases.push(claim.release);
    const d = openDb(db);
    expect(readOwner(db)).toMatchObject({ role: 'worker', pid: process.pid });
    d.$client.close();
    expect(readOwner(db)?.role).toBe('worker');
  });

  it('a CLI claim blocks a worker on another host', async () => {
    const db = tmpDb();
    const d = openDb(db);
    // Seen from another host, the cli owner is foreign: rewrite it as such to simulate that view.
    const o = readOwner(db)!;
    writeOwnerFile(db, { ...o, host: 'other-host' });
    await expect(claimDb({ dbFile: db })).rejects.toBeInstanceOf(DbOwnedError);
    d.$client.close();
  });

  it('a beat that finds a different fresh owner stops, calls onConflict and leaves the file', async () => {
    const db = tmpDb();
    const conflicts: DbOwner[] = [];
    const claim = await claimDb({ dbFile: db, intervalMs: 20, onConflict: (o) => conflicts.push(o) });
    releases.push(claim.release);
    writeOwnerFile(db, { heartbeatAt: ago(0) });
    const foreign = readFileSync(ownerPath(db), 'utf8');
    await sleep(100);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.host).toBe('other-host');
    expect(readFileSync(ownerPath(db), 'utf8')).toBe(foreign);
    claim.release();
    expect(readFileSync(ownerPath(db), 'utf8')).toBe(foreign);
  });

  it('a cli claim yields quietly to a same-host owner with another pid (no conflict, file left alone)', async () => {
    const db = tmpDb();
    const conflicts: DbOwner[] = [];
    const yields: DbOwner[] = [];
    const claim = claimDbSync({
      dbFile: db,
      role: 'cli',
      intervalMs: 20,
      onConflict: (o) => conflicts.push(o),
      onYield: (o) => yields.push(o),
    });
    releases.push(claim.release);
    writeOwnerFile(db, { host: os.hostname(), pid: 999_999, heartbeatAt: ago(0) });
    await sleep(100);
    expect(conflicts).toEqual([]);
    expect(yields.map((c) => c.pid)).toEqual([999_999]);
    expect(readOwner(db)?.pid).toBe(999_999);
  });

  it('a worker claim re-takes the file from a same-host owner with another pid (no conflict)', async () => {
    const db = tmpDb();
    const conflicts: DbOwner[] = [];
    const claim = await claimDb({ dbFile: db, role: 'worker', intervalMs: 20, onConflict: (o) => conflicts.push(o) });
    releases.push(claim.release);
    writeOwnerFile(db, { host: os.hostname(), pid: 999_999, heartbeatAt: ago(0) });
    await sleep(100);
    expect(conflicts).toEqual([]);
    expect(readOwner(db)).toMatchObject({ pid: process.pid, role: 'worker' });
  });

  it("a beat that finds a fresh 'unknown' (garbage) owner is a conflict", async () => {
    const db = tmpDb();
    const conflicts: DbOwner[] = [];
    const claim = await claimDb({ dbFile: db, intervalMs: 20, onConflict: (o) => conflicts.push(o) });
    releases.push(claim.release);
    writeFileSync(ownerPath(db), 'half-written{');
    await sleep(100);
    expect(conflicts.map((c) => c.host)).toEqual(['unknown']);
    expect(readFileSync(ownerPath(db), 'utf8')).toBe('half-written{');
  });

  it('two CLIs on one host: the second watches, and claims when the first lets go', async () => {
    const db = tmpDb();
    // The first CLI (same host, another pid) holds the file.
    writeOwnerFile(db, { host: os.hostname(), pid: 999_999, role: 'cli', heartbeatAt: ago(0) });
    const conflicts: DbOwner[] = [];
    const second = claimForOpen(db, { intervalMs: 20, onConflict: (o) => conflicts.push(o) });
    releases.push(second.release);
    expect(readOwner(db)?.pid).toBe(999_999); // no claim taken, file untouched
    rmSync(ownerPath(db)); // the first CLI closed
    await sleep(100);
    expect(readOwner(db)).toMatchObject({ host: os.hostname(), pid: process.pid, role: 'cli' });
    second.release();
    expect(readOwner(db)).toMatchObject({ pid: process.pid, role: 'cli' }); // a CLI leaves its file to go stale (round 3)
    expect(conflicts).toEqual([]);
  });

  it('the watcher also claims when the same-host owner goes stale', async () => {
    const db = tmpDb();
    const t = Date.now();
    let clock = t;
    writeOwnerFile(db, { host: os.hostname(), pid: 999_999, heartbeatAt: new Date(t).toISOString() });
    const w = claimForOpen(db, { intervalMs: 20, now: () => clock, onConflict: () => {} });
    releases.push(w.release);
    await sleep(60);
    expect(readOwner(db)?.pid).toBe(999_999);
    clock = t + OWNER_STALE_MS + 1;
    await sleep(60);
    expect(readOwner(db)?.pid).toBe(process.pid);
  });

  it('the watcher calls onConflict when a fresh foreign owner appears', async () => {
    const db = tmpDb();
    writeOwnerFile(db, { host: os.hostname(), pid: 999_999, heartbeatAt: ago(0) });
    const conflicts: DbOwner[] = [];
    const w = claimForOpen(db, { intervalMs: 20, onConflict: (o) => conflicts.push(o) });
    releases.push(w.release);
    writeOwnerFile(db, { heartbeatAt: ago(0) });
    await sleep(100);
    expect(conflicts.map((c) => c.host)).toEqual(['other-host']);
    expect(readOwner(db)?.host).toBe('other-host');
  });

  it('a cli claim that yielded falls back to watching, then re-claims when the file is free', async () => {
    const db = tmpDb();
    const w = claimForOpen(db, { intervalMs: 20, onConflict: () => {} });
    releases.push(w.release);
    expect(readOwner(db)?.pid).toBe(process.pid);
    writeOwnerFile(db, { host: os.hostname(), pid: 999_999, heartbeatAt: ago(0) });
    await sleep(80);
    expect(readOwner(db)?.pid).toBe(999_999); // yielded, not overwritten
    rmSync(ownerPath(db));
    await sleep(80);
    expect(readOwner(db)?.pid).toBe(process.pid);
    w.release();
    expect(readOwner(db)).toMatchObject({ pid: process.pid, role: 'cli' }); // a CLI leaves its file to go stale (round 3)
  });

  it('claimDb: a stale-looking foreign owner whose file keeps changing is alive (clock skew) and blocks', async () => {
    const db = tmpDb();
    const old = ago(3_600_000);
    let n = 0;
    writeOwnerFile(db, { heartbeatAt: old, startedAt: String(n++) });
    const rewriter = setInterval(() => {
      try {
        writeOwnerFile(db, { heartbeatAt: old, startedAt: String(n++) });
      } catch {
        // Windows may refuse a write while the file is being read; the next tick retries
      }
    }, 5);
    try {
      await expect(claimDb({ dbFile: db, waitMs: 150, intervalMs: 20 })).rejects.toBeInstanceOf(DbOwnedError);
      expect(readOwner(db)?.host).toBe('other-host');
    } finally {
      clearInterval(rewriter);
    }
  });

  it('claimDb: a skewed-but-alive foreign owner that stops beating is claimed within waitMs', async () => {
    const db = tmpDb();
    const old = ago(3_600_000);
    let n = 0;
    writeOwnerFile(db, { heartbeatAt: old, startedAt: String(n++) });
    const rewriter = setInterval(() => {
      try {
        writeOwnerFile(db, { heartbeatAt: old, startedAt: String(n++) });
      } catch {
        // Windows may refuse a write while the file is being read; the next tick retries
      }
    }, 5);
    setTimeout(() => clearInterval(rewriter), 100);
    const claim = await claimDb({ dbFile: db, waitMs: 3000, intervalMs: 20 });
    releases.push(claim.release);
    expect(readOwner(db)).toMatchObject({ host: os.hostname(), pid: process.pid });
  });

  it('claimDb: an unchanged stale foreign owner is claimed after one liveness check', async () => {
    const db = tmpDb();
    writeOwnerFile(db, { heartbeatAt: ago(3_600_000) });
    const t0 = Date.now();
    const claim = await claimDb({ dbFile: db, intervalMs: 20 });
    releases.push(claim.release);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    expect(readOwner(db)?.pid).toBe(process.pid);
  });

  it('claimDbSync throws on a fresh foreign owner', () => {
    const db = tmpDb();
    writeOwnerFile(db, { heartbeatAt: ago(0) });
    expect(() => claimDbSync({ dbFile: db })).toThrow(DbOwnedError);
  });

  it('garbage with a fresh mtime refuses; with an old mtime allows', () => {
    const db = tmpDb();
    writeFileSync(ownerPath(db), 'half-written{');
    expect(readOwner(db)?.host).toBe('unknown');
    expect(() => assertDbAvailable(db)).toThrow(DbOwnedError);
    expect(() => openDb(db)).toThrow(DbOwnedError);
    expect(existsSync(db)).toBe(false);
    const old = new Date(Date.now() - OWNER_STALE_MS - 5000);
    utimesSync(ownerPath(db), old, old);
    expect(readOwner(db)).toBeNull();
    expect(() => assertDbAvailable(db)).not.toThrow();
  });

  it('an unreadable owner file (a directory: EISDIR) refuses', () => {
    const db = tmpDb();
    mkdirSync(ownerPath(db));
    expect(() => readOwner(db)).toThrow(/cannot read the database owner file/);
    expect(() => assertDbAvailable(db)).toThrow(/check its permissions/);
    expect(() => openDb(db)).toThrow(/cannot read the database owner file/);
    expect(existsSync(db)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('writes the owner file with mode 0644 despite a tight umask', async () => {
    const db = tmpDb();
    const prev = process.umask(0o077);
    try {
      const claim = await claimDb({ dbFile: db, intervalMs: 60_000 });
      releases.push(claim.release);
      expect(statSync(ownerPath(db)).mode & 0o777).toBe(0o644);
    } finally {
      process.umask(prev);
    }
  });

  it('ownerAge measures from heartbeatAt', () => {
    const t = Date.parse('2026-11-10T10:00:00Z');
    const o: DbOwner = { host: 'h', pid: 1, role: 'worker', startedAt: '', heartbeatAt: new Date(t).toISOString() };
    expect(ownerAge(o, () => t + 1234)).toBe(1234);
  });

  it('claimDb with a too-short waitMs still rejects', async () => {
    const db = tmpDb();
    writeOwnerFile(db, { heartbeatAt: ago(0) });
    await expect(claimDb({ dbFile: db, waitMs: 50 })).rejects.toBeInstanceOf(DbOwnedError);
  });
});

describe('db owner file, review round 4 (released mark, clocks, own claim, unreadable)', () => {
  it('a CLI that closes marks its file released: another host may open at once, whatever the clocks say', () => {
    const db = tmpDb();
    openDb(db).$client.close();
    expect(readOwner(db)).toMatchObject({ role: 'cli', released: true });
    // seen from another host: a released file is not a fresh owner
    writeOwnerFile(db, { heartbeatAt: ago(0), role: 'cli', released: true });
    expect(() => assertDbAvailable(db)).not.toThrow();
  });

  it('claimDb: a released foreign file is claimed after the clock-free change check, not after 30 s', async () => {
    const db = tmpDb();
    writeOwnerFile(db, { heartbeatAt: ago(0), role: 'cli', released: true });
    const t0 = Date.now();
    const claim = await claimDb({ dbFile: db, waitMs: 5000, intervalMs: 20 });
    releases.push(claim.release);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(readOwner(db)).toMatchObject({ host: os.hostname(), pid: process.pid });
  });

  it('claimDb: a heartbeat dated far in the future (clock ahead) that does not change is claimed', async () => {
    const db = tmpDb();
    writeOwnerFile(db, { heartbeatAt: new Date(Date.now() + 600_000).toISOString() });
    const claim = await claimDb({ dbFile: db, waitMs: 5000, intervalMs: 20 });
    releases.push(claim.release);
    expect(readOwner(db)?.pid).toBe(process.pid);
  });

  it('claimDb: a future-dated heartbeat that keeps changing is alive and blocks until waitMs', async () => {
    const db = tmpDb();
    let n = 0;
    const future = () => new Date(Date.now() + 600_000).toISOString();
    writeOwnerFile(db, { heartbeatAt: future(), startedAt: String(n++) });
    const beat = setInterval(() => {
      try {
        writeOwnerFile(db, { heartbeatAt: future(), startedAt: String(n++) });
      } catch {
        // a write racing the reader on Windows; the next one lands
      }
    }, 5);
    try {
      await expect(claimDb({ dbFile: db, waitMs: 200, intervalMs: 20 })).rejects.toBeInstanceOf(DbOwnedError);
    } finally {
      clearInterval(beat);
    }
  });

  it('a watching CLI claims at once when the other CLI marks the file released', async () => {
    const db = tmpDb();
    writeOwnerFile(db, { host: os.hostname(), pid: 999_999, role: 'cli', heartbeatAt: ago(0) });
    const w = claimForOpen(db, { intervalMs: 20, onConflict: () => {} });
    releases.push(w.release);
    writeOwnerFile(db, { host: os.hostname(), pid: 999_999, role: 'cli', heartbeatAt: ago(0), released: true });
    await sleep(100);
    expect(readOwner(db)).toMatchObject({ pid: process.pid, role: 'cli' });
    expect(readOwner(db)?.released).toBeUndefined();
  });

  it("the worker's own openDb after claimDb takes no claim and no watcher, and closing leaves the worker's file", async () => {
    const db = tmpDb();
    const claim = await claimDb({ dbFile: db });
    releases.push(claim.release);
    const before = readFileSync(ownerPath(db), 'utf8');
    const d = openDb(db);
    d.$client.close();
    expect(readFileSync(ownerPath(db), 'utf8')).toBe(before);
  });

  it('a CLI with two handles: closing the first does not leave the second unclaimed', async () => {
    const db = tmpDb();
    const first = claimForOpen(db, { intervalMs: 20, onConflict: () => {} });
    const second = claimForOpen(db, { intervalMs: 20, onConflict: () => {} });
    releases.push(second.release);
    first.release(); // marks the file released
    await sleep(100);
    expect(readOwner(db)).toMatchObject({ pid: process.pid, role: 'cli' });
    expect(readOwner(db)?.released).toBeUndefined();
  });

  it('a claim whose owner file stays unreadable gives up after three beats (fail closed)', async () => {
    const db = tmpDb();
    const conflicts: DbOwner[] = [];
    const claim = await claimDb({ dbFile: db, intervalMs: 20, onConflict: (o) => conflicts.push(o) });
    releases.push(claim.release);
    rmSync(ownerPath(db));
    mkdirSync(ownerPath(db)); // EISDIR on every read from now on
    await sleep(150);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.host).toBe('unknown');
  });
});
