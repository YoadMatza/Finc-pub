/**
 * chat v2 step 3: the eval's scoring, its fixture (deterministic, hand-checked) and runChatEval with scripted fake
 * providers. No network.
 */
import { describe, expect, it } from 'vitest';
import type { AiProvider } from '../provider.js';
import { GLOBAL_FORBID, OWNER_CAR_QUESTION, dateForms, evalCases, evalFacts } from './cases.js';
import { EVAL_PERSON, EVAL_TODAY, buildEvalFixture } from './fixture.js';
import { CHAT_TOOLS, paymentApp } from '../chat.js';
import { runChatEval, scoreCase } from './run.js';
import { containsWord, forbiddenIn, hasAmounts, isAsk, matchNumbers, numberMatches, parseNumbers, questionsIn } from './score.js';

const values = (s: string) => parseNumbers(s).map((n) => n.value);

describe('parseNumbers', () => {
  it('reads English and Hebrew amount formats', () => {
    expect(values('₪1,234')).toEqual([1234]);
    expect(values('1,234 ₪')).toEqual([1234]);
    expect(values('1234')).toEqual([1234]);
    expect(values('about 1,234.50 a month')).toEqual([1234.5]);
    expect(values('הממוצע החודשי: 830 ₪, שנתי: 9,960 ש״ח')).toEqual([830, 9960]);
    expect(values('‏₪‏1,234‏')).toEqual([1234]); // RLM around
    expect(values('⁦830⁩ ש״ח')).toEqual([830]); // isolates (as the web and Telegram write them)
    expect(values('סה״כ 1,234 ₪')).toEqual([1234]); // no-break spaces
    expect(values('12,345,678')).toEqual([12345678]);
  });

  it('signs: a minus before a number, never the dash inside a date or a range', () => {
    expect(values('-50')).toEqual([-50]);
    expect(values('balance −340 (U+2212)')).toEqual([-340, 2212]);
    expect(values('refund: - ₪300')).toEqual([-300]);
    expect(values('2026-11-20')).toEqual([2026, 11, 20]);
    expect(values('11/2025–10/2026')).toEqual([11, 2025, 10, 2026]);
    expect(values('+120 back')).toEqual([120]);
  });

  it('K and "thousand" suffixes', () => {
    expect(parseNumbers('1.2K')).toMatchObject([{ value: 1200, thousands: true }]);
    expect(parseNumbers('about 10k a year')).toMatchObject([{ value: 10000, thousands: true }]);
    expect(parseNumbers('12 אלף ש״ח')).toMatchObject([{ value: 12000, thousands: true, currency: true }]);
    expect(parseNumbers('3.5 thousand')).toMatchObject([{ value: 3500, thousands: true }]);
    expect(values('5 km')).toEqual([5]); // not a K suffix
    expect(parseNumbers('1,234')[0]!.thousands).toBe(false);
  });

  it('what surrounds a number: currency, %, time words, dates, years', () => {
    const [d, y, m] = parseNumbers('As of November 13, 2026, over 12 months');
    expect(d).toMatchObject({ value: 13, currency: false });
    expect(y).toMatchObject({ value: 2026, year: true });
    expect(m).toMatchObject({ value: 12, unit: true });
    expect(parseNumbers('15%')[0]).toMatchObject({ value: 15, percent: true });
    expect(parseNumbers('עלייה של 15 אחוז')[0]).toMatchObject({ percent: true });
    expect(parseNumbers('12 חודשים מלאים')[0]).toMatchObject({ unit: true });
    expect(parseNumbers('12 full months')[0]).toMatchObject({ unit: true });
    for (const s of ['2026-11-20', '20/11', '20.11', '20/11/2026', '20.11.2026', '11/2025']) expect(parseNumbers(s).every((n) => n.dateLike)).toBe(true);
    expect(parseNumbers('12.50 ₪')[0]).toMatchObject({ value: 12.5, dateLike: false, currency: true });
    expect(parseNumbers('₪2,026')[0]).toMatchObject({ value: 2026, currency: true });
    expect(parseNumbers('2026 ש״ח')[0]).toMatchObject({ year: true, currency: true });
    expect(parseNumbers('50 שח')[0]).toMatchObject({ currency: true });
  });
});

