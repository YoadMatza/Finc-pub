/**
 * The signals board (research_notes/proposals/stock-decision-aids.md, Part E): instead of a combined score, every
 * source gets the same simple, documented reading, and the board says where they agree. Deterministic rules on data the
 * panel already has; a reading without its data is "unavailable", never a guess. No number score, no buy / sell / hold:
 * the owner's own rules are counted, not judged. News tone (Part C) is not built yet and always reads "unavailable";
 * Reddit (Part D) was dropped by the owner on 2026-11-16.
 */
import type { HoldingInsights } from './panel.js';

export type SignalKey = 'trend' | 'market' | 'company' | 'analysts' | 'news';
export type SignalReading = 'up' | 'down' | 'mixed' | 'ahead' | 'behind' | 'in_line' | 'growing' | 'shrinking' | 'positive' | 'negative' | 'unavailable';

export interface BoardSignal {
  key: SignalKey;
  reading: SignalReading;
  /** +1 the favourable reading, −1 the unfavourable one, 0 neutral (mixed / in line), null unavailable */
  direction: 1 | -1 | 0 | null;
  /** the numbers the rule looked at (shown on tap), null where missing */
  facts: Record<string, number | null>;
  /** why it is unavailable, when it is */
  why?: 'no_data' | 'not_built' | 'etf';
}

export interface SignalsBoard {
  signals: BoardSignal[];
  /** the owner's rules for this holding: how many apply, and how many could be checked */
  rules: { apply: number; checked: number; total: number };
  /** agree: at least two directional readings, all the same way; disagree: both ways present; none: fewer than two */
  agreement: 'agree' | 'disagree' | 'none';
  /** with disagree: the readings on each side */
  favourable: SignalKey[];
  unfavourable: SignalKey[];
}

/** The rules, as numbers, so the hub can show them on tap and tests can pin them. */
export const SIGNAL_RULES = {
  /** the 200-day average counts as rising when it is higher than this many sessions ago */
  smaRisingLookback: 20,
  /** ahead / behind the market: both the 6-month and the 1-year difference beyond ± this many points */
  marketPts: 5,
  /** company growing: revenue up and net margin not down by more than this many points */
  marginDropPts: 2,
  /** analysts: buy + strong buy at or above this share (%) → positive; sell + strong sell at or above → negative */
  analystsBuyPct: 60,
  analystsSellPct: 20,
  analystsMin: 3,
} as const;

const num = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

function trendSignal(d: HoldingInsights): BoardSignal {
  const s50 = d.trend.vsSma50Pct;
  const s200 = d.trend.vsSma200Pct;
  const series = d.series.filter((p) => num(p.sma200));
  const last = series.at(-1)?.sma200 ?? null;
  const before = series.length > SIGNAL_RULES.smaRisingLookback ? (series[series.length - 1 - SIGNAL_RULES.smaRisingLookback]?.sma200 ?? null) : null;
  const rising = num(last) && num(before) ? last > before : null;
  const facts = { vsSma50Pct: s50, vsSma200Pct: s200, sma200Change: num(last) && num(before) ? Math.round(((last - before) / before) * 1000) / 10 : null };
  if (!num(s50) || !num(s200)) return { key: 'trend', reading: 'unavailable', direction: null, facts, why: 'no_data' };
  if (s50 > 0 && s200 > 0 && rising === true) return { key: 'trend', reading: 'up', direction: 1, facts };
  if (s50 < 0 && s200 < 0) return { key: 'trend', reading: 'down', direction: -1, facts };
  return { key: 'trend', reading: 'mixed', direction: 0, facts };
}

function marketSignal(d: HoldingInsights): BoardSignal {
  const m6 = d.benchmark?.diffPts.m6 ?? null;
  const y1 = d.benchmark?.diffPts.y1 ?? null;
  const facts = { diff6mPts: m6, diff1yPts: y1 };
  if (!num(m6) || !num(y1)) return { key: 'market', reading: 'unavailable', direction: null, facts, why: 'no_data' };
  const t = SIGNAL_RULES.marketPts;
  if (m6 > t && y1 > t) return { key: 'market', reading: 'ahead', direction: 1, facts };
  if (m6 < -t && y1 < -t) return { key: 'market', reading: 'behind', direction: -1, facts };
  return { key: 'market', reading: 'in_line', direction: 0, facts };
}

function companySignal(d: HoldingInsights): BoardSignal {
  const f = d.company?.figures;
  const growth = f?.revenueYoYPct?.value ?? null;
  const margin = f?.netMarginPct?.value ?? null;
  const marginBefore = f?.netMarginPct1yAgo?.value ?? null;
  const change = num(margin) && num(marginBefore) ? Math.round((margin - marginBefore) * 10) / 10 : null;
  const facts = { revenueGrowthPct: growth, netMarginPct: margin, marginChangePts: change };
  if (d.instrumentType === 'ETF') return { key: 'company', reading: 'unavailable', direction: null, facts, why: 'etf' };
  if (!num(growth) || !num(change)) return { key: 'company', reading: 'unavailable', direction: null, facts, why: 'no_data' };
  if (growth > 0 && change >= -SIGNAL_RULES.marginDropPts) return { key: 'company', reading: 'growing', direction: 1, facts };
  if (growth < 0 && change < 0) return { key: 'company', reading: 'shrinking', direction: -1, facts };
  return { key: 'company', reading: 'mixed', direction: 0, facts };
}

function analystsSignal(d: HoldingInsights): BoardSignal {
  const a = d.analysts;
  const facts = { buyPct: a?.buyShare ?? null, sellPct: a?.sellShare ?? null, analysts: a?.total ?? null };
  if (d.instrumentType === 'ETF') return { key: 'analysts', reading: 'unavailable', direction: null, facts, why: 'etf' };
  if (!a || a.total < SIGNAL_RULES.analystsMin) return { key: 'analysts', reading: 'unavailable', direction: null, facts, why: 'no_data' };
  if (a.buyShare >= SIGNAL_RULES.analystsBuyPct) return { key: 'analysts', reading: 'positive', direction: 1, facts };
  if (a.sellShare >= SIGNAL_RULES.analystsSellPct) return { key: 'analysts', reading: 'negative', direction: -1, facts };
  return { key: 'analysts', reading: 'mixed', direction: 0, facts };
}

export function signalsBoard(d: HoldingInsights, rules: ReadonlyArray<{ state: string }> = []): SignalsBoard {
  const signals: BoardSignal[] = d.unavailable
    ? (['trend', 'market', 'company', 'analysts'] as const).map((key) => ({ key, reading: 'unavailable' as const, direction: null, facts: {}, why: 'no_data' as const }))
    : [trendSignal(d), marketSignal(d), companySignal(d), analystsSignal(d)];
  signals.push({ key: 'news', reading: 'unavailable', direction: null, facts: {}, why: 'not_built' });
  const favourable = signals.filter((s) => s.direction === 1).map((s) => s.key);
  const unfavourable = signals.filter((s) => s.direction === -1).map((s) => s.key);
  const directional = favourable.length + unfavourable.length;
  const agreement: SignalsBoard['agreement'] = favourable.length && unfavourable.length ? 'disagree' : directional >= 2 ? 'agree' : 'none';
  return {
    signals,
    rules: { apply: rules.filter((r) => r.state === 'applies').length, checked: rules.filter((r) => r.state !== 'unknown').length, total: rules.length },
    agreement,
    favourable: agreement === 'disagree' ? favourable : [],
    unfavourable: agreement === 'disagree' ? unfavourable : [],
  };
}
