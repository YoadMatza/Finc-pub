import { describe, expect, it } from 'vitest';
import { REDACTED, isSecretKey, redact, secretCode } from './redact.js';

// every value below is invented for the test
describe('redact (P2-09)', () => {
  it('censors secret keys 5 levels down and inside arrays', () => {
    const input = { a: { b: { c: { d: { apiKey: 'k-123', keep: 'yes', list: [{ password: 'pw' }, { fine: 1 }] } } } }, top: 'ok' };
    const out = redact(input);
    expect(out).toEqual({ a: { b: { c: { d: { apiKey: REDACTED, keep: 'yes', list: [{ password: REDACTED }, { fine: 1 }] } } } }, top: 'ok' });
    // the input is untouched
    expect(input.a.b.c.d.apiKey).toBe('k-123');
  });

  it('matches keys whatever their case or separators', () => {
    for (const k of ['API_KEY', 'api-key', 'X-Api-Key', 'access_token', 'RefreshToken', 'Set-Cookie', 'AUTHORIZATION', 'account_number', 'card-number', 'IBAN', 'master_password', 'private_key', 'Bearer', 'PIN', 'passwd'])
      expect(isSecretKey(k), k).toBe(true);
    for (const k of ['institution', 'amount', 'kind', 'cards', 'tokenCount', 'pinned']) expect(isSecretKey(k), k).toBe(false);
    expect(redact({ headers: { 'X-API-KEY': 'k', Cookie: 'c=1', 'content-type': 'json' } })).toEqual({ headers: { 'X-API-KEY': REDACTED, Cookie: REDACTED, 'content-type': 'json' } });
  });

  it("keeps an error 'code' and censors a one-time or pairing code", () => {
    expect(secretCode('ENOENT')).toBe(false);
    expect(secretCode('LOCKED')).toBe(false);
    expect(secretCode('SQLITE_BUSY')).toBe(false);
    expect(secretCode('ERR_HTTP2_STREAM_ERROR')).toBe(false);
    expect(secretCode('invalid_type')).toBe(false);
    expect(secretCode(403)).toBe(false);
    expect(secretCode('123456')).toBe(true);
    expect(secretCode(482913)).toBe(true);
    expect(secretCode('q7Xz-P2mK9aB_c4d')).toBe(true);
    expect(redact({ err: { code: 'ECONNREFUSED' }, pairing: { code: 'q7Xz-P2mK9aB_c4d' }, challenge: { code: '0412' } })).toEqual({ err: { code: 'ECONNREFUSED' }, pairing: { code: REDACTED }, challenge: { code: REDACTED } });
  });

  it('matches secret words inside longer keys, and …code keys by value (review L3)', () => {
    for (const k of ['userPassword', 'db_passwd', 'clientSecretValue', 'csrfToken', 'session-cookies', 'smsOtp', 'myApiKey', 'PAIRING_TOKEN']) expect(isSecretKey(k), k).toBe(true);
    for (const k of ['hasPassword', 'isSecret', 'tokensLength', 'passwordChangedAt', 'otpRequired', 'tokenExpiresAt', 'tokenType', 'secretKind', 'pinnedKeys']) expect(isSecretKey(k), k).toBe(false);
    expect(redact({ pairingCode: 'q7Xz-P2mK9aB_c4d', enrolCode: 'Zm9vYmFyYmF6cXV4', smsCode: '123456', errorCode: 'ENOENT', statusCode: 404, exitCode: 1, currencyCode: 'ILS', otpCode: 'ABC' })).toEqual({
      pairingCode: REDACTED,
      enrolCode: REDACTED,
      smsCode: REDACTED,
      errorCode: 'ENOENT',
      statusCode: 404,
      exitCode: 1,
      currencyCode: 'ILS',
      otpCode: REDACTED,
    });
  });

  it('keeps an Error an Error, cleans its message and censors its own secret props', () => {
    class SshError extends Error {
      level = 'client-authentication';
      config = { host: 'nas.example.test', password: 'pw-1' };
      token = 't-1';
    }
    const e = new SshError('auth failed for backup@nas.example.test at https://x.example.test/a?sig=zzz account 987654321');
    const out = redact({ err: e }).err as SshError;
    expect(out).toBeInstanceOf(SshError);
    expect(out.message).toBe('auth failed for [email] at https://x.example.test/a account *******21');
    expect(out.stack?.split('\n')[0]).not.toContain('987654321');
    expect(out.level).toBe('client-authentication');
    expect(out.token).toBe(REDACTED);
    expect(out.config).toEqual({ host: 'nas.example.test', password: REDACTED });
  });

  it('is safe with cycles, deep nesting, maps and buffers', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(redact(a)).toEqual({ name: 'a', self: '[Circular]' });
    let deep: Record<string, unknown> = { secret: 's' };
    for (let i = 0; i < 20; i++) deep = { next: deep };
    expect(JSON.stringify(redact(deep))).not.toContain('"s"');
    expect(redact({ m: new Map([['token', 't'], ['n', 1]]), b: Buffer.from('secret bytes') })).toEqual({ m: [['token', REDACTED], ['n', 1]], b: '[Buffer 12 bytes]' });
    // the same object twice side by side is not a cycle
    const shared = { v: 1 };
    expect(redact({ x: shared, y: shared })).toEqual({ x: { v: 1 }, y: { v: 1 } });
  });

  it('cleans error-text strings and strips URL query strings everywhere', () => {
    expect(redact({ err: 'failed for 123456789 at https://h.example.test/p?k=v', url: 'https://h.example.test/p?k=v#f', note: 'plain 123456789' })).toEqual({
      err: 'failed for *******89 at https://h.example.test/p',
      url: 'https://h.example.test/p',
      note: 'plain 123456789',
    });
  });
});
