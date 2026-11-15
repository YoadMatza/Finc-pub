/**
 * `finc backup now|list|verify|restore`. Backups are made by the running worker (it holds the unlocked vault); the CLI
 * asks it to run one, lists and verifies the files, and restores one over the live database on the host while the
 * worker is stopped (the one-writer rule: never write data/finc.db from the host while the container runs).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { confirm, input } from '@inquirer/prompts';
import {
  type BackupInfo,
  type BackupMeta,
  type VerifyResult,
  assertDbAvailable,
  backupDir,
  dataDir,
  dbPath,
  listBackups,
  readSealed,
  restoreBackup,
  retentionPlan,
  vaultPath,
  verifyBackupWithPassword,
} from '@finc/core';
import type { Command } from 'commander';
import { askMasterPassword } from './vault.js';
import { workerHealth, workerPost, workerRequest, workerUrl } from './worker-client.js';

const TZ = 'Asia/Jerusalem';
const DEFAULT_HOST_DIR = 'E:/finc-backup';

export interface DirEnv {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  exists?: (p: string) => boolean;
  /** contents of the repo .env (only FINC_BACKUP_HOST_DIR is read from it) */
  dotenv?: string | null;
  fallback?: () => string;
}

/** FINC_BACKUP_HOST_DIR from the process environment, else from the .env docker compose reads. */
function hostDirSetting(env: NodeJS.ProcessEnv, dotenv: string | null): string | undefined {
  const fromEnv = env.FINC_BACKUP_HOST_DIR?.trim();
  if (fromEnv) return fromEnv;
  const m = dotenv ? /^\s*FINC_BACKUP_HOST_DIR\s*=\s*["']?([^"'\r\n#]*?)["']?\s*(?:#.*)?$/m.exec(dotenv) : null;
  return m?.[1]?.trim() || undefined;
}

function readDotenv(): string | null {
  try {
    return readFileSync(path.resolve(process.cwd(), '.env'), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Where the backups are: `--dir`, else FINC_BACKUP_DIR (set in Docker: /backup), else on Windows the host side of that
 * mount (FINC_BACKUP_HOST_DIR, default E:/finc-backup) when it exists, else data/backups.
 */
export function resolveBackupDir(flag: string | undefined, o: DirEnv = {}): string {
  const env = o.env ?? process.env;
  if (flag?.trim()) return path.resolve(flag.trim());
  const fromEnv = env.FINC_BACKUP_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  if ((o.platform ?? process.platform) === 'win32') {
    const host = hostDirSetting(env, o.dotenv === undefined ? readDotenv() : o.dotenv) ?? DEFAULT_HOST_DIR;
    if ((o.exists ?? existsSync)(host)) return path.resolve(host);
  }
  return (o.fallback ?? backupDir)();
}

/** True when anything answers on the worker's control port (any HTTP status counts). */
export async function workerAnswers(url = workerUrl(), timeoutMs = 1500): Promise<boolean> {
  try {
    await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

export const STOP_WORKER_FIRST = 'the worker is running; stop the worker first: docker compose stop worker';

/**
 * The worker container's state from Docker: 'running', 'restarting', 'paused', 'exited', 'created', 'dead', or
 * 'absent' (no such container, or no Docker on this machine at all).
 */
export function workerContainerState(run: (cmd: string, args: string[]) => string = (c, a) => execFileSync(c, a, { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] })): string {
  try {
    const out = run('docker', ['ps', '-a', '--filter', 'name=^finc-worker$', '--format', '{{.State}}']).trim();
    return out.split(/\s+/)[0] || 'absent';
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'; // no docker CLI: no container either
    throw new Error(`could not ask Docker whether the worker runs (${e instanceof Error ? e.message : String(e)}); start Docker or stop the worker, then retry`);
  }
}

/** Container states in which nothing can open the database: anything else (running, restarting, paused) is refused. */
const SAFE_STATES = new Set(['absent', 'exited', 'created', 'dead']);

/**
 * Refuse to touch the live database while the worker could write it (one writer only). A crash-looping worker is
 * 'restarting' and its port is silent between attempts, so the port alone is not enough (independent review 2026-11-10).
 */
export async function assertWorkerStopped(url = workerUrl(), state: () => string = workerContainerState, dbFile?: string): Promise<void> {
  const s = state();
  if (!SAFE_STATES.has(s)) throw new Error(`${STOP_WORKER_FIRST} (the container is ${s})`);
  // the owner file next to the database also sees a worker on another host or another Docker context (P1-13)
  if (dbFile !== undefined) assertDbAvailable(dbFile);
  if (await workerAnswers(url)) throw new Error(STOP_WORKER_FIRST);
}

export function localTime(iso: string): string {
  if (!iso) return '?';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '?';
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d);
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The `backup list` table: newest first, with what the retention rule keeps. */
export function formatBackupList(infos: BackupInfo[]): string[] {
  if (infos.length === 0) return ['(no backups)'];
  const { keep } = retentionPlan(infos.map((b) => b.name));
  const kept = new Set(keep);
  const rows = infos.map((b) => [
    b.name,
    localTime(b.createdAt),
    humanSize(b.sizeBytes),
    b.meta ? String(b.meta.counts.transaction ?? '?') : 'unreadable',
    kept.has(b.name) ? 'keep' : 'expires',
  ]);
  const head = ['name', `date (${TZ})`, 'size', 'txns', 'retention'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (r: string[]) => r.map((c, i) => (i === 2 || i === 3 ? c.padStart(widths[i]!) : c.padEnd(widths[i]!))).join('  ').trimEnd();
  return [line(head), ...rows.map(line), '', `${infos.length} backup(s); retention keeps ${kept.size} (7 daily, 4 weekly, 6 monthly)`];
}

/** A backup by name or path; without one, the newest in `dir`. */
export function pickBackup(dir: string, file?: string): string {
  if (file) {
    if (existsSync(file)) return path.resolve(file);
    const inDir = path.join(dir, file);
    if (existsSync(inDir)) return inDir;
    throw new Error(`no backup "${file}" (looked in ${dir})`);
  }
  const newest = listBackups(dir)[0];
  if (!newest) throw new Error(`no backups in ${dir}`);
  return newest.file;
}

function countsLine(counts: Record<string, number>): string {
  return Object.entries(counts)
    .map(([t, n]) => `${t}=${n}`)
    .join(' ');
}

export function formatVerify(file: string, r: VerifyResult): string[] {
  return [
    `${path.basename(file)}  made ${localTime(r.meta.createdAt)}`,
    `  integrity: ${r.integrity}`,
    `  counts:    ${countsLine(r.counts)}`,
    `  mismatches: ${r.mismatches.length ? r.mismatches.map((t) => `${t} (recorded ${r.meta.counts[t]}, found ${r.counts[t]})`).join(', ') : 'none'}`,
    r.ok ? 'OK' : 'NOT OK: this backup cannot be trusted',
  ];
}

const stamp = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

function wrongPassword(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e);
  return new Error(`could not open the backup (wrong master password for the day it was made?): ${msg}`);
}

export function registerBackupCommands(program: Command): void {
  const backup = program.command('backup').description('Encrypted backups of the database and the vault');

  backup
    .command('now')
    .description('Ask the running worker to make a backup now')
    .action(async () => {
      if (!(await workerAnswers())) {
        throw new Error('the worker is not running. Backups are made by the worker (it holds the unlocked vault); start it with: docker compose start worker, then .\\finc unlock');
      }
      const r = await workerPost<{ ok?: boolean; file?: string; counts?: Record<string, number>; error?: string }>('/api/backup/run', {}, 10 * 60_000);
      if (r.status !== 200 || !r.body.ok) throw new Error(r.body.error ?? `backup failed (${r.status})`);
      console.log(`backup written and verified: ${r.body.file ?? '?'}`);
      if (r.body.counts) console.log(`  counts: ${countsLine(r.body.counts)}`);
    });

  backup
    .command('list')
    .description('List backups, newest first, and which ones retention keeps')
    .option('--dir <dir>', 'backup folder')
    .action((opts: { dir?: string }) => {
      const dir = resolveBackupDir(opts.dir);
      console.log(`backups in ${dir}`);
      for (const l of formatBackupList(listBackups(dir))) console.log(l);
    });

  backup
    .command('verify [file]')
    .description('Decrypt a backup (default: newest) and check its integrity and row counts (read-only)')
    .option('--dir <dir>', 'backup folder')
    .action(async (file: string | undefined, opts: { dir?: string }) => {
      const target = pickBackup(resolveBackupDir(opts.dir), file);
      console.log(`verifying ${target}`);
      const pw = await askMasterPassword('Master password (of the day the backup was made)');
      let r: VerifyResult;
      try {
        r = await verifyBackupWithPassword(target, pw);
      } catch (e) {
        throw wrongPassword(e);
      }
      for (const l of formatVerify(target, r)) console.log(l);
      if (!r.ok) process.exitCode = 1;
    });

  backup
    .command('restore <file>')
    .description('Restore a backup over the live database (host only, worker stopped)')
    .option('--with-vault', 'also restore vault.json from the backup', false)
    .option('--dir <dir>', 'backup folder')
    .action(async (file: string, opts: { withVault: boolean; dir?: string }) => {
      const db = dbPath();
      await assertWorkerStopped(undefined, undefined, db);
      const target = pickBackup(resolveBackupDir(opts.dir), file);
      const meta = readSealed(target).meta as unknown as BackupMeta;
      const vault = vaultPath();
      const now = new Date();
      const suffix = `.before-restore-${stamp(now)}`;
      console.log('This will:');
      console.log(`  restore ${target}`);
      console.log(`    made ${localTime(meta.createdAt)}; ${countsLine(meta.counts)}`);
      console.log(`  move the current database aside: ${db} -> ${db}${suffix} (and its -wal/-shm files)`);
      if (opts.withVault) {
        if (meta.vaultBytes > 0) console.log(`  move the current vault aside: ${vault} -> ${vault}${suffix}; the restored vault opens with the master password of that day`);
        else console.log('  (this backup holds no vault.json; the current vault stays)');
      } else console.log(`  keep the current vault (${vault})`);
      const pw = await askMasterPassword('Master password (of the day the backup was made)');
      let check: VerifyResult;
      try {
        check = await verifyBackupWithPassword(target, pw);
      } catch (e) {
        throw wrongPassword(e);
      }
      if (!check.ok) {
        for (const l of formatVerify(target, check)) console.log(l);
        throw new Error('the backup does not verify; nothing was changed');
      }
      console.log(`backup verifies (integrity ${check.integrity}, counts match)`);
      const word = await input({ message: 'Type "restore" to replace the live database' });
      if (word.trim() !== 'restore') {
        console.log('cancelled; nothing was changed');
        return;
      }
      // checked once more inside the restore, right before any live file is moved (the worker may have started meanwhile)
      const { movedAside } = await restoreBackup(target, pw, { dbFile: db, vaultFile: vault, withVault: opts.withVault, now, assertSafe: () => assertWorkerStopped(undefined, undefined, db) });
      console.log(`restored ${path.basename(target)} to ${db}`);
      for (const m of movedAside) console.log(`  moved aside: ${m}`);
      console.log('Money alerts pause until the first sync after the restore, then send one summary line instead of re-sending old charges.');
      console.log('Next: docker compose start worker, then .\\finc unlock');
    });

  registerNasCommands(backup);
}

// ---------------------------------------------------------------------------------------------------------------
// finc backup nas setup|test|status|remove: the off-PC copy on the NAS (SFTP), through the running worker

/** The NAS folder the SFTP user is locked into (ChrootDirectory); the copies folder is inside it. */
export const NAS_CHROOT = '/srv/finc-backups';

async function requireWorker(): Promise<void> {
  if (!(await workerAnswers())) throw new Error('the worker is not running (it holds the vault and makes the copies); start it with: docker compose start worker, then .\\finc unlock');
}

/** The ssh-keygen file name for a host key type. */
export function hostKeyFile(type: string): string {
  const t = type.includes('ed25519') ? 'ed25519' : type.startsWith('ecdsa') ? 'ecdsa' : type.includes('rsa') ? 'rsa' : '*';
  return `/etc/ssh/ssh_host_${t}_key.pub`;
}

/** A NAS user name the recipe may create: finc-… only, so an existing login can never be taken over by mistake. */
export const NAS_USER_RE = /^finc-[a-z0-9-]{1,24}$/;
/** A folder as the NAS user sees it inside the chroot: plain path segments only (the recipe quotes it anyway). */
export const NAS_DIR_RE = /^(\/[A-Za-z0-9._-]+)+$/;

/**
 * The commands to run on the NAS (Debian 11, OpenSSH 8.4): an SFTP-only user locked in its folder, without delete.
 * ONE script, pasted once and run with `set -euo pipefail`, so a failing step stops everything after it (independent
 * review 2026-11-10: pasted line by line, a failed adduser for an existing login went on to replace that login's
 * authorized_keys and lock it into the chroot). It refuses to touch an existing user, quotes every path, and adds the
 * sshd Match block only once.
 */
export function nasRecipe(o: { username: string; dir: string; publicKey: string }): string[] {
  return [
    'On the NAS (Debian 11), as a user with sudo rights, paste this WHOLE block once (from "cat" to the last line).',
    'It stops at the first error, and changes nothing if the user already exists:',
    '',
    "cat > /tmp/finc-nas-setup.sh <<'FINC_EOF'",
    ...nasScript(o),
    'FINC_EOF',
    'sudo bash /tmp/finc-nas-setup.sh; rm -f /tmp/finc-nas-setup.sh',
    '',
    `(The Match block must stay at the end of /etc/ssh/sshd_config. The worker sees the folder as ${o.dir}.`,
    ` The chroot ${NAS_CHROOT} must be on a Linux filesystem (ext4 etc.): root ownership and hard links are needed.)`,
  ];
}

export const NAS_SCRIPT_NAME = 'finc-nas-setup.sh';

/**
 * The same script as a file to copy over (scp) and run (ssh -t … sudo bash): pasting a heredoc into an SSH window
 * broke on the first real try (2026-11-10: the terminal mangled the block, and the owner ended up running it line by line).
 * It goes to the login's home folder, not /tmp: a root-owned leftover there (sticky /tmp) refused the upload.
 */
export function nasScriptCommands(o: { host: string; port: number; hostFile: string; username: string; publicKey: string }): string[] {
  const p = o.port === 22 ? '' : ` -P ${o.port}`;
  const sp = o.port === 22 ? '' : ` -p ${o.port}`;
  return [
    'Easier than pasting: the same script is saved as a file. In ANOTHER PowerShell window run these two',
    '(each asks for your NAS login password; the second also asks for sudo):',
    '',
    `  scp${p} "${o.hostFile}" <you>@${o.host}:${NAS_SCRIPT_NAME}`,
    `  ssh -t${sp} <you>@${o.host} "sudo bash ${NAS_SCRIPT_NAME}; rm -f ${NAS_SCRIPT_NAME}"`,
    '',
    '(<you> = your own NAS login, e.g. pi.) It must end with "ready: … can upload to …".',
    `If it says ${o.username} already exists (a re-pairing), give it THIS key instead; it prints the key line back:`,
    '',
    `  ssh -t${sp} <you>@${o.host} "echo 'restrict ${o.publicKey}' | sudo tee /home/${o.username}/.ssh/authorized_keys"`,
    '',
    // 2026-11-10: three setups in a row failed because each made a new key that never reached the NAS
    'Every run of "finc backup nas setup" makes a NEW key: do the NAS side for THIS run before answering Yes below.',
  ];
}

export function nasScript(o: { username: string; dir: string; publicKey: string }): string[] {
  if (!NAS_USER_RE.test(o.username)) throw new Error('the NAS user must be called finc-something (e.g. finc-backup)');
  if (!NAS_DIR_RE.test(o.dir) || o.dir.split('/').includes('..')) throw new Error('the folder must be a plain path like /copies');
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+( [A-Za-z0-9@._-]+)?$/.test(o.publicKey)) throw new Error('unexpected public key format');
  const real = `${NAS_CHROOT}${o.dir}`;
  return [
    'set -euo pipefail',
    `U='${o.username}'`,
    `CHROOT='${NAS_CHROOT}'`,
    `REAL='${real}'`,
    `KEY='restrict ${o.publicKey}'`,
    'if id "$U" >/dev/null 2>&1; then',
    '  echo "user $U already exists: nothing was changed."',
    '  echo "To give it THIS key instead, run:  echo \'$KEY\' | sudo tee /home/$U/.ssh/authorized_keys"',
    '  exit 1',
    'fi',
    '# 1. a user that can only use SFTP: no password, no shell',
    'adduser --disabled-password --gecos "" --shell /usr/sbin/nologin "$U"',
    '# 2. the chroot belongs to root; the copies folder inside it to the user',
    'mkdir -p "$REAL"',
    'chown root:root "$CHROOT"; chmod 755 "$CHROOT"',
    'chown "$U:$U" "$REAL"; chmod 700 "$REAL"',
    "# 3. the worker's key; root owns ~/.ssh so the user cannot change it",
    'mkdir -p "/home/$U/.ssh"',
    'echo "$KEY" > "/home/$U/.ssh/authorized_keys"',
    'chown -R root:root "/home/$U/.ssh"; chmod 755 "/home/$U/.ssh"; chmod 644 "/home/$U/.ssh/authorized_keys"',
    '# 4. SFTP only, locked in the chroot; new files read-only; no delete, chmod or overwriting rename (added once)',
    'if ! grep -qx "Match User $U" /etc/ssh/sshd_config; then',
    '  cat >> /etc/ssh/sshd_config <<SSHD_EOF',
    '',
    'Match User $U',
    '    ChrootDirectory $CHROOT',
    '    ForceCommand internal-sftp -u 0222 -P remove,rmdir,setstat,fsetstat,lsetstat,symlink,hardlink,posix-rename',
    '    AuthenticationMethods publickey',
    '    PermitTTY no',
    '    DisableForwarding yes',
    'SSHD_EOF',
    'fi',
    'sshd -t',
    'systemctl reload ssh',
    'echo "ready: $U can upload to $REAL (and nothing else)"',
  ];
}

interface SetupAnswer {
  publicKey?: string;
  hostKey?: string;
  hostKeyType?: string;
  target?: string;
  expiresInMin?: number;
  error?: string;
}

export interface OffsiteHealthView {
  configured: boolean | null;
  target?: string | null;
  lastOkAt: string | null;
  lastFile: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

export function formatNasStatus(o: OffsiteHealthView | undefined): string[] {
  if (!o) return ['this worker does not report the offsite copy (update it)'];
  const lines = [
    `configured: ${o.configured === null ? 'unknown (the vault is locked)' : o.configured ? `yes, ${o.target ?? '?'}` : 'no (finc backup nas setup)'}`,
    `last copy:  ${o.lastOkAt ? `${localTime(o.lastOkAt)}  ${o.lastFile ?? ''}`.trimEnd() : 'never'}`,
  ];
  if (o.lastError) {
    lines.push(`last error: ${o.lastErrorAt ? localTime(o.lastErrorAt) : '?'}  ${o.lastError}`);
    // the worker can never delete on the NAS (on purpose), so an interrupted upload leaves a read-only part file
    lines.push(`            interrupted uploads leave ".*.part" files on the NAS; remove them there by hand: sudo rm ${NAS_CHROOT}/copies/.*.part`);
  }
  return lines;
}

function registerNasCommands(backup: Command): void {
  const nas = backup.command('nas').description('The off-PC copy of the backups on the NAS (SFTP)');

  nas
    .command('setup')
    .description('Pair the worker with the NAS: make a key, show the NAS commands, pin the host key')
    .action(async () => {
      await requireWorker();
      // re-pairing replaces the stored key and the pinned host key: say so first (independent review 2026-11-10)
      const h = (await workerHealth(5000)) as { backup?: { offsite?: OffsiteHealthView } } | null;
      const current = h?.backup?.offsite;
      if (current?.configured) {
        const replace = await confirm({ message: `Already paired with ${current.target ?? 'a NAS'}. Replace that pairing (a new key and a new pinned host key)?`, default: false });
        if (!replace) return;
      }
      const host = (await input({ message: 'NAS address (e.g. 192.168.1.50)', validate: (v) => v.trim().length > 0 || 'the NAS IP address or host name' })).trim();
      const port = Number((await input({ message: 'SSH port', default: '22', validate: (v) => (/^\d{1,5}$/.test(v.trim()) && Number(v) >= 1 && Number(v) <= 65535) || 'a port number' })).trim());
      const username = (await input({ message: 'NAS user for the copies (a NEW user, finc-…)', default: 'finc-backup', validate: (v) => NAS_USER_RE.test(v.trim()) || 'a new user called finc-something, e.g. finc-backup (never your own login)' })).trim();
      const dir = (await input({ message: `Folder as that user sees it (inside ${NAS_CHROOT})`, default: '/copies', validate: (v) => (NAS_DIR_RE.test(v.trim()) && !v.includes('..')) || 'a plain path like /copies (letters, digits, . _ -)' })).trim();
      const r = await workerPost<SetupAnswer>('/api/backup/offsite/setup', { host, port, username, dir }, 60_000);
      if (r.status !== 200 || !r.body.publicKey || !r.body.hostKey) throw new Error(r.body.error ?? `setup failed (${r.status})`);
      console.log('');
      console.log('The worker made this key for the NAS (the private half stays in the worker until you confirm):');
      console.log('');
      console.log(`  ${r.body.publicKey}`);
      console.log('');
      for (const l of nasRecipe({ username, dir, publicKey: r.body.publicKey })) console.log(l);
      console.log('');
      // the script holds only the PUBLIC key; written to the data folder (bind-mounted, so the host sees it too)
      try {
        writeFileSync(path.join(dataDir(), NAS_SCRIPT_NAME), `${nasScript({ username, dir, publicKey: r.body.publicKey }).join('\n')}\n`, { mode: 0o644 });
        const hostFile = process.env.FINC_HOST_DATA_DIR?.trim() ? `${process.env.FINC_HOST_DATA_DIR.trim()}\\${NAS_SCRIPT_NAME}` : path.join(dataDir(), NAS_SCRIPT_NAME);
        for (const l of nasScriptCommands({ host, port, hostFile, username, publicKey: r.body.publicKey })) console.log(l);
        console.log('');
      } catch (e) {
        console.log(`(could not save the script as a file: ${e instanceof Error ? e.message : String(e)}; paste the block above instead)`);
      }
      console.log(`The NAS answered with this host key (${r.body.hostKeyType ?? '?'}):`);
      console.log('');
      console.log(`  ${r.body.hostKey}`);
      console.log('');
      console.log('Check it ON THE NAS itself (not over the network from here):');
      console.log(`  ssh-keygen -lf ${hostKeyFile(r.body.hostKeyType ?? '')}`);
      console.log('Its output must show exactly the same SHA256:... value. If it differs, answer N: something else answered at that address.');
      console.log(`(This setup expires in ${r.body.expiresInMin ?? 10} minutes; run it again if it does.)`);
      const same = await confirm({ message: 'THIS key is on the NAS (it printed "ready" or the key line), and the fingerprint is the same?', default: false });
      if (!same) {
        console.log('cancelled; nothing was saved');
        return;
      }
      for (;;) {
        const c = await workerPost<{ ok?: boolean; files?: number; target?: string; error?: string }>('/api/backup/offsite/confirm', { hostKey: r.body.hostKey }, 60_000);
        if (c.status === 200 && c.body.ok) {
          console.log(`paired with ${c.body.target ?? host}: the folder is reachable (${c.body.files ?? 0} file(s) in it). The key is in the vault now.`);
          console.log('Every nightly backup is copied there from now on. Try one now: finc backup nas test');
          return;
        }
        console.log(`the NAS refused: ${c.body.error ?? `error ${c.status}`}`);
        if (c.status === 410 || c.status === 409) throw new Error(c.status === 410 ? 'the setup expired; run finc backup nas setup again' : (c.body.error ?? 'refused'));
        console.log('Check on the NAS: the key line in authorized_keys, the ownership of the folders (step 2), and `sudo sshd -t`; `sudo journalctl -u ssh -n 30` shows why sshd refused.');
        const again = await input({ message: 'Type "retry" after fixing the NAS side (anything else cancels)' });
        if (again.trim() !== 'retry') {
          console.log('cancelled; nothing was saved');
          return;
        }
      }
    });

  nas
    .command('test')
    .description('Copy the newest backup (and up to 3 missing older ones) to the NAS now')
    .action(async () => {
      await requireWorker();
      const r = await workerPost<{ ok?: boolean; target?: string; copied?: string[]; skipped?: string[]; left?: number; error?: string }>('/api/backup/offsite/run', {}, 30 * 60_000);
      if (r.status !== 200 || !r.body.ok) throw new Error(r.body.error ?? `the copy failed (${r.status})`);
      console.log(`copied to ${r.body.target ?? 'the NAS'} and read back:`);
      for (const n of r.body.copied ?? []) console.log(`  copied   ${n}`);
      for (const n of r.body.skipped ?? []) console.log(`  already there ${n}`);
      if (!r.body.copied?.length && !r.body.skipped?.length) console.log('  (nothing)');
      if (r.body.left) console.log(`${r.body.left} older backup(s) are still missing there; the next runs catch them up`);
    });

  nas
    .command('status')
    .description('Is the NAS copy configured, and when did it last work')
    .action(async () => {
      await requireWorker();
      const h = (await workerHealth(5_000)) as { backup?: { offsite?: OffsiteHealthView } } | null;
      if (!h) throw new Error('the worker did not answer the health request (control token?)');
      for (const l of formatNasStatus(h.backup?.offsite)) console.log(l);
    });

  nas
    .command('remove')
    .description('Stop copying to the NAS (removes the key from the vault; files on the NAS stay)')
    .action(async () => {
      await requireWorker();
      if (!(await confirm({ message: 'Remove the NAS entry from the vault? The copies already on the NAS are not touched.', default: false }))) {
        console.log('cancelled');
        return;
      }
      const r = await workerRequest<{ ok?: boolean; removed?: boolean; error?: string }>('DELETE', '/api/backup/offsite', undefined, 30_000);
      if (r.status !== 200 || !r.body.ok) throw new Error(r.body.error ?? `remove failed (${r.status})`);
      console.log(r.body.removed ? 'removed; no more copies to the NAS. Remove the key there too: delete its line in authorized_keys.' : 'there was no NAS entry');
    });
}
