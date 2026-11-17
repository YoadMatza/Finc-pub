/**
 * finc's MCP server logic, shared by the local stdio server (`finc mcp`, research_notes/proposals/mcp-server.md) and
 * the remote HTTP endpoint (`/mcp`, remote-mcp.md). It holds no database: tools come from a `WorkerLink` (HTTP to the
 * worker for stdio, in-process for /mcp), which runs the privacy-checked tools. Hand-written on purpose: a small
 * surface and no new dependency in the path that sees finc's numbers.
 *
 * Dual-era (spec 2026-07-28 "Versioning"): a request whose params carry `_meta["io.modelcontextprotocol/protocolVersion"]`
 * is served statelessly by the modern revision (server/discover, resultType, per-result serverInfo); otherwise the
 * legacy revisions (initialize, ping) apply. Only tools: no resources, prompts, sampling, logging or subscriptions.
 */

/** Modern (stateless) revisions this server speaks. */
export const MCP_MODERN = ['2026-07-28'] as const;
/** Legacy (initialize-based) revisions, newest first. */
export const MCP_LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
export const MCP_VERSIONS = [...MCP_MODERN, ...MCP_LEGACY] as const;
/** The longest line accepted from a stdio client. */
export const MAX_LINE = 1_000_000;

const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_SERVER = 'io.modelcontextprotocol/serverInfo';
/** tools/list may be cached by the client this long; private: never by shared intermediaries */
const LIST_TTL_MS = 3_600_000;

/** JSON-RPC error codes (2026-07-28 allocates -32020…-32099 to the spec). */
export const RPC = { parse: -32700, invalid: -32600, method: -32601, params: -32602, internal: -32603, headerMismatch: -32020, unsupportedVersion: -32022 } as const;

export interface WorkerLink {
  tools(): Promise<{ status: number; body: { instructions?: string; tools?: unknown[]; error?: string } }>;
  call(name: string, args: Record<string, unknown>): Promise<{ status: number; body: { structured?: Record<string, unknown>; isError?: boolean; error?: string } }>;
}

type Id = string | number;
export type Reply = { jsonrpc: '2.0'; id: Id | null; result?: unknown; error?: { code: number; message: string; data?: unknown } };
/** What the HTTP transport needs besides the reply: the status code (2026-07-28 maps some errors to 400 / 404). */
export type Outcome = { reply: Reply | null; status: 200 | 202 | 400 | 404 };

/** HTTP request headers the modern revision mirrors from the body (Streamable HTTP "Server Validation"). */
export interface HttpMirror {
  protocolVersion: string | undefined;
  method: string | undefined;
  name: string | undefined;
}

