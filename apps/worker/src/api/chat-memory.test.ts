/** chat-v2 step 2: lookup memory per chat id, in the worker's memory only, emptied whenever the vault locks. */
import { type AiProvider, ensureAccount, ingestBatch, openDb, setSetting } from '@finc/core';
import { describe, expect, it } from 'vitest';
import type { WorkerState } from '../server.js';
import { createApp } from './app.js';
import { CHAT_MEMORY_MAX_CHARS, CHAT_MEMORY_MAX_CHATS, CHAT_MEMORY_MAX_LOOKUPS, CHAT_MEMORY_TTL_MS, ChatMemory, newestWithin } from './chat-memory.js';

const MIN = 60_000;
const vault = () => ({ locked: false, lock() { this.locked = true; } });

describe('ChatMemory', () => {
  it('keeps a chat\'s lookups for 30 minutes from last use', () => {
    const clock = { t: 0 };
    const m = new ChatMemory(() => clock.t);
    const v = vault();
    m.add('chat-aaaa', ['L1'], v);
    clock.t += 29 * MIN;
    expect(m.get('chat-aaaa', v)).toEqual(['L1']);
    // the read counted as use: another 29 minutes is fine
    clock.t += 29 * MIN;
    expect(m.get('chat-aaaa', v)).toEqual(['L1']);
    clock.t += CHAT_MEMORY_TTL_MS + 1;
    expect(m.get('chat-aaaa', v)).toEqual([]);
    expect(m.size).toBe(0);
  });

  it('adds turns, keeps the newest within the caps, and keeps the old ones when a turn had no lookups', () => {
    const m = new ChatMemory(() => 0);
    const v = vault();
    m.add('chat-aaaa', ['L1', 'L2'], v);
    m.add('chat-aaaa', [], v);
    expect(m.get('chat-aaaa', v)).toEqual(['L1', 'L2']);
    m.add('chat-aaaa', ['L1', 'L3'], v);
    expect(m.get('chat-aaaa', v)).toEqual(['L2', 'L1', 'L3']);
    m.add('chat-aaaa', Array.from({ length: 20 }, (_, i) => `N${i}`), v);
    expect(m.get('chat-aaaa', v)).toEqual(Array.from({ length: CHAT_MEMORY_MAX_LOOKUPS }, (_, i) => `N${20 - CHAT_MEMORY_MAX_LOOKUPS + i}`));
    const big = 'x'.repeat(10_000);
    m.add('chat-bbbb', [`a${big}`, `b${big}`, `c${big}`], v);
    const kept = m.get('chat-bbbb', v);
    expect(kept.map((l) => l[0])).toEqual(['b', 'c']);
    expect(kept.join('').length).toBeLessThanOrEqual(CHAT_MEMORY_MAX_CHARS);
  });

  it('holds at most 50 chats, dropping the least recently used', () => {
    const clock = { t: 0 };
    const m = new ChatMemory(() => clock.t);
    const v = vault();
    for (let i = 0; i < CHAT_MEMORY_MAX_CHATS; i++) {
      clock.t++;
      m.add(`chat-${String(i).padStart(4, '0')}`, [`L${i}`], v);
    }
    // chat 0 used again: chat 1 is now the oldest
    expect(m.get('chat-0000', v)).toEqual(['L0']);
    m.add('chat-new1', ['N'], v);
    expect(m.size).toBe(CHAT_MEMORY_MAX_CHATS);
    expect(m.get('chat-0001', v)).toEqual([]);
    expect(m.get('chat-0000', v)).toEqual(['L0']);
    expect(m.get('chat-new1', v)).toEqual(['N']);
  });

  it('is never served under another vault or a locked one; forget and clear drop entries', () => {
    const m = new ChatMemory(() => 0);
    const v = vault();
    m.add('chat-aaaa', ['L1'], v);
    expect(m.get('chat-aaaa', vault())).toEqual([]);
    m.add('chat-aaaa', ['L1'], v);
    v.lock();
    expect(m.get('chat-aaaa', v)).toEqual([]);
    // a local model with no vault open
    m.add('chat-cccc', ['L'], null);
    expect(m.get('chat-cccc', null)).toEqual(['L']);
    expect(m.get('chat-cccc', vault())).toEqual([]);
    const w = vault();
    m.add('chat-dddd', ['L'], w);
    m.add('chat-eeee', ['L'], w);
    m.forget('chat-dddd');
    expect(m.get('chat-dddd', w)).toEqual([]);
    m.clear();
    expect(m.get('chat-eeee', w)).toEqual([]);
  });
});

