/**
 * Pluggable chat-completion providers. All three speak "system + user → text":
 *  - anthropic: Claude Messages API (api.anthropic.com)
 *  - openai:    OpenAI chat completions (api.openai.com)
 *  - local:     any OpenAI-compatible server on this machine (Ollama, LM Studio, llama.cpp, vLLM)
 * Keys come from the vault (entries ai_anthropic / ai_openai, field apiKey) and are passed in
 * explicitly; the environment is never consulted and is scrubbed again right here, so no entry
 * point or library can make an API call with a key that belongs to another project. The local
 * provider needs no key. Nothing here decides WHAT is sent: see categorize-ai.ts.
 */
import { scrubSecretEnv } from '../vault/env.js';

/**
 * A reply shape the provider enforces (chat-v2 step 1): Anthropic answers through a forced tool call whose input is
 * the object, OpenAI through response_format json_schema. Either way complete() returns that object as JSON text,
 * so the model never hand-escapes quotes (Hebrew abbreviations such as חו"ל broke the free-text JSON). A local model
 * gets plain text and the caller parses it leniently.
 */
export interface ReplyFormat {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

export interface AiProvider {
  readonly name: 'anthropic' | 'openai' | 'local' | 'fake';
  readonly model: string;
  complete(input: { system: string; user: string; maxTokens?: number; format?: ReplyFormat }): Promise<string>;
}

export interface AiConfig {
  provider: 'anthropic' | 'openai' | 'local';
  model: string;
  /** OpenAI-compatible base URL for openai/local, e.g. http://localhost:11434/v1 */
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export const AI_DEFAULTS = {
  anthropic: { model: 'claude-haiku-5-5', baseUrl: 'https://api.anthropic.com' },
  openai: { model: 'gpt-5-mini', baseUrl: 'https://api.openai.com/v1' },
  local: { model: 'llama3.1', baseUrl: 'http://localhost:11434/v1' },
} as const;

export class AiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

export function createProvider(cfg: AiConfig): AiProvider {
  scrubSecretEnv(); // defence in depth: the only key an API call can carry is cfg.apiKey from the vault
  const f = cfg.fetchImpl ?? fetch;
  const timeout = cfg.timeoutMs ?? 120_000;
  // A cloud key only ever travels to its own vendor (audit M1), over https (security research P3-01): a base URL with
  // another origin, http://api.openai.com included, is refused, not followed.
  if (cfg.provider !== 'local' && cfg.baseUrl) {
    const expected = new URL(AI_DEFAULTS[cfg.provider].baseUrl).origin;
    let origin = '';
    try {
      origin = new URL(cfg.baseUrl).origin;
    } catch {
      /* not a URL */
    }
    if (origin !== expected) throw new AiError(`the ${cfg.provider} key is sent to ${expected} only; base URL ${cfg.baseUrl} is refused`);
  }
  if (cfg.provider === 'anthropic') {
    if (!cfg.apiKey) throw new AiError('Anthropic needs an API key in the vault: finc vault set ai_anthropic');
    const base = (cfg.baseUrl ?? AI_DEFAULTS.anthropic.baseUrl).replace(/\/$/, '');
    const model = cfg.model || AI_DEFAULTS.anthropic.model;
    return {
      name: 'anthropic',
      model,
      async complete({ system, user, maxTokens, format }) {
        const tools = format ? { tools: [{ name: format.name, description: format.description, input_schema: format.schema }], tool_choice: { type: 'tool', name: format.name } } : {};
        const res = await f(`${base}/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey!, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model, max_tokens: maxTokens ?? 4000, system, messages: [{ role: 'user', content: user }], ...tools }),
          signal: AbortSignal.timeout(timeout),
        });
        if (!res.ok) throw new AiError(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status);
        const data = (await res.json()) as { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }>; stop_reason?: string };
        if (format && data.stop_reason === 'max_tokens') throw new AiError('the model ran out of output tokens before answering');
        const call = format ? (data.content ?? []).find((c) => c.type === 'tool_use' && c.name === format.name) : undefined;
        if (call) return JSON.stringify(call.input ?? {});
        return (data.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
      },
    };
  }
  const isLocal = cfg.provider === 'local';
  const base = (cfg.baseUrl ?? (isLocal ? AI_DEFAULTS.local.baseUrl : AI_DEFAULTS.openai.baseUrl)).replace(/\/$/, '');
  const model = cfg.model || (isLocal ? AI_DEFAULTS.local.model : AI_DEFAULTS.openai.model);
  if (!isLocal && !cfg.apiKey) throw new AiError('OpenAI needs an API key in the vault: finc vault set ai_openai');
  if (isLocal && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|host\.docker\.internal)(:\d+)?(\/|$)/.test(base)) {
    throw new AiError(`the local provider only talks to this machine; base URL ${base} is not local`);
  }
  // OpenAI's reasoning models (gpt-5 family, o-series) reject `max_tokens` and any non-default temperature;
  // they take `max_completion_tokens` (which reasoning also consumes) and `reasoning_effort`.
  const reasoningModel = !isLocal && /^(gpt-5|o[1-9])/.test(model);
  return {
    name: isLocal ? 'local' : 'openai',
    model,
    async complete({ system, user, maxTokens, format }) {
      // a local server may not support json_schema: it gets plain text and the caller parses leniently
      const shape = format && !isLocal ? { response_format: { type: 'json_schema', json_schema: { name: format.name, description: format.description, schema: format.schema, strict: false } } } : {};
      const limits = reasoningModel ? { max_completion_tokens: (maxTokens ?? 4000) * 3, reasoning_effort: 'low' } : { max_tokens: maxTokens ?? 4000, temperature: 0 };
      const res = await f(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
        body: JSON.stringify({ model, ...limits, ...shape, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) throw new AiError(`${isLocal ? 'local model' : 'OpenAI'} ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status);
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }> };
      const choice = data.choices?.[0];
      if (choice?.finish_reason === 'length' && (!choice.message?.content || format)) throw new AiError(`the model ran out of output tokens before answering${format ? '' : '; try a smaller --limit'}`);
      return choice?.message?.content ?? '';
    },
  };
}

/** Fake provider for tests and dry runs: answers from a lookup table. */
export function fakeProvider(answers: Record<string, { category: string; confidence: number; reason?: string }>): AiProvider & { calls: Array<{ system: string; user: string }> } {
  const calls: Array<{ system: string; user: string }> = [];
  return {
    name: 'fake',
    model: 'fake-1',
    calls,
    async complete(input) {
      calls.push(input);
      const items = (JSON.parse(input.user.slice(input.user.indexOf('['))) as Array<{ key: string }>).map((m) => {
        const a = answers[m.key];
        return a ? { key: m.key, category: a.category, confidence: a.confidence, reason: a.reason ?? 'fake' } : { key: m.key, category: null, confidence: 0, reason: 'unknown' };
      });
      return JSON.stringify(items);
    },
  };
}