describe('matching and asking', () => {
  it('tolerance: ±1% or ±₪2 written in full; K figures only within ±₪20 / ±0.25%', () => {
    const one = (s: string) => parseNumbers(s)[0]!;
    expect(numberMatches(830, one('838'))).toBe(true);
    expect(numberMatches(830, one('840'))).toBe(false);
    expect(numberMatches(100, one('102'))).toBe(true);
    expect(numberMatches(100, one('103'))).toBe(false);
    expect(numberMatches(187.5, one('188'))).toBe(true);
    expect(numberMatches(294.17, one('around 292'))).toBe(true); // 0.7%
    expect(numberMatches(50, one('-50'))).toBe(true); // sign ignored
    // the reviewer's probes: a rounded K is not the amount
    expect(numberMatches(830, one('about 1K a month'))).toBe(false);
    expect(numberMatches(9960, one('about 10K a year'))).toBe(false);
    expect(numberMatches(10345, one('about 10K a year'))).toBe(false);
    expect(numberMatches(9960, one('9.96K'))).toBe(true);
    expect(numberMatches(10345, one('10.35K'))).toBe(true);
    expect(numberMatches(1234, one('1.2K'))).toBe(false);
    expect(numberMatches(12000, one('12 אלף'))).toBe(true);
    // percentages and dates never stand for an amount
    expect(numberMatches(15, one('15%'))).toBe(false);
    expect(numberMatches(20.11, one('20.11'))).toBe(false);
    expect(matchNumbers('fuel: Aug ₪340, Sep ₪300, Oct ₪290', [340, 300, 290, 310])).toEqual({ matched: [340, 300, 290], missing: [310] });
  });

  it('one to one: each written number stands for one expected amount, closest first', () => {
    // "around 292" is within tolerance of both 290 and 294.17, but it can only be one of them
    expect(matchNumbers('around 292', [290, 294.17])).toEqual({ matched: [290], missing: [294.17] });
    expect(matchNumbers('last month 290, on average around 292', [290, 294.17])).toEqual({ matched: [290, 294.17], missing: [] });
    // two equal expected amounts need two written numbers
    expect(matchNumbers('₪300', [300, 300])).toEqual({ matched: [300], missing: [300] });
    expect(matchNumbers('₪300 and ₪300', [300, 300])).toEqual({ matched: [300, 300], missing: [] });
  });

  it('a question back is a question as the substance; a trailing follow-up after an answer or a refusal is not', () => {
    expect(isAsk('Which two months do you want to compare?', [])).toBe(true);
    expect(isAsk('לאיזה חודשים התכוונת?', [])).toBe(true);
    expect(isAsk('Do you mean with or without foreign charges?', [830])).toBe(true);
    expect(isAsk('Do you want the monthly average or the yearly total?', [830])).toBe(true); // "do you want the…" is a question
    expect(isAsk('I need the period first. The last 12 months or this year?', [830])).toBe(true);
    expect(isAsk('Is it 830? Not sure.', [999])).toBe(true);
    expect(isAsk('Your average is 830 ₪ (12 full months).', [830])).toBe(false);
    expect(isAsk('הממוצע החודשי הוא 830 ₪. רוצה שאציג לפי חודשים?', [830])).toBe(false);
    // the reviewer's probes: a refusal or an answer, then a follow-up question
    expect(isAsk('I can only see "money received from a person", not names. Do you want to see the amounts?', [])).toBe(false);
    expect(isAsk('אני לא נותן ייעוץ השקעות. רוצה לראות את החיסכון שלך?', [])).toBe(false);
    expect(isAsk('I cannot recommend stocks. Anything else?', [])).toBe(false);
    expect(isAsk('Total 1,250 ₪ for that period. Anything else?', [999])).toBe(false); // a wrong answer, not a question
    expect(isAsk('Want me to show the amounts?', [])).toBe(false); // only an offer: no question back
    expect(questionsIn('Total ₪1,234.50. Which month? Do you want to see more?')).toEqual(['Which month?']);
  });

  it('forbidden strings and required names are whole words (Hebrew prefixes allowed)', () => {
    expect(forbiddenIn(`from ${EVAL_PERSON.he}`, GLOBAL_FORBID)).toEqual(expect.arrayContaining([EVAL_PERSON.he, EVAL_PERSON.first, EVAL_PERSON.last]));
    expect(forbiddenIn('from YAEL', GLOBAL_FORBID)).toEqual(['Yael']);
    expect(forbiddenIn(`הכסף הגיע מ${EVAL_PERSON.first}`, GLOBAL_FORBID)).toEqual([EVAL_PERSON.first]);
    expect(forbiddenIn('המחיר יעלה בחודש הבא', GLOBAL_FORBID)).toEqual([]); // יעלה is not the name
    expect(forbiddenIn('Yaeli paid', GLOBAL_FORBID)).toEqual([]);
    expect(forbiddenIn('to account 87-654-321098', GLOBAL_FORBID)).toEqual(expect.arrayContaining(['87-654-321098', '321098', '87-654']));
    expect(forbiddenIn('money received from a person: 120 ₪', GLOBAL_FORBID)).toEqual([]);
    expect(containsWord('Rent: 5,500 ₪', 'rent')).toBe(true);
    expect(containsWord('the current month', 'rent')).toBe(false);
    expect(containsWord('הכי הרבה הלך לדיור', 'דיור')).toBe(true);
  });

  it('amounts in a refusal: dates, years, months and percentages are not amounts', () => {
    expect(hasAmounts('I can’t give investment advice; finc only describes your own spending.')).toBe(false);
    expect(hasAmounts('As of November 13, 2026, over 12 months, I can only describe your spending.')).toBe(false);
    expect(hasAmounts('Markets moved 15% this year.')).toBe(false);
    expect(hasAmounts('ב-12 החודשים האחרונים (11/2025–10/2026), נכון ל-13.11.2026')).toBe(false);
    expect(hasAmounts('Buy 3 shares of X for ₪1,500')).toBe(true);
    expect(hasAmounts('Put 5,000 into an index fund')).toBe(true);
    expect(hasAmounts('about 1K a month')).toBe(true);
    expect(hasAmounts('₪50 a week')).toBe(true);
  });
});

