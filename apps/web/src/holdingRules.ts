/**
 * Stock decision aids, part A: the owner's own rules. Pure helpers for the Settings editor, the insights panel and the
 * holdings badge: the sentence for a rule with its numbers filled in, the value that was checked, grouping by state,
 * number validation and the example rules. Wording is neutral: a rule "applies"; finc never says what to do.
 * Tested in holdingRules.test.ts.
 */
import type { Key } from './i18n';
import type { HoldingRule, HoldingRuleInput, HoldingRuleParamSpec, HoldingRuleResult, HoldingRuleSource, HoldingRuleTemplate, HoldingRuleTemplateId } from './types';

type T = (key: Key, vars?: Record<string, string | number>) => string;

/** The TanStack Query key of GET /api/holding-rules (the editor page and the Settings card share it). */
export const HOLDING_RULES_KEY = ['holding-rules'] as const;

/** The templates this app has words for, in the order the picker shows them. */
export const TEMPLATE_IDS: readonly HoldingRuleTemplateId[] = [
  'below_cost_pct',
  'above_cost_pct',
  'concentration_pct',
  'day_move_pct',
  'drop_1m_pct',
  'drop_3m_pct',
  'from_high52_pct',
  'below_sma200_sessions',
  'above_sma200_sessions',
  'lag_spy_1y_pts',
  'pe_above',
  'pe_below',
  'revenue_yoy_below',
  'margin_drop_pts',
  'dilution_pct',
  'analysts_toward_buy_pts',
  'analysts_toward_sell_pts',
  'earnings_within_days',
];

export const isKnownTemplate = (id: string): id is HoldingRuleTemplateId => (TEMPLATE_IDS as readonly string[]).includes(id);

/** A parameter's own number as typed in a sentence: whole for `int`, otherwise up to two decimals, no grouping. */
export function paramText(v: number, kind: HoldingRuleParamSpec['kind'] = 'number'): string {
  if (!Number.isFinite(v)) return '?';
  if (kind === 'int') return String(Math.round(v));
  return String(Math.round(v * 100) / 100);
}

/** Templates whose `n` counts calendar days, not trading sessions. */
const N_IS_DAYS: ReadonlySet<string> = new Set(['earnings_within_days']);

/** The label for a parameter's input (pct, n, pts, x); unknown keys show the key itself. */
export function paramLabel(t: T, key: string, template?: string): string {
  if (key === 'n' && template && N_IS_DAYS.has(template)) return t('hr_p_days');
  return key === 'pct' || key === 'n' || key === 'pts' || key === 'x' ? t(`hr_p_${key}`) : key;
}

/** The rule as a sentence with its numbers, e.g. "Price is 20% or more below my purchase price". */
export function ruleSentence(t: T, template: string, params: Record<string, number>, specs?: HoldingRuleParamSpec[]): string {
  const kindOf = (k: string) => specs?.find((s) => s.key === k)?.kind ?? (k === 'n' ? 'int' : 'number');
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) vars[k] = paramText(v, kindOf(k));
  if (isKnownTemplate(template)) return t(`hr_t_${template}`, vars);
  const list = Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  return `${t('hr_unknown_template')} (${template}${list ? `: ${list}` : ''})`;
}

/** The template's sentence with placeholders (X, N) for the picker, before the owner sets numbers. */
export function templateLabel(t: T, tpl: HoldingRuleTemplate): string {
  if (!isKnownTemplate(tpl.id)) return `${t('hr_unknown_template')} (${tpl.id})`;
  const vars: Record<string, string> = {};
  for (const p of tpl.params) vars[p.key] = p.kind === 'int' ? 'N' : 'X';
  return t(`hr_t_${tpl.id}`, vars);
}

const TZ = 'Asia/Jerusalem';

