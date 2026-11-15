/** chat-v2 step 1: replies always parse, raw JSON never reaches the user. */
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/db.js';
import { CHAT_REPLY_FORMAT, UNREADABLE_REPLY, chat, hebrewGershayim, parseReply } from './chat.js';
import { createProvider, type AiProvider } from './provider.js';

describe('parseReply', () => {
  it('reads lookups and answers, including the new null fields', () => {
    expect(parseReply('{"tool": "month_summary", "args": {"month": "2026-11"}, "answer": null}')).toEqual({ tool: 'month_summary', args: { month: '2026-11' } });
    expect(parseReply('{"tool": null, "args": {}, "answer": "₪1,200"}')).toEqual({ answer: '₪1,200', followUps: [] });
    expect(parseReply('```json\n{"answer": "ok"}\n```')).toEqual({ answer: 'ok', followUps: [] });
    expect(parseReply('{"tool": "x", "args": [1]}')).toEqual({ tool: 'x', args: {} });
  });

  it('repairs a straight quote inside a Hebrew abbreviation', () => {
    expect(hebrewGershayim('חו"ל ש"ח "x"')).toBe('חו״ל ש״ח "x"');
    // the model forgot to escape: invalid JSON, readable after the repair
    expect(parseReply('{"answer": "הוצאות חו"ל: 1,200 ש"ח"}')).toEqual({ answer: 'הוצאות חו״ל: 1,200 ש״ח', followUps: [] });
  });

  it('salvages the answer from JSON that still does not parse (the 2026-11-13 screenshot)', () => {
    // an escaped quote next to a Latin letter plus a raw newline: JSON.parse fails on the newline
    const broken = '{"answer":"אוקיי — כ\\"הוצאות על הרכב\\": דלק,\nאו מיקום ILS."}';
    const r = parseReply(broken);
    expect(r.answer).toBe('אוקיי — כ"הוצאות על הרכב": דלק,\nאו מיקום ILS.');
    expect(r.answer).not.toContain('{"answer"');
  });

  it('never shows JSON it cannot read; prose stays an answer', () => {
    expect(parseReply('{"tool": "month_summary", "args": {"month": ')).toEqual({ unreadable: true });
    expect(parseReply('{"answer": ""}')).toEqual({ unreadable: true });
    expect(parseReply('{"foo": 1}')).toEqual({ unreadable: true });
    expect(parseReply('')).toEqual({ unreadable: true });
    expect(parseReply('You spent ₪300 {roughly}.')).toEqual({ answer: 'You spent ₪300 {roughly}.', followUps: [] });
  });
});

