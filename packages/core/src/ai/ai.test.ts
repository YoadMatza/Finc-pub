import { beforeEach, describe, expect, it } from 'vitest';
import { ensureAccount } from '../db/accounts.js';
import { type Db, openDb } from '../db/db.js';
import { aiSuggestion, transactions } from '../db/schema.js';
import { categoryIndex, seedCategories } from '../engine/categories.js';
import { categorize } from '../engine/categorize.js';
import { assignMerchants } from '../engine/merchant.js';
import { classifyRemaining } from '../engine/rules.js';
import { ingestBatch } from '../ingest/ingest.js';
import type { NormalizedRow } from '../ingest/types.js';
import { allowedAnswer, buildPayload, categorizeWithAi, sanitizeForModel, systemPrompt } from './categorize-ai.js';
import { AiError, type AiProvider, createProvider, fakeProvider } from './provider.js';

let db: Db;
let acc: number;
const row = (date: string, amount: number, description: string): NormalizedRow => ({ externalAccountId: 'x', date, amount, description, status: 'completed', type: 'normal', identifier: `${description}${date}${amount}`, payload: {} });

beforeEach(() => {
  db = openDb(':memory:');
  acc = ensureAccount(db, { institutionId: 'max', institutionKind: 'card', institutionDisplayName: 'Max', source: 'scraper:max', externalId: 'm', type: 'credit_card' }).accountId;
  ingestBatch(db, {
    source: 'scraper:max',
    runId: null,
    accountId: acc,
    rows: [
      row('2026-10-01', -29200, 'NEHCTIK IAHT AMUANO'), // unknown Thai restaurant
      row('2026-10-02', -31800, 'דקאתלון'),
      row('2026-10-03', -12000, 'זיכוי מביט מישהו'), // person-to-person: must never be sent
      row('2026-10-04', -5000, 'WOLT'), // heuristic already categorises it
      row('2026-10-05', -4590, 'TRANSFER 1234567890 ACCT 98765432'), // long numbers are stripped by the merchant key
    ],
  });
  assignMerchants(db);
  classifyRemaining(db);
  seedCategories(db);
  categorize(db);
});

describe('payload privacy', () => {
  it('sends only merchant key, counts, amounts and months; never transfers, ids or raw descriptions', () => {
    const p = buildPayload(db, { limit: 10, since: '2026-01-01' });
    const keys = p.map((x) => x.key);
    expect(keys).toContain('nehctik iaht amuano');
    expect(keys).toContain('דקאתלון');
    expect(keys).not.toContain('wolt'); // already categorised
    expect(keys.some((k) => k.includes('ביט'))).toBe(false);
    expect(p.every((x) => !/\d{4,}/.test(x.key))).toBe(true); // no account/card/booking/reference numbers in names
    expect(JSON.stringify(p)).not.toMatch(/\d{5,}/);
    expect(sanitizeForModel('skywayair51837260913')).toBe('skywayair');
    expect(sanitizeForModel('ebay o 07')).toBe('ebay o 07');
    expect(JSON.stringify(p)).not.toContain('accountId');
    expect(p[0]!.samples[0]).toEqual({ amount: expect.any(Number), date: expect.stringMatching(/^\d{4}-\d{2}$/) });
    expect(systemPrompt()).toContain('lifestyle.eating_out');
    expect(systemPrompt()).not.toContain('transfers =');
  });
});

