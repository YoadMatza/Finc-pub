import { describe, expect, it } from 'vitest';
import { collectAlerts } from './alerts/index.js';
import { openDb } from './db/db.js';
import { setSetting } from './ai/settings.js';
import { ERROR_CLEANUP_SETTING, cleanStoredErrors, finishRunError, startRun } from './db/runs.js';
import { classifyError, cleanErrorText, cleanErrorType, errorPhrase, errorSummary, stripUrlQuery, syncErrorKind } from './errors.js';
import { hubOverview } from './hub/overview.js';

// every value below is invented for the test
const RAW =
  'Login failed at https://login.example-bank.test/auth/step2?session=AbC123secretTOKEN&user=jdoe#frag for account 123456789 card 4580 1111 2222 3456 contact jane.doe@example.test';

describe('cleanErrorText', () => {
  it('strips URL query strings and fragments, keeping scheme, host and path', () => {
    const s = cleanErrorText('GET https://api.example.test/v1/items?token=s3cr3t-value&x=1#top failed');
    expect(s).toBe('GET https://api.example.test/v1/items failed');
    expect(stripUrlQuery('see http://user:pw@host.test/p?q=1')).toBe('see http://host.test/p');
  });

  it('masks a 9-digit account number, keeping the last 2 digits', () => {
    expect(cleanErrorText('account 123456789 is blocked')).toBe('account *******89 is blocked');
    // short numbers (counts, ports, dates) stay
    expect(cleanErrorText('3 rows on 2026-11-10 via port 7443')).toBe('3 rows on 2026-11-10 via port 7443');
  });

  it('masks card numbers, grouped or not', () => {
    expect(cleanErrorText('card 4580 1111 2222 3456 declined')).toBe('card ****56 declined');
    expect(cleanErrorText('card 4580-1111-2222-3456 declined')).toBe('card ****56 declined');
    expect(cleanErrorText('card 4580111122223456 declined')).toBe('card **************56 declined');
  });

  it('masks e-mail addresses and ssh user@host targets', () => {
    expect(cleanErrorText('mail jane.doe@example.test bounced')).toBe('mail [email] bounced');
    expect(cleanErrorText('could not connect to backup-user@nas.example.test:/copies')).toBe('could not connect to [email]:/copies');
  });

  it('replaces bot tokens and bearer values', () => {
    expect(cleanErrorText('fetch https://api.telegram.org/bot1234567:AAbbCCddEEffGGhhIIjjKKllMM/sendMessage failed')).toBe('fetch https://api.telegram.org/bot[REDACTED]/sendMessage failed');
    expect(cleanErrorText('header Authorization: Bearer abc.def-ghi rejected')).toBe('header Authorization: Bearer [REDACTED] rejected');
  });

  it('collapses whitespace and cuts long text to 300 characters', () => {
    expect(cleanErrorText('a\n\n  b\tc ')).toBe('a b c');
    const long = cleanErrorText('x'.repeat(1000));
    expect(long).toHaveLength(300);
    expect(long.endsWith('…')).toBe(true);
    expect(cleanErrorText(new Error('boom'))).toBe('boom');
    expect(cleanErrorText(undefined)).toBe('');
  });

  it('keeps the useful part of a realistic scraper error', () => {
    const s = cleanErrorText(RAW);
    expect(s).toContain('Login failed at https://login.example-bank.test/auth/step2');
    for (const leak of ['AbC123secretTOKEN', 'jdoe', '123456789', '4580 1111', 'jane.doe']) expect(s).not.toContain(leak);
  });
});