describe('follow-ups (chat v2 step 4)', () => {
  it('parseReply reads followUps on an answer; missing or garbage is []', () => {
    expect(parseReply('{"tool": null, "args": {}, "answer": "₪1,200", "followUps": ["And by month?", "ולפי בתי עסק?"]}')).toEqual({ answer: '₪1,200', followUps: ['And by month?', 'ולפי בתי עסק?'] });
    expect(parseReply('{"tool": null, "args": {}, "answer": "x"}').followUps).toEqual([]);
    expect(parseReply('{"tool": null, "args": {}, "answer": "x", "followUps": "And by month?"}').followUps).toEqual([]);
    expect(parseReply('{"tool": null, "args": {}, "answer": "x", "followUps": {"a": 1}}').followUps).toEqual([]);
    expect(parseReply('{"tool": null, "args": {}, "answer": "x", "followUps": null}').followUps).toEqual([]);
    // a lookup reply carries none, even when the model sent some
    expect(parseReply('{"tool": "month_summary", "args": {}, "answer": null, "followUps": ["x?"]}')).toEqual({ tool: 'month_summary', args: {} });
    // broken JSON with a trailing followUps: the answer is still salvaged, the chips dropped
    expect(parseReply('{"answer": "כ"א\nב", "followUps": ["ולפי חודש?"]}')).toEqual({ answer: 'כ"א\nב', followUps: [] });
  });

  it('cleanFollowUps: strings only, trimmed, collapsed, ≤80 chars, deduped, ≤3, never the question itself', async () => {
    const { cleanFollowUps } = await import('./chat.js');
    expect(cleanFollowUps([' And   by\nmonth? ', 42, null, 'x'.repeat(81), 'and by month?', 'By category?', 'How much in 2025?', 'One more?'])).toEqual(['And by month?', 'By category?', 'How much in 2025?']);
    expect(cleanFollowUps(['How much on fuel', 'And by month?'], 'How much on fuel?')).toEqual(['And by month?']);
    expect(cleanFollowUps(['', '   ', '?'])).toEqual([]);
    expect(cleanFollowUps('x')).toEqual([]);
    expect(cleanFollowUps(['y'.repeat(80)])).toHaveLength(1);
  });

  it('chat() passes the follow-ups of the final answer through, without the question', async () => {
    let n = 0;
    const model: AiProvider = {
      name: 'fake',
      model: 'fake',
      complete: async () =>
        n++ === 0
          ? '{"tool": "month_summary", "args": {"month": "2026-11"}, "answer": null, "followUps": ["ignored?"]}'
          : '{"tool": null, "args": {}, "answer": "₪0", "followUps": ["And last month?", "How did November go?"]}',
    };
    const r = await chat(openDb(':memory:'), model, [{ role: 'user', content: 'How did November go?' }], { today: '2026-11-13' });
    expect(r.followUps).toEqual(['And last month?']);
    // an unreadable reply: no chips
    const bad: AiProvider = { name: 'fake', model: 'fake', complete: async () => '{"tool": "x", "args": {"a' };
    expect((await chat(openDb(':memory:'), bad, [{ role: 'user', content: 'hi' }], { today: '2026-11-13' })).followUps).toEqual([]);
  });

  it('the reply schema offers followUps without requiring it; the prompt asks for them and the Hebrew labels', async () => {
    const { chatSystemPrompt } = await import('./chat.js');
    const schema = CHAT_REPLY_FORMAT.schema as { properties: Record<string, unknown>; required: string[] };
    expect(schema.properties.followUps).toMatchObject({ type: 'array', items: { type: 'string' }, maxItems: 3 });
    expect(schema.required).toEqual(['tool', 'args', 'answer']);
    const p = chatSystemPrompt('he', '2026-11-13');
    expect(p).toContain('"followUps"');
    expect(p).toMatch(/up to 3 short questions/);
    expect(p).toMatch(/Never write follow-up offers/);
    expect(p).toMatch(/after a refusal or when your answer is a clarifying question/);
    expect(p).toContain('"money received from a person" = "כסף שהתקבל מאדם"');
    expect(p).toContain('"unnamed transaction" = "עסקה ללא שם"');
  });
});

describe('chat with an unreadable reply', () => {
  it('answers with a short retry message in the interface language, never the raw text', async () => {
    const db = openDb(':memory:');
    const model: AiProvider = { name: 'fake', model: 'fake', complete: async () => '{"tool": "month_summary", "args": {"mo' };
    const r = await chat(db, model, [{ role: 'user', content: 'כמה הוצאתי?' }], { today: '2026-11-13' });
    expect(r.answer).toBe(UNREADABLE_REPLY.he);
  });

  it('asks the provider for the structured reply format', async () => {
    const db = openDb(':memory:');
    const formats: unknown[] = [];
    const model: AiProvider = {
      name: 'fake',
      model: 'fake',
      complete: async (input) => {
        formats.push(input.format);
        return '{"tool": null, "args": {}, "answer": "שלום"}';
      },
    };
    expect((await chat(db, model, [{ role: 'user', content: 'hi' }], { today: '2026-11-13' })).answer).toBe('שלום');
    expect(formats[0]).toBe(CHAT_REPLY_FORMAT);
  });
});

