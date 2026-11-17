import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SeenJti, checkClientAssertion } from './oauth.js';

// private_key_jwt (RFC 7523): ChatGPT proves itself at finc's token endpoint. Keys made up in the test.

const CLIENT = 'https://chatgpt.com/oauth/client.json';
const AUD = ['https://finc.example/oauth/token', 'https://finc.example'];
const NOW = Date.parse('2026-11-17T12:00:00Z');
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = (k: typeof rsa.publicKey, kid: string, alg: string) => ({ ...(k.export({ format: 'jwk' }) as object), kid, alg, use: 'sig' });
const JWKS = { keys: [jwk(rsa.publicKey, 'k1', 'RS256'), jwk(ec.publicKey, 'e1', 'ES256')] };
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

function jwt(claims: Record<string, unknown>, o: { kid?: string; alg?: string; key?: typeof rsa.privateKey } = {}): string {
  const alg = o.alg ?? 'RS256';
  const head = b64({ alg, typ: 'JWT', kid: o.kid ?? 'k1' });
  const body = b64({ iss: CLIENT, sub: CLIENT, aud: AUD[0], exp: NOW / 1000 + 300, iat: NOW / 1000, jti: `j-${Math.random()}`, ...claims });
  const data = Buffer.from(`${head}.${body}`);
  const sig = alg === 'ES256' ? sign('sha256', data, { key: o.key ?? ec.privateKey, dsaEncoding: 'ieee-p1363' }) : alg === 'none' ? Buffer.alloc(0) : sign('RSA-SHA256', data, o.key ?? rsa.privateKey);
  return `${head}.${body}.${sig.toString('base64url')}`;
}
const check = (t: unknown, seen = new SeenJti()) => checkClientAssertion(t, { clientId: CLIENT, audiences: AUD, jwks: JWKS, now: NOW, seen });

describe('client assertions', () => {
  it('a good RS256 or ES256 assertion passes, once', () => {
    const seen = new SeenJti();
    const t = jwt({ jti: 'only-once' });
    expect(check(t, seen)).toEqual({ ok: true, kid: 'k1' });
    expect(check(t, seen)).toMatchObject({ ok: false, reason: 'replayed' });
    expect(check(jwt({}, { alg: 'ES256', kid: 'e1' }))).toMatchObject({ ok: true });
    expect(check(jwt({ aud: [AUD[1], 'x'] }))).toMatchObject({ ok: true });
  });

  it('refuses another key, an unknown kid, alg none or HS256, and a tampered body', () => {
    expect(check(jwt({}, { key: other.privateKey }))).toMatchObject({ ok: false, reason: 'signature' });
    expect(check(jwt({}, { kid: 'k9' }))).toMatchObject({ ok: false, unknownKid: true });
    expect(check(jwt({}, { alg: 'none' }))).toMatchObject({ ok: false }); // an empty signature is already malformed
    expect(check(jwt({}, { alg: 'HS256' }))).toMatchObject({ ok: false, reason: 'alg' });
    const [h, , s] = jwt({}).split('.');
    expect(check(`${h}.${b64({ iss: CLIENT, sub: CLIENT, aud: AUD[0], exp: NOW / 1000 + 300, jti: 'x' })}.${s}`)).toMatchObject({ ok: false, reason: 'signature' });
    // the RSA key cannot pass for the EC one
    expect(check(jwt({}, { alg: 'ES256', kid: 'k1' }))).toMatchObject({ ok: false });
  });

  it('refuses the wrong issuer, subject, audience, an expired or far-future one, and a missing jti', () => {
    expect(check(jwt({ iss: 'https://evil.example/client.json' }))).toMatchObject({ ok: false, reason: 'iss/sub' });
    expect(check(jwt({ sub: 'someone' }))).toMatchObject({ ok: false, reason: 'iss/sub' });
    expect(check(jwt({ aud: 'https://other.example/token' }))).toMatchObject({ ok: false, reason: 'aud' });
    expect(check(jwt({ exp: NOW / 1000 - 120 }))).toMatchObject({ ok: false, reason: 'expired' });
    expect(check(jwt({ exp: NOW / 1000 + 3600 }))).toMatchObject({ ok: false, reason: 'exp too far' });
    expect(check(jwt({ iat: NOW / 1000 + 600 }))).toMatchObject({ ok: false });
    expect(check(jwt({ jti: undefined }))).toMatchObject({ ok: false, reason: 'jti' });
    expect(check('a.b')).toMatchObject({ ok: false, reason: 'malformed' });
  });
});
