import { describe, expect, it, vi } from 'vitest';
import { checkHubUrl, pairedOrigin } from './hubhost';

// Security research P2-05: the QR and manual pairing paths. Pair.tsx turns the scanned or typed text into a target with
// parsePairingText, and redeem() checks target.url with checkHubUrl before anything is sent (no network call on a
// refusal). These tests run the same composition, then the rule for the address the hub sends back.

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true }, registerPlugin: () => ({}) }));
const { parsePairingText } = await import('./native');

const RELEASE = { host: 'hub.example.org', enforce: true };
const DEBUG = { host: 'hub.example.org', enforce: false };
const CODE = 'Abcdefgh_ijklmnop-1234';

/** What redeem() does with a scanned / typed text before it may call pairDevice. */
const target = (text: string, fallbackUrl: string | undefined, policy: typeof RELEASE) => {
  const parsed = parsePairingText(text, fallbackUrl);
  return parsed ? { code: parsed.code, check: checkHubUrl(parsed.url, policy) } : null;
};

describe('QR and manual pairing go through the hub check (P2-05)', () => {
  it('the real QR passes and the code goes to the pinned origin', () => {
    expect(target(`https://hub.example.org:7443/pair?code=${CODE}`, undefined, RELEASE)).toEqual({ code: CODE, check: { ok: true, origin: 'https://hub.example.org:7443' } });
  });

  it('a fake QR for another host is refused in a release build (the finding\'s example)', () => {
    expect(target('https://evil.example/pair?code=AAAAAAAA', undefined, RELEASE)).toEqual({ code: 'AAAAAAAA', check: { ok: false, reason: 'host' } });
    expect(target(`https://hub.example.org.evil.example/pair?code=${CODE}`, undefined, RELEASE)?.check).toEqual({ ok: false, reason: 'host' });
  });

  it('a QR or typed address that is not https is refused, in debug builds too', () => {
    expect(target(`http://hub.example.org:7733/pair?code=${CODE}`, undefined, RELEASE)?.check).toEqual({ ok: false, reason: 'https' });
    expect(target(`http://192.168.1.10:7733/pair?code=${CODE}`, undefined, DEBUG)?.check).toEqual({ ok: false, reason: 'https' });
    // finc:// has no origin ("null"), so it never becomes a hub address
    expect(target(`finc://pair?code=${CODE}&url=https://evil.example`, undefined, DEBUG)?.check).toMatchObject({ ok: false });
  });

  it('manual: a bare code is sent only to a typed address that passes the same check', () => {
    expect(target(CODE, 'https://hub.example.org:7443/', RELEASE)).toEqual({ code: CODE, check: { ok: true, origin: 'https://hub.example.org:7443' } });
    expect(target(CODE, 'https://evil.example', RELEASE)?.check).toEqual({ ok: false, reason: 'host' });
    expect(target(CODE, 'http://hub.example.org', RELEASE)?.check).toEqual({ ok: false, reason: 'https' });
    expect(target(CODE, 'https://user:pw@hub.example.org', RELEASE)?.check).toEqual({ ok: false, reason: 'invalid' });
    expect(target(CODE, undefined, RELEASE)).toBeNull(); // no address, nothing to send to
  });
});

describe('the address the hub sends back after pairing (P2-05)', () => {
  const checked = 'https://hub.example.org:7443';

  it('release: another host is ignored, the checked origin is kept', () => {
    expect(pairedOrigin('https://evil.example:7443', checked, RELEASE)).toBe(checked);
    expect(pairedOrigin('http://hub.example.org:7443', checked, RELEASE)).toBe(checked);
    expect(pairedOrigin('', checked, RELEASE)).toBe(checked);
    expect(pairedOrigin('not a url', checked, RELEASE)).toBe(checked);
  });

  it('release: the pinned host may name its port; the origin is rebuilt from the pinned host, not echoed', () => {
    expect(pairedOrigin('https://HUB.example.org.:8443/some/path', 'https://hub.example.org', RELEASE)).toBe('https://hub.example.org:8443');
  });

  it('debug: any https host the hub names is taken (no pin to protect), never http', () => {
    expect(pairedOrigin('https://other.example:7443', checked, DEBUG)).toBe('https://other.example:7443');
    expect(pairedOrigin('http://other.example:7733', checked, DEBUG)).toBe(checked);
  });
});
