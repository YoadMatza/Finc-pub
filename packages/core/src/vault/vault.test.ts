import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sodium from 'libsodium-wrappers-sumo';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vault, VaultError } from './vault.js';
import { maskNumber, redact } from './redact.js';

let dir: string;
let file: string;
let fast: { ops: number; mem: number };
const PW = 'correct horse battery staple';
const MARKER = 'ZZ-secret-marker-7731-ZZ';

beforeAll(async () => {
  await sodium.ready;
  fast = { ops: sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE, mem: sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE };
});
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'finc-vault-'));
  file = path.join(dir, 'vault.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('Vault', () => {
  it('round-trips an entry through disk', async () => {
    const v = await Vault.create(file, PW, fast);
    v.set('beinleumi', 'scraper', { username: 'u1', password: MARKER });
    v.lock();

    const v2 = await Vault.open(file, PW);
    expect(v2.get('beinleumi')).toMatchObject({ kind: 'scraper', fields: { username: 'u1', password: MARKER } });
    expect(v2.list()).toEqual([expect.objectContaining({ name: 'beinleumi', fields: ['username', 'password'] })]);
  });

  it('never writes plaintext (values, entry names or field names) to disk', async () => {
    const v = await Vault.create(file, PW, fast);
    v.set('isracard', 'scraper', { id: '012345678', card6Digits: '458012', password: MARKER });
    const raw = readFileSync(file, 'utf8');
    for (const needle of [MARKER, '012345678', '458012', 'isracard', 'card6Digits', 'password']) {
      expect(raw).not.toContain(needle);
    }
    expect(JSON.parse(raw)).toMatchObject({ v: 1, kdf: { alg: 'argon2id13' } });
  });

  it('rejects a wrong password with BAD_PASSWORD', async () => {
    await Vault.create(file, PW, fast);
    await expect(Vault.open(file, 'wrong password!')).rejects.toMatchObject({ code: 'BAD_PASSWORD' });
  });

  it('rejects a tampered ciphertext', async () => {
    const v = await Vault.create(file, PW, fast);
    v.set('max', 'scraper', { username: 'x', password: 'y' });
    const j = JSON.parse(readFileSync(file, 'utf8'));
    const ct = Buffer.from(j.ct, 'base64');
    ct[ct.length - 1] ^= 0x01;
    j.ct = ct.toString('base64');
    writeFileSync(file, JSON.stringify(j));
    await expect(Vault.open(file, PW)).rejects.toMatchObject({ code: 'BAD_PASSWORD' });
  });

  it('rejects a tampered header (authenticated as aad)', async () => {
    await Vault.create(file, PW, fast);
    const j = JSON.parse(readFileSync(file, 'utf8'));
    j.kdf.ops = j.kdf.ops + 1;
    writeFileSync(file, JSON.stringify(j));
    await expect(Vault.open(file, PW)).rejects.toMatchObject({ code: 'BAD_PASSWORD' });
  });

  it('refuses to overwrite an existing vault', async () => {
    await Vault.create(file, PW, fast);
    await expect(Vault.create(file, PW, fast)).rejects.toMatchObject({ code: 'EXISTS' });
  });

  it('rekeys to a new password', async () => {
    const v = await Vault.create(file, PW, fast);
    v.set('riseup_pat', 'token', { token: 'riseup_pat_abc' });
    const before = JSON.parse(readFileSync(file, 'utf8'));
    await v.rekey('a brand new passphrase');
    const after = JSON.parse(readFileSync(file, 'utf8'));
    expect(after.kdf.salt).not.toEqual(before.kdf.salt);
    await expect(Vault.open(file, PW)).rejects.toMatchObject({ code: 'BAD_PASSWORD' });
    const v2 = await Vault.open(file, 'a brand new passphrase');
    expect(v2.get('riseup_pat')?.fields.token).toBe('riseup_pat_abc');
  });

  it('lock() makes the vault unusable', async () => {
    const v = await Vault.create(file, PW, fast);
    v.set('a', 'generic', { k: 'v' });
    v.lock();
    expect(v.locked).toBe(true);
    expect(() => v.get('a')).toThrow(VaultError);
    expect(() => v.list()).toThrow(/locked/);
  });

  it('delete removes and persists', async () => {
    const v = await Vault.create(file, PW, fast);
    v.set('a', 'generic', { k: 'v' });
    expect(v.delete('a')).toBe(true);
    expect(v.delete('a')).toBe(false);
    const v2 = await Vault.open(file, PW);
    expect(v2.list()).toEqual([]);
  });

  it('uses a fresh nonce on every save', async () => {
    const v = await Vault.create(file, PW, fast);
    const n1 = JSON.parse(readFileSync(file, 'utf8')).nonce;
    v.set('a', 'generic', { k: 'v' });
    const n2 = JSON.parse(readFileSync(file, 'utf8')).nonce;
    expect(n1).not.toEqual(n2);
  });
});

describe('vault memory hygiene (P2-09)', () => {
  it('zeroes the password bytes right after key derivation, on create, open and a wrong password', async () => {
    const seen: Array<{ arg: Uint8Array; copy: Uint8Array }> = [];
    const real = sodium.crypto_pwhash.bind(sodium);
    const spy = vi.spyOn(sodium, 'crypto_pwhash').mockImplementation(((len: number, pw: Uint8Array, ...rest: unknown[]) => {
      seen.push({ arg: pw, copy: Uint8Array.from(pw) });
      return (real as (...a: unknown[]) => Uint8Array)(len, pw, ...rest);
    }) as typeof sodium.crypto_pwhash);
    try {
      const v = await Vault.create(file, PW, fast);
      v.lock();
      (await Vault.open(file, PW)).lock();
      await expect(Vault.open(file, 'not the password at all')).rejects.toMatchObject({ code: 'BAD_PASSWORD' });
    } finally {
      spy.mockRestore();
    }
    expect(seen).toHaveLength(3);
    expect(Buffer.from(seen[0]!.copy).toString('utf8')).toBe(PW);
    for (const s of seen) {
      expect(s.arg.length).toBeGreaterThan(0);
      expect(s.arg.every((b) => b === 0)).toBe(true);
    }
  });

  it('zeroes the key when the vault is locked', async () => {
    const zeroed: Uint8Array[] = [];
    const v = await Vault.create(file, PW, fast);
    const spy = vi.spyOn(sodium, 'memzero').mockImplementation((b: Uint8Array) => {
      b.fill(0);
      zeroed.push(b);
    });
    try {
      v.lock();
    } finally {
      spy.mockRestore();
    }
    expect(zeroed).toHaveLength(1);
    expect(zeroed[0]!.every((b) => b === 0)).toBe(true);
    expect(v.locked).toBe(true);
  });
});

describe('redact', () => {
  it('masks secret keys at any depth', () => {
    const out = redact({ institution: 'max', credentials: { username: 'u', password: 'p' }, nested: [{ token: 't', ok: 1 }] });
    expect(out).toEqual({ institution: 'max', credentials: '[REDACTED]', nested: [{ token: '[REDACTED]', ok: 1 }] });
  });
  it('masks numbers', () => {
    expect(maskNumber('4580123456786150')).toBe('****6150');
    expect(maskNumber('12')).toBe('**');
  });
});
