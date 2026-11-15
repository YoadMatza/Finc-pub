/**
 * The off-PC copy of the encrypted backups, the worker side: an SFTP target on the NAS (SftpTarget), the nightly copy
 * after a good local backup with a small catch-up (OffsiteJob), and the two-step pairing with the NAS (OffsiteSetup).
 *
 * The connection details and the private key live in the vault entry `nas_backup`. The NAS host key is pinned: only
 * the SHA-256 fingerprint the user confirmed at setup is accepted. Nothing here ever deletes a remote file. A failed
 * offsite copy never fails the local backup; it is recorded in the settings and alerted at most once a day.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { BACKUP_EXT, type Db, OFFSITE_SETTINGS, OFFSITE_STALE_DAYS, type OffsiteTarget, type SecurityEventInput, type Vault, VaultError, backupDir, classifyError, cleanErrorText, copyOffsite, errorPhrase, getSetting, missingOffsite, recordSecurityEvent, setSetting } from '@finc/core';
// ssh2 is CommonJS: Node's ESM loader cannot see its named exports at runtime (vitest can, so only a real start
// showed it, 2026-11-10). Take them from the default export.
import ssh2, { type Client as SshClient, type ConnectConfig, type SFTPWrapper } from 'ssh2';

const { Client, utils } = ssh2;
type Client = SshClient;
import { type SecurityAlertFn, securityAlert } from './alerts.js';
import { log } from './logger.js';

/** The vault entry with the NAS connection (kind 'generic'). */
export const NAS_ENTRY = 'nas_backup';
/** How many older local backups one run copies at most when they are missing on the NAS. */
export const OFFSITE_CATCH_UP = 3;
const KEY_COMMENT = 'finc-backup';

export interface NasConfig {
  host: string;
  port: number;
  username: string;
  dir: string;
  /** OpenSSH private key (ed25519). Never log it. */
  privateKey: string;
  /** "SHA256:<base64>" of the NAS host key, as `ssh-keygen -lf` shows it */
  hostKey: string;
  /** ISO time the pairing was confirmed (the stale check counts from here until the first copy) */
  configuredAt?: string;
}

/** OpenSSH's SHA-256 fingerprint of a public key blob: "SHA256:" + unpadded base64. */
export function fingerprint(keyBlob: Buffer): string {
  return `SHA256:${createHash('sha256').update(keyBlob).digest('base64').replace(/=+$/, '')}`;
}

/** The key type written at the start of an SSH public key blob, e.g. "ssh-ed25519". */
export function keyType(keyBlob: Buffer): string {
  try {
    const n = keyBlob.readUInt32BE(0);
    return keyBlob.subarray(4, 4 + n).toString('ascii');
  } catch {
    return '?';
  }
}

/** The NAS connection from the vault, or null when not configured (or incomplete). */
export function readNasConfig(vault: Vault): NasConfig | null {
  const e = vault.get(NAS_ENTRY);
  if (!e) return null;
  const f = e.fields;
  const port = Number(f.port ?? '22');
  if (!f.host || !f.username || !f.dir || !f.privateKey || !f.hostKey || !Number.isInteger(port)) return null;
  return { host: f.host, port, username: f.username, dir: f.dir, privateKey: f.privateKey, hostKey: f.hostKey, ...(f.configuredAt ? { configuredAt: f.configuredAt } : {}) };
}

export function describeNas(c: Pick<NasConfig, 'host' | 'port' | 'username' | 'dir'>): string {
  return `${c.username}@${c.host}${c.port === 22 ? '' : `:${c.port}`}:${c.dir}`;
}

/** A fresh ed25519 key pair for the NAS user, in OpenSSH formats. */
export function generateBackupKey(): { privateKey: string; publicKey: string } {
  const k = utils.generateKeyPairSync('ed25519', { comment: KEY_COMMENT });
  return { privateKey: k.private, publicKey: k.public.trim() };
}

export class HostKeyChangedError extends Error {
  constructor(
    readonly expected: string,
    readonly got: string,
  ) {
    super(`the NAS host key changed (expected ${expected}, got ${got}); nothing was sent. If the NAS was reinstalled, pair it again with: finc backup nas setup. Otherwise something else may be answering at that address.`);
  }
}

