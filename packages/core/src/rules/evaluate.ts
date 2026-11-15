/**
 * The pure evaluator of the owner's holding rules (stock-decision-aids.md, Part A): a rule (template + numbers) against
 * a facts object assembled from payloads finc already has (facts.ts) → applies / clear / unknown, the value that was
 * compared, and where it came from.
 *
 *  - the RAW condition: no hysteresis (that is for the Telegram step only); the panel and the badges show this;
 *  - unknown whenever a fact the template needs is missing (never 'clear');
 *  - the value is rounded to 1 decimal (as the app shows it) before it is compared, so the shown value and the state
 *    always agree;
 *  - 200-day-average streaks: when the streak on the rule's side reaches back to where the average starts (the true
 *    streak may be longer) and is shorter than N, the answer is unknown.
 *
 * `value` convention (the app relies on it): measured in the rule's direction, positive = in the rule's direction,
 * negative = the opposite, never clamped. below_cost_pct + below cost; above_cost_pct + above cost;
 * below_sma200_sessions + sessions below / − sessions above; above_sma200_sessions the mirror; from_high52_pct + % below
 * the 52-week high (≥ 0); day_move_pct the raw signed move (the exception: |value| is compared); drop_1m_pct /
 * drop_3m_pct + down; lag_spy_1y_pts + lagged / − beat; pe_above / pe_below the P/E; revenue_yoy_below the raw signed
 * growth; margin_drop_pts + margin down; dilution_pct + shares up; concentration_pct the share in percent;
 * analysts_toward_buy_pts + buy share up (points vs ~3 months earlier); analysts_toward_sell_pts + buy share down;
 * earnings_within_days the days until the next report (≥ 0; applies at or under N); the one 'clear' with value null:
 * Finnhub answered (fresh, or cached up to 30 days) and lists no report within 120 days.
 */
import { type FactKey, type RuleTemplate, ruleTemplate } from './templates.js';

export type RuleStateName = 'applies' | 'clear' | 'unknown';

/** Where a value came from; the app words it. Dates YYYY-MM-DD; times HH:MM Israel time. */
export interface RuleSource {
  /** live quote | bank snapshot | Yahoo history | SEC filing | the holdings totals (bank and live mixed) | Finnhub */
  kind: 'live' | 'bank' | 'yahoo' | 'sec' | 'holdings' | 'finnhub';
  /** live: the US session date (New York); bank/holdings: the snapshot date; yahoo: the last session; sec: the filing
   * date (or period end); finnhub: the Israel date Finnhub's answer was fetched */
  date: string | null;
  time: string | null;
  /** sec only: 10-K, 10-Q… */
  form: string | null;
}

export interface Fact {
  value: number;
  source: RuleSource;
  /** daysAboveSma200 only: the streak reaches back to where the 200-day average starts */
  lowerBound?: boolean;
  /** earningsDays only: Finnhub answered and lists no report within its window (EARNINGS_AHEAD_DAYS): `value` is then
   * a placeholder and earnings_within_days is 'clear' with value null */
  noneWithin?: boolean;
}

export type RuleFacts = Partial<Record<FactKey, Fact | null>>;

export interface RuleResult {
  state: RuleStateName;
  /** in the template's own terms, 1 decimal; null when unknown */
  value: number | null;
  source: RuleSource | null;
  /** the cost templates: the date of the bank snapshot whose cost price was used; otherwise null */
  costAsOf: string | null;
}

const round1 = (v: number): number => {
  const x = Math.round(v * 10) / 10;
  return Object.is(x, -0) ? 0 : x;
};

const UNKNOWN: RuleResult = { state: 'unknown', value: null, source: null, costAsOf: null };

