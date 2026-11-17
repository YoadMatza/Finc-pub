import { describe, expect, it } from 'vitest';
import { EXAMPLE_APP, FINC_FOLDER, lastUsedLabel, mcpCommands, sortTokens, tokenPath } from './mcpSettings';
import type { McpToken } from './types';

const tok = (name: string, createdAt: string, lastUsedAt: string | null, callsToday = 0): McpToken => ({ name, createdAt, lastUsedAt, callsToday });

describe('mcpCommands', () => {
  it('builds the PC commands for the example app, with the folder as a literal placeholder', () => {
    const c = mcpCommands();
    expect(EXAMPLE_APP).toBe('claude-desktop');
    expect(c.create).toBe('.\\finc mcp token create claude-desktop');
    expect(c.claudeCode).toBe('claude mcp add finc -- <finc folder>\\finc.cmd mcp --token claude-desktop');
    expect(c.claudeCode).toContain(FINC_FOLDER);
  });
  it('uses the given app name', () => {
    expect(mcpCommands('cursor').create).toBe('.\\finc mcp token create cursor');
    expect(mcpCommands('cursor').claudeCode.endsWith('--token cursor')).toBe(true);
  });
  it('never guesses a real path', () => {
    expect(mcpCommands().claudeCode).not.toMatch(/[A-Z]:\\/);
  });
});

describe('tokenPath', () => {
  it('URL-encodes the name', () => {
    expect(tokenPath('claude-desktop')).toBe('/api/mcp/tokens/claude-desktop');
    expect(tokenPath('a b/c?d')).toBe('/api/mcp/tokens/a%20b%2Fc%3Fd');
    expect(tokenPath('קלוד')).toBe(`/api/mcp/tokens/${encodeURIComponent('קלוד')}`);
  });
});

describe('lastUsedLabel', () => {
  it('null is never', () => {
    expect(lastUsedLabel(null)).toEqual({ kind: 'never' });
  });
  it('an unparsable stamp is never', () => {
    expect(lastUsedLabel('')).toEqual({ kind: 'never' });
    expect(lastUsedLabel('not a date')).toEqual({ kind: 'never' });
  });
  it('a real stamp is relative', () => {
    expect(lastUsedLabel('2026-11-17T08:00:00.000Z')).toEqual({ kind: 'rel', iso: '2026-11-17T08:00:00.000Z' });
  });
});

describe('sortTokens', () => {
  it('most recently used first, never-used last', () => {
    const list = [tok('never', '2026-11-10T00:00:00Z', null), tok('old', '2026-11-01T00:00:00Z', '2026-11-12T00:00:00Z'), tok('new', '2026-11-02T00:00:00Z', '2026-11-16T00:00:00Z')];
    expect(sortTokens(list).map((x) => x.name)).toEqual(['new', 'old', 'never']);
  });
  it('never-used: newest created first, then by name', () => {
    const list = [tok('b', '2026-11-01T00:00:00Z', null), tok('a', '2026-11-01T00:00:00Z', null), tok('c', '2026-11-05T00:00:00Z', null)];
    expect(sortTokens(list).map((x) => x.name)).toEqual(['c', 'a', 'b']);
  });
  it('a bad lastUsedAt sorts as never; the input is not changed', () => {
    const list = [tok('bad', '2026-11-01T00:00:00Z', 'nope'), tok('used', '2026-11-01T00:00:00Z', '2026-11-03T00:00:00Z')];
    const copy = [...list];
    expect(sortTokens(list).map((x) => x.name)).toEqual(['used', 'bad']);
    expect(list).toEqual(copy);
  });
  it('empty stays empty', () => {
    expect(sortTokens([])).toEqual([]);
  });
});
