import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { workerUp } from './worker-client.js';

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