describe('providers enforce the reply format', () => {
  const format = CHAT_REPLY_FORMAT;
  const reply = { tool: null, args: {}, answer: 'הוצאות חו"ל: ₪1,200' };

  it('anthropic: a forced tool call, its input returned as JSON', async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ content: [{ type: 'tool_use', name: 'reply', input: reply }], stop_reason: 'tool_use' }), { status: 200 });
    }) as typeof fetch;
    const p = createProvider({ provider: 'anthropic', model: '', apiKey: 'k', fetchImpl });
    const out = await p.complete({ system: 's', user: 'u', format });
    expect(JSON.parse(out)).toEqual(reply);
    expect(parseReply(out)).toEqual({ answer: 'הוצאות חו"ל: ₪1,200', followUps: [] });
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'reply' });
    expect((body.tools as Array<{ name: string; input_schema: unknown }>)[0]).toMatchObject({ name: 'reply', input_schema: format.schema });
  });

  it('anthropic: out of tokens before the tool call is an error, not half a reply', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ content: [{ type: 'text', text: '{"answer": "הו' }], stop_reason: 'max_tokens' }), { status: 200 })) as typeof fetch;
    const p = createProvider({ provider: 'anthropic', model: '', apiKey: 'k', fetchImpl });
    await expect(p.complete({ system: 's', user: 'u', format })).rejects.toThrow(/out of output tokens/);
  });

  it('openai: response_format json_schema; local: plain text (no response_format)', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) }, finish_reason: 'stop' }] }), { status: 200 });
    }) as typeof fetch;
    await createProvider({ provider: 'openai', model: '', apiKey: 'k', fetchImpl }).complete({ system: 's', user: 'u', format });
    expect(bodies[0]!.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'reply', description: format.description, schema: format.schema, strict: false } });
    await createProvider({ provider: 'local', model: 'qwen2.5', fetchImpl }).complete({ system: 's', user: 'u', format });
    expect(bodies[1]).not.toHaveProperty('response_format');
    // no format → unchanged request
    await createProvider({ provider: 'openai', model: '', apiKey: 'k', fetchImpl }).complete({ system: 's', user: 'u' });
    expect(bodies[2]).not.toHaveProperty('response_format');
  });

  it('openai: cut off by the token limit with a format is an error', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"answer": "הו' }, finish_reason: 'length' }] }), { status: 200 })) as typeof fetch;
    await expect(createProvider({ provider: 'openai', model: '', apiKey: 'k', fetchImpl }).complete({ system: 's', user: 'u', format })).rejects.toThrow(/out of output tokens/);
  });
});

describe('review fixes', () => {
  it('a placeholder tool next to an answer is the answer; a known tool is still a lookup', () => {
    expect(parseReply('{"tool": "none", "args": {}, "answer": "התשובה"}')).toEqual({ answer: 'התשובה', followUps: [] });
    expect(parseReply('{"tool": "month_summary", "args": {}, "answer": "x"}')).toEqual({ tool: 'month_summary', args: {} });
    // an unknown tool with no answer is still reported back to the model
    expect(parseReply('{"tool": "bank_password", "args": {}}')).toEqual({ tool: 'bank_password', args: {} });
  });

  it('args sent as a JSON string are parsed', () => {
    expect(parseReply('{"tool": "find_transactions", "args": "{\\"q\\": \\"דלק\\"}", "answer": null}')).toEqual({ tool: 'find_transactions', args: { q: 'דלק' } });
    expect(parseReply('{"tool": "find_transactions", "args": "not json", "answer": null}')).toEqual({ tool: 'find_transactions', args: {} });
  });

  it('out of tokens → a short localised message, not an error', async () => {
    const { AiError } = await import('./provider.js');
    const { TOO_LONG_REPLY } = await import('./chat.js');
    const model: AiProvider = { name: 'fake', model: 'fake', complete: async () => { throw new AiError('the model ran out of output tokens before answering'); } };
    // the message follows the question's language, not the interface default (Hebrew)
    expect((await chat(openDb(':memory:'), model, [{ role: 'user', content: 'hi' }], { today: '2026-11-13' })).answer).toBe(TOO_LONG_REPLY.en);
    expect((await chat(openDb(':memory:'), model, [{ role: 'user', content: 'כמה?' }], { today: '2026-11-13' })).answer).toBe(TOO_LONG_REPLY.he);
  });

  it('each round tells the model the language of the latest question', async () => {
    const { questionLang } = await import('./chat.js');
    expect(questionLang([{ role: 'user', content: 'How much on fuel?' }])).toBe('en');
    expect(questionLang([{ role: 'user', content: 'כמה על דלק?' }, { role: 'assistant', content: 'ok' }])).toBe('he');
    expect(questionLang([{ role: 'user', content: 'כמה?' }, { role: 'assistant', content: 'x' }, { role: 'user', content: 'and by month?' }])).toBe('en');
    const users: string[] = [];
    const model: AiProvider = { name: 'fake', model: 'fake', complete: async ({ user }) => { users.push(user); return '{"tool": null, "args": {}, "answer": "ok"}'; } };
    await chat(openDb(':memory:'), model, [{ role: 'user', content: 'How much on fuel?' }], { today: '2026-11-13' });
    expect(users[0]).toContain('Answer in English.');
  });

  it('anthropic: max_tokens wins over a partial tool call', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ content: [{ type: 'tool_use', name: 'reply', input: { answer: 'הו' } }], stop_reason: 'max_tokens' }), { status: 200 })) as typeof fetch;
    await expect(createProvider({ provider: 'anthropic', model: '', apiKey: 'k', fetchImpl }).complete({ system: 's', user: 'u', format: CHAT_REPLY_FORMAT })).rejects.toThrow(/out of output tokens before answering$/);
  });
});
