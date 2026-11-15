/**
 * Encrypted credential vault.
 *
 * One file, `vault.json`, holding a small plaintext header (KDF params, salt, nonce)
 * and ONE ciphertext blob. The blob is the JSON of every entry, so entry names and
 * field names are encrypted too. Nothing about the contents is visible on disk.
 *
 *   key        = Argon2id(master password, salt, ops, mem)
 *   ciphertext = XChaCha20-Poly1305-IETF(key, nonce, plaintext, aad = header-without-nonce)
 *
 * The key lives in memory only while the vault is unlocked; `lock()` zeroes it.
 * Values are never logged. Callers must not log what they read either.
 *
 * Memory (security research P2-09): every byte buffer that holds secret material is zeroed as soon as it is no
 * longer needed: the UTF-8 bytes of the master password right after Argon2id, a key whose decrypt failed, the
 * decrypted plaintext after parsing, backup subkeys. What cannot be zeroed: the master password itself arrives as a JS
 * string (from the HTTP body or the terminal) and strings are immutable; the decrypted entries are JS strings for as
 * long as the vault is open (lock() drops them for the garbage collector, it cannot overwrite them); and libsodium.js
 * copies its inputs into its WebAssembly heap for the call. Keep the vault locked when it is not needed.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import sodium from 'libsodium-wrappers-sumo';

export type VaultEntryKind = 'scraper' | 'token' | 'generic';

export interface VaultEntry {
  kind: VaultEntryKind;
  /** e.g. { username, password } or { id, card6Digits, password } or { token } */
  fields: Record<string, string>;
  updatedAt: string; // ISO
}

interface VaultHeader {
  v: 1;
  kdf: { alg: 'argon2id13'; ops: number; mem: number; salt: string };
}
interface VaultFile extends VaultHeader {
  nonce: string;
  ct: string;
}

export type VaultErrorCode = 'NOT_FOUND' | 'EXISTS' | 'BAD_PASSWORD' | 'CORRUPT' | 'LOCKED';

export class VaultError extends Error {
  constructor(
    message: string,
    readonly code: VaultErrorCode,
  ) {
    super(message);
    this.name = 'VaultError';
  }
}

const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64');
const unb64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));

/** The password's UTF-8 bytes live only for the Argon2id call and are zeroed right after it (the string cannot be). */
async function deriveKey(password: string, hdr: VaultHeader): Promise<Uint8Array> {
  await sodium.ready;
  const pw = Buffer.from(password, 'utf8');
  try {
    return sodium.crypto_pwhash(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES, pw, unb64(hdr.kdf.salt), hdr.kdf.ops, hdr.kdf.mem, sodium.crypto_pwhash_ALG_ARGON2ID13);
  } finally {
    pw.fill(0);
  }
}

const aad = (hdr: VaultHeader): Uint8Array => sodium.from_string(JSON.stringify({ v: hdr.v, kdf: hdr.kdf }));

/** An encrypted backup as stored on disk (JSON). `meta` is plaintext but authenticated (part of the AAD). */
export interface SealedBackup {
  v: 1;
  kind: 'finc-backup';
  kdf: VaultHeader['kdf'];
  meta: Record<string, unknown>;
  nonce: string;
  ct: string;
}

const BACKUP_CONTEXT = 'fincbkup'; // crypto_kdf context: exactly 8 characters

function backupSubkey(key: Uint8Array): Uint8Array {
  return sodium.crypto_kdf_derive_from_key(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES, 1, BACKUP_CONTEXT, key);
}

const backupAad = (kdf: VaultHeader['kdf'], meta: Record<string, unknown>): Uint8Array => sodium.from_string(JSON.stringify({ v: 1, kind: 'finc-backup', kdf, meta }));

function decryptBackup(sealed: SealedBackup, key: Uint8Array): Uint8Array {
  const sub = backupSubkey(key);
  try {
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, unb64(sealed.ct), backupAad(sealed.kdf, sealed.meta), unb64(sealed.nonce), sub);
  } catch {
    throw new VaultError('wrong master password, or the backup file is damaged or was changed', 'BAD_PASSWORD');
  } finally {
    sodium.memzero(sub);
  }
}

export interface VaultOptions {
  /** Override Argon2id cost (tests use INTERACTIVE to stay fast). */
  ops?: number;
  mem?: number;
}

const MIN_PASSWORD = 8;

export class Vault {
  private key: Uint8Array | null;
  private entries: Map<string, VaultEntry>;

  private constructor(
    private readonly file: string,
    private header: VaultHeader,
    key: Uint8Array,
    entries: Map<string, VaultEntry>,
  ) {
    this.key = key;
    this.entries = entries;
  }

  static exists(file: string): boolean {
    return existsSync(file);
  }

