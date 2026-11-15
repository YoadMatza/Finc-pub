/**
 * Runs the chat eval (chat v2 step 3): every case's turns through chat() against the in-memory fixture, never the
 * live database, then scores the last answer. Multi-turn cases replay the model's own earlier answers as history and
 * carry the lookups forward as `previousLookups`, as the worker's chat memory does (newest 8, at most 24,000 chars).
 */
import type { Db } from '../../db/db.js';
import { type ChatMessage, TOO_LONG_REPLY, UNREADABLE_REPLY, chat } from '../chat.js';
import type { AiProvider } from '../provider.js';
import { type EvalCase, evalCases } from './cases.js';
import { EVAL_TODAY, buildEvalFixture } from './fixture.js';
import { containsWord, forbiddenIn, hasAmounts, isAsk, matchNumbers } from './score.js';

export interface EvalCaseResult {
  id: string;
  lang: 'he' | 'en';
  modeExpected: 'answer' | 'ask';
  modeGot: 'answer' | 'ask' | 'error';
  /** a usable answer (not a question back, not an error or an unreadable reply) */
  answered: boolean;
  /** answer cases: answered, every expected amount and include found, no amounts on a refusal, nothing leaked;
   *  ask cases: asked, nothing leaked */
  correct: boolean;
  /** an answer was expected and the model asked a question instead */
  askedInstead: boolean;
  leaked: boolean;
  /** the forbidden strings seen, and where ("answer" or "lookups") */
  leaks: string[];
  expected: number[];
  missing: number[];
  /** include groups none of whose strings appeared */
  missingInclude: string[][];
  /** expect.notInAnswer strings found in the last answer (wrong wording; not a leak) */
  unwanted: string[];
  rounds: number;
  tools: string[];
  calls: number;
  ms: number;
  /** the last answer, at most 300 characters */
  answer: string;
  error?: string;
}

export interface EvalSummary {
  provider: string;
  model: string;
  cases: number;
  answered: number;
  correct: number;
  askedInstead: number;
  leaked: number;
  errors: number;
  avgRounds: number;
  avgMs: number;
  /** provider calls in all */
  calls: number;
}

export interface ChatEvalOptions {
  /** case ids to run (default all) */
  only?: string[];
  onCase?: (r: EvalCaseResult) => void;
  /** a prebuilt fixture (tests); default a fresh one */
  db?: Db;
  /** other cases (tests); default evalCases(db) */
  cases?: EvalCase[];
}

const MEMORY_LOOKUPS = 8;
const MEMORY_CHARS = 24_000;
function newest(lookups: readonly string[]): string[] {
  const kept: string[] = [];
  let chars = 0;
  for (let i = lookups.length - 1; i >= 0 && kept.length < MEMORY_LOOKUPS; i--) {
    const l = lookups[i]!;
    if (chars + l.length > MEMORY_CHARS) break;
    kept.unshift(l);
    chars += l.length;
  }
  return kept;
}

const FAILED_REPLIES = new Set<string>([...Object.values(UNREADABLE_REPLY), ...Object.values(TOO_LONG_REPLY)]);

