import { describe, expect, it } from 'vitest';
import { type RuleFacts, type RuleSource, evaluateRule } from './evaluate.js';
import { RULE_TEMPLATES, type TemplateId, ruleTemplate } from './templates.js';

// Fictional numbers only. `make(v)` builds facts whose compared value is exactly v (in the template's own terms).
const LIVE: RuleSource = { kind: 'live', date: '2026-11-11', time: '14:32', form: null };
const BANK: RuleSource = { kind: 'bank', date: '2026-11-11', time: '06:01', form: null };
const YAHOO: RuleSource = { kind: 'yahoo', date: '2026-11-10', time: null, form: null };
const SEC: RuleSource = { kind: 'sec', date: '2026-10-31', time: null, form: '10-Q' };
const HOLD: RuleSource = { kind: 'holdings', date: '2026-11-11', time: '06:01', form: null };
const FINN: RuleSource = { kind: 'finnhub', date: '2026-11-11', time: null, form: null };
const F = (value: number, source: RuleSource = BANK) => ({ value, source });
const make: Record<TemplateId, (v: number) => RuleFacts> = {
  below_cost_pct: (v) => ({ costPrice: F(100, BANK), price: F(100 - v, LIVE) }),
  above_cost_pct: (v) => ({ costPrice: F(100, BANK), price: F(100 + v, LIVE) }),
  below_sma200_sessions: (v) => ({ daysAboveSma200: F(-v, YAHOO) }),
  above_sma200_sessions: (v) => ({ daysAboveSma200: F(v, YAHOO) }),
  from_high52_pct: (v) => ({ fromHigh52Pct: F(-v, YAHOO) }),
  day_move_pct: (v) => ({ dayChangePct: F(v, LIVE) }),
  drop_1m_pct: (v) => ({ returnM1: F(-v, YAHOO) }),
  drop_3m_pct: (v) => ({ returnM3: F(-v, YAHOO) }),
  lag_spy_1y_pts: (v) => ({ spyDiffY1: F(-v, YAHOO) }),
  pe_above: (v) => ({ pe: F(v, SEC) }),
  pe_below: (v) => ({ pe: F(v, SEC) }),
  revenue_yoy_below: (v) => ({ revenueYoYPct: F(v, SEC) }),
  margin_drop_pts: (v) => ({ netMarginPct: F(20 - v, SEC), netMarginPct1yAgo: F(20, { ...SEC, date: '2025-11-01', form: '10-K' }) }),
  dilution_pct: (v) => ({ sharesChange1yPct: F(v, SEC) }),
  concentration_pct: (v) => ({ valueIls: F(v * 1000, LIVE), portfolioIls: F(100_000, HOLD) }),
  analysts_toward_buy_pts: (v) => ({ buyShareChange3mPts: F(v, FINN) }),
  analysts_toward_sell_pts: (v) => ({ buyShareChange3mPts: F(-v, FINN) }),
  earnings_within_days: (v) => ({ earningsDays: F(v, FINN) }),
};
const SOURCE: Record<TemplateId, RuleSource> = {
  below_cost_pct: LIVE,
  above_cost_pct: LIVE,
  below_sma200_sessions: YAHOO,
  above_sma200_sessions: YAHOO,
  from_high52_pct: YAHOO,
  day_move_pct: LIVE,
  drop_1m_pct: YAHOO,
  drop_3m_pct: YAHOO,
  lag_spy_1y_pts: YAHOO,
  pe_above: SEC,
  pe_below: SEC,
  revenue_yoy_below: SEC,
  margin_drop_pts: SEC,
  dilution_pct: SEC,
  concentration_pct: HOLD, // the portfolio's source: it covers every row
  analysts_toward_buy_pts: FINN,
  analysts_toward_sell_pts: FINN,
  earnings_within_days: FINN,
};
const TH: Record<TemplateId, number> = {
  below_cost_pct: 20,
  above_cost_pct: 50,
  below_sma200_sessions: 5,
  above_sma200_sessions: 60,
  from_high52_pct: 25,
  day_move_pct: 5,
  drop_1m_pct: 10,
  drop_3m_pct: 20,
  lag_spy_1y_pts: 15,
  pe_above: 40,
  pe_below: 10,
  revenue_yoy_below: 0,
  margin_drop_pts: 5,
  dilution_pct: 5,
  concentration_pct: 20,
  analysts_toward_buy_pts: 10,
  analysts_toward_sell_pts: 10,
  earnings_within_days: 7,
};