/** A YYYY-MM-DD day in Israel time: a bare date as is, a timestamp converted (not the UTC day); null when unreadable. */
export function jerusalemDay(s: string | null | undefined): string | null {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** HH:MM from "HH:MM[:SS]" as is, or from a timestamp in Israel time; null when unreadable. */
export function clockText(s: string | null | undefined): string | null {
  if (!s) return null;
  if (/^\d{2}:\d{2}/.test(s)) return s.slice(0, 5);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
}

/** "10.11", or "31.10.2026" with the year; null when unreadable. */
export function dayDots(s: string | null | undefined, year = false): string | null {
  const day = jerusalemDay(s);
  if (!day) return null;
  const [y, m, d] = day.split('-');
  return `${Number(d)}.${Number(m)}${year ? `.${y}` : ''}`;
}

/** The value rounded as the hub compares it (one decimal). */
const r1 = (v: number) => Math.round(v * 10) / 10;

/**
 * How the hub's `value` reads per template. The hub measures it in the RULE'S direction: positive = the way the rule
 * looks (27 for below_cost_pct = 27% below cost), negative = the opposite way (−15 = 15% above cost). Exceptions:
 * day_move_pct and revenue_yoy_below are the raw signed move / growth; pe_* is the P/E; concentration_pct the share.
 * analysts_toward_buy_pts is the change of the analysts' buy share in points (+ = more buy ratings), and
 * analysts_toward_sell_pts the same change with the opposite sign; earnings_within_days the days until the report.
 * `pos` is the key for a value ≥ 0 (in the rule's direction), `neg` for a value < 0; `zero` overrides exactly 0.
 * Every key takes the absolute value as {v} (or {n} for sessions and days).
 */
const VALUE_WORDS: Record<HoldingRuleTemplateId, { pos: Key; neg: Key; zero?: Key; sessions?: true; days?: true }> = {
  below_cost_pct: { pos: 'hr_v_cost_below', neg: 'hr_v_cost_above' },
  above_cost_pct: { pos: 'hr_v_cost_above', neg: 'hr_v_cost_below' },
  below_sma200_sessions: { pos: 'hr_v_sma_below', neg: 'hr_v_sma_above', zero: 'hr_v_sma_not_below', sessions: true },
  above_sma200_sessions: { pos: 'hr_v_sma_above', neg: 'hr_v_sma_below', zero: 'hr_v_sma_not_above', sessions: true },
  from_high52_pct: { pos: 'hr_v_high52_below', neg: 'hr_v_high52_at', zero: 'hr_v_high52_at' },
  day_move_pct: { pos: 'hr_v_up_today', neg: 'hr_v_down_today' },
  drop_1m_pct: { pos: 'hr_v_down', neg: 'hr_v_up' },
  drop_3m_pct: { pos: 'hr_v_down', neg: 'hr_v_up' },
  lag_spy_1y_pts: { pos: 'hr_v_spy_lag', neg: 'hr_v_spy_beat' },
  pe_above: { pos: 'hr_v_pe', neg: 'hr_v_pe' },
  pe_below: { pos: 'hr_v_pe', neg: 'hr_v_pe' },
  revenue_yoy_below: { pos: 'hr_v_rev_up', neg: 'hr_v_rev_down' },
  margin_drop_pts: { pos: 'hr_v_margin_down', neg: 'hr_v_margin_up' },
  dilution_pct: { pos: 'hr_v_shares_up', neg: 'hr_v_shares_down' },
  concentration_pct: { pos: 'hr_v_share_of', neg: 'hr_v_share_of' },
  analysts_toward_buy_pts: { pos: 'hr_v_an_buy_up', neg: 'hr_v_an_buy_down', zero: 'hr_v_an_buy_same' },
  analysts_toward_sell_pts: { pos: 'hr_v_an_buy_down', neg: 'hr_v_an_buy_up', zero: 'hr_v_an_buy_same' },
  earnings_within_days: { pos: 'hr_v_earn_in', neg: 'hr_v_earn_ago', zero: 'hr_v_earn_today', days: true },
};

/**
 * The value a rule was checked against, in words with its direction (VALUE_WORDS), one decimal:
 * "27.3% below cost", "41 sessions below the 200-day average", "lagged SPY by 15.0 points", "P/E 46.3".
 * Null when unknown.
 */
export function valueText(t: T, template: string, value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  if (!isKnownTemplate(template)) return r1(value).toFixed(1);
  const w = VALUE_WORDS[template];
  if (w.days) {
    const n = Math.round(value);
    if (n === 0 && w.zero) return t(w.zero);
    if (n === 1) return t('hr_v_earn_tomorrow');
    return t(n > 0 ? w.pos : w.neg, { n: Math.abs(n) });
  }
  if (w.sessions) {
    const n = Math.round(value);
    if (n === 0 && w.zero) return t(w.zero);
    return t(n > 0 ? w.pos : w.neg, { n: Math.abs(n) });
  }
  const v = r1(value);
  if (v === 0 && w.zero) return t(w.zero);
  // the P/E itself can be negative (a loss): keep its sign
  if (template === 'pe_above' || template === 'pe_below') return t('hr_v_pe', { v: v.toFixed(1) });
  return t(v >= 0 ? w.pos : w.neg, { v: Math.abs(v).toFixed(1) });
}

/** How far ahead the hub looks for the next earnings report (days): no report in that window = no value. */
export const EARNINGS_HORIZON_DAYS = 120;

/**
 * "now: 41 sessions below the 200-day average", or null when there is no value. The earnings rule checked with no
 * report in the hub's window comes back 'clear' with no value: "now: no report within 120 days".
 */
export function nowText(t: T, template: string, value: number | null | undefined, state?: HoldingRuleResult['state']): string | null {
  if ((value === null || value === undefined) && template === 'earnings_within_days' && state === 'clear') {
    return t('hr_now', { v: t('hr_v_earn_none', { n: EARNINGS_HORIZON_DAYS }) });
  }
  const v = valueText(t, template, value);
  return v === null ? null : t('hr_now', { v });
}

/**
 * Where a value came from: "live 14:32", "bank 06:01", "Yahoo, 10.11", "10-Q filed 31.10.2026", "your holdings",
 * "Finnhub, 11.11".
 * A plain string (an older hub) shows as sent, at most 80 characters. Null when there is nothing to show.
 */
export function sourceText(t: T, src: HoldingRuleSource | string | null | undefined): string | null {
  if (!src) return null;
  if (typeof src === 'string') {
    const s = src.trim();
    if (!s) return null;
    return s.length > 80 ? `${s.slice(0, 79)}…` : s;
  }
  const time = clockText(src.time);
  const day = dayDots(src.date);
  switch (src.kind) {
    case 'live':
      return time ? t('hr_src_live_at', { t: time }) : t('hr_src_live');
    case 'bank':
      return time ? t('hr_src_bank_at', { t: time }) : day ? `${t('hr_src_bank')}, ${day}` : t('hr_src_bank');
    case 'yahoo':
      return day ? `Yahoo, ${day}` : 'Yahoo';
    case 'sec': {
      const full = dayDots(src.date, true);
      const form = src.form?.trim().slice(0, 20) || null;
      if (form && full) return t('hr_src_filed', { f: form, d: full });
      if (form) return form;
      return full ? `SEC, ${full}` : 'SEC';
    }
    case 'holdings':
      return time ? t('hr_src_holdings_at', { t: time }) : t('hr_src_holdings');
    case 'finnhub':
      return day ? `Finnhub, ${day}` : 'Finnhub';
    default:
      return null;
  }
}

/** For a rule that could not be checked: "last known: applied on 9.11", when the hub sent it; else null. */
export function lastKnownText(t: T, r: HoldingRuleResult): string | null {
  if (r.state !== 'unknown' || (r.lastKnownState !== 'applies' && r.lastKnownState !== 'clear')) return null;
  const d = dayDots(r.lastKnownAt);
  if (!d) return null;
  return t(r.lastKnownState === 'applies' ? 'hr_last_applied' : 'hr_last_clear', { d });
}

/** A help line for a template, when its words need one (what "my portfolio" means, what the buy share is). */
export function templateHelp(t: T, template: string): string | null {
  if (template === 'concentration_pct') return t('hr_help_concentration');
  if (template === 'analysts_toward_buy_pts' || template === 'analysts_toward_sell_pts') return t('hr_help_analysts');
  if (template === 'earnings_within_days') return t('hr_help_earnings');
  return null;
}

export interface RuleGroups {
  applies: HoldingRuleResult[];
  clear: HoldingRuleResult[];
  unknown: HoldingRuleResult[];
}

/** Rules by state; the ones that apply newest first by `since` (no date last), the rest in the hub's order. */
export function groupResults(results: readonly HoldingRuleResult[] | null | undefined): RuleGroups {
  const g: RuleGroups = { applies: [], clear: [], unknown: [] };
  for (const r of results ?? []) {
    if (r.state === 'applies') g.applies.push(r);
    else if (r.state === 'clear') g.clear.push(r);
    else g.unknown.push(r); // anything unexpected counts as unknown, never as "doesn't apply"
  }
  g.applies.sort((a, b) => (b.since ?? '').localeCompare(a.since ?? ''));
  return g;
}

/** The muted summary parts: "3 don't apply", "1 unknown (data missing)"; empty parts left out. */
export function restSummary(t: T, g: RuleGroups): string {
  const parts: string[] = [];
  if (g.clear.length) parts.push(t('hr_ins_clear', { n: g.clear.length }));
  if (g.unknown.length) parts.push(t('hr_ins_unknown', { n: g.unknown.length }));
  return parts.join(' · ');
}

/**
 * The line shown when no rule applies: plainly none; none on the data available with M not checked; or none could be
 * checked at all. Null when some rule applies.
 */
export function noneApplyText(t: T, g: RuleGroups): string | null {
  if (g.applies.length) return null;
  if (g.unknown.length && !g.clear.length) return t('hr_ins_all_unknown');
  if (g.unknown.length) return t('hr_ins_none_some_unknown', { m: g.unknown.length });
  return t('hr_ins_none_apply');
}

/** The day (YYYY-MM-DD, Israel time) of `since`, or null. */
export function sinceDay(since: string | null | undefined): string | null {
  return jerusalemDay(since);
}

/** A typed number for a parameter: at most two decimals, inside [min, max], whole for `int`; otherwise null. */
export function parseParam(input: string, spec: HoldingRuleParamSpec): number | null {
  const s = input.trim().replace(',', '.').replace('−', '-');
  if (!/^-?\d{1,7}(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  if (spec.kind === 'int' && !Number.isInteger(n)) return null;
  return n >= spec.min && n <= spec.max ? n : null;
}

/** All parameters of a draft parsed, or null when any is missing or out of range. */
export function parseParams(draft: Record<string, string>, specs: HoldingRuleParamSpec[]): Record<string, number> | null {
  const out: Record<string, number> = {};
  for (const spec of specs) {
    const n = parseParam(draft[spec.key] ?? '', spec);
    if (n === null) return null;
    out[spec.key] = n;
  }
  return out;
}

/** The draft text for a template's parameters: the given values (an existing rule) or the template's defaults. */
export function draftOf(specs: HoldingRuleParamSpec[], values?: Record<string, number>): Record<string, string> {
  return Object.fromEntries(specs.map((s) => [s.key, paramText(values?.[s.key] ?? s.default, s.kind)]));
}

export function sameParams(a: Record<string, number>, b: Record<string, number>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

/**
 * The parameters to save from an edit: a field whose text the owner did not touch keeps the rule's exact number (a
 * threshold stored with more decimals than the form shows is not rounded by re-saving another field).
 */
export function keepUntouched(parsed: Record<string, number>, draft: Record<string, string>, initialDraft: Record<string, string>, original: Record<string, number> | null | undefined): Record<string, number> {
  const out: Record<string, number> = { ...parsed };
  for (const k of Object.keys(out)) {
    const o = original?.[k];
    if (o !== undefined && Number.isFinite(o) && draft[k] === initialDraft[k]) out[k] = o;
  }
  return out;
}

/** The PATCH body for an edit: only what changed; null when nothing did. */
export function ruleChanges(rule: HoldingRule, next: { params: Record<string, number>; scopeSymbol: string | null; enabled: boolean }): Partial<HoldingRuleInput> | null {
  const out: Partial<HoldingRuleInput> = {};
  if (!sameParams(rule.params, next.params)) out.params = next.params;
  if (rule.scopeSymbol !== next.scopeSymbol) out.scopeSymbol = next.scopeSymbol;
  if (rule.enabled !== next.enabled) out.enabled = next.enabled;
  return Object.keys(out).length ? out : null;
}

/** Example rules the owner can add with one tap; they are created switched off. */
export const EXAMPLE_RULES: ReadonlyArray<{ template: HoldingRuleTemplateId; params: Record<string, number> }> = [
  { template: 'below_cost_pct', params: { pct: 20 } },
  { template: 'concentration_pct', params: { pct: 25 } },
  { template: 'below_sma200_sessions', params: { n: 40 } },
  { template: 'from_high52_pct', params: { pct: 30 } },
];

/**
 * The examples still worth offering: the hub knows the template, the numbers fit its ranges (clamped otherwise), and
 * the owner has no rule with the same template for all holdings yet.
 */
export function suggestions(templates: HoldingRuleTemplate[], rules: HoldingRule[]): HoldingRuleInput[] {
  const out: HoldingRuleInput[] = [];
  for (const ex of EXAMPLE_RULES) {
    const tpl = templates.find((x) => x.id === ex.template);
    if (!tpl) continue;
    if (rules.some((r) => r.template === ex.template && r.scopeSymbol === null)) continue;
    const params: Record<string, number> = {};
    for (const spec of tpl.params) {
      const v = ex.params[spec.key] ?? spec.default;
      params[spec.key] = Math.min(spec.max, Math.max(spec.min, v));
    }
    out.push({ template: ex.template, params, scopeSymbol: null, enabled: false, notify: false });
  }
  return out;
}

/** Templates for the picker: the known ones in TEMPLATE_IDS order, then any the app does not know, by id. */
export function orderedTemplates(templates: HoldingRuleTemplate[]): HoldingRuleTemplate[] {
  const rank = (id: string) => {
    const i = (TEMPLATE_IDS as readonly string[]).indexOf(id);
    return i < 0 ? TEMPLATE_IDS.length : i;
  };
  return [...templates].sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

/** The holdings badge: a count when at least one rule applies, else null. */
export function badgeCount(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}
