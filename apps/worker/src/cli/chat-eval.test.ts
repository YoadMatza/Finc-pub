import { type AiProvider, runChatEval } from '@finc/core';
import { describe, expect, it } from 'vitest';
import { formatEvalSummary, formatEvalTable } from './chat-eval.js';

describe('finc chat-eval output', () => {
  it('a compact table (two lines per case, one-line answers) and a summary line', async () => {
    const model: AiProvider = { name: 'fake', model: 'fake-1', complete: async () => JSON.stringify({ tool: null, args: {}, answer: 'סה״כ\n⁦830⁩ ₪' }) };
    const { results, summary } = await runChatEval(model, { only: ['car-avg-he', 'ambiguous-en'] });
    const lines = formatEvalTable(results);
    expect(lines).toHaveLength(1 + 2 * results.length);
    expect(lines[1]).toMatch(/^car-avg-he\s+he\s+answer\s+answer\s+yes/);
    expect(lines[2]).toContain('סה״כ 830 ₪');
    expect(lines[3]).toMatch(/^ambiguous-en\s+en\s+ask\s+answer\s+NO/);
    expect(formatEvalSummary(summary)).toBe(`fake/fake-1: 2 cases · answered 2 · correct 1 · asked instead 0 · leaked 0 · errors 0 · avg rounds 1 · avg ${summary.avgMs} ms · 2 calls`);
  });
});
