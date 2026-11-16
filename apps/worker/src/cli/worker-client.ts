/** Talk to a running worker's control endpoints, if there is one. Authenticates with data/control.token. */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readControlToken } from '../api/auth.js';

export const workerUrl = (): string => `http://127.0.0.1:${process.env.FINC_PORT ?? '7733'}`;

/** Thrown when whatever answers on the control port cannot prove it is this finc's worker. */
export class NotTheWorkerError extends Error {}

/** The worker's expected answer to a challenge (the same HMAC as controlProof in api/app.ts). */
export function expectedProof(token: string, challenge: string): string {
  return createHmac('sha256', token).update(`finc-control:${challenge}`).digest('hex');
}

let verified: { url: string; token: string } | null = null;

/**
 * Before the control token (or the master password) leaves this process, the listener on 7733 must prove it holds the
 * same token (security research P3-01): an HMAC of a fresh random challenge. Checked once per process and URL.
 */
export async function verifyWorker(token: string, timeoutMs = 3000, fetchImpl: typeof fetch = fetch): Promise<void> {
  const url = workerUrl();
  if (verified && verified.url === url && verified.token === token) return;
  const challenge = randomBytes(32).toString('hex');
  const res = await fetchImpl(`${url}/whoami?challenge=${challenge}`, { signal: AbortSignal.timeout(timeoutMs) });
  const body = (await res.json().catch(() => ({}))) as { proof?: unknown };
  const want = Buffer.from(expectedProof(token, challenge), 'hex');
  const got = typeof body.proof === 'string' && /^[0-9a-f]{64}$/.test(body.proof) ? Buffer.from(body.proof, 'hex') : Buffer.alloc(0);
  if (got.length !== want.length || !timingSafeEqual(got, want)) {
    throw new NotTheWorkerError(
      res.status === 404
        ? 'the program on the control port does not answer the worker challenge (an older worker? rebuild it: docker compose up -d --build worker); the control token was not sent'
        : 'the program on the control port could not prove it is this finc worker (another program on port 7733, or another data folder); the control token was not sent',
    );
  }
  verified = { url, token };
}

/** For tests: forget the verified worker. */
export function resetWorkerVerification(): void {
  verified = null;
}

async function headers(timeoutMs?: number): Promise<Record<string, string>> {
  const token = readControlToken();
  if (!token) return { 'content-type': 'application/json' };
  await verifyWorker(token, Math.min(timeoutMs ?? 3000, 5000));
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` };
}

export async function workerHealth(timeoutMs = 1500): Promise<unknown | null> {
  try {
    const res = await fetch(`${workerUrl()}/health`, { headers: await headers(timeoutMs), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    if (e instanceof NotTheWorkerError) throw e;
    return null;
  }
}

/**
 * Is anything answering on the control port? Any HTTP response counts (401 and 500 included); only a refused
 * connection or a timeout means no. No clock involved, unlike the owner file's heartbeat (P1-13: WSL2's clock can lag).
 * Sends no token.
 */
export async function workerUp(timeoutMs = 3000): Promise<boolean> {
  try {
    const res = await fetch(`${workerUrl()}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

export async function workerPost<T>(path: string, body: unknown, timeoutMs = 30 * 60_000): Promise<{ status: number; body: T }> {
  return workerRequest<T>('POST', path, body, timeoutMs);
}

export async function workerRequest<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body: unknown, timeoutMs = 30 * 60_000): Promise<{ status: number; body: T }> {
  const res = await fetch(`${workerUrl()}${path}`, {
    method,
    headers: await headers(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}
