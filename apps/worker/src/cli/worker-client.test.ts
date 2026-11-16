import { openDb } from '@finc/core';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkerState } from '../server.js';
import { createApp } from '../api/app.js';
import { NotTheWorkerError, expectedProof, resetWorkerVerification, verifyWorker, workerUp } from './worker-client.js';

// security research P3-01: the CLI sends the control token and the master password only to a worker that proves it
// holds the same token

const TOKEN = 'a'.repeat(64);

function realWorker(token = TOKEN): typeof fetch {
  const vault = { locked: true, lock() {}, get: () => undefined, has: () => false, list: () => [] };
  const scheduler = { config: { times: [], jitterMinutes: 0, timezone: 'UTC', monthsBack: 3 }, isRunning: false, nextRun: () => null, syncNow: async () => [] };
  const state: WorkerState = { db: openDb(':memory:'), vault: vault as never, scheduler: scheduler as never, startedAt: Date.now() };
  const { app } = createApp(state, { controlToken: token, webDist: '/nonexistent' });
  return (async (url: string | URL | Request) => {
    const u = new URL(String(url));
    return app.request(`${u.pathname}${u.search}`);
  }) as typeof fetch;
}

afterEach(() => resetWorkerVerification());

const saved = process.env.FINC_PORT;
afterEach(() => {
  if (saved === undefined) delete process.env.FINC_PORT;
  else process.env.FINC_PORT = saved;
});

describe('workerUp: any answer counts, no clock involved (P1-13)', () => {
  it('true on a 401', async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 401;
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    process.env.FINC_PORT = String((server.address() as AddressInfo).port);
    try {
      expect(await workerUp()).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('false on a refused connection', async () => {
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    process.env.FINC_PORT = String(port);
    expect(await workerUp()).toBe(false);
  });
});

describe('worker challenge', () => {
  it('the real worker passes', async () => {
    await expect(verifyWorker(TOKEN, 3000, realWorker())).resolves.toBeUndefined();
  });

  it('a worker with another token (another data folder) fails', async () => {
    await expect(verifyWorker(TOKEN, 3000, realWorker('b'.repeat(64)))).rejects.toBeInstanceOf(NotTheWorkerError);
  });

  it('an impostor that answers anything fails, and gets no token', async () => {
    const seen: string[] = [];
    const impostor = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(JSON.stringify({ url: String(url), headers: init?.headers ?? null }));
      return new Response(JSON.stringify({ proof: 'f'.repeat(64), ok: true }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    await expect(verifyWorker(TOKEN, 3000, impostor)).rejects.toThrow(/could not prove/);
    expect(seen.join('')).not.toContain(TOKEN);
  });

  it('an older worker without the challenge gets a clear message', async () => {
    const old = (async () => new Response('{}', { status: 404 })) as typeof fetch;
    await expect(verifyWorker(TOKEN, 3000, old)).rejects.toThrow(/older worker/);
  });

  it('each challenge has its own answer', async () => {
    expect(expectedProof(TOKEN, '00'.repeat(16))).not.toBe(expectedProof(TOKEN, '11'.repeat(16)));
    const res = await realWorker()('http://127.0.0.1:7733/whoami?challenge=xyz');
    expect(res.status).toBe(400);
  });
});
