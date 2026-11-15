import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { BackupInfo } from '@finc/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STOP_WORKER_FIRST, assertWorkerStopped, formatBackupList, formatNasStatus, hostKeyFile, localTime, nasRecipe, nasScript, nasScriptCommands, pickBackup, resolveBackupDir, workerAnswers } from './backup.js';

const fallback = () => '/data/backups';
const none = () => false;

describe('backup dir resolution', () => {
  it('--dir wins over everything', () => {
    expect(resolveBackupDir('/x/y', { env: { FINC_BACKUP_DIR: '/backup' }, platform: 'win32', exists: () => true, dotenv: null, fallback })).toBe(path.resolve('/x/y'));
  });
  it('FINC_BACKUP_DIR next (Docker: /backup)', () => {
    expect(resolveBackupDir(undefined, { env: { FINC_BACKUP_DIR: '/backup' }, platform: 'linux', exists: none, dotenv: null, fallback })).toBe(path.resolve('/backup'));
  });
  it('on Windows: FINC_BACKUP_HOST_DIR when that folder exists', () => {
    const seen: string[] = [];
    const exists = (p: string) => (seen.push(p), true);
    expect(resolveBackupDir(undefined, { env: { FINC_BACKUP_HOST_DIR: 'F:/bk' }, platform: 'win32', exists, dotenv: null, fallback })).toBe(path.resolve('F:/bk'));
    expect(seen).toEqual(['F:/bk']);
  });
  it('on Windows: FINC_BACKUP_HOST_DIR read from .env when not in the environment', () => {
    const dotenv = 'FINC_PORT=7733\nFINC_BACKUP_HOST_DIR="G:/finc-bk"  # other disk\n';
    expect(resolveBackupDir(undefined, { env: {}, platform: 'win32', exists: (p) => p === 'G:/finc-bk', dotenv, fallback })).toBe(path.resolve('G:/finc-bk'));
  });
  it('on Windows: E:/finc-backup by default when it exists, else data/backups', () => {
    expect(resolveBackupDir(undefined, { env: {}, platform: 'win32', exists: (p) => p === 'E:/finc-backup', dotenv: null, fallback })).toBe(path.resolve('E:/finc-backup'));
    expect(resolveBackupDir(undefined, { env: {}, platform: 'win32', exists: none, dotenv: null, fallback })).toBe('/data/backups');
  });
  it('not on Windows: no host-dir lookup', () => {
    expect(resolveBackupDir(undefined, { env: { FINC_BACKUP_HOST_DIR: 'F:/bk' }, platform: 'linux', exists: () => true, dotenv: null, fallback })).toBe('/data/backups');
  });
});