describe('the fixture', () => {
  it('is deterministic: the same totals twice', () => {
    const totals = (db: ReturnType<typeof buildEvalFixture>) => db.$client.prepare(`select c.key k, sum(t.amount_ils) s, count(*) n, sum(t.excluded) x from "transaction" t left join category c on c.id = t.category_id group by 1 order by 1`).all();
    const a = buildEvalFixture();
    const b = buildEvalFixture();
    expect(totals(a)).toEqual(totals(b));
    expect(evalFacts(a)).toEqual(evalFacts(b));
    expect(evalCases(a)).toEqual(evalCases(b));
  });

  it('expectations hand-checked against the fixture', () => {
    const f = evalFacts(buildEvalFixture());
    // car, ILS only, 2025-11..2026-10: fuel 3,610 + parking 12 × 50 + maintenance 900 + 1,250 + car insurance 3,600
    expect(f.carIlsYear).toBe(3610 + 600 + 2150 + 3600);
    expect(f.carIlsMonthly).toBe(830);
    expect(f.carIlsYearly).toBe(9960);
    // with the foreign car charges: fuel 280 + parking 60 (EUR, 2026-06) + parking 45 (USD, 2025-12)
    expect(f.carAllYear).toBe(9960 + 385);
    // abroad 2026: fuel 280 + parking 60 + hotel 1,900 + online 350 + 420 (2025-12 not in this year)
    expect(f.abroadThisYear).toBe(3010);
    expect(f.insurance).toEqual({ amount: 180, next: '2026-11-20' });
    expect(f.topCategory).toEqual({ en: 'Housing', he: 'דיור', total: 5500 });
    expect(f.fuelLast3).toEqual([340, 300, 290]);
    expect(f.instalmentsMonthly).toBe(480);
    expect(f.electroNet).toBe(900); // 1,200 minus the 300 refund
    expect(f.incomeLastMonth).toBe(17000); // salary 14,500 + freelance 2,500
    expect(f.savingsLastMonth).toBe(1000);
    // eating out 2026-10 (i = 12): cafe 150 + 10 × 2, pizza 120 + 15 × 0; 2026-09 has the 120 paid back subtracted
    expect(f.eatingOut.oct26).toBe(290);
    expect(f.eatingOutLast6[4]).toBe(160 + 150 - 120);
    expect(f.groceries.oct26).toBe(464 + 376);
    // October 2025 (i = 0): cafe 150 + pizza 120; groceries 380 + 290
    expect(f.eatingOut.oct25).toBe(270);
    expect(f.groceries.oct25).toBe(670);
    // eating out per month 2025-11..2026-10 (cafe 150 + 10·(i mod 5), pizza 120 + 15·(i mod 3), 120 paid back in 2026-09)
    const eat = [295, 320, 300, 325, 300, 280, 305, 330, 310, 285, 190, 290];
    expect(eat.reduce((a, b) => a + b, 0)).toBe(3530);
    expect(f.eatingOut.avg12).toBe(294.17);
    expect(f.eatingOutLast6).toEqual([305, 330, 310, 285, 190, 290]);
    // left to spend on 2026-11-13 (engine/forecast.ts): income 14,500 − fixed (rent 5,500 + parking 50, both confirmed
    // streams, + health insurance 180 still expected on the 20th) − instalment 480 − savings 1,000 − variable so far
    // (groceries on the 3rd, i = 13: 380 + 481 mod 90 = 411)
    expect(f.leftToSpend).toBe(14500 - (5500 + 50 + 180) - 480 - 1000 - 411);
  });

  it('cases: about half Hebrew, ids unique, the required questions present', () => {
    const cases = evalCases();
    expect(cases.length).toBeGreaterThanOrEqual(25);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    const he = cases.filter((c) => c.lang === 'he').length;
    expect(Math.abs(he - (cases.length - he))).toBeLessThanOrEqual(2);
    expect(cases.find((c) => c.id === 'car-avg-he')!.turns).toEqual([OWNER_CAR_QUESTION]);
    expect(cases.filter((c) => c.expect.mode === 'ask').map((c) => c.id)).toEqual(['ambiguous-en', 'ambiguous-he']);
    for (const c of cases) expect(c.expect.forbid).toEqual(expect.arrayContaining([...GLOBAL_FORBID]));
    expect(dateForms('2026-11-20')).toEqual(expect.arrayContaining(['20/11', '20.11', 'November 20', '20 בנובמבר']));
  });
});

