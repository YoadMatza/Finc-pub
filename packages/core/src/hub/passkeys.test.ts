import { describe, expect, it } from 'vitest';
import { openDb } from '../db/db.js';
import { activePasskeys, addPasskey, findPasskey, listPasskeys, revokePasskey, touchPasskey } from './passkeys.js';

const RP = 'finc-example.duckdns.org';

describe('passkey store', () => {
  it('adds, finds by credential id and relying party, touches, lists and revokes', () => {
    const db = openDb(':memory:');
    const p = addPasskey(db, { credentialId: 'cred-1', publicKey: 'pk-1', counter: 0, transports: ['hybrid', 'internal'], rpId: RP, name: '  Galaxy phone  ', deviceType: 'multiDevice', backedUp: true });
    expect(p).toMatchObject({ name: 'Galaxy phone', rpId: RP, backedUp: true, lastUsedAt: null, revokedAt: null });
    expect(findPasskey(db, 'cred-1', RP)).toMatchObject({ id: p.id, publicKey: 'pk-1', counter: 0, transports: ['hybrid', 'internal'] });
    expect(findPasskey(db, 'cred-1', 'evil.example')).toBeNull(); // bound to its relying party
    expect(findPasskey(db, 'nope', RP)).toBeNull();
    touchPasskey(db, p.id, 7);
    expect(findPasskey(db, 'cred-1', RP)).toMatchObject({ counter: 7 });
    expect(findPasskey(db, 'cred-1', RP)?.lastUsedAt).not.toBeNull();
    expect(activePasskeys(db, RP)).toHaveLength(1);
    expect(revokePasskey(db, p.id)).toBe(true);
    expect(revokePasskey(db, p.id)).toBe(false);
    expect(findPasskey(db, 'cred-1', RP)).toBeNull();
    expect(activePasskeys(db, RP)).toHaveLength(0);
    expect(listPasskeys(db)).toHaveLength(0);
    expect(listPasskeys(db, true)).toHaveLength(1);
  });

  it('refuses the same credential twice and an empty one', () => {
    const db = openDb(':memory:');
    addPasskey(db, { credentialId: 'c', publicKey: 'p', counter: 0, rpId: RP, name: 'x' });
    expect(() => addPasskey(db, { credentialId: 'c', publicKey: 'p', counter: 0, rpId: RP, name: 'y' })).toThrow();
    expect(() => addPasskey(db, { credentialId: '', publicKey: 'p', counter: 0, rpId: RP, name: 'z' })).toThrow();
  });
});
