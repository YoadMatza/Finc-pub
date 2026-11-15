import { describe, expect, it } from 'vitest';
import { badgeCount, draftOf, paramLabel, groupResults, keepUntouched, lastKnownText, noneApplyText, nowText, orderedTemplates, paramText, parseParam, parseParams, restSummary, ruleChanges, ruleSentence, sinceDay, sourceText, suggestions, templateHelp, templateLabel, TEMPLATE_IDS, valueText } from './holdingRules';
import { en, type Key } from './i18n';
import type { HoldingRule, HoldingRuleParamSpec, HoldingRuleResult, HoldingRuleTemplate } from './types';

/** the real English strings, so the sentences are checked as the owner reads them */
const t = (k: Key, vars?: Record<string, string | number>) => {
  let s: string = en[k];
  for (const [a, b] of Object.entries(vars ?? {})) s = s.replaceAll(`{${a}}`, String(b));
  return s;
};

const pct: HoldingRuleParamSpec = { key: 'pct', kind: 'pct', min: 1, max: 95, default: 20 };
const n: HoldingRuleParamSpec = { key: 'n', kind: 'int', min: 1, max: 250, default: 30 };
const x: HoldingRuleParamSpec = { key: 'x', kind: 'number', min: 0.5, max: 500, default: 40 };
const rev: HoldingRuleParamSpec = { key: 'pct', kind: 'pct', min: -90, max: 100, default: 0 };

const rule = (over: Partial<HoldingRule> = {}): HoldingRule => ({ id: 1, template: 'below_cost_pct', params: { pct: 20 }, scopeSymbol: null, notify: false, enabled: true, createdAt: '2026-11-10T10:00:00Z', updatedAt: '2026-11-10T10:00:00Z', ...over });
const res = (over: Partial<HoldingRuleResult> = {}): HoldingRuleResult => ({ ruleId: 1, template: 'below_cost_pct', params: { pct: 20 }, scopeSymbol: null, state: 'applies', value: 27.34, source: 'bank', since: '2026-11-09', ...over });

describe('sentences', () => {
  it('fills the numbers in', () => {
    expect(ruleSentence(t, 'below_cost_pct', { pct: 20 })).toBe('Price is 20% or more below my purchase price');
    expect(ruleSentence(t, 'below_sma200_sessions', { n: 40 })).toBe('Below the 200-day average for 40+ sessions');
    expect(ruleSentence(t, 'pe_above', { x: 35.5 })).toBe('P/E above 35.5');
    expect(ruleSentence(t, 'concentration_pct', { pct: 12.345 })).toBe('This holding is 12.35% or more of my portfolio');
    expect(ruleSentence(t, 'below_sma200_sessions', { n: 40.4 }, [n])).toBe('Below the 200-day average for 40+ sessions');
  });
  it('has a sentence for every template, in both languages, with no placeholder left', async () => {
    const { he } = await import('./i18n');
    for (const id of TEMPLATE_IDS) {
      const s = ruleSentence(t, id, { pct: 5, n: 5, pts: 5, x: 5 });
      expect(s).not.toMatch(/[{}]/);
      expect(he[`hr_t_${id}` as Key]).toBeTruthy();
    }
  });
  it('never words a verdict', async () => {
    const { he } = await import('./i18n');
    const words = /\b(buy|sell|hold|should|recommend\w*)\b/i;
    for (const k of Object.keys(en).filter((k) => k.startsWith('hr_'))) {
      // "buy share" names what analysts published (strong buy + buy ratings); it is not finc telling the owner to buy
      expect(en[k as Key].replace(/\b(strong buy and )?buy (share|ratings)\b/gi, '')).not.toMatch(words);
      expect(he[k as Key]).not.toMatch(/כדאי|מומלץ|לקנות|למכור|להחזיק/);
    }
  });
  it('names an unknown template without guessing its meaning', () => {
    expect(ruleSentence(t, 'future_rule', { a: 1 })).toBe('A condition this app does not know (future_rule: a=1)');
  });
  it('labels the picker with placeholders', () => {
    expect(templateLabel(t, { id: 'below_cost_pct', params: [pct] })).toBe('Price is X% or more below my purchase price');
    expect(templateLabel(t, { id: 'above_sma200_sessions', params: [n] })).toBe('Above the 200-day average for N+ sessions');
  });
  it('paramText', () => {
    expect(paramText(20, 'pct')).toBe('20');
    expect(paramText(2.5, 'pct')).toBe('2.5');
    expect(paramText(41.6, 'int')).toBe('42');
    expect(paramText(Number.NaN)).toBe('?');
  });
});