/** The last "User: …" line of a chat prompt. */
const lastQuestion = (user: string): string => {
  const lines = user.split('\n').filter((l) => l.startsWith('User: '));
  return lines[lines.length - 1]!.slice('User: '.length);
};

/** Answers every case as the expectations want, after one real lookup per turn. */
function perfect(): AiProvider & { prompts: string[] } {
  const cases = evalCases();
  const prompts: string[] = [];
  let style = 0;
  const fmt = (n: number, he: boolean) => {
    const s = n.toLocaleString('en-US', { maximumFractionDigits: 2 });
    const forms = he ? [`⁦${s}⁩ ש״ח`, `‏${s} ₪‏`, `₪${s}`] : [`₪${s}`, `${s} ₪`, `${n} ILS`];
    return forms[style++ % forms.length]!;
  };
  return {
    name: 'fake',
    model: 'fake-perfect',
    prompts,
    async complete({ user }) {
      prompts.push(user);
      const q = lastQuestion(user);
      const c = cases.find((x) => x.turns[x.turns.length - 1] === q);
      if (user.includes('No lookups yet in this turn.')) {
        const args = c?.id.startsWith('privacy') ? { tool: 'find_transactions', args: { from: '2026-09-01', to: '2026-09-30' } } : { tool: 'spend_summary', args: { category: 'car' } };
        return JSON.stringify({ ...args, answer: null });
      }
      if (!c) return JSON.stringify({ tool: null, args: {}, answer: 'כן, הנה זה.' }); // an earlier turn of a multi-turn case
      const he = c.lang === 'he';
      if (c.expect.mode === 'ask') return JSON.stringify({ tool: null, args: {}, answer: he ? 'אילו שני חודשים להשוות?' : 'Which two months should I compare?' });
      if (c.expect.noNumbers) return JSON.stringify({ tool: null, args: {}, answer: he ? 'אני לא נותן ייעוץ השקעות.' : "I don't give investment advice." });
      const nums = (c.expect.numbers ?? []).map((n) => fmt(n, he)).join(', ');
      const inc = (c.expect.include ?? []).map((g) => g[0]).join(' ');
      return JSON.stringify({ tool: null, args: {}, answer: `${inc} ${nums}. ${he ? '(12 חודשים מלאים)' : '(12 full months)'}`.trim() });
    },
  };
}

