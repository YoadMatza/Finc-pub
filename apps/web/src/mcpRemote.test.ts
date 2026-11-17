import { describe, expect, it } from 'vitest';
import { formatCountdown, grantPath, remoteRefetchMs, sortGrants, windowLeftMs } from './mcpRemote';
import type { McpRemoteGrant } from './types';

const NOW = Date.parse('2026-11-17T10:00:00Z');
const grant = (id: number, createdAt: string, lastUsedAt: string | null): McpRemoteGrant => ({
  id,
  app: id % 2 ? 'ChatGPT' : 'Claude',
  createdAt,
  lastUsedAt,
  callsToday: 0,
  expiresAt: '2026-12-17T10:00:00Z',
});

describe('windowLeftMs', () => {
  it('counts down to the window end', () => {
    expect(windowLeftMs('2026-11-17T10:09:41Z', NOW)).toBe(581_000);
  });
  it('is 0 with no window, a past window, or a bad stamp', () => {
    expect(windowLeftMs(null, NOW)).toBe(0);
    expect(windowLeftMs(undefined, NOW)).toBe(0);
    expect(windowLeftMs('2026-11-17T09:59:59Z', NOW)).toBe(0);
    expect(windowLeftMs('soon', NOW)).toBe(0);
  });
});

describe('formatCountdown', () => {
  it('shows m:ss', () => {
    expect(formatCountdown(581_000)).toBe('9:41');
    expect(formatCountdown(600_000)).toBe('10:00');
    expect(formatCountdown(5_000)).toBe('0:05');
  });
  it('rounds a partial second up and never goes negative', () => {
    expect(formatCountdown(400)).toBe('0:01');
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(-3000)).toBe('0:00');
  });
  it('shows hours past an hour', () => {
    expect(formatCountdown(3_723_000)).toBe('1:02:03');
  });
});

describe('remoteRefetchMs', () => {
  it('is 15 s while a window is open, else 30 s', () => {
    expect(remoteRefetchMs('2026-11-17T10:05:00Z', NOW)).toBe(15_000);
    expect(remoteRefetchMs('2026-11-17T09:00:00Z', NOW)).toBe(30_000);
    expect(remoteRefetchMs(null, NOW)).toBe(30_000);
  });
});

describe('grantPath', () => {
  it('builds the DELETE path', () => {
    expect(grantPath(7)).toBe('/api/mcp/remote/grants/7');
  });
});

describe('sortGrants', () => {
  it('puts recent use first, then never-used by newest connection, then id', () => {
    const gs = [
      grant(1, '2026-11-01T00:00:00Z', null),
      grant(2, '2026-11-02T00:00:00Z', '2026-11-10T00:00:00Z'),
      grant(3, '2026-11-03T00:00:00Z', null),
      grant(4, '2026-11-01T00:00:00Z', '2026-11-16T00:00:00Z'),
      grant(5, '2026-11-01T00:00:00Z', null),
    ];
    expect(sortGrants(gs).map((g) => g.id)).toEqual([4, 2, 3, 1, 5]);
  });
  it('treats a bad last-used stamp as never and leaves the input alone', () => {
    const gs = [grant(1, '2026-11-01T00:00:00Z', 'x'), grant(2, '2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z')];
    expect(sortGrants(gs).map((g) => g.id)).toEqual([2, 1]);
    expect(gs.map((g) => g.id)).toEqual([1, 2]);
  });
});