describe('values', () => {
  // the hub's value is measured in the rule's direction (+ = the rule's way), except day move / revenue (raw) and P/E
  it.each([
    ['below_cost_pct', 27.34, '27.3% below cost'],
    ['below_cost_pct', -15, '15.0% above cost'],
    ['above_cost_pct', 40, '40.0% above cost'],
    ['above_cost_pct', -10, '10.0% below cost'],
    ['below_sma200_sessions', 41, '41 sessions below the 200-day average'],
    ['below_sma200_sessions', -20, '20 sessions above the 200-day average'],
    ['below_sma200_sessions', 0, 'not below the 200-day average'],
    ['above_sma200_sessions', 12, '12 sessions above the 200-day average'],
    ['above_sma200_sessions', -7, '7 sessions below the 200-day average'],
    ['above_sma200_sessions', 0, 'not above the 200-day average'],
    ['from_high52_pct', 18.24, '18.2% below the 52-week high'],
    ['from_high52_pct', 0, 'at the 52-week high'],
    ['day_move_pct', 3.21, 'up 3.2% today'],
    ['day_move_pct', -3.21, 'down 3.2% today'],
    ['drop_1m_pct', 12, 'down 12.0%'],
    ['drop_1m_pct', -4, 'up 4.0%'],
    ['drop_3m_pct', 12, 'down 12.0%'],
    ['drop_3m_pct', -4, 'up 4.0%'],
    ['lag_spy_1y_pts', 15, 'lagged SPY by 15.0 points'],
    ['lag_spy_1y_pts', -12, 'beat SPY by 12.0 points'],
    ['pe_above', 46.25, 'P/E 46.3'],
    ['pe_below', 8, 'P/E 8.0'],
    ['pe_below', -5, 'P/E -5.0'],
    ['revenue_yoy_below', 4, 'revenue up 4.0%'],
    ['revenue_yoy_below', -3, 'revenue down 3.0%'],
    ['margin_drop_pts', 3.44, 'margin down 3.4 points'],
    ['margin_drop_pts', -1.2, 'margin up 1.2 points'],
    ['dilution_pct', 5, 'shares up 5.0%'],
    ['dilution_pct', -2, 'shares down 2.0%'],
    ['concentration_pct', 27.34, '27.3% of the portfolio'],
    // the buy share's change in points: + = toward buy for toward_buy, the opposite sign for toward_sell
    ['analysts_toward_buy_pts', 8.04, 'buy share up 8.0 points'],
    ['analysts_toward_buy_pts', -5, 'buy share down 5.0 points'],
    ['analysts_toward_buy_pts', 0, 'buy share unchanged'],
    ['analysts_toward_sell_pts', 6.5, 'buy share down 6.5 points'],
    ['analysts_toward_sell_pts', -3, 'buy share up 3.0 points'],
    ['analysts_toward_sell_pts', 0.04, 'buy share unchanged'],
    ['earnings_within_days', 12, 'report in 12 days'],
    ['earnings_within_days', 1, 'report tomorrow'],
    ['earnings_within_days', 0, 'report today'],
    ['earnings_within_days', -2, 'reported 2 days ago'],
    ['unknown_tpl', 3, '3.0'],
  ] as const)('%s %d reads "%s"', (tpl, v, out) => {
    expect(valueText(t, tpl, v)).toBe(out);
  });
  it('compares at one decimal: a value that rounds to zero is not the opposite way', () => {
    expect(valueText(t, 'below_cost_pct', -0.04)).toBe('0.0% below cost');
  });
  it('null when unknown', () => {
    expect(valueText(t, 'pe_above', null)).toBeNull();
    expect(valueText(t, 'pe_above', Number.NaN)).toBeNull();
    expect(nowText(t, 'pe_above', null)).toBeNull();
    expect(nowText(t, 'below_sma200_sessions', 41)).toBe('now: 41 sessions below the 200-day average');
  });
  it('the earnings rule with no report in the window: clear, no value', () => {
    expect(nowText(t, 'earnings_within_days', null, 'clear')).toBe('now: no report within 120 days');
    expect(nowText(t, 'earnings_within_days', null, 'unknown')).toBeNull();
    expect(nowText(t, 'earnings_within_days', 5, 'applies')).toBe('now: report in 5 days');
    expect(nowText(t, 'pe_above', null, 'clear')).toBeNull();
  });
  it('sources', () => {
    const src = (kind: 'live' | 'bank' | 'yahoo' | 'sec' | 'holdings' | 'finnhub', over: { date?: string | null; time?: string | null; form?: string | null } = {}) => ({ kind, date: null, time: null, form: null, ...over });
    expect(sourceText(t, src('live', { time: '14:32' }))).toBe('live 14:32');
    expect(sourceText(t, src('live'))).toBe('live price');
    expect(sourceText(t, src('bank', { time: '06:01:13' }))).toBe('bank 06:01');
    expect(sourceText(t, src('bank', { date: '2026-11-10' }))).toBe('bank, 10.11');
    expect(sourceText(t, src('yahoo', { date: '2026-11-10' }))).toBe('Yahoo, 10.11');
    expect(sourceText(t, src('sec', { date: '2026-10-31', form: '10-Q' }))).toBe('10-Q filed 31.10.2026');
    expect(sourceText(t, src('sec', { date: '2026-10-31' }))).toBe('SEC, 31.10.2026');
    expect(sourceText(t, src('holdings'))).toBe('your holdings');
    expect(sourceText(t, src('finnhub', { date: '2026-11-11' }))).toBe('Finnhub, 11.11');
    expect(sourceText(t, src('finnhub'))).toBe('Finnhub');
    // a timestamp is read in Israel time: 22:30 UTC on 9 Nov is 00:30 on 10 Nov there
    expect(sourceText(t, src('live', { time: '2026-11-09T22:30:00Z' }))).toBe('live 00:30');
    expect(sourceText(t, src('yahoo', { date: '2026-11-09T22:30:00Z' }))).toBe('Yahoo, 10.11');
    expect(sourceText(t, { kind: 'other' as never, date: null, time: null, form: null })).toBeNull();
    expect(sourceText(t, '10-Q filed 31.10')).toBe('10-Q filed 31.10');
    expect(sourceText(t, '  ')).toBeNull();
    expect(sourceText(t, null)).toBeNull();
    expect(sourceText(t, 'a'.repeat(100))).toHaveLength(80);
  });
  it('sinceDay is the Israel day', () => {
    expect(sinceDay('2026-11-09T20:30:00Z')).toBe('2026-11-09');
    expect(sinceDay('2026-11-09T22:30:00Z')).toBe('2026-11-10');
    expect(sinceDay('2026-11-09')).toBe('2026-11-09');
    expect(sinceDay('soon')).toBeNull();
    expect(sinceDay(null)).toBeNull();
  });
  it('last known state, only for unknown', () => {
    expect(lastKnownText(t, res({ state: 'unknown', lastKnownState: 'applies', lastKnownAt: '2026-11-09' }))).toBe('last known: applied on 9.11');
    expect(lastKnownText(t, res({ state: 'unknown', lastKnownState: 'clear', lastKnownAt: '2026-11-09T10:00:00Z' }))).toBe("last known: didn't apply on 9.11");
    expect(lastKnownText(t, res({ state: 'unknown' }))).toBeNull();
    expect(lastKnownText(t, res({ state: 'applies', lastKnownState: 'applies', lastKnownAt: '2026-11-09' }))).toBeNull();
  });
  it('explains "my portfolio"', () => {
    expect(templateHelp(t, 'concentration_pct')).toContain('FIBI');
    expect(templateHelp(t, 'pe_above')).toBeNull();
  });
  it('explains the buy share and where the earnings date comes from', () => {
    expect(templateHelp(t, 'analysts_toward_buy_pts')).toContain('strong buy and buy');
    expect(templateHelp(t, 'analysts_toward_sell_pts')).toBe(templateHelp(t, 'analysts_toward_buy_pts'));
    expect(templateHelp(t, 'earnings_within_days')).toContain('Finnhub');
  });
  it('labels n as days for the earnings rule, sessions elsewhere', () => {
    expect(paramLabel(t, 'n', 'earnings_within_days')).toBe('Days');
    expect(paramLabel(t, 'n', 'below_sma200_sessions')).toBe('Sessions');
    expect(paramLabel(t, 'n')).toBe('Sessions');
    expect(paramLabel(t, 'pts', 'analysts_toward_buy_pts')).toBe('Points');
  });
});