  /** Create a new, empty vault. Fails if the file exists. */
  static async create(file: string, password: string, opts: VaultOptions = {}): Promise<Vault> {
    await sodium.ready;
    if (existsSync(file)) throw new VaultError(`vault already exists at ${file}`, 'EXISTS');
    if (password.length < MIN_PASSWORD) throw new Error(`master password must be at least ${MIN_PASSWORD} characters`);
    const header: VaultHeader = {
      v: 1,
      kdf: {
        alg: 'argon2id13',
        ops: opts.ops ?? sodium.crypto_pwhash_OPSLIMIT_MODERATE,
        mem: opts.mem ?? sodium.crypto_pwhash_MEMLIMIT_MODERATE,
        salt: b64(sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES)),
      },
    };
    const key = await deriveKey(password, header);
    const v = new Vault(file, header, key, new Map());
    try {
      v.save();
    } catch (e) {
      v.lock();
      throw e;
    }
    return v;
  }

  /** Open and decrypt an existing vault. Wrong password → VaultError BAD_PASSWORD. */
  static async open(file: string, password: string): Promise<Vault> {
    await sodium.ready;
    if (!existsSync(file)) throw new VaultError(`no vault at ${file}`, 'NOT_FOUND');
    let parsed: VaultFile;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8')) as VaultFile;
    } catch {
      throw new VaultError('vault file is not valid JSON', 'CORRUPT');
    }
    if (parsed.v !== 1 || parsed.kdf?.alg !== 'argon2id13') throw new VaultError('unsupported vault format', 'CORRUPT');
    const header: VaultHeader = { v: 1, kdf: parsed.kdf };
    const key = await deriveKey(password, header);
    let plain: Uint8Array;
    try {
      plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, unb64(parsed.ct), aad(header), unb64(parsed.nonce), key);
    } catch {
      sodium.memzero(key);
      throw new VaultError('wrong master password (or the vault file is corrupt)', 'BAD_PASSWORD');
    }
    let obj: Record<string, VaultEntry>;
    try {
      obj = JSON.parse(sodium.to_string(plain)) as Record<string, VaultEntry>;
    } catch {
      sodium.memzero(key);
      throw new VaultError('vault contents are not valid JSON', 'CORRUPT');
    } finally {
      sodium.memzero(plain);
    }
    return new Vault(file, header, key, new Map(Object.entries(obj)));
  }

  get path(): string {
    return this.file;
  }

  get locked(): boolean {
    return this.key === null;
  }

  private assertUnlocked(): Uint8Array {
    if (!this.key) throw new VaultError('vault is locked', 'LOCKED');
    return this.key;
  }

  list(): Array<{ name: string; kind: VaultEntryKind; fields: string[]; updatedAt: string }> {
    this.assertUnlocked();
    return [...this.entries.entries()]
      .map(([name, e]) => ({ name, kind: e.kind, fields: Object.keys(e.fields), updatedAt: e.updatedAt }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  has(name: string): boolean {
    this.assertUnlocked();
    return this.entries.has(name);
  }

  /** Returns a copy. Do not log the result. */
  get(name: string): VaultEntry | undefined {
    this.assertUnlocked();
    const e = this.entries.get(name);
    return e ? { kind: e.kind, fields: { ...e.fields }, updatedAt: e.updatedAt } : undefined;
  }

  set(name: string, kind: VaultEntryKind, fields: Record<string, string>): void {
    this.assertUnlocked();
    if (!/^[a-z0-9_-]{1,64}$/i.test(name)) throw new Error('entry name: letters, digits, _ and - only');
    this.entries.set(name, { kind, fields: { ...fields }, updatedAt: new Date().toISOString() });
    this.save();
  }

  delete(name: string): boolean {
    this.assertUnlocked();
    const had = this.entries.delete(name);
    if (had) this.save();
    return had;
  }

  /** Re-encrypt under a new master password (new salt, new key). */
  async rekey(newPassword: string): Promise<void> {
    this.assertUnlocked();
    if (newPassword.length < MIN_PASSWORD) throw new Error(`master password must be at least ${MIN_PASSWORD} characters`);
    const header: VaultHeader = {
      v: 1,
      kdf: { ...this.header.kdf, salt: b64(sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES)) },
    };
    const newKey = await deriveKey(newPassword, header);
    if (this.key) sodium.memzero(this.key);
    this.key = newKey;
    this.header = header;
    this.save();
  }

  /** Encrypt all entries with a fresh nonce and write atomically (tmp + rename). */
  private save(): void {
    const key = this.assertUnlocked();
    const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
    const plain = sodium.from_string(JSON.stringify(Object.fromEntries(this.entries)));
    const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plain, aad(this.header), null, nonce, key);
    sodium.memzero(plain);
    const out: VaultFile = { ...this.header, nonce: b64(nonce), ct: b64(ct) };
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /**
   * Encrypt a backup payload with a subkey derived from the vault key (crypto_kdf, context "fincbkup"), never the
   * vault key itself. The header carries the vault's KDF parameters and salt, so the master password of today can open
   * it later even after a rekey: openBackupWithPassword derives the same key from that salt.
   */
  sealBackup(plain: Uint8Array, meta: Record<string, unknown>): SealedBackup {
    const key = this.assertUnlocked();
    const sub = backupSubkey(key);
    const kdf = { ...this.header.kdf };
    const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
    const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plain, backupAad(kdf, meta), null, nonce, sub);
    sodium.memzero(sub);
    return { v: 1, kind: 'finc-backup', kdf, meta, nonce: b64(nonce), ct: b64(ct) };
  }

  /** Decrypt a backup with this unlocked vault; only works for backups made under the current master password (same salt). */
  openBackup(sealed: SealedBackup): Uint8Array {
    const key = this.assertUnlocked();
    if (sealed.kdf?.salt !== this.header.kdf.salt) throw new VaultError('this backup was made under an earlier master password; open it with that password', 'BAD_PASSWORD');
    return decryptBackup(sealed, key);
  }

  /** Decrypt a backup with the master password in use when it was made (restore on the PC, no vault needed). */
  static async openBackupWithPassword(sealed: SealedBackup, password: string): Promise<Uint8Array> {
    await sodium.ready;
    if (sealed.v !== 1 || sealed.kind !== 'finc-backup' || sealed.kdf?.alg !== 'argon2id13') throw new VaultError('not a finc backup file', 'CORRUPT');
    const key = await deriveKey(password, { v: 1, kdf: sealed.kdf });
    try {
      return decryptBackup(sealed, key);
    } finally {
      sodium.memzero(key);
    }
  }

  /** Zero the key and forget every entry. The object is unusable afterwards. */
  lock(): void {
    if (this.key) sodium.memzero(this.key);
    this.key = null;
    this.entries = new Map();
  }
}
