import { ensureAccount, ingestBatch, openDb, runEngine, type NormalizedRow } from '@finc/core';
import { describe, expect, it } from 'vitest';
import type { WorkerState } from '../server.js';
import { createApp } from './app.js';

// MCP (research_notes/proposals/mcp-server.md): the bridge's /mcp routes, the tokens, the switch and the limits.
// Made-up rows only.

const TOKEN = 'm'.repeat(64);
const CONTROL = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const T0 = Date.parse('2026-11-17T08:00:00Z');
const row = (date: string, amount: number, description: string, memo?: string): NormalizedRow => ({ externalAccountId: 'x', date, amount, description, ...(memo ? { memo } : {}), status: 'completed', type: 'normal', identifier: `${description}${date}${amount}`, payload: {} });

function setup() {
  const db = openDb(':memory:');
  const card = ensureAccount(db, { institutionId: 'max', institutionKind: 'card', institutionDisplayName: 'Max ****4580', source: 'scraper:max', externalId: 'MX-77001234', type: 'credit_card', last4: '4580' }).accountId;
  ingestBatch(db, { source: 'scraper:max', runId: null, accountId: card, rows: [row('2026-11-02', -5_000, 'WOLT'), row('2026-11-03', -8_800, 'PIZZA 052-7654321', 'card 4580'), row('2026-10-02', -4_400, 'WOLT')] });
  runEngine(db);
  let t = T0;
  const state = { db, vault: null, scheduler: { config: { times: [], jitterMinutes: 0, timezone: 'UTC', monthsBack: 3 }, isRunning: false, nextRun: () => null }, startedAt: T0 } as unknown as WorkerState;
  const { app } = createApp(state, { controlToken: TOKEN, webDist: '/nonexistent', now: () => t });
  const req = async (path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) => {
    const res = await app.request(path, { method: init.method ?? 'GET', headers: { 'content-type': 'application/json', ...(init.headers ?? {}) }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
  };
  const make = async (name = 'claude-code') => (await req('/api/mcp/tokens', { method: 'POST', headers: CONTROL, body: { name } })).body.token as string;
  const turn = (on: boolean, headers: Record<string, string> = CONTROL) => req('/api/settings', { method: 'PATCH', headers, body: { ai: { mcp: on } } });
  const bearer = (tok: string) => ({ authorization: `Bearer ${tok}` });
  return { db, req, make, turn, bearer, tick: (ms: number) => (t += ms) };
}

describe('MCP routes', () => {
  it('off by default: a token works only once MCP is turned on, and off stops it at once', async () => {
    const env = setup();
    expect((await env.req('/api/settings', { headers: CONTROL })).body.ai.mcp).toBe(false);
    const tok = await env.make();
    expect(tok).toMatch(/^finc_mcp_/);
    expect((await env.req('/mcp/tools', { headers: env.bearer(tok) })).status).toBe(403);
    expect((await env.turn(true)).status).toBe(200);
    const list = await env.req('/mcp/tools', { headers: env.bearer(tok) });
    expect(list.status).toBe(200);
    expect(list.body.tools.map((t: { name: string }) => t.name)).toEqual(['spend_summary', 'month_summary', 'compare_periods', 'spend_by_category', 'top_merchants', 'find_transactions', 'recurring', 'trends', 'events', 'net_worth']);
    expect(list.body.tools.every((t: { annotations: { readOnlyHint: boolean } }) => t.annotations.readOnlyHint)).toBe(true);
    await env.turn(false);
    expect((await env.req('/mcp/call', { method: 'POST', headers: env.bearer(tok), body: { name: 'net_worth' } })).status).toBe(403);
  });

  it('turning it on is for home only; from the public site it is refused', async () => {
    const env = setup();
    expect((await env.turn(true, { ...CONTROL, 'x-finc-edge': 'public', 'x-forwarded-for': '203.0.113.7' })).status).toBe(403);
    expect((await env.req('/api/settings', { headers: CONTROL })).body.ai.mcp).toBe(false);
  });

  it('only an MCP token opens /mcp, never through the public site; tokens are made with the control token only', async () => {
    const env = setup();
    await env.turn(true);
    const tok = await env.make();
    expect((await env.req('/mcp/tools')).status).toBe(401);
    expect((await env.req('/mcp/tools', { headers: CONTROL })).status).toBe(401);
    expect((await env.req('/mcp/tools', { headers: env.bearer(`finc_mcp_${'A'.repeat(43)}`) })).status).toBe(401);
    expect((await env.req('/mcp/tools', { headers: { ...env.bearer(tok), 'x-finc-edge': 'public' } })).status).toBe(404);
    // a hub session or a device cannot make a token: no bearer at all is refused, and so is an MCP token
    expect((await env.req('/api/mcp/tokens', { method: 'POST', headers: env.bearer(tok), body: { name: 'x' } })).status).toBe(401);
    expect((await env.req('/api/mcp/tokens', { method: 'POST', headers: CONTROL, body: { name: 'Bad Name' } })).status).toBe(400);
    expect((await env.req('/api/mcp/tokens', { method: 'POST', headers: CONTROL, body: { name: 'claude-code' } })).status).toBe(400); // taken
  });

  it('a call runs the privacy-checked tool; bad arguments and unknown tools come back as tool errors', async () => {
    const env = setup();
    await env.turn(true);
    const tok = await env.make();
    const call = (name: string, args?: Record<string, unknown>) => env.req('/mcp/call', { method: 'POST', headers: env.bearer(tok), body: { name, ...(args ? { arguments: args } : {}) } });
    const r = await call('find_transactions', { from: '2026-10-01', to: '2026-11-30' });
    expect(r.status).toBe(200);
    expect(r.body.isError).toBe(false);
    const text = JSON.stringify(r.body.structured);
    expect(r.body.structured.rows.length).toBe(3);
    for (const bad of ['7654321', '4580', '77001234']) expect(text).not.toContain(bad);
    expect((await call('recurring')).body.structured).toHaveProperty('items');
    expect((await call('find_transactions', { sql: 'select 1' })).body).toMatchObject({ isError: true });
    expect((await call('find_transactions', { limit: 500 })).body).toMatchObject({ isError: true });
    expect((await call('raw_sql')).body).toMatchObject({ isError: true });
    expect((await env.req('/mcp/call', { method: 'POST', headers: env.bearer(tok), body: { name: 'net_worth', extra: 1 } })).status).toBe(400);
  });

  it('the security log has the tool and argument names, never values; the list never shows a token', async () => {
    const env = setup();
    await env.turn(true);
    const tok = await env.make();
    await env.req('/mcp/call', { method: 'POST', headers: env.bearer(tok), body: { name: 'find_transactions', arguments: { q: 'pizza-secret-word' } } });
    const rows = env.db.$client.prepare(`select kind, actor, detail from security_event where kind like 'mcp.%'`).all() as Array<{ kind: string; actor: string; detail: string | null }>;
    expect(rows.map((r) => r.kind)).toEqual(expect.arrayContaining(['mcp.token_created', 'mcp.call']));
    expect(JSON.stringify(rows)).not.toContain('pizza-secret-word');
    expect(JSON.stringify(rows)).not.toContain(tok);
    const list = await env.req('/api/mcp/tokens', { headers: CONTROL });
    expect(list.body.tokens).toEqual([{ name: 'claude-code', createdAt: expect.any(String), lastUsedAt: expect.any(String), callsToday: 1 }]);
    expect(JSON.stringify(list.body)).not.toContain(tok.slice(9));
  });

  it('revoked tokens stop at once; 30 calls a minute per token', async () => {
    const env = setup();
    await env.turn(true);
    const tok = await env.make();
    const tools = () => env.req('/mcp/tools', { headers: env.bearer(tok) });
    for (let i = 0; i < 30; i++) expect((await tools()).status).toBe(200);
    expect((await tools()).status).toBe(429);
    env.tick(61_000);
    expect((await tools()).status).toBe(200);
    expect((await env.req('/api/mcp/tokens/claude-code', { method: 'DELETE', headers: CONTROL })).status).toBe(200);
    expect((await tools()).status).toBe(401);
    expect((await env.req('/api/mcp/tokens/claude-code', { method: 'DELETE', headers: CONTROL })).status).toBe(404);
  });
});