describe('none apply', () => {
  const g = (a: number, c: number, u: number) => ({ applies: Array(a).fill(res()), clear: Array(c).fill(res({ state: 'clear' })), unknown: Array(u).fill(res({ state: 'unknown' })) });
  it('says plainly what was checked', () => {
    expect(noneApplyText(t, g(1, 1, 1))).toBeNull();
    expect(noneApplyText(t, g(0, 2, 0))).toBe('None of your rules apply right now.');
    expect(noneApplyText(t, g(0, 2, 1))).toBe("None of your rules apply on the data available; 1 couldn't be checked (data missing).");
    expect(noneApplyText(t, g(0, 0, 3))).toBe("Your rules couldn't be checked right now (data missing).");
  });
});

describe('grouping', () => {
  it('splits by state, newest applying first, unexpected states as unknown', () => {
    const g = groupResults([
      res({ ruleId: 1, since: '2026-10-01' }),
      res({ ruleId: 2, state: 'clear' }),
      res({ ruleId: 3, since: '2026-11-05' }),
      res({ ruleId: 4, state: 'unknown', value: null }),
      res({ ruleId: 5, state: 'weird' as never }),
      res({ ruleId: 6, since: null }),
    ]);
    expect(g.applies.map((r) => r.ruleId)).toEqual([3, 1, 6]);
    expect(g.clear.map((r) => r.ruleId)).toEqual([2]);
    expect(g.unknown.map((r) => r.ruleId)).toEqual([4, 5]);
    expect(restSummary(t, g)).toBe("1 don't apply · 2 unknown (data missing)");
  });
  it('handles none', () => {
    const g = groupResults(undefined);
    expect(g.applies).toEqual([]);
    expect(restSummary(t, g)).toBe('');
  });
});