describe('ChatMemory turns (review)', () => {
  it('a turn stores nothing when the memory was cleared or its vault locked while it ran', () => {
    const m = new ChatMemory(() => 0);
    const v = vault();
    const t1 = m.begin('k', v);
    m.clear();
    t1.finish(['L1']);
    expect(m.get('k', v)).toEqual([]);
    const t2 = m.begin('k', v);
    v.lock();
    t2.finish(['L2']);
    expect(m.size).toBe(0);
    const w = vault();
    const t3 = m.begin('k', w);
    t3.finish(['L3']);
    expect(m.begin('k', w).previous).toEqual(['L3']);
  });

  it('data changed since (sync, engine run, edit): the earlier lookups are dropped', () => {
    const m = new ChatMemory(() => 0);
    const v = vault();
    m.begin('k', v, 'stamp-1').finish(['L1']);
    expect(m.begin('k', v, 'stamp-1').previous).toEqual(['L1']);
    expect(m.begin('k', v, 'stamp-2').previous).toEqual([]);
  });

  it('a character cap per question keeps the newest lookups', () => {
    expect(newestWithin(['a'.repeat(5000), 'b'.repeat(5000), 'c'.repeat(2000)], 8000).map((l) => l[0])).toEqual(['b', 'c']);
    const m = new ChatMemory(() => 0);
    const v = vault();
    m.add('k', ['a'.repeat(5000), 'b'.repeat(5000)], v);
    expect(m.begin('k', v, '', 8000).previous.map((l) => l[0])).toEqual(['b']);
    // the stored entry is untouched by a capped read
    expect(m.get('k', v)).toHaveLength(2);
  });
});

