import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type OffsiteTarget, copyOffsite, missingOffsite } from './offsite.js';

/** An in-memory target that can be told to corrupt what it stores. */
function memTarget(opts: { corrupt?: boolean } = {}) {
  const files = new Map<string, Buffer>();
  const t: OffsiteTarget & { files: Map<string, Buffer>; puts: number } = {
    files,
    puts: 0,
    describe: () => 'mem:/finc-backups',
    put: async (name, bytes) => {
      t.puts++;
      if (files.has(name)) throw new Error('exists');
      files.set(name, opts.corrupt ? Buffer.concat([bytes, Buffer.from('x')]) : Buffer.from(bytes));
    },
    get: async (name) => {
      const b = files.get(name);
      if (!b) throw new Error('no such file');
      return b;
    },
    list: async () => [...files.keys()],
    close: async () => undefined,
  };
  return t;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function backupFile(name: string, content = 'ciphertext') {
  const d = mkdtempSync(path.join(os.tmpdir(), 'finc-offsite-'));
  dirs.push(d);
  const f = path.join(d, name);
  writeFileSync(f, content);
  return f;
}

describe('offsite copy', () => {
  it('uploads, reads back and proves the copy by SHA-256', async () => {
    const t = memTarget();
    const r = await copyOffsite(t, backupFile('finc-20261110T014000Z.fincbak'));
    expect(r).toMatchObject({ name: 'finc-20261110T014000Z.fincbak', bytes: 10, uploaded: true });
    expect(t.files.get(r.name)?.toString()).toBe('ciphertext');
  });

  it('a copy that comes back different is a failure', async () => {
    await expect(copyOffsite(memTarget({ corrupt: true }), backupFile('finc-20261110T014000Z.fincbak'))).rejects.toThrow(/does not match/);
  });

  it('the same file twice is left alone; a different file under the same name is never overwritten', async () => {
    const t = memTarget();
    const f = backupFile('finc-20261110T014000Z.fincbak');
    await copyOffsite(t, f);
    expect((await copyOffsite(t, f)).uploaded).toBe(false);
    expect(t.puts).toBe(1);
    await expect(copyOffsite(t, backupFile('finc-20261110T014000Z.fincbak', 'other content'))).rejects.toThrow(/not overwritten/);
  });

  it('refuses files that are not finc backups', async () => {
    await expect(copyOffsite(memTarget(), backupFile('notes.txt'))).rejects.toThrow(/not a finc backup/);
  });

  it('knows which local backups are missing remotely (a missed night is caught up)', async () => {
    const t = memTarget();
    await copyOffsite(t, backupFile('finc-20261109T014000Z.fincbak'));
    expect(await missingOffsite(t, ['finc-20261110T014000Z.fincbak', 'finc-20261109T014000Z.fincbak', 'x.txt'])).toEqual(['finc-20261110T014000Z.fincbak']);
  });
});