describe('cleanErrorText, more shapes (review L2)', () => {
  it('strips the query of a URL without a scheme, and session path parameters', () => {
    expect(cleanErrorText('redirected to bank.example.test/login?token=abc&u=1 then failed')).toBe('redirected to bank.example.test/login then failed');
    expect(cleanErrorText('GET https://h.example.test/app;jsessionid=A1B2C3D4/next')).toBe('GET https://h.example.test/app;jsessionid=[REDACTED]/next');
  });

  it('masks JWTs, long base64/hex tokens and bare Telegram tokens', () => {
    expect(cleanErrorText('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl rejected')).toBe('jwt [JWT] rejected');
    expect(cleanErrorText('key 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 bad')).toBe('key [token] bad');
    expect(cleanErrorText('sig dGhpcyBpcyBhIHRlc3QgdG9rZW4gMTIz== bad')).toBe('sig [token] bad');
    expect(cleanErrorText('token 1234567:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQ rejected')).toBe('token [REDACTED] rejected');
    // upper-case identifiers and plain words are not tokens
    expect(cleanErrorText('TWO_FACTOR_RETRIEVER_MISSING in libsodium-wrappers-sumo')).toBe('TWO_FACTOR_RETRIEVER_MISSING in libsodium-wrappers-sumo');
  });

  it('masks Amex groups and dash-joined bank accounts, and keeps dates, IPs, versions and ports', () => {
    expect(cleanErrorText('amex 3714 496353 98431 declined')).toBe('amex ****31 declined');
    expect(cleanErrorText('account 12-345-67890 missing')).toBe('account ****90 missing');
    expect(cleanErrorText('call 050-1234567')).toBe('call ****67');
    const keep = 'on 2026-11-10 and 10-11-2026 at 10:30 from 192.168.1.50:7443 with node 22.11.0, 12-34 rows';
    expect(cleanErrorText(keep)).toBe(keep);
  });

  it('is linear: 1 MB of hostile text cleans in well under 50 ms (review M1)', () => {
    const cases = ['a.'.repeat(500_000), `x@${'a-'.repeat(500_000)}`, `x://y ${'a.'.repeat(500_000)}`, `${'a'.repeat(1_000_000)}@`];
    for (const c of cases) {
      const t0 = performance.now();
      cleanErrorText(c);
      expect(performance.now() - t0).toBeLessThan(50);
    }
    // stripUrlQuery alone (the logger runs it on any string with "://") is linear too
    const t1 = performance.now();
    stripUrlQuery(`x://y ${'a.'.repeat(500_000)}`);
    stripUrlQuery(`https://h/ ${'a1+.-'.repeat(200_000)}://`);
    expect(performance.now() - t1).toBeLessThan(50);
  });
});

describe('cleanStoredErrors (review L1)', () => {
  it('cleans error text stored before cleaning existed, once, and is idempotent', () => {
    const db = openDb(':memory:');
    const runId = startRun(db, { institutionId: 'max', source: 'scraper:max', trigger: 'scheduled' });
    finishRunError(db, runId, 'GENERIC', 'x');
    // as an older version would have stored them
    db.$client.prepare('update sync_run set error = ? where id = ?').run(RAW, runId);
    db.$client.prepare(`update connection set last_error = ? where institution_id = 'max'`).run(`GENERIC: ${RAW}`);
    setSetting(db, 'backup.lastError', 'EACCES: /backups/jane.doe@example.test/123456789');
    setSetting(db, 'offsite.lastError', 'could not connect to backup-user@nas.example.test:/copies');
    setSetting(db, 'alerts.securityLastError', 'alarm bot: fetch https://api.telegram.org/bot1234567:AAbbCCddEEffGGhhIIjjKKllMM/x failed');
    expect(cleanStoredErrors(db)).toBe(5);
    const all = JSON.stringify([
      db.$client.prepare('select error from sync_run').all(),
      db.$client.prepare('select last_error from connection').all(),
      db.$client.prepare(`select value from setting where key in ('backup.lastError','offsite.lastError','alerts.securityLastError')`).all(),
    ]);
    for (const leak of ['AbC123secretTOKEN', '123456789', 'jane.doe', 'backup-user', 'AAbbCC']) expect(all).not.toContain(leak);
    expect(all).toContain('https://login.example-bank.test/auth/step2');
    // done for this version: skipped; forced or flag cleared: nothing left to change
    expect(cleanStoredErrors(db)).toBe(0);
    expect(cleanStoredErrors(db, { force: true })).toBe(0);
    setSetting(db, ERROR_CLEANUP_SETTING, null);
    expect(cleanStoredErrors(db)).toBe(0);
  });
});

