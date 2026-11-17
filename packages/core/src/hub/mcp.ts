/**
 * MCP tokens (research_notes/proposals/mcp-server.md §5.4): one per AI app, made on the PC only, stored as a SHA-256,
 * revocable, counted per local day. A token reads finc's privacy-checked tools and nothing else.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/db.js';
import { getSetting, setSetting } from '../ai/settings.js';
import { todayLocal } from './overview.js';

export const MCP_TOKEN_PREFIX = 'finc_mcp_';
/** 'on' when the owner turned MCP on in Settings; anything else is off (the default) */
export const MCP_SETTING = 'mcp.enabled';
/** Limits per token (design §5.4). */
export const MCP_PER_MINUTE = 30;
export const MCP_PER_DAY = 1000;
/** An app name: lower-case letters, digits and dashes, also the token file's name. */
export const MCP_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const mcpEnabled = (db: Db): boolean => getSetting(db, MCP_SETTING) === 'on';
export const setMcpEnabled = (db: Db, on: boolean): void => setSetting(db, MCP_SETTING, on ? 'on' : null);

export function isMcpToken(token: string | undefined): token is string {
  return typeof token === 'string' && token.startsWith(MCP_TOKEN_PREFIX) && token.length === MCP_TOKEN_PREFIX.length + 43 && /^[A-Za-z0-9_-]+$/.test(token.slice(MCP_TOKEN_PREFIX.length));
}

const hash = (token: string): string => createHash('sha256').update(token).digest('hex');

export interface McpTokenView {
  id: number;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  callsToday: number;
}

type Row = { id: number; name: string; created_at: string; last_used_at: string | null; calls_day: string | null; calls_today: number };
const view = (r: Row, today: string): McpTokenView => ({ id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at, callsToday: r.calls_day === today ? r.calls_today : 0 });

/** A new token for an app. The name must be free among active tokens. Returns the token once; only its hash is kept. */
export function createMcpToken(db: Db, name: string, now: Date = new Date()): { id: number; name: string; token: string } {
  if (!MCP_NAME.test(name)) throw new Error('the name takes lower-case letters, digits and dashes (at most 40), e.g. claude-desktop');
  const taken = db.$client.prepare('select 1 from mcp_token where name = ? and revoked_at is null').get(name);
  if (taken) throw new Error(`there is already an active token named "${name}"; revoke it first`);
  const token = MCP_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const r = db.$client.prepare('insert into mcp_token (name, token_hash, created_at) values (?, ?, ?)').run(name, hash(token), now.toISOString());
  return { id: Number(r.lastInsertRowid), name, token };
}

/** The active tokens, most recently used first. */
export function listMcpTokens(db: Db, now: Date = new Date()): McpTokenView[] {
  const today = todayLocal(now);
  const rows = db.$client.prepare('select id, name, created_at, last_used_at, calls_day, calls_today from mcp_token where revoked_at is null order by coalesce(last_used_at, created_at) desc, id desc').all() as Row[];
  return rows.map((r) => view(r, today));
}

/** Revokes the active token with this name; false when there is none. */
export function revokeMcpToken(db: Db, name: string, now: Date = new Date()): boolean {
  return db.$client.prepare('update mcp_token set revoked_at = ? where name = ? and revoked_at is null').run(now.toISOString(), name).changes > 0;
}

/** Revokes every active token (the panic button); returns how many. */
export function revokeAllMcpTokens(db: Db, now: Date = new Date()): number {
  return db.$client.prepare('update mcp_token set revoked_at = ? where revoked_at is null').run(now.toISOString()).changes;
}

export type McpAuth = { ok: true; token: McpTokenView } | { ok: false; reason: 'malformed' | 'unknown' | 'revoked' | 'daily_limit' };

/**
 * Checks a token and, when it is good, counts one call for today (the daily limit is checked before counting).
 * The lookup is by hash; the stored hash is compared in constant time.
 */
export function useMcpToken(db: Db, token: string | undefined, now: Date = new Date()): McpAuth {
  if (!isMcpToken(token)) return { ok: false, reason: 'malformed' };
  const h = hash(token);
  const r = db.$client.prepare('select id, name, token_hash, created_at, last_used_at, revoked_at, calls_day, calls_today from mcp_token where token_hash = ?').get(h) as (Row & { token_hash: string; revoked_at: string | null }) | undefined;
  if (!r || !timingSafeEqual(Buffer.from(r.token_hash, 'hex'), Buffer.from(h, 'hex'))) return { ok: false, reason: 'unknown' };
  if (r.revoked_at !== null) return { ok: false, reason: 'revoked' };
  const today = todayLocal(now);
  const calls = r.calls_day === today ? r.calls_today : 0;
  if (calls >= MCP_PER_DAY) return { ok: false, reason: 'daily_limit' };
  const at = now.toISOString();
  db.$client.prepare('update mcp_token set last_used_at = ?, calls_day = ?, calls_today = ? where id = ?').run(at, today, calls + 1, r.id);
  return { ok: true, token: view({ ...r, last_used_at: at, calls_day: today, calls_today: calls + 1 }, today) };
}

/** What an MCP token's status is, without counting a call (for the security log). */
export function mcpTokenStatus(db: Db, token: string): 'ok' | 'revoked' | 'unknown' {
  if (!isMcpToken(token)) return 'unknown';
  const r = db.$client.prepare('select revoked_at from mcp_token where token_hash = ?').get(hash(token)) as { revoked_at: string | null } | undefined;
  return !r ? 'unknown' : r.revoked_at === null ? 'ok' : 'revoked';
}
