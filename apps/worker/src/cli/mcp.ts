/**
 * `finc mcp`: the MCP server an AI app starts (research_notes/proposals/mcp-server.md §4, §6), and `finc mcp token
 * create | list | revoke`. Runs inside the container (the launcher uses `exec -T` for `mcp`, so stdout stays clean).
 * A token is made by the worker (control token: the PC only), kept in data/mcp/<app>.token (owner-only), and never
 * printed. The AI app's config names the app, never the token.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FINC_VERSION, MCP_NAME, dataDir } from '@finc/core';
import type { Command } from 'commander';
import { readControlToken } from '../api/auth.js';
import { McpBridge, serveStdio, type WorkerLink } from '../mcp/bridge.js';
import { verifyWorker, workerRequest, workerUrl } from './worker-client.js';

export const mcpTokenFile = (name: string): string => path.join(dataDir(), 'mcp', `${name}.token`);

function readMcpToken(name: string): string {
  if (!MCP_NAME.test(name)) throw new Error('--token takes the app name given to `finc mcp token create`');
  const file = mcpTokenFile(name);
  if (!existsSync(file)) throw new Error(`no MCP token for "${name}"; make one on the PC: .\\finc mcp token create ${name}`);
  return readFileSync(file, 'utf8').trim();
}

/** The bridge's link to the worker: the MCP token only, after the worker proved it holds the control token. */
function httpLink(token: string): WorkerLink {
  const verified = (async () => {
    const control = readControlToken();
    if (!control) throw new Error('no control token in data/: is this the finc container?');
    await verifyWorker(control);
  })();
  const go = async <T>(method: 'GET' | 'POST', p: string, body?: unknown): Promise<{ status: number; body: T }> => {
    await verified;
    const res = await fetch(`${workerUrl()}${p}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
  };
  return { tools: () => go('GET', '/mcp/tools'), call: (name, args) => go('POST', '/mcp/call', { name, arguments: args }) };
}

export function registerMcpCommands(program: Command): void {
  const mcp = program
    .command('mcp')
    .description('MCP server for an AI app (read-only, local): started by the app, e.g. claude mcp add finc -- <finc folder>\\finc.cmd mcp --token claude-desktop')
    .option('--token <app>', 'the app name its token was made for')
    .action(async (o: { token?: string }) => {
      if (!o.token) throw new Error('--token <app> is required (the name given to `finc mcp token create`)');
      const bridge = new McpBridge(httpLink(readMcpToken(o.token)), FINC_VERSION);
      process.stdin.setEncoding('utf8');
      await serveStdio(bridge, process.stdin, (line) => process.stdout.write(`${line}\n`));
    });

  const token = mcp.command('token').description('Tokens for AI apps (made on the PC only)');
  token
    .command('create <app>')
    .description('Make a token for an AI app; kept in data/mcp/<app>.token, never printed')
    .action(async (app: string) => {
      if (!MCP_NAME.test(app)) throw new Error('the app name takes lower-case letters, digits and dashes, e.g. claude-desktop');
      const r = await workerRequest<{ name?: string; token?: string; error?: string }>('POST', '/api/mcp/tokens', { name: app }, 15_000);
      if (r.status !== 200 || !r.body.token) throw new Error(r.body.error ?? `the worker refused (${r.status}); is it running?`);
      const file = mcpTokenFile(app);
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, `${r.body.token}\n`, { mode: 0o600 });
      chmodSync(file, 0o600);
      console.log(`token for "${app}" made and kept in data/mcp/${app}.token (not shown).`);
      console.log('Turn MCP on in Settings → AI, then add finc to the app, e.g. Claude Code:');
      console.log(`  claude mcp add finc -- <finc folder>\\finc.cmd mcp --token ${app}`);
    });
  token
    .command('list')
    .description('The active tokens, with last use and calls today')
    .action(async () => {
      const r = await workerRequest<{ enabled?: boolean; tokens?: Array<{ name: string; createdAt: string; lastUsedAt: string | null; callsToday: number }> }>('GET', '/api/mcp/tokens', undefined, 15_000);
      if (r.status !== 200) throw new Error(`the worker refused (${r.status})`);
      console.log(`MCP is ${r.body.enabled ? 'on' : 'off'}`);
      for (const t of r.body.tokens ?? []) console.log(`  ${t.name.padEnd(24)} made ${t.createdAt.slice(0, 10)}  last used ${t.lastUsedAt ? t.lastUsedAt.slice(0, 16).replace('T', ' ') : 'never'}  calls today ${t.callsToday}`);
      if (!r.body.tokens?.length) console.log('  no tokens');
    });
  token
    .command('revoke <app>')
    .description("Revoke an app's token and delete its file")
    .action(async (app: string) => {
      const r = await workerRequest<{ error?: string }>('DELETE', `/api/mcp/tokens/${encodeURIComponent(app)}`, undefined, 15_000);
      if (r.status !== 200 && r.status !== 404) throw new Error(r.body.error ?? `the worker refused (${r.status})`);
      if (MCP_NAME.test(app)) rmSync(mcpTokenFile(app), { force: true });
      console.log(r.status === 200 ? `token for "${app}" revoked` : `no active token named "${app}"; its file (if any) is removed`);
    });
}
