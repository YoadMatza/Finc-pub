import { describe, expect, it } from 'vitest';
import { CLOSED_POLICY, checkHubUrl } from './hubhost';

const RELEASE = { host: 'hub.example.org', enforce: true };
const DEBUG = { host: 'hub.example.org', enforce: false };

describe('checkHubUrl (security research P1-10)', () => {
  it('release: the built-in host, https, any port', () => {
    expect(checkHubUrl('https://hub.example.org:7443', RELEASE)).toEqual({ ok: true, origin: 'https://hub.example.org:7443' });
    expect(checkHubUrl('https://hub.example.org', RELEASE)).toEqual({ ok: true, origin: 'https://hub.example.org' });
    expect(checkHubUrl('  https://HUB.Example.org:8443/pair?code=x ', RELEASE)).toEqual({ ok: true, origin: 'https://hub.example.org:8443' });
  });

  it('one trailing dot is the same name; the origin used is always built from the pinned host', () => {
    expect(checkHubUrl('https://hub.example.org.:7443', RELEASE)).toEqual({ ok: true, origin: 'https://hub.example.org:7443' });
    expect(checkHubUrl('https://HUB.EXAMPLE.ORG', RELEASE)).toEqual({ ok: true, origin: 'https://hub.example.org' });
    expect(checkHubUrl('https://hub.example.org:7443/x?y#z', RELEASE)).toEqual({ ok: true, origin: 'https://hub.example.org:7443' });
  });

  it('two trailing dots are refused, not normalised', () => {
    expect(checkHubUrl('https://hub.example.org..:7443', RELEASE)).toMatchObject({ ok: false });
    expect(checkHubUrl('https://hub.example.org..', RELEASE)).toMatchObject({ ok: false });
  });

  it('release: any other host is refused, including look-alikes and subdomains', () => {
    for (const url of [
      'https://evil.example:7443',
      'https://hub.example.org.evil.example:7443',
      'https://sub.hub.example.org:7443',
      'https://xhub.example.org',
      'https://192.168.1.10:7443',
      'https://localhost:7443',
    ]) {
      expect(checkHubUrl(url, RELEASE)).toEqual({ ok: false, reason: 'host' });
    }
  });

  it('https only, everywhere', () => {
    expect(checkHubUrl('http://hub.example.org:7443', RELEASE)).toEqual({ ok: false, reason: 'https' });
    expect(checkHubUrl('http://192.168.1.10:7733', DEBUG)).toEqual({ ok: false, reason: 'https' });
    expect(checkHubUrl('finc://pair?code=x', RELEASE)).toEqual({ ok: false, reason: 'https' });
  });

  it('no user:password in the URL, no garbage', () => {
    expect(checkHubUrl('https://evil.example@hub.example.org:7443', RELEASE)).toEqual({ ok: false, reason: 'invalid' });
    expect(checkHubUrl('not a url', RELEASE)).toEqual({ ok: false, reason: 'invalid' });
    expect(checkHubUrl('', RELEASE)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('debug: any https host', () => {
    expect(checkHubUrl('https://192.168.1.10:7443', DEBUG)).toEqual({ ok: true, origin: 'https://192.168.1.10:7443' });
  });

  it('fails closed when the built-in host is unknown', () => {
    expect(checkHubUrl('https://hub.example.org:7443', CLOSED_POLICY)).toEqual({ ok: false, reason: 'host' });
    expect(checkHubUrl('https://hub.example.org:7443', { host: '', enforce: true })).toEqual({ ok: false, reason: 'host' });
  });
});