const rule = (id: TemplateId, th = TH[id]) => ({ template: id, params: { [ruleTemplate(id)!.threshold]: th } });
const ev = (id: TemplateId, v: number, th = TH[id]) => evaluateRule(rule(id, th), make[id](v));
const unit = (id: TemplateId) => (ruleTemplate(id)!.params[0]!.kind === 'int' ? 1 : 0.1);
const costAsOf = (id: TemplateId) => (id === 'below_cost_pct' || id === 'above_cost_pct' ? '2026-11-11' : null);

describe.each(RULE_TEMPLATES.map((t) => [t.id, t] as const))('%s', (id, tpl) => {
  const th = TH[id];
  const u = unit(id);
  const inside = tpl.direction === 'up' ? th + u : th - u;
  const outside = tpl.direction === 'up' ? th - u : th + u;

  it('applies on the applying side, with the value, its source and (cost rules) the cost date', () => {
    expect(ev(id, inside)).toEqual({ state: 'applies', value: inside, source: SOURCE[id], costAsOf: costAsOf(id) });
  });

  it('is clear one step on the other side: the raw condition, no hysteresis', () => {
    expect(ev(id, outside)).toEqual({ state: 'clear', value: outside, source: SOURCE[id], costAsOf: costAsOf(id) });
  });

  it(tpl.strict ? 'is clear exactly at the threshold (strictly above/below)' : 'applies exactly at the threshold ("or more")', () => {
    expect(ev(id, th).state).toBe(tpl.strict ? 'clear' : 'applies');
  });

  it('is unknown (never clear) when any needed fact is missing or not a finite number', () => {
    for (const k of tpl.facts) {
      for (const bad of [null, undefined, { value: Number.NaN, source: BANK }, { value: Number.POSITIVE_INFINITY, source: BANK }]) {
        const facts = { ...make[id](inside), [k]: bad } as RuleFacts;
        expect(evaluateRule(rule(id), facts)).toEqual({ state: 'unknown', value: null, source: null, costAsOf: null });
      }
    }
    expect(evaluateRule(rule(id), {})).toEqual({ state: 'unknown', value: null, source: null, costAsOf: null });
  });
});