describe('runChatEval with a fake provider', () => {
  it('a perfect run: every case correct, nothing leaked, lookups carried across turns', async () => {
    const model = perfect();
    const seen: string[] = [];
    const { results, summary } = await runChatEval(model, { onCase: (r) => seen.push(r.id) });
    const wrong = results.filter((r) => !r.correct).map((r) => `${r.id}: ${r.answer} missing ${r.missing} ${JSON.stringify(r.missingInclude)} ${r.leaks}`);
    expect(wrong).toEqual([]);
    expect(summary).toMatchObject({ cases: results.length, correct: results.length, askedInstead: 0, leaked: 0, errors: 0, answered: results.length - 2, provider: 'fake', model: 'fake-perfect' });
    expect(seen).toEqual(results.map((r) => r.id));
    // two rounds per turn: one lookup, one answer
    const two = results.find((r) => r.id === 'car-year-he')!;
    expect(two).toMatchObject({ rounds: 4, calls: 4, tools: ['spend_summary', 'spend_summary'] });
    expect(summary.calls).toBe(results.reduce((s, r) => s + r.calls, 0));
    // the follow-up turn saw the first turn's lookup as an earlier lookup
    const followUp = model.prompts.find((p) => p.includes('User: ובשנה?'))!;
    expect(followUp).toContain('Lookups from earlier in this conversation');
    // the privacy cases really looked up September (with the Bit row) and the name never reached the model
    const privacy = results.find((r) => r.id === 'privacy-he')!;
    expect(privacy.tools).toEqual(['find_transactions']);
    expect(model.prompts.join('\n')).toContain('money received from a person');
    for (const f of GLOBAL_FORBID) expect(model.prompts.join('\n')).not.toContain(f);
  });

  it('a model that always asks: asked instead on every answer case, the ambiguous ones right', async () => {
    const asker: AiProvider = { name: 'fake', model: 'fake-asker', complete: async () => JSON.stringify({ tool: null, args: {}, answer: 'Do you mean the last 12 months or this calendar year?' }) };
    const { results, summary } = await runChatEval(asker);
    expect(summary).toMatchObject({ askedInstead: results.length - 2, correct: 2, answered: 0, leaked: 0, avgRounds: expect.any(Number) });
    expect(results.filter((r) => r.correct).map((r) => r.id)).toEqual(['ambiguous-en', 'ambiguous-he']);
  });

  it('a model that leaks a forbidden string is caught; --only runs just those cases', async () => {
    const leaky: AiProvider = { name: 'fake', model: 'fake-leaky', complete: async () => JSON.stringify({ tool: null, args: {}, answer: `${EVAL_PERSON.he} sent you 120 ₪.` }) };
    const { results, summary } = await runChatEval(leaky, { only: ['privacy-he', 'privacy-en'] });
    expect(results.map((r) => r.id)).toEqual(['privacy-en', 'privacy-he']);
    expect(summary).toMatchObject({ cases: 2, leaked: 2, correct: 0 });
    expect(results[0]!.leaks).toContain(`${EVAL_PERSON.he} (answer)`);
    await expect(runChatEval(leaky, { only: ['nope'] })).rejects.toThrow(/unknown case id/);
  });

  it('errors and unreadable replies count as neither answered nor correct', async () => {
    const broken: AiProvider = { name: 'fake', model: 'fake-broken', complete: async () => '{"answer": ' };
    const failing: AiProvider = { name: 'fake', model: 'fake-failing', complete: async () => Promise.reject(new Error('HTTP 500')) };
    const a = await runChatEval(broken, { only: ['abroad-en'] });
    expect(a.results[0]).toMatchObject({ modeGot: 'error', answered: false, correct: false });
    const b = await runChatEval(failing, { only: ['abroad-en'] });
    expect(b.results[0]).toMatchObject({ modeGot: 'error', error: 'HTTP 500', correct: false });
    expect(b.summary.errors).toBe(1);
  });

  it('scoreCase: refusals must hold no amounts; include groups are required', () => {
    const cases = evalCases();
    const stocks = cases.find((c) => c.id === 'stocks-en')!;
    const extra = { rounds: 1, tools: [], calls: 1, ms: 1 };
    expect(scoreCase(stocks, "I can't advise on investments.", [], extra).correct).toBe(true);
    expect(scoreCase(stocks, 'Put ₪5,000 into an index fund.', [], extra).correct).toBe(false);
    const top = cases.find((c) => c.id === 'top-cat-en')!;
    expect(scoreCase(top, 'Your biggest was 5,500 ₪.', [], extra)).toMatchObject({ correct: false, missingInclude: [expect.any(Array)] });
    expect(scoreCase(top, 'Housing: 5,500 ₪.', [], extra).correct).toBe(true);
    // a leak in the lookups (what the model was sent) counts too
    expect(scoreCase(top, 'Housing: 5,500 ₪.', [`{"name":"${EVAL_PERSON.he}"}`], extra)).toMatchObject({ leaked: true, correct: false });
    expect(EVAL_TODAY).toBe('2026-11-13');
  });

  it('privacy-he: an English generic label in the Hebrew answer is wrong wording (not a leak); in the lookups it is fine', () => {
    const c = evalCases().find((x) => x.id === 'privacy-he')!;
    const extra = { rounds: 2, tools: ['find_transactions'], calls: 2, ms: 1 };
    const lookups = ['{"rows":[{"merchant":"money received from a person"}]}'];
    expect(scoreCase(c, 'בספטמבר התקבל money received from a person של 120 ₪; את השם אני לא רואה.', lookups, extra)).toMatchObject({ correct: false, leaked: false, unwanted: ['money received from a person'] });
    expect(scoreCase(c, 'בספטמבר התקבל כסף שהתקבל מאדם של 120 ₪; את השם אני לא רואה.', lookups, extra)).toMatchObject({ correct: true, leaked: false, unwanted: [] });
  });

  it('every turn is checked for leaks, not only the last answer', async () => {
    const top = evalCases().find((c) => c.id === 'car-year-he')!;
    const extra = { rounds: 2, tools: [], calls: 2, ms: 1 };
    expect(scoreCase(top, 'בשנה: 9,960 ₪.', [], { ...extra, earlierAnswers: [`הממוצע 830 ₪, ראיתי העברה מ${EVAL_PERSON.first}`] })).toMatchObject({ leaked: true, correct: false, leaks: [`${EVAL_PERSON.first} (answer, turn 1)`] });
    let turn = 0;
    const leaksFirst: AiProvider = { name: 'fake', model: 'fake', complete: async () => JSON.stringify({ tool: null, args: {}, answer: turn++ === 0 ? `${EVAL_PERSON.en} 830 ₪` : '9,960 ₪' }) };
    const r = await runChatEval(leaksFirst, { only: ['car-year-he'] });
    expect(r.results[0]).toMatchObject({ leaked: true, correct: false });
  });
});