describe('restore refuses while the worker answers', () => {
  let server: Server;
  let url: string;
  beforeAll(async () => {
    // any answer counts, even a 401
    server = createServer((_req, res) => {
      res.statusCode = 401;
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('a control port that answers means: stop the worker first', async () => {
    expect(await workerAnswers(url)).toBe(true);
    await expect(assertWorkerStopped(url, () => 'exited')).rejects.toThrow(STOP_WORKER_FIRST);
    expect(STOP_WORKER_FIRST).toContain('docker compose stop worker');
  });

  it('nothing listening and the container stopped (or absent) means the worker is stopped', async () => {
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    for (const s of ['exited', 'created', 'dead', 'absent']) await expect(assertWorkerStopped(`http://127.0.0.1:${port}`, () => s)).resolves.toBeUndefined();
  });

  it('a crash-looping (restarting), paused or running container is refused even when its port is silent', async () => {
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    for (const s of ['restarting', 'paused', 'running']) await expect(assertWorkerStopped(`http://127.0.0.1:${port}`, () => s)).rejects.toThrow(`the container is ${s}`);
  });

  it('reads the container state from docker, and treats a missing docker CLI as no container', async () => {
    const { workerContainerState } = await import('./backup.js');
    expect(workerContainerState(() => 'restarting\n')).toBe('restarting');
    expect(workerContainerState(() => '')).toBe('absent');
    expect(
      workerContainerState(() => {
        throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
      }),
    ).toBe('absent');
    expect(() =>
      workerContainerState(() => {
        throw new Error('Cannot connect to the Docker daemon');
      }),
    ).toThrow(/could not ask Docker/);
  });
});

const info = (name: string, createdAt: string, txns: number | null): BackupInfo => ({
  file: `/b/${name}`,
  name,
  createdAt,
  sizeBytes: 2_500_000,
  meta: txns === null ? null : { createdAt, migrations: 9, dbBytes: 1, vaultBytes: 1, counts: { transaction: txns } },
});

describe('backup list output', () => {
  it('shows local Jerusalem time, size, transaction count and the retention verdict', () => {
    // two backups on the same UTC day: only the newer one is kept by the daily rule
    const lines = formatBackupList([
      info('finc-20261110T030000Z.fincbak', '2026-11-10T03:00:00.000Z', 1234),
      info('finc-20261110T010000Z.fincbak', '2026-11-10T01:00:00.000Z', 1230),
      info('finc-20261109T030000Z.fincbak', '', null),
    ]);
    expect(lines[0]).toMatch(/^name\s+date \(Asia\/Jerusalem\)\s+size\s+txns\s+retention$/);
    expect(lines[1]).toMatch(/finc-20261110T030000Z\.fincbak\s+2026-11-10 05:00\s+2\.4 MB\s+1234\s+keep$/);
    expect(lines[2]).toMatch(/finc-20261110T010000Z\.fincbak\s+2026-11-10 03:00\s+2\.4 MB\s+1230\s+expires$/);
    expect(lines[3]).toMatch(/finc-20261109T030000Z\.fincbak\s+\?\s+2\.4 MB\s+unreadable\s+keep$/);
    expect(lines.at(-1)).toBe('3 backup(s); retention keeps 2 (7 daily, 4 weekly, 6 monthly)');
  });
  it('says so when there are none', () => {
    expect(formatBackupList([])).toEqual(['(no backups)']);
  });
  it('local time follows Israel summer time', () => {
    expect(localTime('2026-07-01T09:00:00.000Z')).toBe('2026-07-01 12:00');
  });
});

describe('picking a backup', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'finc-cli-backup-'));
    for (const n of ['finc-20261108T030000Z.fincbak', 'finc-20261109T030000Z.fincbak']) writeFileSync(path.join(dir, n), '{}');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('defaults to the newest, accepts a bare name, refuses an unknown one', () => {
    expect(path.basename(pickBackup(dir))).toBe('finc-20261109T030000Z.fincbak');
    expect(pickBackup(dir, 'finc-20261108T030000Z.fincbak')).toBe(path.join(dir, 'finc-20261108T030000Z.fincbak'));
    expect(() => pickBackup(dir, 'nope.fincbak')).toThrow(/no backup "nope.fincbak"/);
  });
  it('an empty folder has nothing to pick', () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), 'finc-cli-backup-empty-'));
    try {
      expect(() => pickBackup(empty)).toThrow(/no backups in/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('finc backup nas', () => {
  it('prints a NAS recipe with the restricted key, the chroot and the SFTP-only Match block', () => {
    const lines = nasRecipe({ username: 'finc-backup', dir: '/copies', publicKey: 'ssh-ed25519 AAAAC3Nz finc-backup' });
    const text = lines.join('\n');
    // one script, stopping at the first error, refusing an existing user, quoting paths, adding the Match block once
    expect(text).toContain('set -euo pipefail');
    expect(text).toContain("U='finc-backup'");
    expect(text).toContain("REAL='/srv/finc-backups/copies'");
    expect(text).toContain("KEY='restrict ssh-ed25519 AAAAC3Nz finc-backup'");
    expect(text).toContain('if id "$U" >/dev/null 2>&1; then');
    expect(text).toContain('adduser --disabled-password --gecos "" --shell /usr/sbin/nologin "$U"');
    expect(text).toContain('if ! grep -qx "Match User $U" /etc/ssh/sshd_config; then');
    expect(text).toContain('    ChrootDirectory $CHROOT');
    expect(text).toContain('    ForceCommand internal-sftp -u 0222 -P remove,rmdir,setstat,fsetstat,lsetstat,symlink,hardlink,posix-rename');
    expect(text).toContain('sshd -t');
    expect(text).toContain('sudo bash /tmp/finc-nas-setup.sh');
    expect(text).not.toContain('PRIVATE');
    // an existing login, an odd folder or a strange key never make it into a recipe (independent review 2026-11-10)
    expect(() => nasRecipe({ username: 'alex', dir: '/copies', publicKey: 'ssh-ed25519 AAAAC3Nz finc-backup' })).toThrow(/finc-something/);
    for (const dir of ['/', '/my copies', '/a/../b', '/$(rm -rf x)', 'copies']) expect(() => nasRecipe({ username: 'finc-backup', dir, publicKey: 'ssh-ed25519 AAAAC3Nz finc-backup' }), dir).toThrow(/plain path/);
    expect(() => nasRecipe({ username: 'finc-backup', dir: '/copies', publicKey: "ssh-ed25519 AAAA'; rm -rf / #" })).toThrow(/public key/);
  });

  it('saves the same script as a file and prints scp + ssh -t commands for it', () => {
    const o = { username: 'finc-backup', dir: '/copies', publicKey: 'ssh-ed25519 AAAAC3Nz finc-backup' };
    const script = nasScript(o);
    expect(script[0]).toBe('set -euo pipefail');
    expect(script.at(-1)).toContain('ready: $U can upload');
    expect(script.join('\n')).not.toContain('FINC_EOF');
    // the pasted block is exactly the file wrapped in the heredoc
    const recipe = nasRecipe(o);
    const start = recipe.indexOf("cat > /tmp/finc-nas-setup.sh <<'FINC_EOF'");
    expect(recipe.slice(start + 1, start + 1 + script.length)).toEqual(script);
    expect(recipe[start + 1 + script.length]).toBe('FINC_EOF');
    expect(() => nasScript({ ...o, username: 'pi' })).toThrow(/finc-something/);
    const cmds = nasScriptCommands({ host: '192.168.1.50', port: 22, hostFile: 'D:\\projects\\finc\\data\\finc-nas-setup.sh', username: 'finc-backup', publicKey: 'ssh-ed25519 AAAAC3Nz finc-backup' }).join('\n');
    // a re-pairing (the user exists) only needs the new key: one ready-to-run command for it
    expect(cmds).toContain(`ssh -t <you>@192.168.1.50 "echo 'restrict ssh-ed25519 AAAAC3Nz finc-backup' | sudo tee /home/finc-backup/.ssh/authorized_keys"`);
    expect(cmds).toMatch(/NEW key/);
    expect(cmds).toContain('scp "D:\\projects\\finc\\data\\finc-nas-setup.sh" <you>@192.168.1.50:finc-nas-setup.sh');
    expect(cmds).toContain('ssh -t <you>@192.168.1.50 "sudo bash finc-nas-setup.sh; rm -f finc-nas-setup.sh"');
    const other = nasScriptCommands({ host: 'nas', port: 2222, hostFile: 'x', username: 'finc-backup', publicKey: 'ssh-ed25519 AAAAC3Nz finc-backup' }).join('\n');
    expect(other).toContain('scp -P 2222 ');
    expect(other).toContain('ssh -t -p 2222 ');
  });

  it('names the host key file to compare on the NAS, and formats the status', () => {
    expect(hostKeyFile('ssh-ed25519')).toBe('/etc/ssh/ssh_host_ed25519_key.pub');
    expect(hostKeyFile('ecdsa-sha2-nistp256')).toBe('/etc/ssh/ssh_host_ecdsa_key.pub');
    expect(hostKeyFile('rsa-sha2-512')).toBe('/etc/ssh/ssh_host_rsa_key.pub');
    expect(formatNasStatus({ configured: null, lastOkAt: null, lastFile: null, lastError: null, lastErrorAt: null })[0]).toMatch(/vault is locked/);
    const s = formatNasStatus({ configured: true, target: 'finc-backup@192.168.1.50:/copies', lastOkAt: '2026-11-10T01:41:00.000Z', lastFile: 'finc-x.fincbak', lastError: 'boom', lastErrorAt: '2026-11-09T01:41:00.000Z' });
    expect(s.slice(0, 3)).toEqual(['configured: yes, finc-backup@192.168.1.50:/copies', 'last copy:  2026-11-10 03:41  finc-x.fincbak', 'last error: 2026-11-09 03:41  boom']);
    expect(s[3]).toMatch(/\.part/); // how to clean up what an interrupted upload leaves
  });
});

describe('restore also reads the owner file (P1-13)', () => {
  it('a fresh owner from another host is refused even with the container stopped and the port silent', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'finc-owner-'));
    try {
      const probe = createServer();
      await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
      const url = `http://127.0.0.1:${(probe.address() as AddressInfo).port}`;
      await new Promise<void>((r) => probe.close(() => r()));
      const dbFile = path.join(dir, 'finc.db');
      await expect(assertWorkerStopped(url, () => 'absent', dbFile)).resolves.toBeUndefined(); // no owner file
      const now = new Date().toISOString();
      writeFileSync(`${dbFile}.owner`, JSON.stringify({ host: 'other-docker-host', pid: 7, role: 'worker', startedAt: now, heartbeatAt: now }));
      await expect(assertWorkerStopped(url, () => 'absent', dbFile)).rejects.toThrow('the finc worker on other-docker-host owns the database');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