describe('numbers', () => {
  it('parseParam checks range and whole numbers', () => {
    expect(parseParam('20', pct)).toBe(20);
    expect(parseParam(' 2,5 ', pct)).toBe(2.5);
    expect(parseParam('0', pct)).toBeNull();
    expect(parseParam('96', pct)).toBeNull();
    expect(parseParam('', pct)).toBeNull();
    expect(parseParam('1e2', pct)).toBeNull();
    expect(parseParam('abc', pct)).toBeNull();
    expect(parseParam('40', n)).toBe(40);
    expect(parseParam('40.5', n)).toBeNull();
    expect(parseParam('-10', rev)).toBe(-10);
    expect(parseParam('−10', rev)).toBe(-10);
    expect(parseParam('0.5', x)).toBe(0.5);
    expect(parseParam('12.25', x)).toBe(12.25);
    expect(parseParam('12.255', x)).toBeNull();
  });
  it('parseParams needs every parameter', () => {
    expect(parseParams({ pct: '20' }, [pct])).toEqual({ pct: 20 });
    expect(parseParams({}, [pct])).toBeNull();
    expect(parseParams({ pct: '20', n: '0' }, [pct, n])).toBeNull();
  });
  it('draftOf uses values, then defaults', () => {
    expect(draftOf([pct, n])).toEqual({ pct: '20', n: '30' });
    expect(draftOf([pct], { pct: 12.5 })).toEqual({ pct: '12.5' });
  });
  it('keepUntouched keeps the exact stored number of a field the owner did not edit', () => {
    const original = { pct: 12.345, n: 30 };
    const initialDraft = draftOf([pct, n], original);
    expect(initialDraft).toEqual({ pct: '12.35', n: '30' });
    const kept = keepUntouched({ pct: 12.35, n: 40 }, { pct: '12.35', n: '40' }, initialDraft, original);
    expect(kept).toEqual({ pct: 12.345, n: 40 });
    // only the scope changed: the threshold is not sent
    expect(ruleChanges(rule({ params: original }), { params: keepUntouched({ pct: 12.35, n: 30 }, initialDraft, initialDraft, original), scopeSymbol: 'AAPL', enabled: true })).toEqual({ scopeSymbol: 'AAPL' });
    // an edited field takes the typed number
    expect(keepUntouched({ pct: 12.4, n: 30 }, { pct: '12.4', n: '30' }, initialDraft, original)).toEqual({ pct: 12.4, n: 30 });
  });
  it('ruleChanges sends only what changed', () => {
    const r = rule();
    expect(ruleChanges(r, { params: { pct: 20 }, scopeSymbol: null, enabled: true })).toBeNull();
    expect(ruleChanges(r, { params: { pct: 25 }, scopeSymbol: 'AAPL', enabled: false })).toEqual({ params: { pct: 25 }, scopeSymbol: 'AAPL', enabled: false });
    expect(ruleChanges(r, { params: { pct: 20 }, scopeSymbol: null, enabled: false })).toEqual({ enabled: false });
  });
});

