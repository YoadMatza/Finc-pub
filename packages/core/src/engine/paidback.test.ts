import { describe, expect, it } from 'vitest';
import { type AskRow, NO_RULE_NOTE, VARIABLE_ROW_SQL, isAskCandidate, isExactRule, payerWords, isSpecificPayer, matchingRules, paidBackLine, paidBackSummary, patternMatches, rulePatternOf } from './paidback.js';

// fictional payers and amounts (agorot)
const base: AskRow = { kind: 'income', bucket: 'income', amount: 30000, isCard: false, incomeKind: 'extra', categoryKey: 'income.other', inConfirmedStream: false, descriptionNorm: 'bit from dana', accountId: 1 };

describe('paid back: pure helpers', () => {
  it('patternMatches is a literal, ASCII case-insensitive substring; an empty pattern matches nothing', () => {
    expect(patternMatches('bit from dana', 'bit from dana 123')).toBe(true);
    expect(patternMatches('BIT From', 'bit from dana')).toBe(true);
    expect(patternMatches('dana%', 'bit from dana')).toBe(false);
    expect(patternMatches('d_na', 'bit from dana')).toBe(false);
    expect(patternMatches('העברה', 'העברה מדנה')).toBe(true);
    expect(patternMatches('', 'anything')).toBe(false);
  });

  it('matchingRules: kind, pattern and the rule account', () => {
    const rules = [
      { pattern: 'bit from dana', kind: 'paid_back', accountId: null },
      { pattern: 'dana', kind: 'income', accountId: 2 }, // an older substring income rule
      { pattern: 'bit from omer', kind: 'paid_back', accountId: null },
      { pattern: 'dana', kind: 'savings', accountId: null },
      { pattern: 'dana', kind: 'paid_back', accountId: null }, // paid_back rules match the whole description only
      { pattern: 'bit from', kind: 'income', accountId: null, note: NO_RULE_NOTE }, // the "no" answer's rule: exact too
    ];
    expect(matchingRules(rules, { descriptionNorm: 'bit from dana', accountId: 1 }, ['income', 'paid_back'])).toEqual([rules[0]]);
    expect(matchingRules(rules, { descriptionNorm: 'bit from dana', accountId: 2 }, ['income', 'paid_back'])).toEqual([rules[0], rules[1]]);
    expect(matchingRules(rules, { descriptionNorm: 'bit from dana kohen', accountId: 1 }, ['income', 'paid_back'])).toEqual([]);
    expect(matchingRules(rules, { descriptionNorm: ' Bit From ', accountId: 1 }, ['income'])).toEqual([rules[5]]);
  });

  it('exact rules: "זיכוי מביט דנה" matches itself, not "דנה כהן" nor "דנהיה"; isExactRule', () => {
    expect(patternMatches('זיכוי מביט דנה', 'זיכוי מביט דנה', true)).toBe(true);
    expect(patternMatches('זיכוי מביט דנה', 'זיכוי מביט דנה כהן', true)).toBe(false);
    expect(patternMatches('זיכוי מביט דנה', 'זיכוי מביט דנהיה', true)).toBe(false);
    expect(patternMatches('זיכוי מביט דנה', 'זיכוי מביט דנה כהן')).toBe(true); // substring (other rules)
    expect(isExactRule({ kind: 'paid_back' })).toBe(true);
    expect(isExactRule({ kind: 'income', note: NO_RULE_NOTE })).toBe(true);
    expect(isExactRule({ kind: 'income', note: null })).toBe(false);
    expect(isExactRule({ kind: 'transfer', note: NO_RULE_NOTE })).toBe(false);
  });

  it('payerWords: generic transfer words, punctuation and digits name no payer', () => {
    expect(payerWords('זיכוי מביט')).toEqual([]);
    expect(payerWords('זיכוי מפייבוקס')).toEqual([]);
    expect(payerWords('העברה מ-פפר 1234')).toEqual([]);
    expect(payerWords('BIT transfer from 05-1234567')).toEqual([]);
    expect(payerWords('זיכוי מביט דנה כהן')).toEqual(['דנה', 'כהן']);
    expect(payerWords('paybox from omer')).toEqual(['omer']);
  });

  it('isAskCandidate: every condition', () => {
    expect(isAskCandidate(base, [])).toBe(true);
    expect(isAskCandidate({ ...base, categoryKey: null }, [])).toBe(true);
    expect(isAskCandidate({ ...base, bucket: 'variable', kind: 'paid_back' }, [])).toBe(false);
    expect(isAskCandidate({ ...base, kind: 'refund' }, [])).toBe(false);
    expect(isAskCandidate({ ...base, kind: null }, [])).toBe(false);
    expect(isAskCandidate({ ...base, isCard: true }, [])).toBe(false);
    expect(isAskCandidate({ ...base, amount: 0 }, [])).toBe(false);
    expect(isAskCandidate({ ...base, incomeKind: 'regular' }, [])).toBe(false);
    expect(isAskCandidate({ ...base, categoryKey: 'income.freelance' }, [])).toBe(false);
    expect(isAskCandidate({ ...base, inConfirmedStream: true }, [])).toBe(false);
    expect(isAskCandidate({ ...base, descriptionNorm: ' ' }, [])).toBe(false);
    // answered for the payer: an income ("no") or paid_back ("always") rule
    expect(isAskCandidate(base, [{ pattern: 'from dana', kind: 'income', accountId: null }])).toBe(false);
    expect(isAskCandidate(base, [{ pattern: 'bit from dana', kind: 'paid_back', accountId: null }])).toBe(false);
    // other rules do not answer it
    expect(isAskCandidate(base, [{ pattern: 'bit from dana', kind: 'transfer', accountId: null }, { pattern: 'omer', kind: 'income', accountId: null }])).toBe(true);
  });

  it('rulePatternOf trims and needs two characters', () => {
    expect(rulePatternOf('  bit from dana ')).toBe('bit from dana');
    expect(rulePatternOf('x')).toBeNull();
    expect(rulePatternOf('')).toBeNull();
  });

  it('paidBackSummary: total and largest first; paidBackLine only when something was paid back', () => {
    const s = paidBackSummary([
      { id: 1, name: 'Dana', amount: 12000, date: '2026-11-10', byRule: true },
      { id: 2, name: 'Omer', amount: 30000, date: '2026-11-03', byRule: false },
      { id: 3, name: 'Dana', amount: 12000, date: '2026-11-02', byRule: true },
    ]);
    expect(s.total).toBe(54000);
    expect(s.items.map((i) => i.id)).toEqual([2, 3, 1]);
    const money = (m: number) => `₪${m / 100}`;
    expect(paidBackLine(s, money)).toBe('paid back to you: ₪540 (3 payments), counted against day-to-day spending');
    expect(paidBackLine({ total: 12000, items: [1] }, money)).toBe('paid back to you: ₪120 (1 payment), counted against day-to-day spending');
    expect(paidBackLine({ total: 12000, items: [1] }, money, 'he')).toContain('₪120');
    expect(paidBackLine(paidBackSummary([]), money)).toBeNull();
  });

  it('isSpecificPayer: at least 6 characters and one payer (merchant, or description when there is none)', () => {
    const rows = [
      { descriptionNorm: 'bit from dana', merchantId: 7 },
      { descriptionNorm: 'bit from dana', merchantId: 7 },
      { descriptionNorm: 'bit client alpha', merchantId: 9 },
      { descriptionNorm: 'bit from danah levi', merchantId: null }, // a longer description is another payer, not a match
      { descriptionNorm: 'זיכוי מביט', merchantId: 11 },
      { descriptionNorm: 'זיכוי מפייבוקס', merchantId: 12 },
      { descriptionNorm: 'זיכוי מביט דנה', merchantId: 13 },
      { descriptionNorm: 'זיכוי מביט דנה כהן', merchantId: 14 },
    ];
    expect(isSpecificPayer('bit from dana', rows)).toBe(true);
    expect(isSpecificPayer('bit from dana', [...rows, { descriptionNorm: 'bit from dana', merchantId: 8 }])).toBe(false); // two merchants
    expect(isSpecificPayer('bit from dana', [...rows, { descriptionNorm: 'bit from dana', merchantId: null }])).toBe(false);
    expect(isSpecificPayer('bit', rows)).toBe(false); // too short
    expect(isSpecificPayer('bit client alpha', rows)).toBe(true);
    expect(isSpecificPayer(null, rows)).toBe(false);
    expect(isSpecificPayer('nobody at all', rows)).toBe(true);
    // a channel without a person
    expect(isSpecificPayer('זיכוי מביט', rows)).toBe(false);
    expect(isSpecificPayer('זיכוי מפייבוקס', rows)).toBe(false);
    expect(isSpecificPayer('bit transfer from', [])).toBe(false);
    expect(isSpecificPayer('זיכוי מביט דנה', rows)).toBe(true);
  });

  it('a payment answered "no" for itself only is not asked about', () => {
    expect(isAskCandidate({ ...base, notAsked: true }, [])).toBe(false);
    expect(isAskCandidate({ ...base, notAsked: false }, [])).toBe(true);
    expect(VARIABLE_ROW_SQL).toContain("t.kind = 'paid_back'");
  });
});
