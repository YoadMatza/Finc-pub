import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { revokeSession } from './logout';

const noWait = { wait: async () => undefined };

describe('sign-out revokes on the hub first (security research P3-02)', () => {
  it('revoked when the hub answers', async () => {
    expect(await revokeSession(async () => ({}), noWait)).toBe('revoked');
  });

  it('retries a dropped connection and succeeds', async () => {
    let n = 0;
    const post = async () => {
      if (++n < 3) throw new TypeError('Failed to fetch');
      return {};
    };
    expect(await revokeSession(post, noWait)).toBe('revoked');
    expect(n).toBe(3);
  });

  it('fails, so the session is kept, when the hub stays unreachable', async () => {
    let n = 0;
    expect(await revokeSession(async () => { n++; throw new TypeError('Failed to fetch'); }, noWait)).toBe('failed');
    expect(n).toBe(3);
  });

  it('a 401 means the hub already forgot the session', async () => {
    expect(await revokeSession(async () => { throw new ApiError('unauthorized', 401); }, noWait)).toBe('revoked');
  });

  it('does not retry a refusal that will not change', async () => {
    let n = 0;
    expect(await revokeSession(async () => { n++; throw new ApiError('forbidden', 403); }, noWait)).toBe('failed');
    expect(n).toBe(1);
  });
});
