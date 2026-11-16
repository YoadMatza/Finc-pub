import { ApiError } from './api';

/**
 * Revoke this device's session on the hub before forgetting it here (security research P3-02). A dropped connection
 * or a hub error is retried; if the hub still cannot be reached the caller keeps the session and says so, rather than
 * deleting the token locally while it stays valid on the server. A 401 means the hub no longer knows the session:
 * that is a sign-out too.
 */
export async function revokeSession(post: () => Promise<unknown>, opts: { tries?: number; waitMs?: number; wait?: (ms: number) => Promise<void> } = {}): Promise<'revoked' | 'failed'> {
  const tries = opts.tries ?? 3;
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; i < tries; i++) {
    try {
      await post();
      return 'revoked';
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return 'revoked';
      // another 4xx will not change on a retry
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) return 'failed';
      if (i < tries - 1) await wait((opts.waitMs ?? 1000) * (i + 1));
    }
  }
  return 'failed';
}
