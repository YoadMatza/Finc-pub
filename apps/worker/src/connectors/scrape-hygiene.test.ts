import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { hardenBrowserProfile, isIsracardSignedIn, sameOrigin, urlForLog, writePrivate } from './scrape-hygiene.js';

const dir = mkdtempSync(path.join(tmpdir(), 'finc-profile-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('scraper hygiene (security research P2-06)', () => {
  it('turns off saved passwords and autofill in a new profile', () => {
    const p = path.join(dir, 'fresh');
    hardenBrowserProfile(p);
    const prefs = JSON.parse(readFileSync(path.join(p, 'Default', 'Preferences'), 'utf8'));
    expect(prefs).toMatchObject({ credentials_enable_service: false, profile: { password_manager_enabled: false }, autofill: { profile_enabled: false, credit_card_enabled: false } });
  });

  it('keeps the rest of an existing profile and overrides a stored "save passwords" choice', () => {
    const p = path.join(dir, 'used');
    mkdirSync(path.join(p, 'Default'), { recursive: true });
    writeFileSync(path.join(p, 'Default', 'Preferences'), JSON.stringify({ credentials_enable_service: true, profile: { name: 'x', password_manager_enabled: true }, intl: { accept_languages: 'he' } }));
    hardenBrowserProfile(p);
    const prefs = JSON.parse(readFileSync(path.join(p, 'Default', 'Preferences'), 'utf8'));
    expect(prefs.credentials_enable_service).toBe(false);
    expect(prefs.profile).toMatchObject({ name: 'x', password_manager_enabled: false });
    expect(prefs.intl).toEqual({ accept_languages: 'he' });
  });

  it('survives a broken Preferences file', () => {
    const p = path.join(dir, 'broken');
    mkdirSync(path.join(p, 'Default'), { recursive: true });
    writeFileSync(path.join(p, 'Default', 'Preferences'), '{not json');
    hardenBrowserProfile(p);
    expect(JSON.parse(readFileSync(path.join(p, 'Default', 'Preferences'), 'utf8')).credentials_enable_service).toBe(false);
  });

  it('checks the Isracard hostname, not a substring of the URL', () => {
    expect(isIsracardSignedIn('https://digital.isracard.co.il/personalarea/dashboard')).toBe(true);
    expect(isIsracardSignedIn('https://digital.isracard.co.il/personalarea/Login')).toBe(false);
    expect(isIsracardSignedIn('https://evil.example/?next=isracard.co.il')).toBe(false);
    expect(isIsracardSignedIn('https://isracard.co.il.evil.example/home')).toBe(false);
    expect(isIsracardSignedIn('http://digital.isracard.co.il/home')).toBe(false);
    expect(isIsracardSignedIn('not a url')).toBe(false);
  });

  it('keeps explore mode on the bank origin', () => {
    const base = 'https://online.fibi.co.il/wps/myportal/FibiMenu/Online';
    expect(sameOrigin('#/Online/OnForeignCurrency', base)).toBe(true);
    expect(sameOrigin('/wps/myportal/x', base)).toBe(true);
    expect(sameOrigin('https://ads.example/track', base)).toBe(false);
    expect(sameOrigin('//ads.example/x', base)).toBe(false);
  });

  it('logs URLs without queries or fragments', () => {
    expect(urlForLog('https://bank.example/a/b?session=abc&t=1#/x?y=2')).toBe('https://bank.example/a/b');
    expect(urlForLog('::')).toBe('[unparsable url]');
  });

  it.skipIf(process.platform === 'win32')('writes captures owner-only', () => {
    const f = path.join(dir, 'shot.png');
    writePrivate(f, new Uint8Array([1, 2, 3]));
    expect(statSync(f).mode & 0o077).toBe(0);
  });
});