const ok = (id: Id, result: unknown): Reply => ({ jsonrpc: '2.0', id, result });
const fail = (id: Id | null, code: number, message: string, data?: unknown): Reply => ({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });
const validId = (v: unknown): v is Id => (typeof v === 'string' && v.length <= 200) || (typeof v === 'number' && Number.isFinite(v));
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** A Base64-sentinel header value (`=?base64?…?=`) decoded; plain values as they are. */
export function decodeHeaderValue(v: string): string | null {
  const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(v);
  if (!m) return v;
  try {
    return Buffer.from(m[1]!, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

export class McpBridge {
  private toolsCache: { instructions: string; tools: unknown[] } | null = null;

  constructor(
    private readonly link: WorkerLink,
    private readonly version: string,
  ) {}

  private serverInfo() {
    return { name: 'finc', title: 'finc (read-only)', version: this.version };
  }

  /** One stdio line → the line to answer with, or null (a notification). */
  async handleLine(line: string): Promise<Reply | null> {
    if (line.length > MAX_LINE) return fail(null, RPC.invalid, 'message too large');
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return fail(null, RPC.parse, 'parse error');
    }
    return (await this.handle(msg)).reply;
  }

  /** One parsed message. `http` is set for the Streamable HTTP transport (its header checks and status codes). */
  async handle(msg: unknown, http?: HttpMirror): Promise<Outcome> {
    if (Array.isArray(msg)) return { reply: fail(null, RPC.invalid, 'batches are not supported'), status: 400 };
    const m = obj(msg);
    if (!m) return { reply: fail(null, RPC.invalid, 'invalid request'), status: 400 };
    if (m.jsonrpc !== '2.0' || typeof m.method !== 'string') return { reply: validId(m.id) ? fail(m.id, RPC.invalid, 'invalid request') : fail(null, RPC.invalid, 'invalid request'), status: 400 };
    if (m.id === undefined) return { reply: null, status: 202 }; // a notification (initialized, cancelled…): accepted, nothing to say
    if (!validId(m.id)) return { reply: fail(null, RPC.invalid, 'invalid id'), status: 400 };
    const id = m.id;
    const method = m.method;
    const params = obj(m.params) ?? {};
    const meta = obj(params._meta);
    const modernVersion = meta && typeof meta[META_VERSION] === 'string' ? (meta[META_VERSION] as string) : undefined;
    try {
      if (modernVersion !== undefined) {
        if (!(MCP_MODERN as readonly string[]).includes(modernVersion)) return { reply: fail(id, RPC.unsupportedVersion, 'Unsupported protocol version', { supported: [...MCP_VERSIONS], requested: modernVersion.slice(0, 40) }), status: 400 };
        if (http) {
          const bad = mismatch(http, modernVersion, method, params);
          if (bad) return { reply: fail(id, RPC.headerMismatch, `Header mismatch: ${bad}`), status: 400 };
        }
        return await this.modern(id, method, params);
      }
      return { reply: await this.legacy(id, method, params), status: 200 };
    } catch {
      // never the exception's text: it could carry a path or a worker answer
      return { reply: fail(id, RPC.internal, 'finc could not answer; is the worker running?'), status: 200 };
    }
  }

  private async modern(id: Id, method: string, p: Record<string, unknown>): Promise<Outcome> {
    const done = (result: Record<string, unknown>): Outcome => ({ reply: ok(id, { resultType: 'complete', ...result, _meta: { [META_SERVER]: this.serverInfo() } }), status: 200 });
    switch (method) {
      case 'server/discover': {
        const t = await this.loadTools();
        return done({ supportedVersions: [...MCP_VERSIONS], capabilities: { tools: {} }, instructions: t.instructions, ttlMs: LIST_TTL_MS, cacheScope: 'private' });
      }
      case 'tools/list': {
        const t = await this.loadTools();
        return done({ tools: t.tools, ttlMs: LIST_TTL_MS, cacheScope: 'private' });
      }
      case 'tools/call': {
        const r = await this.call(id, p);
        return r.ok ? done(r.result) : { reply: r.reply, status: 200 };
      }
      default:
        return { reply: fail(id, RPC.method, `method not found: ${method.slice(0, 60)}`), status: 404 };
    }
  }

  private async legacy(id: Id, method: string, p: Record<string, unknown>): Promise<Reply> {
    switch (method) {
      case 'initialize': {
        const asked = typeof p.protocolVersion === 'string' ? p.protocolVersion : '';
        const protocolVersion = (MCP_LEGACY as readonly string[]).includes(asked) ? asked : MCP_LEGACY[0];
        const t = await this.loadTools();
        return ok(id, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: this.serverInfo(), instructions: t.instructions });
      }
      case 'ping':
        return ok(id, {});
      case 'tools/list': {
        const t = await this.loadTools();
        return ok(id, { tools: t.tools });
      }
      case 'tools/call': {
        const r = await this.call(id, p);
        return r.ok ? ok(id, r.result) : r.reply;
      }
      default:
        return fail(id, RPC.method, `method not found: ${method.slice(0, 60)}`);
    }
  }

  private async call(id: Id, p: Record<string, unknown>): Promise<{ ok: false; reply: Reply } | { ok: true; result: Record<string, unknown> }> {
    const name = typeof p.name === 'string' ? p.name : '';
    if (!name) return { ok: false, reply: fail(id, RPC.params, 'tools/call needs a tool name') };
    const args = p.arguments === undefined ? {} : p.arguments;
    if (!obj(args)) return { ok: false, reply: fail(id, RPC.params, 'arguments must be an object') };
    const r = await this.link.call(name, args as Record<string, unknown>);
    if (r.status !== 200 || !r.body.structured) return { ok: true, result: toolError(r.body.error ?? `finc refused the call (${r.status})`) };
    const structured = r.body.structured;
    return { ok: true, result: { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured, isError: r.body.isError === true } };
  }

  private async loadTools(): Promise<{ instructions: string; tools: unknown[] }> {
    if (this.toolsCache) return this.toolsCache;
    const r = await this.link.tools();
    if (r.status !== 200 || !Array.isArray(r.body.tools)) throw new Error(r.body.error ?? `tools: ${r.status}`);
    this.toolsCache = { instructions: r.body.instructions ?? '', tools: r.body.tools };
    return this.toolsCache;
  }
}

/** The modern revision's header-body checks; the first problem, or null. */
function mismatch(h: HttpMirror, version: string, method: string, p: Record<string, unknown>): string | null {
  if (h.protocolVersion === undefined) return 'MCP-Protocol-Version is missing';
  if (h.protocolVersion !== version) return 'MCP-Protocol-Version does not match _meta';
  if (h.method === undefined) return 'Mcp-Method is missing';
  if (h.method !== method) return 'Mcp-Method does not match the body';
  if (method === 'tools/call') {
    if (h.name === undefined) return 'Mcp-Name is missing';
    const name = decodeHeaderValue(h.name);
    if (name === null || name !== p.name) return 'Mcp-Name does not match the body';
  }
  return null;
}

const toolError = (message: string) => ({ content: [{ type: 'text', text: message.slice(0, 300) }], isError: true });

/** Reads newline-delimited messages from `input`, answers on `write`, one at a time in order. */
export async function serveStdio(bridge: McpBridge, input: AsyncIterable<string | Buffer>, write: (line: string) => void): Promise<void> {
  let buf = '';
  for await (const chunk of input) {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (buf.length > MAX_LINE * 2 && !buf.includes('\n')) {
      write(JSON.stringify(fail(null, RPC.invalid, 'message too large')));
      buf = '';
      continue;
    }
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const reply = await bridge.handleLine(line);
      if (reply) write(JSON.stringify(reply));
    }
  }
}
