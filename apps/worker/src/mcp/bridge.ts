/**
 * The MCP server an AI app starts on the PC (research_notes/proposals/mcp-server.md §4): JSON-RPC over stdio,
 * newline-delimited. It holds no database: every tool call is relayed to the worker's /mcp routes, which run the
 * privacy-checked tools. Hand-written on purpose (initialize, ping, tools/list, tools/call): a small surface and no
 * new dependency in the path that sees finc's numbers. Nothing but JSON-RPC goes to stdout.
 */

/** Protocol revisions this server speaks, newest first. */
export const MCP_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
/** The longest line accepted from the client. */
export const MAX_LINE = 1_000_000;

export interface WorkerLink {
  tools(): Promise<{ status: number; body: { instructions?: string; tools?: unknown[]; error?: string } }>;
  call(name: string, args: Record<string, unknown>): Promise<{ status: number; body: { structured?: Record<string, unknown>; isError?: boolean; error?: string } }>;
}

type Id = string | number;
type Msg = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
export type Reply = { jsonrpc: '2.0'; id: Id | null; result?: unknown; error?: { code: number; message: string } };

const ok = (id: Id, result: unknown): Reply => ({ jsonrpc: '2.0', id, result });
const fail = (id: Id | null, code: number, message: string): Reply => ({ jsonrpc: '2.0', id, error: { code, message } });
const validId = (v: unknown): v is Id => (typeof v === 'string' && v.length <= 200) || (typeof v === 'number' && Number.isFinite(v));

export class McpBridge {
  private toolsCache: { instructions: string; tools: unknown[] } | null = null;

  constructor(
    private readonly link: WorkerLink,
    private readonly version: string,
  ) {}

  /** One line from the client → the line to answer with, or null (a notification, or nothing to say). */
  async handleLine(line: string): Promise<Reply | null> {
    if (line.length > MAX_LINE) return fail(null, -32600, 'message too large');
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return fail(null, -32700, 'parse error');
    }
    if (Array.isArray(msg)) return fail(null, -32600, 'batches are not supported');
    if (!msg || typeof msg !== 'object') return fail(null, -32600, 'invalid request');
    const m = msg as Msg;
    if (m.jsonrpc !== '2.0' || typeof m.method !== 'string') return validId(m.id) ? fail(m.id, -32600, 'invalid request') : null;
    if (m.id === undefined) return null; // a notification (initialized, cancelled…): nothing to answer
    if (!validId(m.id)) return fail(null, -32600, 'invalid id');
    try {
      return await this.dispatch(m.id, m.method, m.params);
    } catch {
      // never the exception's text: it could carry a path or a worker answer
      return fail(m.id, -32603, 'finc could not answer; is the worker running?');
    }
  }

  private async dispatch(id: Id, method: string, params: unknown): Promise<Reply> {
    const p = params && typeof params === 'object' && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
    switch (method) {
      case 'initialize': {
        const asked = typeof p.protocolVersion === 'string' ? p.protocolVersion : '';
        const protocolVersion = (MCP_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_VERSIONS[0];
        const t = await this.loadTools();
        return ok(id, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'finc', title: 'finc (read-only)', version: this.version }, instructions: t.instructions });
      }
      case 'ping':
        return ok(id, {});
      case 'tools/list': {
        const t = await this.loadTools();
        return ok(id, { tools: t.tools });
      }
      case 'tools/call': {
        const name = typeof p.name === 'string' ? p.name : '';
        if (!name) return fail(id, -32602, 'tools/call needs a tool name');
        const args = p.arguments === undefined ? {} : p.arguments;
        if (!args || typeof args !== 'object' || Array.isArray(args)) return fail(id, -32602, 'arguments must be an object');
        const r = await this.link.call(name, args as Record<string, unknown>);
        if (r.status !== 200 || !r.body.structured) return ok(id, toolError(r.body.error ?? `finc refused the call (${r.status})`));
        const structured = r.body.structured;
        return ok(id, { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured, isError: r.body.isError === true });
      }
      default:
        return fail(id, -32601, `method not found: ${method.slice(0, 60)}`);
    }
  }

  private async loadTools(): Promise<{ instructions: string; tools: unknown[] }> {
    if (this.toolsCache) return this.toolsCache;
    const r = await this.link.tools();
    if (r.status !== 200 || !Array.isArray(r.body.tools)) throw new Error(r.body.error ?? `tools: ${r.status}`);
    this.toolsCache = { instructions: r.body.instructions ?? '', tools: r.body.tools };
    return this.toolsCache;
  }
}

const toolError = (message: string) => ({ content: [{ type: 'text', text: message.slice(0, 300) }], isError: true });

/** Reads newline-delimited messages from `input`, answers on `write`, one at a time in order. */
export async function serveStdio(bridge: McpBridge, input: AsyncIterable<string | Buffer>, write: (line: string) => void): Promise<void> {
  let buf = '';
  for await (const chunk of input) {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (buf.length > MAX_LINE * 2 && !buf.includes('\n')) {
      write(JSON.stringify(fail(null, -32600, 'message too large')));
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
