/** chat v2 step 4: the chat's own model (ai.chatModel), separate from categorisation, and follow-ups through the API. */
import { type AiConfig, type AiProvider, getSetting, openDb, setSetting } from '@finc/core';
import { describe, expect, it } from 'vitest';
import type { WorkerState } from '../server.js';
import { createApp } from './app.js';

const TOKEN = 'f'.repeat(64);
const HOME = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
// a fake unlocked vault holding a (fake) key for both cloud providers
const vault = () => ({ locked: false, lock() { this.locked = true; }, get: (name: string) => (name.startsWith('ai_') ? { fields: { apiKey: 'test-key' } } : undefined) });

function setup(provider: 'openai' | 'anthropic' | 'local' = 'openai') {
  const db = openDb(':memory:');
  setSetting(db, 'ai.provider', provider);
  const configs: AiConfig[] = [];
  const fake = (cfg: AiConfig): AiProvider => {
    configs.push(cfg);
    return { name: 'fake', model: cfg.model, complete: async () => '{"tool": null, "args": {}, "answer": "ok", "followUps": ["And by month?", "q"]}' };
  };
  const state: WorkerState = { db, vault: vault() as never, scheduler: { config: { times: [], jitterMinutes: 0, timezone: 'UTC', monthsBack: 3 }, isRunning: false, nextRun: () => null } as never, startedAt: Date.now() };
  const { app } = createApp(state, { controlToken: TOKEN, webDist: '/nonexistent', chatProvider: fake });
  const call = async (path: string, init: RequestInit = {}, base: Record<string, string> = HOME) => {
    const res = await app.request(path, { ...init, headers: { ...base, ...(init.headers as Record<string, string> | undefined) } });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
  };
  const patch = (ai: unknown) => call('/api/settings', { method: 'PATCH', body: JSON.stringify({ ai }) });
  const ask = (content: string) => call('/api/chat', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content }] }) });
  return { db, configs, call, patch, ask };
}

describe('ai.chatModel', () => {
  it('null by default: the chat uses ai.model / the default, as before', async () => {
    const env = setup();
    expect((await env.call('/api/settings')).body.ai).toMatchObject({ provider: 'openai', model: 'gpt-5-mini', chatModel: null, chatModels: { fast: 'gpt-5-mini', better: 'gpt-5' } });
    expect((await env.call('/api/chat/status')).body.model).toBe('gpt-5-mini');
    await env.ask('how much?');
    expect(env.configs[0]!.model).toBe('gpt-5-mini');
  });

  it('when set, the chat (and its status) use it; categorisation keeps ai.model', async () => {
    const env = setup();
    setSetting(env.db, 'ai.model', 'gpt-5-mini');
    expect((await env.patch({ chatModel: 'gpt-5' })).status).toBe(200);
    expect(getSetting(env.db, 'ai.chatModel')).toBe('gpt-5');
    expect(getSetting(env.db, 'ai.model')).toBe('gpt-5-mini');
    expect((await env.call('/api/settings')).body.ai).toMatchObject({ model: 'gpt-5-mini', chatModel: 'gpt-5' });
    expect((await env.call('/api/chat/status')).body.model).toBe('gpt-5');
    const r = await env.ask('how much?');
    expect(env.configs[0]!.model).toBe('gpt-5');
    expect(r.body).toMatchObject({ answer: 'ok', model: 'gpt-5', followUps: ['And by month?', 'q'] });
    // back to the default
    expect((await env.patch({ chatModel: null })).status).toBe(200);
    expect(getSetting(env.db, 'ai.chatModel')).toBeNull();
  });

  it('only the allow-list of the provider: anything else is a 400 and writes nothing', async () => {
    const env = setup();
    for (const bad of ['gpt-4o', 'claude-sonnet-5-5', 'GPT-5', '']) expect((await env.patch({ chatModel: bad })).status, bad).toBe(400);
    expect(getSetting(env.db, 'ai.chatModel')).toBeNull();
    // with a provider change in the same patch, the new provider's list applies
    expect((await env.patch({ provider: 'anthropic', chatModel: 'gpt-5' })).status).toBe(400);
    expect(getSetting(env.db, 'ai.provider')).toBe('openai');
    expect((await env.patch({ provider: 'anthropic', chatModel: 'claude-sonnet-5-5' })).status).toBe(200);
    expect((await env.call('/api/chat/status')).body.model).toBe('claude-sonnet-5-5');
    // the local provider has no choice
    expect((await env.patch({ provider: 'local', chatModel: 'gpt-5' })).status).toBe(400);
  });

  it('changing the provider resets it; re-sending the same provider does not', async () => {
    const env = setup();
    await env.patch({ chatModel: 'gpt-5' });
    expect((await env.patch({ provider: 'openai' })).status).toBe(200);
    expect(getSetting(env.db, 'ai.chatModel')).toBe('gpt-5');
    expect((await env.patch({ provider: 'anthropic' })).status).toBe(200);
    expect(getSetting(env.db, 'ai.chatModel')).toBeNull();
    expect((await env.call('/api/settings')).body.ai).toMatchObject({ provider: 'anthropic', chatModel: null, chatModels: { fast: 'claude-haiku-5-5', better: 'claude-sonnet-5-5' } });
    await env.patch({ provider: 'local' });
    expect((await env.call('/api/settings')).body.ai.chatModels).toBeNull();
  });

  it('local: a stored chat model is ignored, the chat keeps ai.model', async () => {
    const env = setup('local');
    setSetting(env.db, 'ai.model', 'qwen2.5');
    setSetting(env.db, 'ai.chatModel', 'gpt-5');
    expect((await env.call('/api/chat/status')).body.model).toBe('qwen2.5');
    await env.ask('how much?');
    expect(env.configs[0]!.model).toBe('qwen2.5');
  });

  it('is an admin setting: refused from outside the home network, like ai.provider', async () => {
    const env = setup();
    const code = (await env.call('/api/devices/pairings', { method: 'POST', body: JSON.stringify({ name: 'Phone' }) })).body.code as string;
    const EDGE = { 'x-finc-edge': 'public', 'x-forwarded-for': '198.51.100.40', 'x-forwarded-proto': 'https', 'content-type': 'application/json' };
    const token = (await env.call('/api/devices/pair', { method: 'POST', body: JSON.stringify({ code }) }, EDGE)).body.token as string;
    const r = await env.call('/api/settings', { method: 'PATCH', body: JSON.stringify({ ai: { chatModel: 'gpt-5' } }) }, { ...EDGE, authorization: `Bearer ${token}` });
    expect(r.status).toBe(403);
    expect(getSetting(env.db, 'ai.chatModel')).toBeNull();
  });
});