/** The value a template compares and its source; null when a needed fact is missing, not finite, or not usable. */
export function ruleValue(tpl: RuleTemplate, facts: RuleFacts, threshold: number): { value: number; source: RuleSource; costAsOf: string | null } | null {
  const f: Partial<Record<FactKey, Fact>> = {};
  for (const k of tpl.facts) {
    const x = facts[k];
    if (!x || typeof x.value !== 'number' || !Number.isFinite(x.value)) return null;
    f[k] = x;
  }
  const out = (value: number, src: Fact, costAsOf: string | null = null) => (Number.isFinite(value) ? { value: round1(value), source: { ...src.source }, costAsOf } : null);
  // sessions on the rule's side (positive), or on the other side (negative): not clamped
  const sma = (side: 1 | -1) => {
    const d = f.daysAboveSma200!;
    const sessions = side * d.value;
    // a streak on the rule's side that may be longer than counted, and short of N: cannot say
    if (sessions > 0 && d.lowerBound && sessions < threshold) return null;
    return out(sessions, d);
  };
  switch (tpl.id) {
    case 'below_cost_pct':
      return f.costPrice!.value > 0 ? out(((f.costPrice!.value - f.price!.value) / f.costPrice!.value) * 100, f.price!, f.costPrice!.source.date) : null;
    case 'above_cost_pct':
      return f.costPrice!.value > 0 ? out((f.price!.value / f.costPrice!.value - 1) * 100, f.price!, f.costPrice!.source.date) : null;
    case 'below_sma200_sessions':
      return sma(-1);
    case 'above_sma200_sessions':
      return sma(1);
    case 'from_high52_pct':
      return out(-f.fromHigh52Pct!.value, f.fromHigh52Pct!);
    case 'day_move_pct':
      return out(f.dayChangePct!.value, f.dayChangePct!);
    case 'drop_1m_pct':
      return out(-f.returnM1!.value, f.returnM1!);
    case 'drop_3m_pct':
      return out(-f.returnM3!.value, f.returnM3!);
    case 'lag_spy_1y_pts':
      return out(-f.spyDiffY1!.value, f.spyDiffY1!);
    case 'pe_above':
    case 'pe_below':
      return out(f.pe!.value, f.pe!);
    case 'revenue_yoy_below':
      return out(f.revenueYoYPct!.value, f.revenueYoYPct!);
    case 'margin_drop_pts':
      return out(f.netMarginPct1yAgo!.value - f.netMarginPct!.value, f.netMarginPct!);
    case 'dilution_pct':
      return out(f.sharesChange1yPct!.value, f.sharesChange1yPct!);
    case 'concentration_pct':
      return f.portfolioIls!.value > 0 && f.valueIls!.value >= 0 ? out((f.valueIls!.value / f.portfolioIls!.value) * 100, f.portfolioIls!) : null;
    case 'analysts_toward_buy_pts':
      return out(f.buyShareChange3mPts!.value, f.buyShareChange3mPts!);
    case 'analysts_toward_sell_pts':
      return out(-f.buyShareChange3mPts!.value, f.buyShareChange3mPts!);
    case 'earnings_within_days':
      return f.earningsDays!.value >= 0 ? out(f.earningsDays!.value, f.earningsDays!) : null;
  }
}

/** Does `m` meet the condition? */
function meets(tpl: RuleTemplate, m: number, th: number): boolean {
  if (tpl.direction === 'up') return tpl.strict ? m > th : m >= th;
  return tpl.strict ? m < th : m <= th;
}

/** One rule against the facts, raw. An unknown template or a params object without the threshold answers 'unknown'. */
export function evaluateRule(rule: { template: string; params: Record<string, number> }, facts: RuleFacts): RuleResult {
  const tpl = ruleTemplate(rule.template);
  const th = tpl ? rule.params[tpl.threshold] : undefined;
  if (!tpl || typeof th !== 'number' || !Number.isFinite(th)) return { ...UNKNOWN };
  const ed = facts.earningsDays;
  if (tpl.id === 'earnings_within_days' && ed?.noneWithin) return { state: 'clear', value: null, source: { ...ed.source }, costAsOf: null };
  const v = ruleValue(tpl, facts, th);
  if (!v) return { ...UNKNOWN };
  const m = tpl.abs ? Math.abs(v.value) : v.value;
  return { state: meets(tpl, m, th) ? 'applies' : 'clear', value: v.value, source: v.source, costAsOf: v.costAsOf };
}
