import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Db, type OffsiteTarget, Vault, getSetting, openDb, setSetting } from '@finc/core';
import { type Connection, type ParsedKey, Server, type SFTPWrapper, utils } from 'ssh2';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './api/app.js';
import { type BackupDeps, BackupJob } from './backup.js';
import { HostKeyChangedError, NAS_ENTRY, type NasConfig, OffsiteJob, SftpTarget, fingerprint, generateBackupKey, generateSshKeyPair, probeHostKey } from './offsite.js';
import { Scheduler, type SchedulerDeps } from './scheduler.js';
import type { WorkerState } from './server.js';

const { STATUS_CODE } = utils.sftp;

// ---------------------------------------------------------------------------------------------------------------
// A fake NAS: ssh2's Server on 127.0.0.1 with its own host key, accepting only the keys it is given, serving SFTP
// from a temp folder. Like OpenSSH it refuses a rename onto an existing file; REMOVE is refused (and recorded).

interface FakeNas {
  port: number;
  hostKey: string;
  root: string;
  ops: string[];
  authAttempts: number;
  allow(publicKey: string): void;
  close(): Promise<void>;
}

function parse(k: string): ParsedKey {
  const p = utils.parseKey(k);
  if (p instanceof Error) throw p;
  return p;
}

async function startFakeNas(root: string): Promise<FakeNas> {
  const host = generateSshKeyPair();
  const allowed: ParsedKey[] = [];
  const clients = new Set<Connection>();
  const nas: FakeNas = {
    port: 0,
    hostKey: fingerprint(parse(host.public).getPublicSSH()),
    root,
    ops: [],
    authAttempts: 0,
    allow: (pub) => void allowed.push(parse(pub)),
    close: async () => {
      for (const c of clients) c.end();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
  const local = (p: string): string => {
    const parts = p.split('/').filter(Boolean);
    if (parts.includes('..')) throw new Error('..');
    return path.join(root, ...parts);
  };
  const serveSftp = (sftp: SFTPWrapper) => {
    const handles = new Map<number, { fd: number } | { names: string[]; sent: boolean }>();
    let next = 1;
    const h = (n: number) => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(n);
      return b;
    };
    const id = (b: Buffer) => b.readUInt32BE(0);
    const fail = (req: number, e: unknown) => sftp.status(req, (e as NodeJS.ErrnoException).code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE, String((e as Error).message));
    const attrsOf = (st: ReturnType<typeof statSync>) => ({ mode: Number(st.mode), uid: 0, gid: 0, size: Number(st.size), atime: Math.floor(Number(st.atimeMs) / 1000), mtime: Math.floor(Number(st.mtimeMs) / 1000) });
    sftp.on('OPEN', (req, filename, flags) => {
      nas.ops.push(`OPEN ${filename} ${utils.sftp.flagsToString(flags)}`);
      try {
        const fd = openSync(local(filename), utils.sftp.flagsToString(flags) ?? 'r');
        const n = next++;
        handles.set(n, { fd });
        sftp.handle(req, h(n));
      } catch (e) {
        fail(req, e);
      }
    });
    sftp.on('WRITE', (req, handle, offset, data) => {
      const x = handles.get(id(handle));
      if (!x || !('fd' in x)) return sftp.status(req, STATUS_CODE.FAILURE);
      writeSync(x.fd, data, 0, data.length, offset);
      sftp.status(req, STATUS_CODE.OK);
    });
    sftp.on('READ', (req, handle, offset, len) => {
      const x = handles.get(id(handle));
      if (!x || !('fd' in x)) return sftp.status(req, STATUS_CODE.FAILURE);
      const buf = Buffer.alloc(len);
      const n = readSync(x.fd, buf, 0, len, offset);
      if (n === 0) sftp.status(req, STATUS_CODE.EOF);
      else sftp.data(req, buf.subarray(0, n));
    });
    sftp.on('FSTAT', (req, handle) => {
      const x = handles.get(id(handle));
      if (!x || !('fd' in x)) return sftp.status(req, STATUS_CODE.FAILURE);
      sftp.attrs(req, attrsOf(fstatSync(x.fd)));
    });
    const stat = (req: number, p: string) => {
      try {
        sftp.attrs(req, attrsOf(statSync(local(p))));
      } catch (e) {
        fail(req, e);
      }
    };
    sftp.on('STAT', stat);
    sftp.on('LSTAT', stat);
    sftp.on('CLOSE', (req, handle) => {
      const x = handles.get(id(handle));
      handles.delete(id(handle));
      if (x && 'fd' in x) closeSync(x.fd);
      sftp.status(req, STATUS_CODE.OK);
    });
    sftp.on('RENAME', (req, from, to) => {
      nas.ops.push(`RENAME ${from} ${to}`);
      try {
        if (existsSync(local(to))) return sftp.status(req, STATUS_CODE.FAILURE, 'target exists');
        renameSync(local(from), local(to));
        sftp.status(req, STATUS_CODE.OK);
      } catch (e) {
        fail(req, e);
      }
    });
    sftp.on('REMOVE', (req, p) => {
      nas.ops.push(`REMOVE ${p}`);
      sftp.status(req, STATUS_CODE.PERMISSION_DENIED);
    });
    sftp.on('OPENDIR', (req, p) => {
      try {
        const names = readdirSync(local(p));
        const n = next++;
        handles.set(n, { names, sent: false });
        sftp.handle(req, h(n));
      } catch (e) {
        fail(req, e);
      }
    });
    sftp.on('READDIR', (req, handle) => {
      const x = handles.get(id(handle));
      if (!x || !('names' in x)) return sftp.status(req, STATUS_CODE.FAILURE);
      if (x.sent) return sftp.status(req, STATUS_CODE.EOF);
      x.sent = true;
      sftp.name(
        req,
        x.names.map((filename) => ({ filename, longname: filename, attrs: { mode: 0o100644, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 } })),
      );
    });
    sftp.on('end', () => {
      for (const x of handles.values()) if ('fd' in x) closeSync(x.fd); // Windows: open handles block the temp cleanup
      handles.clear();
    });
  };
  const server = new Server({ hostKeys: [host.private] }, (client) => {
    clients.add(client);
    client.on('error', () => undefined);
    client.on('close', () => clients.delete(client));
    client.on('authentication', (ctx) => {
      nas.authAttempts++;
      if (ctx.method !== 'publickey') return ctx.reject(['publickey']);
      const k = allowed.find((a) => a.type === ctx.key.algo && a.getPublicSSH().equals(ctx.key.data));
      if (!k) return ctx.reject(['publickey']);
      if (ctx.signature && ctx.blob && !k.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) return ctx.reject(['publickey']);
      ctx.accept();
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('sftp', (acceptSftp) => serveSftp(acceptSftp()));
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  nas.port = (server.address() as { port: number }).port;
  return nas;
}

// ---------------------------------------------------------------------------------------------------------------

const backupName = (day: number, hh = '01') => `finc-202611${String(day).padStart(2, '0')}T${hh}4000Z.fincbak`;

/** An in-memory target for the job logic (the real SFTP path is tested against the fake NAS above). */
class MemTarget implements OffsiteTarget {
  files = new Map<string, Buffer>();
  closed = 0;
  puts: string[] = [];
  describe() {
    return 'mem:/copies';
  }
  async put(n: string, b: Buffer) {
    if (this.files.has(n)) throw new Error('exists');
    this.puts.push(n);
    this.files.set(n, Buffer.from(b));
  }
  async get(n: string) {
    const b = this.files.get(n);
    if (!b) throw new Error('no such file');
    return b;
  }
  async list() {
    return [...this.files.keys()];
  }
  async close() {
    this.closed++;
  }
}

const nasEntry = (o: Partial<NasConfig> = {}) => ({ host: '192.0.2.1', port: '22', username: 'finc-backup', dir: '/copies', privateKey: 'not-a-real-key', hostKey: 'SHA256:x', configuredAt: '2026-11-01T00:00:00.000Z', ...o });
/** a vault stub: `nas` null means "not configured" */
const stubVault = (s: { locked: boolean; nas: Record<string, string> | null }) =>
  ({
    get locked() {
      return s.locked;
    },
    has: () => true,
    get: (name: string) => (name === NAS_ENTRY ? (s.nas ? { kind: 'generic', fields: s.nas, updatedAt: '' } : undefined) : { kind: 'scraper', fields: { username: 'u', password: 'p' }, updatedAt: '' }),
  }) as unknown as Vault;

let db: Db;
let tmp: string;
let dataDirBefore: string | undefined;
beforeAll(() => {
  dataDirBefore = process.env.FINC_DATA_DIR;
});
afterAll(() => {
  if (dataDirBefore === undefined) delete process.env.FINC_DATA_DIR;
  else process.env.FINC_DATA_DIR = dataDirBefore;
});
beforeEach(() => {
  db = openDb(':memory:');
  tmp = mkdtempSync(path.join(os.tmpdir(), 'finc-offsite-test-'));
  process.env.FINC_DATA_DIR = path.join(tmp, 'data'); // never the real data folder (vaultPath() in /api/health)
});
afterEach(() => {
  db.$client.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('SftpTarget against a local SSH server', () => {
  let nas: FakeNas;
  let key: { privateKey: string; publicKey: string };
  let cfg: NasConfig;
  beforeEach(async () => {
    mkdirSync(path.join(tmp, 'nas', 'copies'), { recursive: true });
    nas = await startFakeNas(path.join(tmp, 'nas'));
    key = generateBackupKey();
    cfg = { host: '127.0.0.1', port: nas.port, username: 'finc-backup', dir: '/copies', privateKey: key.privateKey, hostKey: nas.hostKey };
  });
  afterEach(async () => {
    await nas.close();
  });

  it('a key made for the NAS is ed25519 with the finc-backup comment', () => {
    expect(key.publicKey).toMatch(/^ssh-ed25519 AAAA[\w+/=]+ finc-backup$/);
    expect(key.privateKey).toContain('OPENSSH PRIVATE KEY');
  });

  it('every generated key reads back (ssh2 alone writes a broken one about 1 time in 256)', () => {
    for (let i = 0; i < 1500; i++) {
      const k = generateBackupKey();
      expect(utils.parseKey(k.publicKey)).not.toBeInstanceOf(Error);
      expect(utils.parseKey(k.privateKey)).not.toBeInstanceOf(Error);
    }
  });

  it('connects with the pinned host key, puts via a temporary name and a rename, reads back, lists, never overwrites', async () => {
    nas.allow(key.publicKey);
    const t = await SftpTarget.open(cfg);
    try {
      expect(t.describe()).toBe(`finc-backup@127.0.0.1:${nas.port}:/copies`);
      expect(await t.list()).toEqual([]);
      const bytes = randomBytes(200_000); // more than one SFTP packet
      await t.put('finc-20261110T014000Z.fincbak', bytes);
      expect(readFileSync(path.join(tmp, 'nas', 'copies', 'finc-20261110T014000Z.fincbak')).equals(bytes)).toBe(true);
      expect((await t.get('finc-20261110T014000Z.fincbak')).equals(bytes)).toBe(true);
      expect(await t.list()).toEqual(['finc-20261110T014000Z.fincbak']); // no temporary file left behind
      const open = nas.ops.find((o) => o.startsWith('OPEN /copies/.finc-20261110T014000Z.fincbak.'));
      expect(open).toMatch(/\.part wx$/); // created exclusively, never truncating anything
      expect(nas.ops.some((o) => /^RENAME \/copies\/\.finc-.*\.part \/copies\/finc-20261110T014000Z\.fincbak$/.test(o))).toBe(true);
      await expect(t.put('finc-20261110T014000Z.fincbak', randomBytes(10))).rejects.toThrow(/already exists.*not overwritten/);
      expect(readFileSync(path.join(tmp, 'nas', 'copies', 'finc-20261110T014000Z.fincbak')).equals(bytes)).toBe(true);
      await expect(t.put('../evil', bytes)).rejects.toThrow(/invalid remote file name/);
      await expect(t.get('finc-missing.fincbak')).rejects.toThrow(/read on .*: /);
      expect(nas.ops.some((o) => o.startsWith('REMOVE'))).toBe(false);
    } finally {
      await t.close();
    }
  });

  it('refuses a NAS whose host key is not the pinned one, before authenticating', async () => {
    nas.allow(key.publicKey);
    const other = fingerprint(parse(generateSshKeyPair().public).getPublicSSH());
    const err = await SftpTarget.open({ ...cfg, hostKey: other }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostKeyChangedError);
    expect(String((err as Error).message)).toMatch(/^the NAS host key changed \(expected SHA256:.* got SHA256:/);
    expect((err as Error).message).not.toContain('PRIVATE KEY');
    expect(nas.authAttempts).toBe(0);
    expect(nas.ops).toEqual([]);
  });

  it('a key the NAS does not know is refused with a clear error', async () => {
    await expect(SftpTarget.open(cfg)).rejects.toThrow(/could not connect to finc-backup@127\.0\.0\.1.*authentication/i);
  });

  it('probeHostKey reads the host key without authenticating', async () => {
    const r = await probeHostKey('127.0.0.1', nas.port);
    expect(r).toEqual({ fingerprint: nas.hostKey, type: 'ssh-ed25519' });
    expect(nas.authAttempts).toBe(0);
  });

  it('a closed port is a clear error, not a hang', async () => {
    await nas.close();
    await expect(probeHostKey('127.0.0.1', nas.port, 3_000)).rejects.toThrow(/ECONNREFUSED|connect/i);
  });
});

describe('the nightly offsite copy', () => {
  const cfg = { times: ['06:00'], jitterMinutes: 0, timezone: 'UTC', monthsBack: 3, backupTime: '03:40' };
  const writeLocal = (names: string[]) => {
    for (const n of names) writeFileSync(path.join(tmp, n), randomBytes(64));
  };
  const create: BackupDeps['create'] = async (_db, _v, o) => ({ file: path.join(o.dir, backupName(10)), result: { ok: true, integrity: 'ok', counts: { transaction: 5 }, mismatches: [], meta: {} as never } });

  it('is a no-op when the NAS is not configured: no connection, no alerts', async () => {
    writeLocal([backupName(10)]);
    let connects = 0;
    const alerts: string[] = [];
    const job = new BackupJob(db, () => stubVault({ locked: false, nas: null }), 'UTC', {
      create,
      retention: () => [],
      dir: () => tmp,
      alert: (_d, _v, t) => void alerts.push(t),
      offsite: {
        connect: async () => {
          connects++;
          return new MemTarget();
        },
      },
    });
    job.reserve();
    const r = await job.runReserved();
    expect(r.offsite).toBeNull();
    job.checkAllStale();
    expect(connects).toBe(0);
    expect(alerts).toEqual([]);
    expect(getSetting(db, 'offsite.lastOkAt')).toBeNull();
    expect(job.offsite.status()).toMatchObject({ configured: false, target: null });
  });

  it('after a good backup: copies the newest, then catches up at most 3 missing older ones', async () => {
    const names = [10, 9, 8, 7, 6, 5].map((d) => backupName(d));
    writeLocal(names);
    const mem = new MemTarget();
    mem.files.set(backupName(8), readFileSync(path.join(tmp, backupName(8)))); // already there
    const now = new Date('2026-11-10T01:41:00Z');
    const job = new BackupJob(db, () => stubVault({ locked: false, nas: nasEntry() }), 'UTC', { create, retention: () => [], dir: () => tmp, now: () => now, alert: () => undefined, offsite: { connect: async () => mem } });
    job.reserve();
    const r = await job.runReserved();
    expect(r.offsite).toEqual({ ok: true, copied: [backupName(10), backupName(9), backupName(7), backupName(6)] });
    expect(mem.puts).toEqual([backupName(10), backupName(9), backupName(7), backupName(6)]);
    expect(mem.files.has(backupName(5))).toBe(false); // left for the next night
    expect(mem.closed).toBe(1);
    expect(getSetting(db, 'offsite.lastOkAt')).toBe(now.toISOString());
    expect(getSetting(db, 'offsite.lastFile')).toBe(backupName(10));
    // the next night catches up the last one; nothing is uploaded twice
    const r2 = await job.offsite.run();
    expect(r2).toMatchObject({ copied: [backupName(5)], skipped: [backupName(10)], left: 0 });
  });

  it('a failed copy does not fail the local backup; it is recorded and alerted once a day', async () => {
    writeLocal([backupName(10)]);
    let now = new Date('2026-11-10T01:41:00Z');
    const alerts: string[] = [];
    const job = new BackupJob(db, () => stubVault({ locked: false, nas: nasEntry() }), 'UTC', {
      create,
      retention: () => [],
      dir: () => tmp,
      now: () => now,
      alert: (_d, _v, t) => void alerts.push(t),
      offsite: {
        connect: async () => {
          throw new Error('could not connect to finc-backup@192.0.2.1:/copies: Timed out while waiting\n for handshake');
        },
      },
    });
    for (let i = 0; i < 2; i++) {
      job.reserve();
      const r = await job.runReserved();
      expect(r.ok).toBe(true);
      expect(r.offsite).toMatchObject({ ok: false });
    }
    expect(getSetting(db, 'backup.lastOkAt')).toBe(now.toISOString());
    expect(getSetting(db, 'backup.lastError')).toBeNull();
    // stored cleaned (P2-09): the NAS user@host is masked
    expect(getSetting(db, 'offsite.lastError')).toBe('could not connect to [email]:/copies: Timed out while waiting for handshake');
    expect(getSetting(db, 'offsite.lastErrorAt')).toBe(now.toISOString());
    expect(getSetting(db, 'offsite.lastOkAt')).toBeNull();
    // the alert: kind + fixed phrase only, no host or path
    expect(alerts).toEqual(['offsite backup copy failed: no answer in time (timeout); details: finc backup nas status at home']);
    now = new Date('2026-11-11T01:41:00Z');
    job.reserve();
    await job.runReserved();
    expect(alerts).toHaveLength(2);
  });

  it('a copy that would overwrite different content fails (never overwritten)', async () => {
    writeLocal([backupName(10)]);
    const mem = new MemTarget();
    mem.files.set(backupName(10), Buffer.from('something else'));
    const job = new OffsiteJob(db, () => stubVault({ locked: false, nas: nasEntry() }), 'UTC', { connect: async () => mem, dir: () => tmp, alert: () => undefined });
    await expect(job.run()).rejects.toThrow(/different content; not overwritten/);
    expect(mem.files.get(backupName(10))!.toString()).toBe('something else');
    expect(getSetting(db, 'offsite.lastError')).toMatch(/not overwritten/);
  });

  it('stale: one alert a day when configured and no copy for OFFSITE_STALE_DAYS, only while unlocked', () => {
    const state = { locked: false, nas: nasEntry({ configuredAt: '2026-11-01T00:00:00.000Z' }) as Record<string, string> | null };
    let now = new Date('2026-11-03T12:00:00Z');
    const alerts: string[] = [];
    const job = new OffsiteJob(db, () => stubVault(state), 'UTC', { connect: async () => new MemTarget(), dir: () => tmp, now: () => now, alert: (_d, _v, t) => void alerts.push(t) });
    job.checkStale(); // configured 2.5 days ago, never copied: not yet
    expect(alerts).toEqual([]);
    now = new Date('2026-11-05T12:00:00Z');
    state.locked = true;
    job.checkStale();
    expect(alerts).toEqual([]);
    state.locked = false;
    job.checkStale();
    job.checkStale();
    expect(alerts).toEqual(['no offsite backup copy for 4 days']);
    // a copy 2 days old: quiet
    now = new Date('2026-11-06T12:00:00Z');
    setSetting(db, 'offsite.lastOkAt', '2026-11-04T12:00:00.000Z');
    job.checkStale();
    expect(alerts).toHaveLength(1);
    // 3 days and a bit, another day: alert again
    now = new Date('2026-11-07T13:00:00Z');
    job.checkStale();
    expect(alerts).toEqual(['no offsite backup copy for 4 days', 'no offsite backup copy for 3 days']);
    // not configured: never
    now = new Date('2026-11-20T13:00:00Z');
    state.nas = null;
    job.checkStale();
    expect(alerts).toHaveLength(2);
  });

  it('the scheduler hourly check runs the offsite stale check too', () => {
    const alerts: string[] = [];
    const s = new Scheduler(db, () => stubVault({ locked: false, nas: nasEntry({ configuredAt: '2026-01-01T00:00:00.000Z' }) }), cfg, {
      dispatch: (async () => undefined) as SchedulerDeps['dispatch'],
      backup: { dir: () => tmp, alert: (_d, _v, t) => void alerts.push(t) },
    });
    setSetting(db, 'backup.lastOkAt', new Date().toISOString());
    s.backup.checkAllStale();
    expect(alerts.length).toBe(1);
    expect(alerts[0]).toMatch(/^no offsite backup copy for \d+ days$/);
  });
});

describe('/api/backup/offsite/*', () => {
  const TOKEN = 'c'.repeat(64);
  const bearer = { authorization: `Bearer ${TOKEN}` };
  const publicEdge = { ...bearer, 'x-finc-edge': 'public', 'x-forwarded-for': '172.18.0.1' };
  const cfg = { times: ['06:00'], jitterMinutes: 0, timezone: 'UTC', monthsBack: 3, backupTime: '03:40' };
  let nas: FakeNas;
  let vault: Vault;
  beforeEach(async () => {
    mkdirSync(path.join(tmp, 'nas', 'copies'), { recursive: true });
    mkdirSync(path.join(tmp, 'local'));
    nas = await startFakeNas(path.join(tmp, 'nas'));
    vault = await Vault.create(path.join(tmp, 'vault.json'), 'correct-horse-9', { ops: 1, mem: 1024 * 1024 });
  });
  afterEach(async () => {
    vault.lock();
    await nas.close();
  });

  const setup = () => {
    const state: WorkerState = { db, vault: null, scheduler: null as unknown as Scheduler, startedAt: Date.now() };
    state.scheduler = new Scheduler(db, () => state.vault, cfg, { dispatch: (async () => undefined) as SchedulerDeps['dispatch'], backup: { dir: () => path.join(tmp, 'local'), alert: () => undefined } });
    const { app } = createApp(state, { controlToken: TOKEN, webDist: '/nonexistent' });
    const call = async (p: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
      const res = await app.request(p, { method: init.method ?? 'POST', headers: { 'content-type': 'application/json', ...(init.headers ?? bearer) }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    };
    return { state, call };
  };

  it('home only: every endpoint refuses the public edge', async () => {
    const { state, call } = setup();
    state.vault = vault;
    for (const [p, method] of [
      ['/api/backup/offsite/setup', 'POST'],
      ['/api/backup/offsite/confirm', 'POST'],
      ['/api/backup/offsite/run', 'POST'],
      ['/api/backup/offsite', 'DELETE'],
    ] as const) {
      expect((await call(p, { method, body: {}, headers: publicEdge })).status).toBe(403);
      expect((await call(p, { method, body: {}, headers: {} })).status).toBe(401);
    }
  });

  it('setup, a failed confirm that keeps the setup, a good confirm, run, health and remove', async () => {
    const { state, call } = setup();
    const body = { host: '127.0.0.1', port: nas.port, username: 'finc-backup', dir: '/copies' };
    expect((await call('/api/backup/offsite/setup', { body })).status).toBe(409); // vault locked
    state.vault = vault;
    expect((await call('/api/backup/offsite/setup', { body: { ...body, dir: '/copies/../etc' } })).status).toBe(400);
    expect((await call('/api/backup/offsite/confirm', { body: { hostKey: nas.hostKey } })).status).toBe(410); // nothing pending
    const s = await call('/api/backup/offsite/setup', { body });
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ hostKey: nas.hostKey, hostKeyType: 'ssh-ed25519', expiresInMin: 10 });
    expect(s.body.publicKey).toMatch(/^ssh-ed25519 \S+ finc-backup$/);
    expect(JSON.stringify(s.body)).not.toContain('PRIVATE');
    expect(nas.authAttempts).toBe(0);
    expect(vault.has(NAS_ENTRY)).toBe(false); // nothing stored before the confirm
    // a fingerprint that is not the one read: refused
    expect((await call('/api/backup/offsite/confirm', { body: { hostKey: 'SHA256:somethingelse' } })).status).toBe(400);
    // the key is not on the NAS yet: a clear error, the setup is kept
    const bad = await call('/api/backup/offsite/confirm', { body: { hostKey: nas.hostKey } });
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toMatch(/authentication/i);
    expect(vault.has(NAS_ENTRY)).toBe(false);
    // the user installs the key on the NAS and retries
    nas.allow(String(s.body.publicKey));
    const ok = await call('/api/backup/offsite/confirm', { body: { hostKey: nas.hostKey } });
    expect(ok).toMatchObject({ status: 200, body: { ok: true, files: 0 } });
    const entry = vault.get(NAS_ENTRY)!;
    expect(entry.kind).toBe('generic');
    expect(entry.fields).toMatchObject({ host: '127.0.0.1', port: String(nas.port), username: 'finc-backup', dir: '/copies', hostKey: nas.hostKey });
    expect(entry.fields.privateKey).toContain('OPENSSH PRIVATE KEY');
    expect((await call('/api/backup/offsite/confirm', { body: { hostKey: nas.hostKey } })).status).toBe(410); // used up
    // run: nothing local yet is an error (recorded), then a real copy over SFTP
    const empty = await call('/api/backup/offsite/run');
    expect(empty.status).toBe(502);
    writeFileSync(path.join(tmp, 'local', backupName(9)), randomBytes(5000));
    writeFileSync(path.join(tmp, 'local', backupName(10)), randomBytes(5000));
    const run = await call('/api/backup/offsite/run');
    expect(run).toMatchObject({ status: 200, body: { ok: true, copied: [backupName(10), backupName(9)], skipped: [], left: 0 } });
    expect(readdirSync(path.join(tmp, 'nas', 'copies')).sort()).toEqual([backupName(9), backupName(10)]);
    const again = await call('/api/backup/offsite/run');
    expect(again.body).toMatchObject({ copied: [], skipped: [backupName(10)] });
    const health = await call('/api/health', { method: 'GET' });
    expect((health.body.backup as { offsite: unknown }).offsite).toMatchObject({ configured: true, target: `finc-backup@127.0.0.1:${nas.port}:/copies`, lastFile: backupName(10) });
    expect(JSON.stringify(health.body)).not.toContain('PRIVATE');
    // remove: the vault entry goes, the NAS files stay, run is refused
    expect(await call('/api/backup/offsite', { method: 'DELETE' })).toMatchObject({ status: 200, body: { ok: true, removed: true } });
    expect(vault.has(NAS_ENTRY)).toBe(false);
    expect(readdirSync(path.join(tmp, 'nas', 'copies'))).toHaveLength(2);
    expect((await call('/api/backup/offsite/run')).status).toBe(409);
    state.vault = null;
    expect((await call('/api/backup/offsite/run')).status).toBe(409);
    expect(((await call('/api/health', { method: 'GET' })).body.backup as { offsite: { configured: unknown } }).offsite.configured).toBeNull();
  });

  it('independent review 2026-11-10: a real login or an odd folder is refused; remove clears the old status and any pending setup', async () => {
    const { state, call } = setup();
    state.vault = vault;
    const body = { host: '127.0.0.1', port: nas.port, username: 'finc-backup', dir: '/copies' };
    for (const bad of [{ username: 'alex' }, { username: 'root' }, { dir: '/' }, { dir: '/my copies' }, { dir: '/$(id)' }]) {
      expect((await call('/api/backup/offsite/setup', { body: { ...body, ...bad } })).status, JSON.stringify(bad)).toBe(400);
    }
    // an old pairing's status, then remove: the weekly summary and health must not keep warning about it
    const { setSetting, getSetting } = await import('@finc/core');
    setSetting(db, 'offsite.lastOkAt', '2026-11-01T01:40:00.000Z');
    setSetting(db, 'offsite.lastError', 'old failure');
    const s = await call('/api/backup/offsite/setup', { body });
    expect(s.status).toBe(200);
    expect((await call('/api/backup/offsite', { method: 'DELETE' })).status).toBe(200);
    expect(getSetting(db, 'offsite.lastOkAt')).toBeNull();
    expect(getSetting(db, 'offsite.lastError')).toBeNull();
    // the pending setup (and its private key) went with the remove
    nas.allow(String(s.body.publicKey));
    expect((await call('/api/backup/offsite/confirm', { body: { hostKey: nas.hostKey } })).status).toBe(410);
  });

  it('a pending setup expires after 10 minutes', async () => {
    let t = Date.now();
    const state: WorkerState = { db, vault, scheduler: null as unknown as Scheduler, startedAt: Date.now() };
    state.scheduler = new Scheduler(db, () => state.vault, cfg, { dispatch: (async () => undefined) as SchedulerDeps['dispatch'], backup: { dir: () => tmp } });
    const { app } = createApp(state, { controlToken: TOKEN, webDist: '/nonexistent', now: () => t });
    const post = (p: string, body: unknown) => app.request(p, { method: 'POST', headers: { 'content-type': 'application/json', ...bearer }, body: JSON.stringify(body) });
    const s = await post('/api/backup/offsite/setup', { host: '127.0.0.1', port: nas.port, username: 'finc-backup', dir: '/copies' });
    const { publicKey, hostKey } = (await s.json()) as { publicKey: string; hostKey: string };
    nas.allow(publicKey);
    t += 10 * 60_000 + 1;
    expect((await post('/api/backup/offsite/confirm', { hostKey })).status).toBe(410);
    expect(vault.has(NAS_ENTRY)).toBe(false);
  });
});
