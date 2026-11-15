import { type DbOwner, OWNER_STALE_MS } from '@finc/core';
import { describe, expect, it, vi } from 'vitest';
import { guardHostRun, otherWorkerAnswers } from './guard.js';

const owner: DbOwner = { host: 'container-abc', pid: 1, role: 'worker', startedAt: '2026-11-10T10:00:00.000Z', heartbeatAt: '2026-11-10T10:00:00.000Z' };

describe('the host-run guard (security research P1-13)', () => {
  it('no owner file: allowed, and no HTTP call', async () => {
    const up = vi.fn(async () => true);
    expect(await guardHostRun(null, 'my-pc', 0, up)).toEqual({ allow: true });
    expect(up).not.toHaveBeenCalled();
  });

  it('an owner on this host (a launcher run inside the container): allowed without asking', async () => {
    const up = vi.fn(async () => true);
    expect(await guardHostRun(owner, 'container-abc', 1000, up)).toEqual({ allow: true });
    expect(up).not.toHaveBeenCalled();
  });

  it('a fresh owner from another host is refused with the DbOwnedError message', async () => {
    const up = vi.fn(async () => false);
    const v = await guardHostRun(owner, 'my-pc', 5_000, up);
    expect(v.allow).toBe(false);
    if (v.allow) return;
    expect(v.message).toContain('the finc worker on container-abc owns the database');
    expect(up).not.toHaveBeenCalled();
  });

  it('a stale-looking owner whose worker still answers is refused (a lagging WSL2 clock)', async () => {
    const v = await guardHostRun(owner, 'my-pc', OWNER_STALE_MS + 300_000, async () => true);
    expect(v.allow).toBe(false);
  });

  it('a stale owner with nothing answering is allowed (a worker that died without releasing)', async () => {
    expect(await guardHostRun(owner, 'my-pc', OWNER_STALE_MS + 1, async () => false)).toEqual({ allow: true });
  });
});

describe("the worker's start-up probe (P1-13)", () => {
  it('no owner file, or one from this host: no probe, start', async () => {
    const up = vi.fn(async () => true);
    expect(await otherWorkerAnswers(null, 'c1', up)).toBe(false);
    expect(await otherWorkerAnswers(owner, 'container-abc', up)).toBe(false);
    expect(up).not.toHaveBeenCalled();
  });
  it('an owner from another host: refuse to start only when its control port answers', async () => {
    expect(await otherWorkerAnswers(owner, 'new-container', async () => true)).toBe(true);
    expect(await otherWorkerAnswers(owner, 'new-container', async () => false)).toBe(false);
  });
});