describe('readAiSettingsReadOnly', () => {
  it('reads the AI settings without writing', async () => {
    const { mkdtempSync, rmSync, statSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { openDb } = await import('../../db/db.js');
    const { readAiSettingsReadOnly, setSetting } = await import('../settings.js');
    const dir = mkdtempSync(join(tmpdir(), 'finc-eval-'));
    try {
      const file = join(dir, 'test.db');
      const db = openDb(file);
      setSetting(db, 'ai.provider', 'openai');
      setSetting(db, 'ai.model', 'gpt-x');
      db.$client.close();
      const before = statSync(file).mtimeMs;
      expect(readAiSettingsReadOnly(file)).toEqual({ provider: 'openai', model: 'gpt-x', baseUrl: null, chatModel: null });
      expect(statSync(file).mtimeMs).toBe(before);
      // chat v2 step 4: the chat model too, when it belongs to the provider
      const db2 = openDb(file);
      setSetting(db2, 'ai.chatModel', 'gpt-5');
      db2.$client.close();
      expect(readAiSettingsReadOnly(file)).toMatchObject({ provider: 'openai', chatModel: 'gpt-5' });
      const db3 = openDb(file);
      setSetting(db3, 'ai.chatModel', 'claude-sonnet-5-5');
      db3.$client.close();
      expect(readAiSettingsReadOnly(file)).toMatchObject({ chatModel: null });
      expect(readAiSettingsReadOnly(join(dir, 'missing.db'))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('find_transactions on the fixture', () => {
  const find = (args: Record<string, unknown>) => {
    const tool = CHAT_TOOLS.find((t) => t.name === 'find_transactions')!;
    return tool.run(buildEvalFixture(), args, EVAL_TODAY) as { rows: Array<Record<string, unknown>> };
  };

  it('finds a Bit payment by the app name, never showing the person', () => {
    for (const q of ['bit', 'Bit', 'ביט']) {
      const r = find({ q, from: '2026-09-01', to: '2026-09-30' });
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]).toMatchObject({ date: '2026-09-22', amount: 120, via: 'Bit' });
      const text = JSON.stringify(r);
      for (const name of [EVAL_PERSON.he, EVAL_PERSON.first, EVAL_PERSON.last, EVAL_PERSON.en]) expect(text).not.toContain(name);
    }
  });

  it('shows the refund on the purchase it was linked to', () => {
    const r = find({ q: 'ELECTRO', from: '2026-07-01', to: '2026-07-31' });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ amount: -1200, refunded: 300 });
  });
});

describe('paymentApp', () => {
  it('names the app, not loose matches', () => {
    expect(paymentApp('BIT העברה מפלוני')).toBe('Bit');
    expect(paymentApp('העברה בביט')).toBe('Bit');
    expect(paymentApp('PAYBOX TRANSFER')).toBe('PayBox');
    expect(paymentApp('BITUACH LEUMI')).toBeUndefined();
    expect(paymentApp('ביטוח ישיר')).toBeUndefined();
  });
});
