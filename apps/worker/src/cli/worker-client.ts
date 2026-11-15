/** Talk to a running worker's control endpoints, if there is one. Authenticates with data/control.token. */
import { readControlToken } from '../api/auth.js';

export const workerUrl = (): string => `http://127.0.0.1:${process.env.FINC_PORT ?? '7733'}`;

function headers(): Record<string, string> {
  const token = readControlToken();
  return { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

export async function workerHealth(timeoutMs = 1500): Promise<unknown | null> {
  try {
    const res = await fetch(`${workerUrl()}/health`, { headers: headers(), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Is anything answering on the control port? Any HTTP response counts (401 and 500 included); only a refused
 * connection or a timeout means no. No clock involved, unlike the owner file's heartbeat (P1-13: WSL2's clock can lag).
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
    headers: headers(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}
