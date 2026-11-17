import { describe, expect, it, vi } from 'vitest';
import { McpBridge, type WorkerLink, serveStdio } from './bridge.js';

// the stdio MCP server: speaks JSON-RPC, relays tool calls, never writes anything but replies

const TOOLS = [{ name: 'net_worth', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }];
function link(over: Partial<WorkerLink> = {}): WorkerLink {
  return {
    tools: vi.fn(async () => ({ status: 200, body: { instructions: 'read-only', tools: TOOLS } })),
    call: vi.fn(async () => ({ status: 200, body: { structured: { total: 1000 }, isError: false } })),
    ...over,
  };
}

async function run(lines: string[], l: WorkerLink = link()): Promise<Array<Record<string, any>>> {
  const out: string[] = [];
  async function* input() {
    yield `${lines.join('\n')}\n`;
  }
  await serveStdio(new McpBridge(l, '0.9.0'), input(), (line) => out.push(line));
  return out.map((x) => JSON.parse(x));
}

const rpc = (id: number | undefined, method: string, params?: unknown) => JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }) });

describe('MCP bridge', () => {
  it('initialize, initialized, tools/list, tools/call', async () => {
    const l = link();
    const out = await run([rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }), rpc(undefined, 'notifications/initialized'), rpc(2, 'tools/list'), rpc(3, 'tools/call', { name: 'net_worth', arguments: {} }), rpc(4, 'ping')], l);
    expect(out).toHaveLength(4); // the notification gets no answer
    expect(out[0]).toMatchObject({ id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'finc' }, instructions: 'read-only' } });
    expect(out[1]).toMatchObject({ id: 2, result: { tools: TOOLS } });
    expect(out[2]).toMatchObject({ id: 3, result: { structuredContent: { total: 1000 }, isError: false, content: [{ type: 'text', text: '{"total":1000}' }] } });
    expect(out[3]).toEqual({ jsonrpc: '2.0', id: 4, result: {} });
    expect(l.tools).toHaveBeenCalledTimes(1); // cached
    expect(l.call).toHaveBeenCalledWith('net_worth', {});
  });

  it('an unknown version gets the newest it speaks', async () => {
    const out = await run([rpc(1, 'initialize', { protocolVersion: '2099-01-01' })]);
    expect(out[0]!.result.protocolVersion).toBe('2025-11-25');
  });

  it('a refusal by the worker is a tool error the model can read; a failure says nothing more', async () => {
    const out = await run([rpc(1, 'tools/call', { name: 'net_worth' })], link({ call: async () => ({ status: 403, body: { error: 'MCP is off in finc; turn it on in Settings → AI' } }) }));
    expect(out[0]).toMatchObject({ id: 1, result: { isError: true, content: [{ text: 'MCP is off in finc; turn it on in Settings → AI' }] } });
    const boom = await run([rpc(1, 'tools/call', { name: 'net_worth' })], link({ call: async () => Promise.reject(new Error('ECONNREFUSED /data/secret/path')) }));
    expect(boom[0]).toMatchObject({ id: 1, error: { code: -32603 } });
    expect(JSON.stringify(boom[0])).not.toContain('secret');
  });

  it('modern (2026-07-28): stateless server/discover, tools/list, tools/call with resultType and serverInfo', async () => {
    const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 't', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} };
    const out = await run([rpc(1, 'server/discover', { _meta: meta }), rpc(2, 'tools/list', { _meta: meta }), rpc(3, 'tools/call', { name: 'net_worth', arguments: {}, _meta: meta }), rpc(4, 'ping', { _meta: meta })]);
    expect(out[0]).toMatchObject({ id: 1, result: { resultType: 'complete', supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'], capabilities: { tools: {} }, instructions: 'read-only', cacheScope: 'private', _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'finc' } } } });
    expect(out[1]).toMatchObject({ id: 2, result: { resultType: 'complete', tools: TOOLS, ttlMs: 3_600_000 } });
    expect(out[2]).toMatchObject({ id: 3, result: { resultType: 'complete', structuredContent: { total: 1000 }, isError: false } });
    expect(out[3]).toMatchObject({ id: 4, error: { code: -32601 } }); // ping is gone in 2026-07-28
  });

  it('modern: an unknown version is refused with the supported list; over HTTP the headers must match the body', async () => {
    const b = new McpBridge(link(), '0.9.0');
    const msg = (version: string, method = 'tools/call', name = 'net_worth') => ({ jsonrpc: '2.0', id: 9, method, params: { name, arguments: {}, _meta: { 'io.modelcontextprotocol/protocolVersion': version } } });
    expect(await b.handle(msg('2099-01-01'))).toMatchObject({ status: 400, reply: { error: { code: -32022, data: { requested: '2099-01-01' } } } });
    const h = { protocolVersion: '2026-07-28', method: 'tools/call', name: 'net_worth' };
    expect((await b.handle(msg('2026-07-28'), h)).status).toBe(200);
    expect(await b.handle(msg('2026-07-28'), { ...h, name: 'trends' })).toMatchObject({ status: 400, reply: { error: { code: -32020 } } });
    expect(await b.handle(msg('2026-07-28'), { ...h, protocolVersion: undefined })).toMatchObject({ status: 400, reply: { error: { code: -32020 } } });
    expect(await b.handle(msg('2026-07-28'), { ...h, method: 'tools/list' })).toMatchObject({ status: 400 });
    expect((await b.handle(msg('2026-07-28'), { ...h, name: `=?base64?${Buffer.from('net_worth').toString('base64')}?=` })).status).toBe(200);
    expect((await b.handle(msg('2026-07-28', 'resources/list'), { ...h, method: 'resources/list' })).status).toBe(404);
    expect((await b.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
  });

  it('bad input: parse errors, batches, unknown methods, bad arguments', async () => {
    const out = await run(['{not json', '[1,2]', rpc(1, 'resources/list'), rpc(2, 'tools/call', { name: 'net_worth', arguments: [1] }), rpc(3, 'tools/call', {})]);
    expect(out.map((o) => o.error?.code)).toEqual([-32700, -32600, -32601, -32602, -32602]);
  });
});
