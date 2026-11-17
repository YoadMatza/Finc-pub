import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { codeKind, groupSecret, isAppCode, qrPath, totpConfirmError, totpLoginError, totpRetryText } from './totp';

// a t() that shows the key and its vars, so the tests see which text was chosen
const t = (key: string, vars?: Record<string, string | number>) => `${key}(${Object.entries(vars ?? {}).map(([k, v]) => `${k}=${v}`).join(',')})`;
const locked = (retryAt: unknown) => new ApiError('locked', 429, undefined, { error: 'locked', retryAt });

describe('groupSecret', () => {
  it('groups of 4, the last one shorter', () => {
    expect(groupSecret('JBSWY3DPEHPK3PXPJBSWY3DPEH')).toBe('JBSW Y3DP EHPK 3PXP JBSW Y3DP EH');
    expect(groupSecret('ABCDEFGH')).toBe('ABCD EFGH');
  });
  it('drops spaces and dashes, upper-cases', () => {
    expect(groupSecret(' abcd efgh-ij ')).toBe('ABCD EFGH IJ');
  });
  it('empty stays empty', () => {
    expect(groupSecret('')).toBe('');
  });
});

describe('codeKind', () => {
  it('6 digits is an app code, also with spaces around or inside', () => {
    expect(codeKind('123456')).toBe('totp');
    expect(codeKind(' 123 456 ')).toBe('totp');
    expect(isAppCode('000000')).toBe(true);
  });
  it('a recovery code, with or without the dash, any case', () => {
    expect(codeKind('ABCDE-FGHIJ')).toBe('recovery');
    expect(codeKind('abcde-fghij')).toBe('recovery');
    expect(codeKind('ABCDEFGHIJ')).toBe('recovery');
    expect(codeKind('12345-67890')).toBe('recovery');
    expect(isAppCode('ABCDE-FGHIJ')).toBe(false);
  });
  it('anything else is neither', () => {
    for (const s of ['', '12345', '1234567', '12a456', 'ABCD-EFGHIJ', 'ABCDE--FGHIJ', 'ABCDE_FGHIJ', 'ABCDE-FGHIJK', 'אבגדה-ABCDE']) expect(codeKind(s)).toBeNull();
  });
});

describe('totpRetryText', () => {
  const now = new Date('2026-11-11T10:00:00Z'); // 12:00 in Israel
  it('later today: the time only, in Israel time', () => {
    expect(totpRetryText(locked('2026-11-11T12:35:00Z'), t, 'en-GB', now)).toBe('totp_locked_until(when=limit_when_today(t=14:35,d=))');
  });
  it('tomorrow', () => {
    expect(totpRetryText(locked('2026-11-12T08:00:00Z'), t, 'en-GB', now)).toBe('totp_locked_until(when=limit_when_tomorrow(t=10:00,d=))');
  });
  it('null without a readable retryAt or for another status', () => {
    expect(totpRetryText(locked(undefined), t, 'en-GB', now)).toBeNull();
    expect(totpRetryText(new ApiError('x', 401), t, 'en-GB', now)).toBeNull();
  });
});

describe('totpLoginError', () => {
  const now = new Date('2026-11-11T10:00:00Z');
  it('one message for a wrong PIN or code', () => {
    expect(totpLoginError(new ApiError('wrong PIN or code', 401), t, 'en-GB', now)).toBe('totp_wrong()');
  });
  it('locked: when to try again, or a plain locked line without retryAt', () => {
    expect(totpLoginError(locked('2026-11-11T12:35:00Z'), t, 'en-GB', now)).toContain('totp_locked_until');
    expect(totpLoginError(new ApiError('locked', 429), t, 'en-GB', now)).toBe('totp_locked()');
  });
  it('off, and anything else as the hub said it', () => {
    expect(totpLoginError(new ApiError('off', 409), t, 'en-GB', now)).toBe('totp_off_now()');
    expect(totpLoginError(new ApiError('boom', 500), t, 'en-GB', now)).toBe('boom');
    expect(totpLoginError('network', t, 'en-GB', now)).toBe('network');
  });
});

describe('totpConfirmError', () => {
  it('wrong code, expired setup, other', () => {
    expect(totpConfirmError(new ApiError('wrong code', 400), t)).toBe('totp_confirm_wrong()');
    expect(totpConfirmError(new ApiError('gone', 410), t)).toBe('totp_setup_expired()');
    expect(totpConfirmError(new ApiError('away', 403), t)).toBe('away');
  });
});

describe('qrPath', () => {
  it('draws a square with the quiet zone and only dark modules', () => {
    const { size, d } = qrPath('otpauth://totp/finc:owner?secret=JBSWY3DPEHPK3PXP&issuer=finc');
    expect(size).toBeGreaterThanOrEqual(21 + 4);
    expect((size - 4 - 17) % 4).toBe(0); // QR versions are 17 + 4v modules wide
    expect(d.startsWith('M2 2h1v1h-1z')).toBe(true); // the top-left finder starts dark, inside the margin
    expect(d).toMatch(/^(M\d+ \d+h1v1h-1z)+$/);
  });
});
