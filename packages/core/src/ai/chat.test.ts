import { describe, expect, it } from 'vitest';
import { ensureAccount } from '../db/accounts.js';
import { openDb } from '../db/db.js';
import { runEngine } from '../engine/run.js';
import { ingestBatch } from '../ingest/ingest.js';
import type { NormalizedRow } from '../ingest/types.js';
import { CHAT_TOOLS, chat, chatSystemPrompt } from './chat.js';
import type { AiProvider } from './provider.js';

const row = (date: string, amount: number, description: string): NormalizedRow => ({ externalAccountId: 'x', date, amount, description, status: 'completed', type: 'normal', identifier: `${description}${date}${amount}`, payload: {} });

function seed() {
  const db = openDb(':memory:');
  const acc = ensureAccount(db, { institutionId: 'max', institutionKind: 'card', institutionDisplayName: 'Max ****1234', source: 'scraper:max', externalId: 'm', type: 'credit_card', last4: '1234' }).accountId;
  const month = '2026-11';
  ingestBatch(db, { source: 'scraper:max', runId: null, accountId: acc, rows: [row(`${month}-02`, -5000, 'WOLT'), row(`${month}-03`, -31800, 'דקאתלון 48812345'), row(`${month}-04`, -12000, 'SUPERMARKET'), row(`${month}-01`, 1400000, 'SALARY')] });
  runEngine(db);
  return db;
}

/** A scripted model: first asks for a lookup, then answers with what it saw. */
function scripted(script: Array<string | ((user: string) => string)>): AiProvider & { prompts: string[] } {
  const prompts: string[] = [];
  let i = 0;
  return {
    name: 'fake',
    model: 'fake-chat',
    prompts,
    async complete({ user }) {
      prompts.push(user);
      const s = script[Math.min(i++, script.length - 1)]!;
      return typeof s === 'function' ? s(user) : s;
    },
  };
}

describe('ask my money', () => {
  it('looks things up through the fixed tools and answers from the results only', async () => {
    const db = seed();
    const model = scripted([
      '{"tool": "top_merchants", "args": {"from": "2026-11-01", "to": "2026-11-30", "limit": 3}}',
      (user) => {
        expect(user).toContain('Lookups so far');
        expect(user).toContain('"merchant":"Wolt"');
        return 'Some text first {"answer": "הכי הרבה יצא בדקאתלון: 318 ₪."}';
      },
    ]);
    const r = await chat(db, model, [{ role: 'user', content: 'איפה יצא הכי הרבה כסף החודש?' }], { today: '2026-11-09' });
    expect(r.answer).toBe('הכי הרבה יצא בדקאתלון: 318 ₪.');
    expect(r.steps).toEqual([{ tool: 'top_merchants', args: { from: '2026-11-01', to: '2026-11-30', limit: 3 }, summary: 'top_merchants (from=2026-11-01, to=2026-11-30, limit=3)' }]);
    expect(r.rounds).toBe(2);
    // the system prompt lists every tool and the protocol
    const sys = chatSystemPrompt('he', '2026-11-09');
    for (const t of CHAT_TOOLS) expect(sys).toContain(t.name);
    expect(sys).toContain('{"tool"');
  });

  it('tool results never carry account numbers, raw descriptions or digit runs inside names', () => {
    const db = seed();
    const outputs = CHAT_TOOLS.map((t) => JSON.stringify(t.run(db, { month: '2026-11', from: '2026-11-01', to: '2026-11-30', q: 'דקאתלון' }, '2026-11-09')));
    const all = outputs.join('\n');
    expect(all).not.toContain('1234');
    expect(all).not.toContain('48812345');
    expect(all).not.toContain('descriptionRaw');
    expect(all).not.toContain('identifier');
    expect(all).toContain('Wolt');
    expect(outputs[CHAT_TOOLS.findIndex((t) => t.name === 'month_summary')]).toContain('"income":14000');
  });

  it('an unknown tool is reported back and a plain-text reply counts as the answer', async () => {
    const db = seed();
    const model = scripted(['{"tool": "bank_password", "args": {}}', 'I cannot do that.']);
    const r = await chat(db, model, [{ role: 'user', content: 'what is my password' }], { today: '2026-11-09' });
    expect(model.prompts[1]).toContain('unknown tool bank_password');
    expect(r.answer).toBe('I cannot do that.');
    await expect(chat(db, model, [{ role: 'assistant', content: 'hi' }])).rejects.toThrow();
  });
});
