/**
 * The fixed list of rule templates for the owner's own holding rules (research_notes/proposals/stock-decision-aids.md,
 * Part A, templates 1–13; Part B, templates 14–15 from Finnhub). A rule is a template + the owner's numbers + a scope; there is no free text and no code.
 *
 * Each template names its params (typed, with a range and a default), the facts it reads (evaluate.ts), the direction
 * of its condition and how the value it compares is shown:
 *  - 'up': applies when the value is at or above the threshold (`strict`: above);
 *  - 'down': applies when the value is at or below the threshold (`strict`: below);
 *  - `abs`: the absolute value is compared (the day's move either way); the value shown keeps its sign.
 * Values (rounded to 1 decimal, as the app shows them) are in the template's own terms, positive in the rule's direction: "27.5" for "27.5% below my purchase price",
 * "41" for "41 sessions below the 200-day average", "12" for "lagged SPY by 12 points".
 */
export type ParamKind = 'pct' | 'int' | 'number';

export interface ParamSpec {
  key: string;
  kind: ParamKind;
  min: number;
  max: number;
  default: number;
}

export type FactKey =
  | 'costPrice'
  | 'price'
  | 'valueIls'
  | 'portfolioIls'
  | 'dayChangePct'
  | 'daysAboveSma200'
  | 'fromHigh52Pct'
  | 'returnM1'
  | 'returnM3'
  | 'spyDiffY1'
  | 'pe'
  | 'revenueYoYPct'
  | 'netMarginPct'
  | 'netMarginPct1yAgo'
  | 'sharesChange1yPct'
  | 'buyShareChange3mPts'
  | 'earningsDays';

export const TEMPLATE_IDS = [
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
] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export interface RuleTemplate {
  id: TemplateId;
  params: ParamSpec[];
  /** the facts the value is computed from; any of them missing → 'unknown' */
  facts: FactKey[];
  /** the param holding the threshold */
  threshold: string;
  direction: 'up' | 'down';
  strict: boolean;
  abs: boolean;
}

const p = (key: string, kind: ParamKind, min: number, max: number, def: number): ParamSpec => ({ key, kind, min, max, default: def });
const t = (id: TemplateId, param: ParamSpec, facts: FactKey[], direction: 'up' | 'down' = 'up', o: { strict?: boolean; abs?: boolean } = {}): RuleTemplate => ({
  id,
  params: [param],
  facts,
  threshold: param.key,
  direction,
  strict: o.strict ?? false,
  abs: o.abs ?? false,
});

export const RULE_TEMPLATES: readonly RuleTemplate[] = [
  // 1–2: the bank's (checked) cost price against the live or bank price
  t('below_cost_pct', p('pct', 'pct', 1, 95, 20), ['costPrice', 'price']),
  t('above_cost_pct', p('pct', 'pct', 1, 1000, 50), ['costPrice', 'price']),
  // 3–5: the step-1 trend (Yahoo)
  t('below_sma200_sessions', p('n', 'int', 1, 250, 20), ['daysAboveSma200']),
  t('above_sma200_sessions', p('n', 'int', 1, 250, 60), ['daysAboveSma200']),
  t('from_high52_pct', p('pct', 'pct', 1, 95, 25), ['fromHigh52Pct']),
  // 6: live (or the bank's) day change, either way
  t('day_move_pct', p('pct', 'pct', 0.5, 50, 5), ['dayChangePct'], 'up', { abs: true }),
  // 7: step-1 returns
  t('drop_1m_pct', p('pct', 'pct', 1, 95, 10), ['returnM1']),
  t('drop_3m_pct', p('pct', 'pct', 1, 95, 20), ['returnM3']),
  // 8: step-1 benchmark (SPY), points
  t('lag_spy_1y_pts', p('pts', 'number', 1, 200, 15), ['spyDiffY1']),
  // 9–12: step-2 company figures (SEC)
  t('pe_above', p('x', 'number', 1, 1000, 40), ['pe'], 'up', { strict: true }),
  t('pe_below', p('x', 'number', 1, 1000, 10), ['pe'], 'down', { strict: true }),
  t('revenue_yoy_below', p('pct', 'pct', -100, 100, 0), ['revenueYoYPct'], 'down', { strict: true }),
  t('margin_drop_pts', p('pts', 'number', 0.5, 100, 5), ['netMarginPct', 'netMarginPct1yAgo']),
  t('dilution_pct', p('pct', 'pct', 0.5, 100, 5), ['sharesChange1yPct']),
  // 13: the holding's share of every holding (both FIBI accounts), live where live
  t('concentration_pct', p('pct', 'pct', 1, 100, 20), ['valueIls', 'portfolioIls']),
  // 14: Finnhub analysts, the change of the buy share (strong buy + buy) vs ~3 months earlier, points, either way
  t('analysts_toward_buy_pts', p('pts', 'number', 1, 100, 10), ['buyShareChange3mPts']),
  t('analysts_toward_sell_pts', p('pts', 'number', 1, 100, 10), ['buyShareChange3mPts']),
  // 15: Finnhub earnings calendar, days until the next report (Israel date)
  t('earnings_within_days', p('n', 'int', 1, 60, 7), ['earningsDays'], 'down'),
];

const BY_ID = new Map<string, RuleTemplate>(RULE_TEMPLATES.map((x) => [x.id, x]));

export function ruleTemplate(id: string): RuleTemplate | null {
  return BY_ID.get(id) ?? null;
}

export const isTemplateId = (id: string): id is TemplateId => BY_ID.has(id);

/** The templates as the API lists them (GET /api/holding-rules). */
export function templateList(): Array<{ id: TemplateId; params: ParamSpec[] }> {
  return RULE_TEMPLATES.map((x) => ({ id: x.id, params: x.params.map((q) => ({ ...q })) }));
}

/** The template's defaults, e.g. { pct: 20 }. */
export function defaultParams(id: TemplateId): Record<string, number> {
  return Object.fromEntries(ruleTemplate(id)!.params.map((q) => [q.key, q.default]));
}

/**
 * Checks params against the template: exactly its keys, each a finite number within [min, max] with at most 2
 * decimals (a whole number for 'int'). Returns the clean object, or an English reason.
 */
export function validateParams(id: string, params: unknown): { ok: true; params: Record<string, number> } | { ok: false; error: string } {
  const tpl = ruleTemplate(id);
  if (!tpl) return { ok: false, error: 'unknown template' };
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return { ok: false, error: 'params must be an object' };
  const given = Object.keys(params);
  const keys = tpl.params.map((q) => q.key);
  const extra = given.filter((k) => !keys.includes(k));
  if (extra.length) return { ok: false, error: `unknown param ${extra[0]!.slice(0, 20)} for ${id}` };
  const out: Record<string, number> = {};
  for (const q of tpl.params) {
    const v = (params as Record<string, unknown>)[q.key];
    if (v === undefined) return { ok: false, error: `missing param ${q.key} for ${id}` };
    if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, error: `${q.key} must be a number` };
    if (q.kind === 'int' && !Number.isInteger(v)) return { ok: false, error: `${q.key} must be a whole number` };
    if (v < q.min || v > q.max) return { ok: false, error: `${q.key} must be from ${q.min} to ${q.max}` };
    if (Math.abs(Math.round(v * 100) - v * 100) > 1e-6) return { ok: false, error: `${q.key} may have at most 2 decimals` };
    out[q.key] = v;
  }
  return { ok: true, params: out };
}
