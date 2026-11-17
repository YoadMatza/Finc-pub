/**
 * Settings → AI → Remote AI apps: the pure parts (remote-mcp.md §4.1, §4.4). The hub never sees a token: it shows
 * the connector address, opens the 10-minute "Connect an app" window, and lists and revokes grants.
 */
import type { McpRemoteGrant } from './types';

const parse = (iso: string | null | undefined): number | null => {
  const n = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(n) ? null : n;
};

/** Milliseconds left in the window; 0 when there is none, it is over, or the stamp does not parse. */
export function windowLeftMs(windowUntil: string | null | undefined, now: number): number {
  const until = parse(windowUntil);
  return until === null ? 0 : Math.max(0, until - now);
}

/** "9:41" (m:ss), or "1:02:03" past an hour; rounds up so the last second shows 0:01, not 0:00. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** How often to refetch GET /api/mcp/remote: every 15 s while a window is open (an approval may land), else 30 s. */
export function remoteRefetchMs(windowUntil: string | null | undefined, now: number): number {
  return windowLeftMs(windowUntil, now) > 0 ? 15_000 : 30_000;
}

/** DELETE path for one grant. */
export function grantPath(id: number): string {
  return `/api/mcp/remote/grants/${encodeURIComponent(String(id))}`;
}

/** Most recently used first; never-used grants after them, newest connected first; then by id (stable). */
export function sortGrants(grants: readonly McpRemoteGrant[]): McpRemoteGrant[] {
  return [...grants].sort((a, b) => {
    const ua = parse(a.lastUsedAt);
    const ub = parse(b.lastUsedAt);
    if (ua !== null && ub === null) return -1;
    if (ua === null && ub !== null) return 1;
    if (ua !== null && ub !== null && ua !== ub) return ub - ua;
    const ca = parse(a.createdAt) ?? 0;
    const cb = parse(b.createdAt) ?? 0;
    if (ca !== cb) return cb - ca;
    return a.id - b.id;
  });
}
