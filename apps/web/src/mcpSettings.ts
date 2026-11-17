/**
 * Settings → AI → AI apps (MCP): the pure parts (proposal mcp-server.md §5.4, §6). The token itself never reaches the
 * hub; tokens are created on the PC only (`finc mcp token create <app-name>`), the hub lists and revokes them.
 */
import type { McpToken } from './types';

/** The placeholder shown for the finc folder: the hub does not know (and must not guess) where finc lives on the PC. */
export const FINC_FOLDER = '<finc folder>';
/** The example app name used in the setup steps. */
export const EXAMPLE_APP = 'claude-desktop';

/** The two setup commands, run on the PC (PowerShell in the finc folder, then the AI app's own CLI). */
export function mcpCommands(app: string = EXAMPLE_APP): { create: string; claudeCode: string } {
  return {
    create: `.\\finc mcp token create ${app}`,
    claudeCode: `claude mcp add finc -- ${FINC_FOLDER}\\finc.cmd mcp --token ${app}`,
  };
}

/** DELETE path for one token; the name is URL-encoded (names come from the PC, not from the hub). */
export function tokenPath(name: string): string {
  return `/api/mcp/tokens/${encodeURIComponent(name)}`;
}

/** What the "last used" cell shows: `never`, or a relative time from this ISO stamp. A stamp that does not parse counts as never. */
export function lastUsedLabel(lastUsedAt: string | null): { kind: 'never' } | { kind: 'rel'; iso: string } {
  if (!lastUsedAt || Number.isNaN(Date.parse(lastUsedAt))) return { kind: 'never' };
  return { kind: 'rel', iso: lastUsedAt };
}

/** Most recently used first; never-used tokens after them, newest created first; then by name (stable for equal stamps). */
export function sortTokens(tokens: readonly McpToken[]): McpToken[] {
  const ts = (iso: string | null) => {
    const n = iso ? Date.parse(iso) : NaN;
    return Number.isNaN(n) ? null : n;
  };
  return [...tokens].sort((a, b) => {
    const ua = ts(a.lastUsedAt);
    const ub = ts(b.lastUsedAt);
    if (ua !== null && ub === null) return -1;
    if (ua === null && ub !== null) return 1;
    if (ua !== null && ub !== null && ua !== ub) return ub - ua;
    const ca = ts(a.createdAt) ?? 0;
    const cb = ts(b.createdAt) ?? 0;
    if (ca !== cb) return cb - ca;
    return a.name.localeCompare(b.name);
  });
}