/** Score one finished case. Exported for tests. */
export function scoreCase(c: EvalCase, answer: string, lookups: readonly string[], extra: { rounds: number; tools: string[]; calls: number; ms: number; error?: string; earlierAnswers?: readonly string[] }): EvalCaseResult {
  const e = c.expect;
  const expected = e.numbers ?? [];
  // every turn's answer is checked for leaks, not only the last one, and so is everything the model was sent
  const answers = [...(extra.earlierAnswers ?? []), answer];
  const leaks = [
    ...answers.flatMap((a, i) => forbiddenIn(a, e.forbid ?? []).map((f) => `${f} (answer${answers.length > 1 ? `, turn ${i + 1}` : ''})`)),
    ...forbiddenIn(lookups.join('\n'), e.forbid ?? []).map((f) => `${f} (lookups)`),
  ];
  const failed = extra.error !== undefined || !answer.trim() || FAILED_REPLIES.has(answer);
  const modeGot: EvalCaseResult['modeGot'] = failed ? 'error' : isAsk(answer, expected) ? 'ask' : 'answer';
  const { missing } = matchNumbers(answer, expected);
  const missingInclude = (e.include ?? []).filter((g) => !g.some((s) => containsWord(answer, s)));
  const unwanted = forbiddenIn(answer, e.notInAnswer ?? []);
  const leaked = leaks.length > 0;
  const answered = modeGot === 'answer';
  const correct =
    !leaked &&
    unwanted.length === 0 &&
    (e.mode === 'ask' ? modeGot === 'ask' : answered && missing.length === 0 && missingInclude.length === 0 && !(e.noNumbers && hasAmounts(answer)));
  return {
    id: c.id,
    lang: c.lang,
    modeExpected: e.mode,
    modeGot,
    answered,
    correct,
    askedInstead: e.mode === 'answer' && modeGot === 'ask',
    leaked,
    leaks,
    expected,
    missing,
    missingInclude,
    unwanted,
    rounds: extra.rounds,
    tools: extra.tools,
    calls: extra.calls,
    ms: extra.ms,
    answer: answer.length > 300 ? `${answer.slice(0, 297)}...` : answer,
    ...(extra.error !== undefined ? { error: extra.error } : {}),
  };
}

/** Run the eval cases against `provider`. Sends fixture data only. */
export async function runChatEval(provider: AiProvider, opts: ChatEvalOptions = {}): Promise<{ results: EvalCaseResult[]; summary: EvalSummary }> {
  const db = opts.db ?? buildEvalFixture();
  const all = opts.cases ?? evalCases(db);
  const only = opts.only?.length ? new Set(opts.only) : null;
  if (only) {
    const unknown = [...only].filter((id) => !all.some((c) => c.id === id));
    if (unknown.length) throw new Error(`unknown case id(s): ${unknown.join(', ')}`);
  }
  const cases = only ? all.filter((c) => only.has(c.id)) : all;
  let calls = 0;
  const counted: AiProvider = {
    name: provider.name,
    model: provider.model,
    complete: (input) => {
      calls++;
      return provider.complete(input);
    },
  };
  const results: EvalCaseResult[] = [];
  for (const c of cases) {
    const t0 = Date.now();
    const callsBefore = calls;
    const history: ChatMessage[] = [];
    let memory: string[] = [];
    const seen: string[] = [];
    const tools: string[] = [];
    let rounds = 0;
    let answer = '';
    const earlierAnswers: string[] = [];
    let error: string | undefined;
    for (const q of c.turns) {
      history.push({ role: 'user', content: q });
      if (answer) earlierAnswers.push(answer);
      try {
        const r = await chat(db, counted, history, { today: EVAL_TODAY, previousLookups: memory });
        rounds += r.rounds;
        tools.push(...r.steps.map((s) => s.tool));
        seen.push(...r.lookups);
        memory = newest([...memory, ...r.lookups]);
        answer = r.answer;
        history.push({ role: 'assistant', content: r.answer });
      } catch (e) {
        error = (e instanceof Error ? e.message : String(e)).slice(0, 200);
        answer = '';
        break;
      }
    }
    const res = scoreCase(c, answer, seen, { rounds, tools, calls: calls - callsBefore, ms: Date.now() - t0, earlierAnswers, ...(error !== undefined ? { error } : {}) });
    results.push(res);
    opts.onCase?.(res);
  }
  const n = results.length;
  const count = (f: (r: EvalCaseResult) => boolean) => results.filter(f).length;
  const avg = (f: (r: EvalCaseResult) => number) => (n ? Math.round((results.reduce((s, r) => s + f(r), 0) / n) * 10) / 10 : 0);
  return {
    results,
    summary: {
      provider: provider.name,
      model: provider.model,
      cases: n,
      answered: count((r) => r.answered),
      correct: count((r) => r.correct),
      askedInstead: count((r) => r.askedInstead),
      leaked: count((r) => r.leaked),
      errors: count((r) => r.modeGot === 'error'),
      avgRounds: avg((r) => r.rounds),
      avgMs: Math.round(avg((r) => r.ms)),
      calls,
    },
  };
}