describe('template details and the value convention', () => {
  it('cost: + below / + above the purchase price, negative the other way; a zero cost is unknown', () => {
    expect(evaluateRule(rule('below_cost_pct', 25), { costPrice: F(80, BANK), price: F(58.4, LIVE) })).toEqual({ state: 'applies', value: 27, source: LIVE, costAsOf: '2026-11-11' });
    expect(evaluateRule(rule('below_cost_pct', 25), { costPrice: F(80), price: F(90) })).toMatchObject({ state: 'clear', value: -12.5 });
    expect(evaluateRule(rule('above_cost_pct', 25), { costPrice: F(80), price: F(100) })).toMatchObject({ state: 'applies', value: 25 });
    expect(evaluateRule(rule('above_cost_pct', 25), { costPrice: F(80), price: F(60) })).toMatchObject({ state: 'clear', value: -25 });
    expect(evaluateRule(rule('below_cost_pct'), { costPrice: F(0), price: F(10) }).state).toBe('unknown');
    expect(evaluateRule(rule('above_cost_pct'), { costPrice: F(-1), price: F(10) }).state).toBe('unknown');
  });

  it('200-day average: + sessions on the rule’s side, − on the other (not clamped)', () => {
    expect(evaluateRule(rule('below_sma200_sessions', 20), { daysAboveSma200: F(-41) })).toMatchObject({ state: 'applies', value: 41 });
    expect(evaluateRule(rule('below_sma200_sessions', 20), { daysAboveSma200: F(30) })).toMatchObject({ state: 'clear', value: -30 });
    expect(evaluateRule(rule('above_sma200_sessions', 20), { daysAboveSma200: F(-30) })).toMatchObject({ state: 'clear', value: -30 });
    expect(evaluateRule(rule('above_sma200_sessions', 20), { daysAboveSma200: F(25) })).toMatchObject({ state: 'applies', value: 25 });
    expect(evaluateRule(rule('above_sma200_sessions', 20), { daysAboveSma200: F(0) })).toMatchObject({ state: 'clear', value: 0 });
  });

  it('200-day average: a lower-bound streak on the rule’s side shorter than N is unknown; long enough or the other side is known', () => {
    const lb = (d: number) => ({ daysAboveSma200: { value: d, source: YAHOO, lowerBound: true } });
    expect(evaluateRule(rule('below_sma200_sessions', 20), lb(-12)).state).toBe('unknown');
    expect(evaluateRule(rule('below_sma200_sessions', 20), lb(-20))).toMatchObject({ state: 'applies', value: 20 });
    expect(evaluateRule(rule('below_sma200_sessions', 20), lb(15))).toMatchObject({ state: 'clear', value: -15 });
    expect(evaluateRule(rule('above_sma200_sessions', 60), lb(45)).state).toBe('unknown');
    expect(evaluateRule(rule('above_sma200_sessions', 60), lb(-45))).toMatchObject({ state: 'clear', value: -45 });
    expect(evaluateRule(rule('above_sma200_sessions', 60), { daysAboveSma200: { value: 45, source: YAHOO, lowerBound: false } })).toMatchObject({ state: 'clear', value: 45 });
  });

  it('52-week high: + % below the high', () => {
    expect(evaluateRule(rule('from_high52_pct', 25), { fromHigh52Pct: F(-27.46) })).toMatchObject({ state: 'applies', value: 27.5 });
    expect(evaluateRule(rule('from_high52_pct', 25), { fromHigh52Pct: F(0) })).toMatchObject({ state: 'clear', value: 0 });
  });

  it('day move: either direction, the value keeps its sign', () => {
    expect(ev('day_move_pct', -6.2)).toEqual({ state: 'applies', value: -6.2, source: LIVE, costAsOf: null });
    expect(ev('day_move_pct', -5)).toMatchObject({ state: 'applies', value: -5 });
    expect(ev('day_move_pct', -4.9)).toMatchObject({ state: 'clear', value: -4.9 });
  });

  it('returns and benchmark: + down / − up; + lagged / − beat SPY', () => {
    expect(evaluateRule(rule('drop_1m_pct'), { returnM1: F(4.5) })).toMatchObject({ state: 'clear', value: -4.5 });
    expect(evaluateRule(rule('drop_3m_pct'), { returnM3: F(-22.25) })).toMatchObject({ state: 'applies', value: 22.3 });
    expect(evaluateRule(rule('lag_spy_1y_pts'), { spyDiffY1: F(3.1) })).toMatchObject({ state: 'clear', value: -3.1 });
  });

  it('revenue growth: raw signed growth, below a negative threshold', () => {
    expect(ev('revenue_yoy_below', -16, -15)).toMatchObject({ state: 'applies', value: -16 });
    expect(ev('revenue_yoy_below', -15, -15)).toMatchObject({ state: 'clear' });
    expect(ev('revenue_yoy_below', 8, -15)).toMatchObject({ state: 'clear', value: 8 });
  });

  it('margin drop: + margin down (last year minus now), from the newer figure', () => {
    expect(evaluateRule(rule('margin_drop_pts', 5), { netMarginPct: F(11.5, SEC), netMarginPct1yAgo: F(18, { ...SEC, date: '2025-10-30' }) })).toEqual({ state: 'applies', value: 6.5, source: SEC, costAsOf: null });
    expect(evaluateRule(rule('margin_drop_pts', 5), { netMarginPct: F(18), netMarginPct1yAgo: F(11.5) })).toMatchObject({ state: 'clear', value: -6.5 });
  });

  it('dilution: + shares up; buybacks negative', () => {
    expect(evaluateRule(rule('dilution_pct', 5), { sharesChange1yPct: F(-3) })).toMatchObject({ state: 'clear', value: -3 });
  });

  it('concentration: share of the whole portfolio, the portfolio’s source; an empty portfolio is unknown', () => {
    expect(evaluateRule(rule('concentration_pct', 20), { valueIls: F(2_640_000, LIVE), portfolioIls: F(10_000_000, HOLD) })).toEqual({ state: 'applies', value: 26.4, source: HOLD, costAsOf: null });
    expect(evaluateRule(rule('concentration_pct', 20), { valueIls: F(1), portfolioIls: F(0) }).state).toBe('unknown');
  });

  it('analysts (Part B): toward buy + buy share up, toward sell + buy share down; the other way negative', () => {
    expect(evaluateRule(rule('analysts_toward_buy_pts', 10), { buyShareChange3mPts: F(12.5, FINN) })).toEqual({ state: 'applies', value: 12.5, source: FINN, costAsOf: null });
    expect(evaluateRule(rule('analysts_toward_buy_pts', 10), { buyShareChange3mPts: F(-12.5, FINN) })).toMatchObject({ state: 'clear', value: -12.5 });
    expect(evaluateRule(rule('analysts_toward_sell_pts', 10), { buyShareChange3mPts: F(-12.5, FINN) })).toEqual({ state: 'applies', value: 12.5, source: FINN, costAsOf: null });
    expect(evaluateRule(rule('analysts_toward_sell_pts', 10), { buyShareChange3mPts: F(4, FINN) })).toMatchObject({ state: 'clear', value: -4 });
    expect(evaluateRule(rule('analysts_toward_sell_pts', 10), { buyShareChange3mPts: F(0, FINN) })).toMatchObject({ state: 'clear', value: 0 });
    expect(evaluateRule(rule('analysts_toward_buy_pts', 10), { buyShareChange3mPts: null }).state).toBe('unknown');
  });

  it('earnings within N days (Part B): the days until; today counts (0); a past date or none is unknown', () => {
    expect(evaluateRule(rule('earnings_within_days', 7), { earningsDays: F(0, FINN) })).toEqual({ state: 'applies', value: 0, source: FINN, costAsOf: null });
    expect(evaluateRule(rule('earnings_within_days', 7), { earningsDays: F(7, FINN) })).toMatchObject({ state: 'applies', value: 7 });
    expect(evaluateRule(rule('earnings_within_days', 7), { earningsDays: F(8, FINN) })).toMatchObject({ state: 'clear', value: 8 });
    expect(evaluateRule(rule('earnings_within_days', 7), { earningsDays: F(-1, FINN) }).state).toBe('unknown');
    expect(evaluateRule(rule('earnings_within_days', 7), {}).state).toBe('unknown');
    // Finnhub answered and lists no report within its window: clear with value null (this template only)
    expect(evaluateRule(rule('earnings_within_days', 7), { earningsDays: { value: 120, source: FINN, noneWithin: true } })).toEqual({ state: 'clear', value: null, source: FINN, costAsOf: null });
    expect(evaluateRule(rule('analysts_toward_buy_pts', 10), { earningsDays: { value: 120, source: FINN, noneWithin: true } }).state).toBe('unknown');
  });

  it('rounds to 1 decimal (as shown) before comparing, so the shown value and the state agree', () => {
    // 19.96% below cost is shown as 20 and applies at 20; 19.94 is shown as 19.9 and does not
    expect(evaluateRule(rule('below_cost_pct', 20), { costPrice: F(100), price: F(80.04) })).toMatchObject({ state: 'applies', value: 20 });
    expect(evaluateRule(rule('below_cost_pct', 20), { costPrice: F(100), price: F(80.06) })).toMatchObject({ state: 'clear', value: 19.9 });
    // a 2-decimal threshold against a 1-decimal value
    expect(evaluateRule(rule('below_cost_pct', 19.95), { costPrice: F(100), price: F(80.04) })).toMatchObject({ state: 'applies', value: 20 });
    expect(evaluateRule(rule('below_cost_pct', 19.95), { costPrice: F(100), price: F(80.1) })).toMatchObject({ state: 'clear', value: 19.9 });
  });

  it('an unknown template or a params object without the threshold is unknown', () => {
    expect(evaluateRule({ template: 'nope', params: { pct: 5 } }, { price: F(1) })).toEqual({ state: 'unknown', value: null, source: null, costAsOf: null });
    expect(evaluateRule({ template: 'below_cost_pct', params: {} }, make.below_cost_pct(30))).toMatchObject({ state: 'unknown' });
  });
});
