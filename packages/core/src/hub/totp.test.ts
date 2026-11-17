import { describe, expect, it } from 'vitest';
import { openDb } from '../db/db.js';
import { base32Decode, base32Encode, disableTotp, enableTotp, hotp, matchTotp, newTotpSecret, totpEnabled, totpRecoveryLeft, useTotpCode } from './totp.js';

// backup login (research_notes/proposals/totp-backup-login.md): RFC 6238 codes, once each, recovery codes

// RFC 6238 appendix B, SHA-1: the ASCII secret "12345678901234567890", 8 digits
const RFC_SECRET = Buffer.from('12345678901234567890');
const T0 = Date.parse('2026-11-17T12:00:00Z');

describe('TOTP', () => {
  it('matches the RFC 6238 SHA-1 test vectors', () => {
    const at = (t: number) => hotp(RFC_SECRET, Math.floor(t / 30), 8);
    expect(at(59)).toBe('94287082');
    expect(at(1111111109)).toBe('07081804');
    expect(at(1234567890)).toBe('89005924');
    expect(at(2000000000)).toBe('69279037');
  });

  it('base32 round-trips; a code matches one step either side and no further', () => {
    const k = Buffer.from('a secret of twenty b');
    expect(base32Decode(base32Encode(k)).equals(k)).toBe(true);
    const code = hotp(k, Math.floor(T0 / 30000));
    expect(matchTotp(k, code, T0)).not.toBeNull();
    expect(matchTotp(k, code, T0 + 30_000)).not.toBeNull();
    expect(matchTotp(k, code, T0 + 90_000)).toBeNull();
    expect(matchTotp(k, '12345', T0)).toBeNull();
  });
});

describe('the backup login state', () => {
  const setup = () => {
    const db = openDb(':memory:');
    const { secret, uri } = newTotpSecret('owner');
    expect(uri).toMatch(/^otpauth:\/\/totp\/finc%3Aowner\?secret=[A-Z2-7]+&issuer=finc/);
    const key = base32Decode(secret);
    const code = (t: number) => hotp(key, Math.floor(t / 30000));
    return { db, secret, code };
  };

  it('turns on only with a valid code, and gives 8 recovery codes once', () => {
    const { db, secret, code } = setup();
    expect(enableTotp(db, secret, '000000', T0)).toEqual({ ok: false });
    expect(totpEnabled(db)).toBe(false);
    const r = enableTotp(db, secret, code(T0), T0);
    expect(r.ok && r.recoveryCodes).toHaveLength(8);
    expect(totpEnabled(db)).toBe(true);
    // only hashes are stored
    const stored = db.$client.prepare("select value from setting where key = 'auth.totp'").get() as { value: string };
    if (r.ok) for (const c of r.recoveryCodes) expect(stored.value).not.toContain(c.replace('-', ''));
  });

  it('a code works once; the one used at setup cannot sign in; later steps can', () => {
    const { db, secret, code } = setup();
    enableTotp(db, secret, code(T0), T0);
    expect(useTotpCode(db, code(T0), T0)).toEqual({ ok: false }); // the setup code is spent
    const later = T0 + 60_000;
    expect(useTotpCode(db, code(later), later)).toMatchObject({ ok: true, via: 'app' });
    expect(useTotpCode(db, code(later), later)).toEqual({ ok: false }); // replay
    expect(useTotpCode(db, code(later - 30_000), later)).toEqual({ ok: false }); // an older step
  });

  it('recovery codes: each once, any case or dashes; turning off ends everything', () => {
    const { db, secret, code } = setup();
    const r = enableTotp(db, secret, code(T0), T0);
    if (!r.ok) throw new Error('setup');
    const first = r.recoveryCodes[0]!;
    expect(useTotpCode(db, first.toLowerCase(), T0)).toMatchObject({ ok: true, via: 'recovery', recoveryLeft: 7 });
    expect(useTotpCode(db, first, T0)).toEqual({ ok: false });
    expect(useTotpCode(db, r.recoveryCodes[1]!.replace('-', ''), T0)).toMatchObject({ ok: true, recoveryLeft: 6 });
    expect(totpRecoveryLeft(db)).toBe(6);
    disableTotp(db);
    expect(totpEnabled(db)).toBe(false);
    expect(useTotpCode(db, r.recoveryCodes[2]!, T0)).toEqual({ ok: false });
  });
});
