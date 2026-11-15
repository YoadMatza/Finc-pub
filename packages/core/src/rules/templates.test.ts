import { describe, expect, it } from 'vitest';
import { RULE_TEMPLATES, TEMPLATE_IDS, defaultParams, ruleTemplate, templateList, validateParams } from './templates.js';

describe('rule templates', () => {
  it('lists the 15 agreed templates (18 ids: 7, 9 and 14 come in two), each with one ranged param and its facts', () => {
    expect(TEMPLATE_IDS).toEqual([
      'below_cost_pct',
      'above_cost_pct',
      'below_sma200_sessions',
      'above_sma200_sessions',
      'from_high52_pct',
      'day_move_pct',
      'drop_1m_pct',
      'drop_3m_pct',
      'lag_spy_1y_pts',
      'pe_above',
      'pe_below',
      'revenue_yoy_below',
      'margin_drop_pts',
      'dilution_pct',
      'concentration_pct',
      'analysts_toward_buy_pts',
      'analysts_toward_sell_pts',
      'earnings_within_days',
    ]);
    for (const t of RULE_TEMPLATES) {
      expect(t.facts.length).toBeGreaterThan(0);
      expect(t.params.map((p) => p.key)).toContain(t.threshold);
      for (const p of t.params) {
        expect(p.min).toBeLessThan(p.max);
        expect(p.default).toBeGreaterThanOrEqual(p.min);
        expect(p.default).toBeLessThanOrEqual(p.max);
        expect(['pct', 'int', 'number']).toContain(p.kind);
        expect(validateParams(t.id, defaultParams(t.id))).toEqual({ ok: true, params: defaultParams(t.id) });
      }
    }
    expect(templateList().map((t) => t.id)).toEqual([...TEMPLATE_IDS]);
    expect(templateList()[0]).toEqual({ id: 'below_cost_pct', params: [{ key: 'pct', kind: 'pct', min: 1, max: 95, default: 20 }] });
    expect(ruleTemplate('revenue_yoy_below')!.params[0]).toMatchObject({ min: -100 }); // may be negative
    expect(ruleTemplate('nope')).toBeNull();
    // Part B
    expect(ruleTemplate('analysts_toward_buy_pts')).toMatchObject({ params: [{ key: 'pts', kind: 'number', min: 1, max: 100 }], facts: ['buyShareChange3mPts'], direction: 'up' });
    expect(ruleTemplate('analysts_toward_sell_pts')).toMatchObject({ params: [{ key: 'pts', kind: 'number', min: 1, max: 100 }], facts: ['buyShareChange3mPts'], direction: 'up' });
    expect(ruleTemplate('earnings_within_days')).toMatchObject({ params: [{ key: 'n', kind: 'int', min: 1, max: 60 }], facts: ['earningsDays'], direction: 'down', strict: false });
  });

  it('accepts exactly the template keys within range', () => {
    expect(validateParams('below_cost_pct', { pct: 1 })).toEqual({ ok: true, params: { pct: 1 } });
    expect(validateParams('below_cost_pct', { pct: 95 })).toEqual({ ok: true, params: { pct: 95 } });
    expect(validateParams('below_cost_pct', { pct: 12.5 })).toEqual({ ok: true, params: { pct: 12.5 } });
    expect(validateParams('below_cost_pct', { pct: 12.35 })).toEqual({ ok: true, params: { pct: 12.35 } });
    expect(validateParams('day_move_pct', { pct: 0.07 * 100 })).toEqual({ ok: true, params: { pct: 7.000000000000001 } }); // float noise is not a third decimal
    expect(validateParams('revenue_yoy_below', { pct: -15 })).toEqual({ ok: true, params: { pct: -15 } });
    expect(validateParams('below_sma200_sessions', { n: 41 })).toEqual({ ok: true, params: { n: 41 } });
  });

  it.each([
    ['nope', { pct: 5 }, 'unknown template'],
    ['below_cost_pct', null, 'params must be an object'],
    ['below_cost_pct', [5], 'params must be an object'],
    ['below_cost_pct', 'pct=5', 'params must be an object'],
    ['below_cost_pct', {}, 'missing param pct for below_cost_pct'],
    ['below_cost_pct', { pct: 5, extra: 1 }, 'unknown param extra for below_cost_pct'],
    ['below_cost_pct', { n: 5 }, 'unknown param n for below_cost_pct'],
    ['below_cost_pct', { pct: '5' }, 'pct must be a number'],
    ['below_cost_pct', { pct: Number.NaN }, 'pct must be a number'],
    ['below_cost_pct', { pct: Number.POSITIVE_INFINITY }, 'pct must be a number'],
    ['below_cost_pct', { pct: 0.99 }, 'pct must be from 1 to 95'],
    ['below_cost_pct', { pct: 95.01 }, 'pct must be from 1 to 95'],
    ['below_sma200_sessions', { n: 20.5 }, 'n must be a whole number'],
    ['below_cost_pct', { pct: 12.345 }, 'pct may have at most 2 decimals'],
    ['revenue_yoy_below', { pct: -0.001 }, 'pct may have at most 2 decimals'],
    ['below_sma200_sessions', { n: 251 }, 'n must be from 1 to 250'],
    ['revenue_yoy_below', { pct: -101 }, 'pct must be from -100 to 100'],
    ['analysts_toward_buy_pts', { pts: 0.5 }, 'pts must be from 1 to 100'],
    ['analysts_toward_sell_pts', { pts: 101 }, 'pts must be from 1 to 100'],
    ['earnings_within_days', { n: 0 }, 'n must be from 1 to 60'],
    ['earnings_within_days', { n: 61 }, 'n must be from 1 to 60'],
    ['earnings_within_days', { n: 3.5 }, 'n must be a whole number'],
  ])('refuses %s %j', (id, params, error) => {
    expect(validateParams(id, params)).toEqual({ ok: false, error });
  });
});