describe('POST /api/chat with a chat id', () => {
  const TOKEN = 'f'.repeat(64);
  const HOME = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const Q = (content: string, chatId?: string) => ({ messages: [{ role: 'user', content }], ...(chatId !== undefined ? { chatId } : {}) });

  function setup() {
    const db = openDb(':memory:');
    setSetting(db, 'ai.provider', 'local');
    const clock = { t: Date.parse('2026-11-13T08:00:00Z') };
    const prompts: string[] = [];
    let n = 0;
    /** while set, the model's first round waits on it (a question in flight) */
    const hold: { gate: Promise<void> | null } = { gate: null };
    // every question: one lookup, then an answer
    const provider: AiProvider = {
      name: 'fake',
      model: 'fake-chat',
      async complete({ user }) {
        prompts.push(user);
        if (hold.gate && n % 2 === 0) await hold.gate;
        return n++ % 2 === 0 ? '{"tool": "spend_summary", "args": {"category": "car", "currency": "ils"}, "answer": null}' : '{"tool": null, "args": {}, "answer": "ok"}';
      },
    };
    const state: WorkerState = { db, vault: vault() as never, scheduler: { config: { times: [], jitterMinutes: 0, timezone: 'UTC', monthsBack: 3 }, isRunning: false, nextRun: () => null } as never, startedAt: Date.now() };
    const { app, panic } = createApp(state, { controlToken: TOKEN, webDist: '/nonexistent', now: () => clock.t, chatProvider: () => provider });
    const call = async (path: string, init: RequestInit = {}, base: Record<string, string> = HOME) => {
      const res = await app.request(path, { ...init, headers: { ...base, ...(init.headers as Record<string, string> | undefined) } });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
    };
    const ask = (body: unknown) => call('/api/chat', { method: 'POST', body: JSON.stringify(body) });
    /** the prompt of the first round of the latest question */
    const firstPrompt = () => prompts[prompts.length - 2]!;
    const EDGE = { 'x-finc-edge': 'public', 'x-forwarded-for': '198.51.100.40', 'x-forwarded-proto': 'https', 'content-type': 'application/json' };
    /** a paired phone, asking from outside the home network */
    const phone = async () => {
      const code = (await call('/api/devices/pairings', { method: 'POST', body: JSON.stringify({ name: 'Phone' }) })).body.code as string;
      const token = (await call('/api/devices/pair', { method: 'POST', body: JSON.stringify({ code }) }, EDGE)).body.token as string;
      return (body: unknown) => call('/api/chat', { method: 'POST', body: JSON.stringify(body) }, { ...EDGE, authorization: `Bearer ${token}` });
    };
    return { state, clock, prompts, ask, call, firstPrompt, panic, hold, phone };
  }
  const EARLIER = 'Lookups from earlier in this conversation (exact when made; may predate a sync since)';

  it('validates the id and never returns the lookups to the browser', async () => {
    const env = setup();
    for (const bad of ['short', 'x'.repeat(65), 'has space!', 'דני-כהן-12', 5]) expect((await env.ask(Q('q', bad as string))).status).toBe(400);
    const r = await env.ask(Q('how much on the car?', 'chat-1234'));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ answer: 'ok', rounds: 2 });
    expect(r.body.lookups).toBeUndefined();
    // without an id: as before, nothing remembered
    expect((await env.ask(Q('how much on the car?'))).status).toBe(200);
    expect(env.firstPrompt()).not.toContain(EARLIER);
  });

  it('a follow-up in the same chat sees the earlier lookups; another chat id does not', async () => {
    const env = setup();
    await env.ask(Q('average on the car?', 'chat-aaaa1111'));
    await env.ask({ messages: [{ role: 'user', content: 'average on the car?' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'and by merchant?' }], chatId: 'chat-aaaa1111' });
    expect(env.firstPrompt()).toContain(EARLIER);
    expect(env.firstPrompt()).toContain('e1. {"tool":"spend_summary","args":{"category":"car","currency":"ils"}} → {"from":"2025-11"');
    await env.ask(Q('and by merchant?', 'chat-bbbb2222'));
    expect(env.firstPrompt()).not.toContain(EARLIER);
  });

  it('expires after 30 minutes; DELETE (new chat on the web) drops it at once', async () => {
    const env = setup();
    await env.ask(Q('q1', 'chat-aaaa1111'));
    env.clock.t += 31 * MIN;
    await env.ask(Q('q2', 'chat-aaaa1111'));
    expect(env.firstPrompt()).not.toContain(EARLIER);
    await env.ask(Q('q3', 'chat-aaaa1111'));
    expect(env.firstPrompt()).toContain(EARLIER);
    expect((await env.call('/api/chat/chat-aaaa1111', { method: 'DELETE' })).status).toBe(200);
    expect((await env.call('/api/chat/bad id', { method: 'DELETE' })).status).toBe(400);
    await env.ask(Q('q4', 'chat-aaaa1111'));
    expect(env.firstPrompt()).not.toContain(EARLIER);
  });

  it('a lock (or a lock and a new unlock) while a question is in flight: nothing is stored or served afterwards', async () => {
    for (const unlockAgain of [false, true]) {
      const env = setup();
      let release!: () => void;
      env.hold.gate = new Promise<void>((r) => (release = r));
      const inFlight = env.ask(Q('q1', 'chat-aaaa1111'));
      await new Promise((r) => setTimeout(r, 10));
      expect((await env.call('/lock', { method: 'POST', body: '{}' })).status).toBe(200);
      if (unlockAgain) env.state.vault = vault() as never;
      release();
      expect((await inFlight).status).toBe(200);
      env.hold.gate = null;
      await env.ask(Q('q2', 'chat-aaaa1111'));
      expect(env.firstPrompt()).not.toContain(EARLIER);
    }
  });

  it('belongs to the caller: another device with the same chat id sees nothing; from outside it still works', async () => {
    const env = setup();
    await env.ask(Q('q1', 'chat-aaaa1111'));
    const ask = await env.phone();
    expect((await ask(Q('q2', 'chat-aaaa1111'))).status).toBe(200);
    expect(env.firstPrompt()).not.toContain(EARLIER);
    expect((await ask(Q('q3', 'chat-aaaa1111'))).status).toBe(200);
    expect(env.firstPrompt()).toContain(EARLIER);
  });

  it('new data (a sync or an engine run changes the transactions) drops the earlier lookups', async () => {
    const env = setup();
    await env.ask(Q('q1', 'chat-aaaa1111'));
    await env.ask(Q('q2', 'chat-aaaa1111'));
    expect(env.firstPrompt()).toContain(EARLIER);
    const acc = ensureAccount(env.state.db, { institutionId: 'max', institutionKind: 'card', institutionDisplayName: 'Max', source: 'scraper:max', externalId: 'm', type: 'credit_card' }).accountId;
    ingestBatch(env.state.db, { source: 'scraper:max', runId: null, accountId: acc, rows: [{ externalAccountId: 'm', date: '2026-11-12', amount: -100, description: 'SHOP', status: 'completed', type: 'normal', identifier: 'i1', payload: {} }] });
    await env.ask(Q('q3', 'chat-aaaa1111'));
    expect(env.firstPrompt()).not.toContain(EARLIER);
  });

  it('is emptied when the vault locks and by a panic', async () => {
    const env = setup();
    await env.ask(Q('q1', 'chat-aaaa1111'));
    expect((await env.call('/lock', { method: 'POST', body: '{}' })).status).toBe(200);
    expect(env.state.vault).toBeNull();
    await env.ask(Q('q2', 'chat-aaaa1111'));
    expect(env.firstPrompt()).not.toContain(EARLIER);
    // stored with no vault open (a local model); a panic empties it too
    await env.ask(Q('q3', 'chat-aaaa1111'));
    expect(env.firstPrompt()).toContain(EARLIER);
    await env.panic('test');
    await env.ask(Q('q4', 'chat-aaaa1111'));
    expect(env.firstPrompt()).not.toContain(EARLIER);
  });
});