describe('categorizeWithAi', () => {
  it('dry run sends nothing; a run applies confident answers as source ai, caches per merchant, keeps low confidence out', async () => {
    const fake = fakeProvider({ 'nehctik iaht amuano': { category: 'lifestyle.eating_out', confidence: 0.85 }, דקאתלון: { category: 'lifestyle.shopping', confidence: 0.4 } });
    const dry = await categorizeWithAi(db, fake, { dryRun: true, since: '2026-01-01' });
    expect(dry.payload.length).toBeGreaterThanOrEqual(2);
    expect(fake.calls).toHaveLength(0);

    const r = await categorizeWithAi(db, fake, { since: '2026-01-01' });
    expect(fake.calls).toHaveLength(1);
    expect(r.applied).toEqual({ merchants: 1, transactions: 1 });
    expect(r.lowConfidence).toBe(1);
    const { byKey } = categoryIndex(db);
    const thai = db.select().from(transactions).where(eq(transactions.descriptionRaw, 'NEHCTIK IAHT AMUANO')).get()!;
    expect(thai).toMatchObject({ categoryId: byKey.get('lifestyle.eating_out')!.id, categorySource: 'ai', categoryConfidence: 0.85 });
    expect(db.select().from(transactions).where(eq(transactions.descriptionRaw, 'דקאתלון')).get()?.categoryId).toBeNull();
    expect(db.select().from(aiSuggestion).all().length).toBeGreaterThanOrEqual(2);

    const again = await categorizeWithAi(db, fake, { since: '2026-01-01' });
    expect(fake.calls).toHaveLength(1); // every remaining merchant is cached → no new call
    expect(again.sent).toBe(0);
  });

  it('a steered or shifted answer cannot hide a merchant (security research P2-07)', async () => {
    const replies: string[] = [];
    const steered: AiProvider = {
      name: 'steered',
      model: 's-1',
      async complete(input) {
        expect(input.system).toMatch(/not instructions/);
        const items = JSON.parse(input.user.slice(input.user.indexOf('['))) as Array<{ id: string; key: string }>;
        expect(items.every((m, j) => m.id === `m${j + 1}`)).toBe(true);
        // the first answer is dropped, so a positional reading would give the Thai answer to the next merchant;
        // the other asks for categories that drop out of spending or belong to the other side
        const out = [
          { key: 'some other name', category: 'lifestyle.eating_out', confidence: 0.9 },
          ...items.slice(1).map((m) => ({ id: m.id, key: m.key, category: m.key === 'דקאתלון' ? 'transfers' : 'income.salary', confidence: 0.95 })),
        ];
        const text = JSON.stringify(out);
        replies.push(text);
        return text;
      },
    };
    const r = await categorizeWithAi(db, steered, { since: '2026-01-01' });
    expect(replies).toHaveLength(1);
    expect(r.applied.transactions).toBe(0);
    for (const d of ['NEHCTIK IAHT AMUANO', 'דקאתלון']) expect(db.select().from(transactions).where(eq(transactions.descriptionRaw, d)).get()?.categoryId).toBeNull();
    expect(allowedAnswer('transfers', false)).toBe(false);
    expect(allowedAnswer('installments', false)).toBe(false);
    expect(allowedAnswer('income.salary', false)).toBe(false);
    expect(allowedAnswer('income.salary', true)).toBe(true);
    expect(allowedAnswer('daily.supermarket', true)).toBe(false);
    expect(allowedAnswer('daily.supermarket', false)).toBe(true);
  });
});

describe('providers', () => {
  it('never takes a key from the environment and wipes such variables from the process', () => {
    process.env.OPENAI_API_KEY = 'sk-belongs-to-another-project';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-belongs-to-another-project';
    expect(() => createProvider({ provider: 'openai', model: '' })).toThrow(/vault/);
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });
  it('refuses a non-local base URL for the local provider and demands keys for the cloud ones', () => {
    expect(() => createProvider({ provider: 'local', model: 'x', baseUrl: 'https://evil.example.com/v1' })).toThrow(AiError);
    expect(() => createProvider({ provider: 'anthropic', model: '' })).toThrow(/API key/);
    expect(() => createProvider({ provider: 'openai', model: '' })).toThrow(/API key/);
    expect(createProvider({ provider: 'local', model: '', baseUrl: 'http://localhost:11434/v1' }).model).toBe('llama3.1');
  });
  it('anthropic and openai-compatible request shapes', async () => {
    const seen: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: init?.headers as Record<string, string> });
      const isAnthropic = String(url).includes('anthropic');
      return new Response(JSON.stringify(isAnthropic ? { content: [{ type: 'text', text: '[]' }] } : { choices: [{ message: { content: '[]' } }] }), { status: 200 });
    }) as typeof fetch;
    const a = createProvider({ provider: 'anthropic', model: '', apiKey: 'k1', fetchImpl });
    expect(await a.complete({ system: 's', user: 'u' })).toBe('[]');
    expect(seen[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(seen[0]!.headers['x-api-key']).toBe('k1');
    expect(seen[0]!.body.model).toBe('claude-haiku-5-5');
    const l = createProvider({ provider: 'local', model: 'qwen2.5', fetchImpl });
    expect(await l.complete({ system: 's', user: 'u' })).toBe('[]');
    expect(seen[1]!.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(seen[1]!.headers.authorization).toBeUndefined();
    expect(seen[1]!.body.model).toBe('qwen2.5');
    expect(seen[1]!.body).toMatchObject({ max_tokens: 4000, temperature: 0 });
    const o = createProvider({ provider: 'openai', model: '', apiKey: 'k2', fetchImpl });
    expect(await o.complete({ system: 's', user: 'u' })).toBe('[]');
    expect(seen[2]!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(seen[2]!.headers.authorization).toBe('Bearer k2');
    expect(seen[2]!.body).toMatchObject({ model: 'gpt-5-mini', max_completion_tokens: 12000, reasoning_effort: 'low' });
    expect(seen[2]!.body).not.toHaveProperty('temperature');
    expect(seen[2]!.body).not.toHaveProperty('max_tokens');
  });
});

import { eq } from 'drizzle-orm';