describe('error kinds', () => {
  it('maps sync error types; anything unknown is other', () => {
    expect(syncErrorKind('INVALID_PASSWORD')).toBe('invalid_password');
    expect(syncErrorKind('TWO_FACTOR_RETRIEVER_MISSING')).toBe('otp');
    expect(syncErrorKind('CRASH')).toBe('crash');
    expect(syncErrorKind('LOCKED')).toBe('locked');
    expect(syncErrorKind('GENERIC')).toBe('other');
    expect(syncErrorKind('whatever the site said')).toBe('other');
    expect(syncErrorKind(null)).toBe('other');
    expect(cleanErrorType('INVALID PASSWORD <b>')).toBe('INVALIDPASSWORDb');
    expect(cleanErrorType('')).toBe('UNKNOWN');
  });

  it('classifies thrown errors by code, name and message', () => {
    expect(classifyError(Object.assign(new Error('x'), { code: 'ENOSPC' }))).toBe('disk_full');
    expect(classifyError(Object.assign(new Error('x'), { code: 'EACCES' }))).toBe('permission');
    expect(classifyError(Object.assign(new Error('All configured authentication methods failed'), { level: 'client-authentication' }))).toBe('auth');
    expect(classifyError(Object.assign(new Error('changed'), { name: 'HostKeyChangedError' }))).toBe('host_key');
    expect(classifyError(new Error('Timed out while waiting for handshake'))).toBe('timeout');
    expect(classifyError(new Error('getaddrinfo ENOTFOUND nas.example.test'))).toBe('network');
    expect(classifyError('something odd')).toBe('other');
    expect(errorPhrase('nonsense', 'en')).toBe(errorPhrase('other', 'en'));
    expect(errorSummary(new Error('no space left on device'))).toBe('the disk is full (disk_full)');
  });
});

describe('a failing sync (P2-09)', () => {
  it('stores cleaned text, and its Telegram alert carries only the institution, the kind and a fixed phrase', () => {
    const db = openDb(':memory:');
    const runId = startRun(db, { institutionId: 'max', source: 'scraper:max', trigger: 'scheduled' });
    finishRunError(db, runId, 'INVALID_PASSWORD', RAW);

    const run = db.$client.prepare('select error_type, error from sync_run where id = ?').get(runId) as { error_type: string; error: string };
    const conn = db.$client.prepare(`select last_error from connection where institution_id = 'max'`).get() as { last_error: string };
    for (const stored of [run.error, conn.last_error]) {
      expect(stored).toContain('https://login.example-bank.test/auth/step2');
      for (const leak of ['AbC123secretTOKEN', 'session=', '123456789', '4580 1111 2222', 'jane.doe@example.test']) expect(stored).not.toContain(leak);
      expect(stored.length).toBeLessThanOrEqual(320);
    }
    expect(run.error_type).toBe('INVALID_PASSWORD');

    const insight = hubOverview(db).attention.find((i) => i.kind === 'sync_error');
    expect(insight?.name).toBe('invalid_password');

    for (const lang of ['en', 'he'] as const) {
      const text = collectAlerts(db, { lang }).find((a) => a.type === 'sync_error')?.text ?? '';
      expect(text).toContain('max');
      expect(text).toContain(`${errorPhrase('invalid_password', lang)} (invalid_password)`);
      for (const leak of ['Login failed', 'example-bank', 'account', '*', '@']) expect(text).not.toContain(leak);
    }
  });

  it('an error type the scraper made up reads as other', () => {
    const db = openDb(':memory:');
    const runId = startRun(db, { institutionId: 'max', source: 'scraper:max', trigger: 'scheduled' });
    finishRunError(db, runId, 'SOMETHING_NEW', 'page said: call 0501234567');
    const text = collectAlerts(db, { lang: 'en' }).find((a) => a.type === 'sync_error')?.text ?? '';
    expect(text).toContain('unexpected error; details in the log at home (other)');
    expect(text).not.toContain('page said');
  });
});