export interface SftpOptions {
  /** connect + handshake + authentication, default 15 s */
  readyTimeoutMs?: number;
  /** each SFTP operation, default 120 s */
  opTimeoutMs?: number;
}

/**
 * Connect once, without authenticating, and capture the server's host key (the verifier refuses it, which ends the
 * handshake before any credential is sent). Used by the setup so the user can compare the fingerprint on the NAS.
 */
export function probeHostKey(host: string, port: number, timeoutMs = 15_000): Promise<{ fingerprint: string; type: string }> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let captured: Buffer | null = null;
    let done = false;
    const finish = (err: Error | null) => {
      if (done) return;
      done = true;
      conn.end();
      if (captured) resolve({ fingerprint: fingerprint(captured), type: keyType(captured) });
      else reject(err ?? new Error(`no host key from ${host}:${port}`));
    };
    conn.on('error', (e) => finish(e));
    conn.on('close', () => finish(null));
    conn.on('ready', () => finish(null)); // cannot happen (the verifier refuses), but never leave it open
    const cfg: ConnectConfig = {
      host,
      port,
      username: 'finc-hostkey-probe',
      readyTimeout: timeoutMs,
      hostVerifier: (key: Buffer) => {
        captured = Buffer.from(key);
        return false;
      },
    };
    try {
      conn.connect(cfg);
    } catch (e) {
      finish(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

const posixJoin = (dir: string, name: string): string => `${dir.replace(/\/+$/, '')}/${name}`;

function safeName(name: string): string {
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') throw new Error(`invalid remote file name: ${name}`);
  return name;
}

/** SFTP over SSH with a pinned host key. Open with SftpTarget.open(); always close(). */
export class SftpTarget implements OffsiteTarget {
  private closed = false;
  private closeError: Error | null = null;
  private readonly pending = new Set<(e: Error) => void>();

  private constructor(
    private readonly cfg: NasConfig,
    private readonly conn: Client,
    private readonly sftp: SFTPWrapper,
    private readonly opTimeoutMs: number,
  ) {
    const fail = (e: Error) => {
      this.closeError ??= e;
      for (const r of [...this.pending]) r(e);
    };
    conn.on('error', (e) => fail(new Error(`connection to ${this.describe()} failed: ${e.message}`)));
    conn.on('close', () => {
      this.closed = true;
      fail(new Error(`connection to ${this.describe()} closed`));
    });
  }

  static open(cfg: NasConfig, o: SftpOptions = {}): Promise<SftpTarget> {
    const readyTimeout = o.readyTimeoutMs ?? 15_000;
    const opTimeout = o.opTimeoutMs ?? 120_000;
    return new Promise((resolve, reject) => {
      const conn = new Client();
      let mismatch: string | null = null;
      let settled = false;
      const fail = (e: Error) => {
        if (settled) return;
        settled = true;
        conn.end();
        reject(mismatch ? new HostKeyChangedError(cfg.hostKey, mismatch) : new Error(`could not connect to ${describeNas(cfg)}: ${e.message}`));
      };
      // a hard stop in case the SFTP subsystem never answers after the handshake (readyTimeout covers the handshake)
      const timer = setTimeout(() => fail(new Error(`no answer within ${Math.round((readyTimeout + 5_000) / 1000)} s`)), readyTimeout + 5_000);
      conn.on('error', (e) => {
        clearTimeout(timer);
        fail(e);
      });
      conn.on('close', () => {
        clearTimeout(timer);
        fail(new Error('the connection closed'));
      });
      conn.on('ready', () => {
        conn.sftp((err, sftp) => {
          clearTimeout(timer);
          if (err) return fail(new Error(`the SFTP subsystem refused: ${err.message}`));
          if (settled) {
            conn.end();
            return;
          }
          settled = true;
          resolve(new SftpTarget(cfg, conn, sftp, opTimeout));
        });
      });
      try {
        conn.connect({
          host: cfg.host,
          port: cfg.port,
          username: cfg.username,
          privateKey: cfg.privateKey,
          readyTimeout,
          // ONLY the pinned key: anything else ends the handshake before authentication
          hostVerifier: (key: Buffer) => {
            const got = fingerprint(key);
            if (got === cfg.hostKey) return true;
            mismatch = got;
            return false;
          },
          // the backup key only: no agent, no password, no keyboard-interactive
          tryKeyboard: false,
        });
      } catch (e) {
        clearTimeout(timer);
        fail(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  describe(): string {
    return describeNas(this.cfg);
  }

  private remote(name: string): string {
    return posixJoin(this.cfg.dir, safeName(name));
  }

  /** Time for moving `bytes`: the base timeout plus 1 s per 100 KB, so a slow link does not fail every night. */
  private transferTimeout(bytes: number): number {
    return this.opTimeoutMs + Math.ceil(bytes / 100_000) * 1000;
  }

  /** One SFTP call with a timeout; a dropped connection rejects it at once. */
  private op<T>(what: string, fn: (cb: (err: Error | null | undefined, v?: T) => void) => void, timeoutMs = this.opTimeoutMs): Promise<T> {
    if (this.closeError) return Promise.reject(this.closeError);
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const end = (e: Error | null, v?: T) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.pending.delete(onDrop);
        if (e) reject(e);
        else resolve(v as T);
      };
      const onDrop = (e: Error) => end(e);
      this.pending.add(onDrop);
      const timer = setTimeout(() => {
        end(new Error(`${what} on ${this.describe()} timed out after ${Math.round(timeoutMs / 1000)} s`));
        this.conn.end();
      }, timeoutMs);
      try {
        fn((err, v) => end(err ? new Error(`${what} on ${this.describe()}: ${err.message}`) : null, v));
      } catch (e) {
        end(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private async exists(remotePath: string): Promise<boolean> {
    try {
      await this.op('stat', (cb) => this.sftp.stat(remotePath, (err, st) => cb(err, st)));
      return true;
    } catch (e) {
      if (/no such file|does not exist/i.test(e instanceof Error ? e.message : '')) return false;
      throw e;
    }
  }

  async put(name: string, bytes: Buffer): Promise<void> {
    const final = this.remote(name);
    if (await this.exists(final)) throw new Error(`${name} already exists on ${this.describe()}; not overwritten`);
    // A unique temporary name: a part left by an interrupted run may be read-only (mode 0400), so it is never reused.
    const part = this.remote(`.${name}.${randomBytes(4).toString('hex')}.part`);
    // 'wx': create only, never truncate an existing file; 0400: the finished copy is read-only on the NAS
    await this.op('write', (cb) => this.sftp.writeFile(part, bytes, { flag: 'wx', mode: 0o400 }, (err) => cb(err)), this.transferTimeout(bytes.length));
    if (await this.exists(final)) throw new Error(`${name} appeared on ${this.describe()} during the upload; not overwritten (the temporary ${path.posix.basename(part)} is left there)`);
    // plain SFTP rename (not posix-rename): the server refuses it when the target exists
    await this.op('rename', (cb) => this.sftp.rename(part, final, (err) => cb(err)));
  }

  get(name: string): Promise<Buffer> {
    // the read-back is as large as the upload; allow for a local backup of up to 100 MB on a slow link
    return this.op<Buffer>('read', (cb) => this.sftp.readFile(this.remote(name), (err, data) => cb(err, data)), this.transferTimeout(100_000_000));
  }

  async list(): Promise<string[]> {
    const entries = await this.op<Array<{ filename: string }>>('list', (cb) => this.sftp.readdir(this.cfg.dir, (err, list) => cb(err, list)));
    return entries.map((e) => e.filename).filter((n) => n !== '.' && n !== '..');
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.conn.destroy();
        resolve();
      }, 5_000);
      this.conn.once('close', () => {
        clearTimeout(t);
        resolve();
      });
      try {
        this.sftp.end();
      } catch {
        /* already closed */
      }
      this.conn.end();
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The nightly copy

export class OffsiteNotConfiguredError extends Error {
  constructor() {
    super('offsite backup is not configured; run: finc backup nas setup');
  }
}
export class OffsiteLockedError extends Error {
  constructor() {
    super('vault is locked');
  }
}
export class OffsiteBusyError extends Error {
  constructor() {
    super('an offsite copy is already running');
  }
}

export interface OffsiteDeps {
  connect: (cfg: NasConfig) => Promise<OffsiteTarget>;
  /** the local backup folder */
  dir: () => string;
  now: () => Date;
  alert: SecurityAlertFn;
}

export interface OffsiteRunResult {
  ok: true;
  target: string;
  /** uploaded and read back */
  copied: string[];
  /** already on the NAS with the same content */
  skipped: string[];
  /** older local backups still missing on the NAS after this run (the next runs catch them up) */
  left: number;
}

export interface OffsiteStatus {
  /** null while the vault is locked (the entry cannot be read) */
  configured: boolean | null;
  target: string | null;
  lastOkAt: string | null;
  lastFile: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  running: boolean;
}

/** Local backup file names, newest first. */
function localBackups(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => n.startsWith('finc-') && n.endsWith(BACKUP_EXT))
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return [];
  }
}

/** Stored and logged error text, cleaned (P2-09): the NAS user@host becomes [email], numbers and query strings are masked. */
const oneLine = (e: unknown): string => cleanErrorText(e, 200);

export class OffsiteJob {
  private busy = false;
  private readonly deps: OffsiteDeps;

  constructor(
    private readonly db: Db,
    private readonly getVault: () => Vault | null,
    private readonly timezone: string,
    deps: Partial<OffsiteDeps> = {},
  ) {
    this.deps = {
      connect: deps.connect ?? ((cfg) => SftpTarget.open(cfg)),
      dir: deps.dir ?? backupDir,
      now: deps.now ?? (() => new Date()),
      alert: deps.alert ?? securityAlert,
    };
  }

  get isRunning(): boolean {
    return this.busy;
  }

  private config(): NasConfig | null {
    const v = this.getVault();
    if (!v || v.locked) throw new OffsiteLockedError();
    return readNasConfig(v);
  }

  /** Refuse at once (before queueing a manual run): locked, not configured, or already copying. */
  precheck(): void {
    if (!this.config()) throw new OffsiteNotConfiguredError();
    if (this.busy) throw new OffsiteBusyError();
  }

  /**
   * Copy the newest local backup, then up to OFFSITE_CATCH_UP older ones missing on the NAS. Records the outcome in
   * the settings; throws on failure (no alert here: the nightly caller alerts, a manual caller shows the error).
   */
  async run(): Promise<OffsiteRunResult> {
    const cfg = this.config();
    if (!cfg) throw new OffsiteNotConfiguredError();
    if (this.busy) throw new OffsiteBusyError();
    this.busy = true;
    try {
      const dir = this.deps.dir();
      const local = localBackups(dir);
      if (local.length === 0) throw new Error('no local backups to copy yet (make one: finc backup now)');
      const target = await this.deps.connect(cfg);
      const copied: string[] = [];
      const skipped: string[] = [];
      try {
        const newest = local[0]!;
        const r = await copyOffsite(target, path.join(dir, newest));
        (r.uploaded ? copied : skipped).push(newest);
        setSetting(this.db, OFFSITE_SETTINGS.lastOkAt, this.deps.now().toISOString());
        setSetting(this.db, OFFSITE_SETTINGS.lastFile, newest);
        const missing = await missingOffsite(target, local.slice(1));
        for (const name of missing.slice(0, OFFSITE_CATCH_UP)) {
          const c = await copyOffsite(target, path.join(dir, name));
          (c.uploaded ? copied : skipped).push(name);
        }
        const left = Math.max(0, missing.length - OFFSITE_CATCH_UP);
        log.info({ target: target.describe(), copied, skipped: skipped.length, left }, 'offsite: copied and read back');
        return { ok: true, target: target.describe(), copied, skipped, left };
      } finally {
        await target.close().catch(() => undefined);
      }
    } catch (e) {
      if (!(e instanceof OffsiteNotConfiguredError) && !(e instanceof OffsiteBusyError) && !(e instanceof VaultError && e.code === 'LOCKED')) {
        const msg = oneLine(e);
        log.error({ err: msg }, 'offsite: copy failed');
        // a changed NAS host key is its own kind: it may mean something else answers at that address
        recordSecurityEvent(this.db, e instanceof HostKeyChangedError ? { kind: 'backup.offsite_hostkey_changed', actor: 'system' } : { kind: 'backup.offsite_failed', actor: 'system', detail: { error: msg, kind: classifyError(e) } });
        try {
          setSetting(this.db, OFFSITE_SETTINGS.lastError, msg);
          setSetting(this.db, OFFSITE_SETTINGS.lastErrorAt, this.deps.now().toISOString());
        } catch (err) {
          log.error({ err: oneLine(err) }, 'offsite: the failure could not be recorded');
        }
      }
      throw e;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Right after a good local backup: copy when configured. Never throws (the local backup stays good whatever happens
   * here); a failure alerts at most once a local day. Returns null when nothing was attempted.
   */
  async afterBackup(): Promise<{ ok: true; copied: string[] } | { ok: false; error: string } | null> {
    try {
      if (!this.config()) return null;
    } catch {
      return null; // locked: the next night (or `finc backup nas test`) copies
    }
    try {
      const r = await this.run();
      return { ok: true, copied: r.copied };
    } catch (e) {
      if (e instanceof OffsiteBusyError || e instanceof OffsiteNotConfiguredError || e instanceof OffsiteLockedError || (e instanceof VaultError && e.code === 'LOCKED')) return null;
      const msg = oneLine(e);
      // the NAS host and path stay home (P2-09): the kind and a fixed phrase only; the detail is in /api/health
      const kind = classifyError(e);
      this.alertOnce(`offsite backup copy failed: ${errorPhrase(kind, 'en')} (${kind}); details: finc backup nas status at home`, null); // recorded in run()
      return { ok: false, error: msg };
    }
  }

  /** Hourly: one alert a day when configured, the vault unlocked, and no copy younger than OFFSITE_STALE_DAYS. */
  checkStale(): void {
    let cfg: NasConfig | null;
    try {
      cfg = this.config();
    } catch {
      return; // locked
    }
    if (!cfg) return;
    const last = getSetting(this.db, OFFSITE_SETTINGS.lastOkAt) ?? cfg.configuredAt;
    if (!last) return;
    const since = new Date(last);
    const now = this.deps.now();
    if (Number.isNaN(since.getTime()) || !(now.getTime() - since.getTime() > OFFSITE_STALE_DAYS * 86_400_000)) return;
    const days = Math.floor((now.getTime() - since.getTime()) / 86_400_000);
    this.alertOnce(`no offsite backup copy for ${days} days`, { kind: 'backup.offsite_stale', actor: 'system', detail: { days } });
  }

  private alertOnce(text: string, event: SecurityEventInput | null): void {
    try {
      const day = this.localDay(this.deps.now());
      if (getSetting(this.db, OFFSITE_SETTINGS.alertDay) === day) return;
      setSetting(this.db, OFFSITE_SETTINGS.alertDay, day);
      this.deps.alert(this.db, this.getVault(), text, event);
    } catch (e) {
      log.error({ err: oneLine(e) }, 'offsite: alert failed');
    }
  }

  status(): OffsiteStatus {
    let cfg: NasConfig | null = null;
    let configured: boolean | null = null;
    try {
      cfg = this.config();
      configured = cfg !== null;
    } catch {
      /* locked: unknown */
    }
    return {
      configured,
      target: cfg ? describeNas(cfg) : null,
      lastOkAt: getSetting(this.db, OFFSITE_SETTINGS.lastOkAt),
      lastFile: getSetting(this.db, OFFSITE_SETTINGS.lastFile),
      lastError: getSetting(this.db, OFFSITE_SETTINGS.lastError),
      lastErrorAt: getSetting(this.db, OFFSITE_SETTINGS.lastErrorAt),
      running: this.busy,
    };
  }

  private localDay(d: Date): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: this.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Pairing with the NAS (POST /api/backup/offsite/setup, then /confirm)

export interface SetupDeps {
  probe: (host: string, port: number) => Promise<{ fingerprint: string; type: string }>;
  keyPair: () => { privateKey: string; publicKey: string };
  connect: (cfg: NasConfig) => Promise<OffsiteTarget>;
  now: () => number;
}

export const SETUP_TTL_MIN = 10;

interface Pending {
  cfg: NasConfig;
  publicKey: string;
  hostKeyType: string;
  expires: number;
}

export class OffsiteSetupError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 | 410,
  ) {
    super(message);
  }
}

/** The pending pairing lives in memory only (10 minutes); the private key reaches the vault only after a good confirm. */
export class OffsiteSetup {
  private pending: Pending | null = null;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private readonly deps: SetupDeps;

  constructor(deps: Partial<SetupDeps> = {}) {
    this.deps = {
      probe: deps.probe ?? ((h, p) => probeHostKey(h, p)),
      keyPair: deps.keyPair ?? generateBackupKey,
      connect: deps.connect ?? ((cfg) => SftpTarget.open(cfg)),
      now: deps.now ?? Date.now,
    };
  }

  async start(o: { host: string; port: number; username: string; dir: string }): Promise<{ publicKey: string; hostKey: string; hostKeyType: string; target: string; expiresInMin: number }> {
    let hk: { fingerprint: string; type: string };
    try {
      hk = await this.deps.probe(o.host, o.port);
    } catch (e) {
      throw new OffsiteSetupError(`could not reach ${o.host}:${o.port} to read its host key: ${oneLine(e)}`, 400);
    }
    const keys = this.deps.keyPair();
    const cfg: NasConfig = { ...o, privateKey: keys.privateKey, hostKey: hk.fingerprint };
    this.pending = { cfg, publicKey: keys.publicKey, hostKeyType: hk.type, expires: this.deps.now() + SETUP_TTL_MIN * 60_000 };
    // the private key must not outlive the setup window in memory (independent review 2026-11-10)
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = setTimeout(() => this.cancel(), SETUP_TTL_MIN * 60_000);
    this.expiry.unref?.();
    return { publicKey: keys.publicKey, hostKey: hk.fingerprint, hostKeyType: hk.type, target: describeNas(cfg), expiresInMin: SETUP_TTL_MIN };
  }

  /** Forget a pending setup and its private key at once (on expiry, on DELETE /api/backup/offsite). */
  cancel(): void {
    this.pending = null;
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = null;
  }

  private current(): Pending {
    if (this.pending && this.pending.expires <= this.deps.now()) this.pending = null;
    if (!this.pending) throw new OffsiteSetupError('no pending NAS setup (or it expired after 10 minutes); run: finc backup nas setup', 410);
    return this.pending;
  }

  /**
   * The user compared the fingerprint on the NAS: connect for real with the pending key and list the folder. On success
   * the entry is saved in the vault and the pending setup is cleared; on failure it is kept so the user can fix the NAS
   * side and retry.
   */
  async confirm(hostKey: string, vault: Vault | null): Promise<{ ok: true; files: number; target: string }> {
    const p = this.current();
    if (hostKey.trim() !== p.cfg.hostKey) throw new OffsiteSetupError('that is not the host key this setup read; nothing was saved', 400);
    if (!vault || vault.locked) throw new OffsiteSetupError('vault is locked', 409);
    let files: number;
    try {
      const t = await this.deps.connect(p.cfg);
      try {
        files = (await t.list()).filter((n) => !n.startsWith('.')).length;
      } finally {
        await t.close().catch(() => undefined);
      }
    } catch (e) {
      throw new OffsiteSetupError(oneLine(e), 400);
    }
    const configuredAt = new Date(this.deps.now()).toISOString();
    vault.set(NAS_ENTRY, 'generic', { host: p.cfg.host, port: String(p.cfg.port), username: p.cfg.username, dir: p.cfg.dir, privateKey: p.cfg.privateKey, hostKey: p.cfg.hostKey, configuredAt });
    this.pending = null;
    log.info({ target: describeNas(p.cfg), files }, 'offsite: NAS paired');
    return { ok: true, files, target: describeNas(p.cfg) };
  }
}
