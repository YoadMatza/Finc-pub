import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { LOG_OPTIONS } from './logger.js';

// every value below is invented for the test
function capture(): { logger: pino.Logger; lines: () => Array<Record<string, unknown>> } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk.toString('utf8'));
      cb();
    },
  });
  const logger = pino({ ...LOG_OPTIONS, level: 'debug' }, stream);
  return {
    logger,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

describe('worker logger (P2-09)', () => {
  it('still prints normal fields and the message', () => {
    const { logger, lines } = capture();
    logger.info({ institution: 'max', rows: 12, ms: 340, sent: ['sync_error'] }, 'sync: done');
    expect(lines()[0]).toMatchObject({ level: 30, institution: 'max', rows: 12, ms: 340, sent: ['sync_error'], msg: 'sync: done' });
    expect(typeof lines()[0]!.time).toBe('string');
  });

  it('censors secrets at any depth, whatever the key spelling', () => {
    const { logger, lines } = capture();
    logger.warn({ req: { headers: { 'X-Api-Key': 'k-1', authorization: 'Bearer abc' } }, a: { b: { c: { d: { access_token: 't-1', ok: true } } } }, pairing: { code: 'q7Xz-P2mK9aB_c4d' }, err: { code: 'ENOENT' } }, 'x');
    const l = lines()[0]!;
    expect(l).toMatchObject({ req: { headers: { 'X-Api-Key': '[REDACTED]', authorization: '[REDACTED]' } }, a: { b: { c: { d: { access_token: '[REDACTED]', ok: true } } } }, pairing: { code: '[REDACTED]' }, err: { code: 'ENOENT' } });
    expect(JSON.stringify(l)).not.toMatch(/k-1|t-1|q7Xz/);
  });

  it('serialises an Error with its type and stack, cleaned, and its secret props censored', () => {
    const { logger, lines } = capture();
    class FetchError extends Error {
      token = 'tok-1';
      code = 'ECONNRESET';
    }
    logger.error({ err: new FetchError('GET https://bank.example.test/api?session=abc failed for jane@example.test') }, 'scrape: crashed');
    const err = lines()[0]!.err as Record<string, unknown>;
    expect(err.type).toBe('FetchError');
    expect(err.message).toBe('GET https://bank.example.test/api failed for [email]');
    expect(String(err.stack)).toContain('logger.test');
    expect(String(err.stack)).not.toContain('session=abc');
    expect(err.token).toBe('[REDACTED]');
    expect(err.code).toBe('ECONNRESET');
    // a bare error: the message pino derives from it is cleaned too
    logger.error(new Error('account 123456789 blocked'));
    expect(lines()[1]!.msg).toBe('account *******89 blocked');
    // { err } without a message string: same (review L4)
    logger.error({ err: new Error('mail jane@example.test failed for 123456789') });
    expect(lines()[2]!.msg).toBe('mail [email] failed for *******89');
    expect(JSON.stringify(lines()[2])).not.toMatch(/jane|123456789/);
  });

  it('strips query strings from URLs in the message', () => {
    const { logger, lines } = capture();
    logger.info('fetching https://h.example.test/p?token=abc#x now');
    logger.info({ n: 1 }, 'calling %s', 'https://h.example.test/q?key=1');
    expect(lines()[0]!.msg).toBe('fetching https://h.example.test/p now');
    expect(lines()[1]!.msg).toBe('calling https://h.example.test/q');
  });
});