describe('examples', () => {
  const templates: HoldingRuleTemplate[] = [
    { id: 'below_cost_pct', params: [pct] },
    { id: 'concentration_pct', params: [{ ...pct, max: 20 }] },
    { id: 'below_sma200_sessions', params: [n] },
  ];
  it('offers the examples the hub knows, switched off, clamped to its ranges', () => {
    const s = suggestions(templates, []);
    expect(s.map((x) => x.template)).toEqual(['below_cost_pct', 'concentration_pct', 'below_sma200_sessions']);
    expect(s.every((x) => x.enabled === false && x.scopeSymbol === null)).toBe(true);
    expect(s[1]!.params).toEqual({ pct: 20 });
  });
  it('skips a template the owner already has for all holdings', () => {
    expect(suggestions(templates, [rule()]).map((x) => x.template)).not.toContain('below_cost_pct');
    expect(suggestions(templates, [rule({ scopeSymbol: 'AAPL' })]).map((x) => x.template)).toContain('below_cost_pct');
  });
  it('orders the picker', () => {
    expect(orderedTemplates([{ id: 'zzz', params: [] }, { id: 'pe_above', params: [] }, { id: 'below_cost_pct', params: [] }]).map((x) => x.id)).toEqual(['below_cost_pct', 'pe_above', 'zzz']);
  });
});

describe('badge', () => {
  it('only above zero', () => {
    expect(badgeCount(2)).toBe(2);
    expect(badgeCount(0)).toBeNull();
    expect(badgeCount(undefined)).toBeNull();
    expect(badgeCount(Number.NaN)).toBeNull();
  });
});
