/**
 * The company's numbers (stock-insights section E) from its own XBRL filings (SEC companyfacts, trimmed by sec.ts).
 * Pure: facts in, figures out; every figure carries the filing it comes from. Nothing here fetches.
 *
 * Rules (research_notes/proposals/stock-insights.md §3 E and §4; reviewed on real filings 2026-11-11):
 *
 * Concept per figure: the candidates below, in order. The concept whose newest usable fact was FILED most recently
 * wins; a tie goes to the earlier candidate. Revenue guard: when the winner's fiscal-year value is below 70% of another
 * candidate's for the same fiscal year (a bank's "revenue from contracts with customers" is fee income only), the
 * larger concept is used. Fill: a period the chosen concept lacks is taken from another candidate only when every
 * period both report agrees within 0.5% (a company that switched concepts keeps its history; different meanings are
 * never mixed).
 *
 * Units: money in the filer's reporting currency, taken from the revenue concept (USD when it reports USD, else the
 * currency of its newest fact). Every money figure must be in that currency, per-share figures in
 * "<currency>/shares", share counts in "shares"; never mixed or converted.
 *
 * Splits (from the price history's split events): a per-share or share-count fact FILED before a split cannot reflect
 * it and is scaled by the cumulative split factor (EPS divided, share counts multiplied); a cover-page share count
 * (dei) dated before a split likewise. Facts filed after a split already restate earlier periods and are left alone.
 * Splits unknown (no price history): nothing is scaled, and a share count change beyond ×1.8 or ×0.55 in a year is
 * not shown (`split_suspected`).
 *
 * Periods: facts are deduplicated by (start, end); the one filed latest wins. Durations (end − start, days): 80–100 =
 * a quarter, 350–380 = a fiscal year; year-to-date facts are ignored. A missing Q4 = FY − (Q1 + Q2 + Q3), only when
 * the three quarters chain from the year's start. TTM = the last 4 quarters with consecutive end dates (80–100 days
 * apart); otherwise, or when the latest fiscal year is newer, the latest fiscal year (`annual_basis`). "A year earlier"
 * = the same basis ending within 20 days of 365 days before (3 years: 1095). Stale: a figure (other than the 1- and
 * 3-year-ago margins) whose period ends more than 15 months before the company's newest period end is dropped.
 *
 * EPS (diluted) TTM = the sum of 4 quarterly EPS, checked against net income TTM ÷ the average diluted share count of
 * the same quarters: more than 5% apart → EPS and P/E are not shown (`eps_inconsistent`). P/E = the latest close /
 * EPS TTM, only when EPS > 0, in the price's currency, and not from a foreign filer's 20-F/40-F/6-K (the ADR ratio is
 * unknown: `adr_no_pe`).
 *
 * Total debt = borrowings, leases excluded (`excludes_leases`), at the latest balance-sheet date (equity's, else
 * cash's), the first complete rule:
 *  (a) LongTermDebtNoncurrent + DebtCurrent (DebtCurrent includes current maturities);
 *  (b) LongTermDebtNoncurrent + LongTermDebtCurrent + short-term borrowings;
 *  (c) LongTermDebt (which includes current maturities) + short-term borrowings;
 *  short-term borrowings = ShortTermBorrowings, else CommercialPaper + OtherShortTermBorrowings (those reported), else 0.
 *  Otherwise null. Finance leases are a figure of their own: FinanceLeaseLiability, else its current + noncurrent
 *  parts. Banks (SIC 6000–6299): debt/equity is not meaningful and not shown.
 *
 * Shares outstanding: the latest instant; several values in one filing for one date (share classes) are summed.
 * "A year ago" = the instant closest to 365 days before, within 45 days.
 *
 * Bounds: revenue ≥ 0, shares > 0, |net margin| ≤ 500%, P/E ≤ 1000, debt/equity only when equity > 0, YoY only when
 * the earlier value is not 0. Rounding: money and shares whole, EPS 4 decimals, percentages 1, P/E and debt/equity 2.
 *
 * Every omission or approximation is a note: a stable code (for the app to translate), the figure it concerns, and an
 * English text.
 */
import type { CompanyFacts, SecFact } from './sec.js';

export type FigureBasis = 'ttm' | 'annual' | 'instant' | 'derived';

export interface CompanyFigure {
  value: number;
  /** "USD", "EUR", "USD/shares", "shares", "%", "x" (P/E), "ratio" (debt/equity) */
  unit: string;
  periodEnd: string;
  basis: FigureBasis;
  form: string | null;
  filed: string | null;
  accn: string | null;
}

export const FIGURE_KEYS = [
  'revenueTtm',
  'revenueYoYPct',
  'netIncomeTtm',
  'netIncomeYoYPct',
  'netMarginPct',
  'netMarginPct1yAgo',
  'netMarginPct3yAgo',
  'epsTtm',
  'pe',
  'cash',
  'totalDebt',
  'financeLeases',
  'debtToEquity',
  'sharesOutstanding',
  'sharesChange1yPct',
] as const;
export type FigureKey = (typeof FIGURE_KEYS)[number];
export type CompanyFigures = Record<FigureKey, CompanyFigure | null>;

export const NOTE_CODES = [
  'no_xbrl',
  'no_currency',
  'foreign_currency',
  'foreign_ifrs',
  'not_reported',
  'annual_basis',
  'q4_derived',
  'concept_filled',
  'larger_revenue_concept',
  'stale_dropped',
  'no_prior_period',
  'prior_zero',
  'no_matching_period',
  'revenue_not_positive',
  'out_of_bounds',
  'split_adjusted',
  'split_suspected',
  'eps_inconsistent',
  'no_price',
  'eps_currency',
  'eps_not_positive',
  'adr_no_pe',
  'not_determinable',
  'excludes_leases',
  'equity_not_positive',
  'bank_debt_ratio',
  'share_classes_summed',
  'no_prior_shares',
  'filings_unavailable',
] as const;
export type NoteCode = (typeof NOTE_CODES)[number];

export interface CompanyNote {
  code: NoteCode;
  /** the figure it concerns, or null for the whole section */
  figure: FigureKey | null;
  /** English, one line */
  text: string;
}

export interface CompanySection {
  name: string;
  /** 10 digits, zero-padded */
  cik: string;
  sic: string | null;
  sicDescription: string | null;
  /** the filer's reporting currency (null when it filed no usable figures) */
  currency: string | null;
  figures: CompanyFigures;
  notes: CompanyNote[];
}

export const CONCEPTS = {
  revenue: ['us-gaap:Revenues', 'us-gaap:RevenuesNetOfInterestExpense', 'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax', 'us-gaap:SalesRevenueNet', 'us-gaap:RevenueFromContractWithCustomerIncludingAssessedTax', 'ifrs-full:Revenue'],
  netIncome: ['us-gaap:NetIncomeLoss', 'ifrs-full:ProfitLossAttributableToOwnersOfParent', 'ifrs-full:ProfitLoss'],
  eps: ['us-gaap:EarningsPerShareDiluted', 'ifrs-full:DilutedEarningsLossPerShare'],
  dilutedShares: ['us-gaap:WeightedAverageNumberOfDilutedSharesOutstanding'],
  cash: ['us-gaap:CashAndCashEquivalentsAtCarryingValue', 'us-gaap:CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents', 'ifrs-full:CashAndCashEquivalents'],
  equity: ['us-gaap:StockholdersEquity', 'us-gaap:StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest', 'ifrs-full:EquityAttributableToOwnersOfParent', 'ifrs-full:Equity'],
  shares: ['dei:EntityCommonStockSharesOutstanding', 'us-gaap:CommonStockSharesOutstanding'],
} as const;

const DAY = 86_400_000;
const QUARTER = [80, 100] as const;
const YEAR = [350, 380] as const;
const CHAIN_DAYS = 7;
const NEAR_DAYS = 20;
const SHARES_NEAR_DAYS = 45;
/** 15 months */
const STALE_DAYS = 457;
const FILL_TOLERANCE = 0.005;
const SUBSET_RATIO = 0.7;
const EPS_TOLERANCE = 0.05;
const SPLIT_SUSPECT = [0.55, 1.8] as const;
export const BOUNDS = { maxAbsMarginPct: 500, maxPe: 1000 } as const;
const FOREIGN_FORMS = /^(20-F|40-F|6-K)(\/A)?$/;

const days = (a: string, b: string): number => (Date.parse(b) - Date.parse(a)) / DAY;
const addDays = (d: string, n: number): string => new Date(Date.parse(d) + n * DAY).toISOString().slice(0, 10);
const within = (n: number, [lo, hi]: readonly [number, number]): boolean => n >= lo && n <= hi;
const newer = (a: SecFact, b: SecFact): boolean => a.filed > b.filed || (a.filed === b.filed && a.accn > b.accn);
const close = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol * Math.max(Math.abs(a), Math.abs(b));

const round = (v: number, dp: number): number => {
  const f = 10 ** dp;
  const x = Math.round(v * f) / f;
  return Object.is(x, -0) ? 0 : x;
};

// ---------------------------------------------------------------------------------------------------------------
// splits

export interface Split {
  d: string;
  /** new shares per old share (10 for a 10-for-1 split, 0.1 for a 1-for-10 reverse split) */
  factor: number;
}

/** Yahoo's split events ("10:1") to factors; null when unknown or any is unreadable. */
export function parseSplits(splits: ReadonlyArray<{ d: string; ratio: string }> | null | undefined): Split[] | null {
  if (!splits) return null;
  const out: Split[] = [];
  for (const s of splits) {
    const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(s.ratio);
    const f = m ? Number(m[1]) / Number(m[2]) : Number.NaN;
    if (!Number.isFinite(f) || f <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(s.d)) return null;
    out.push({ d: s.d, factor: f });
  }
  return out;
}

/** the product of the split factors after `date` */
export function splitFactorAfter(splits: readonly Split[], date: string): number {
  return splits.reduce((p, s) => (s.d > date ? p * s.factor : p), 1);
}

/**
 * Facts scaled to today's share basis: `per` = 'divide' for per-share values, 'multiply' for share counts. `byEnd`:
 * the fact's own date decides (a cover-page count); otherwise its filing date. Returns the facts and whether any moved.
 */
export function splitAdjust(facts: readonly SecFact[], splits: readonly Split[] | null, per: 'divide' | 'multiply', byEnd = false): { facts: SecFact[]; adjusted: boolean } {
  if (!splits || !splits.length) return { facts: [...facts], adjusted: false };
  let adjusted = false;
  const out = facts.map((f) => {
    const k = splitFactorAfter(splits, byEnd ? (f.end < f.filed ? f.end : f.filed) : f.filed);
    if (k === 1) return f;
    adjusted = true;
    return { ...f, val: per === 'divide' ? f.val / k : f.val * k };
  });
  return { facts: out, adjusted };
}

// ---------------------------------------------------------------------------------------------------------------
// concepts and units

type Units = Record<string, SecFact[]>;
type Kind = 'flow' | 'instant';

const isCurrency = (u: string): boolean => /^[A-Z]{3}$/.test(u);
const relevant = (f: SecFact, kind: Kind): boolean => {
  if (kind === 'instant') return f.start === undefined;
  if (f.start === undefined) return false;
  const d = days(f.start, f.end);
  return within(d, QUARTER) || within(d, YEAR);
};
const newestFiled = (facts: readonly SecFact[], kind: Kind): string | null => {
  let best: string | null = null;
  for (const f of facts) if (relevant(f, kind) && (best === null || f.filed > best)) best = f.filed;
  return best;
};

/** A money concept's unit: `currency` when given (or null), else USD when present, else the currency filed last. */
export function moneyUnit(units: Units, currency: string | null, kind: Kind): string | null {
  if (currency) return units[currency]?.some((f) => relevant(f, kind)) ? currency : null;
  if (units.USD?.some((f) => relevant(f, kind))) return 'USD';
  let best: { u: string; filed: string } | null = null;
  for (const [u, fs] of Object.entries(units)) {
    if (!isCurrency(u)) continue;
    const filed = newestFiled(fs, kind);
    if (filed && (!best || filed > best.filed)) best = { u, filed };
  }
  return best?.u ?? null;
}

export interface Chosen {
  concept: string;
  unit: string;
  facts: SecFact[];
}

/**
 * The candidate whose newest usable fact (in the unit `unitOf` picks) was filed last; ties go to the earlier
 * candidate. Null when none has one.
 */
export function chooseConcept(cf: CompanyFacts, candidates: readonly string[], unitOf: (units: Units) => string | null, kind: Kind): Chosen | null {
  let best: (Chosen & { filed: string }) | null = null;
  for (const c of usable(cf, candidates, unitOf, kind)) {
    const filed = newestFiled(c.facts, kind)!;
    if (!best || filed > best.filed) best = { ...c, filed };
  }
  return best ? { concept: best.concept, unit: best.unit, facts: best.facts } : null;
}

function usable(cf: CompanyFacts, candidates: readonly string[], unitOf: (units: Units) => string | null, kind: Kind): Chosen[] {
  const out: Chosen[] = [];
  for (const concept of candidates) {
    const units = cf.concepts[concept];
    if (!units) continue;
    const unit = unitOf(units);
    if (!unit) continue;
    const facts = units[unit] ?? [];
    if (newestFiled(facts, kind)) out.push({ concept, unit, facts });
  }
  return out;
}

/** fiscal-year values by end date (deduplicated) */
function annualsOf(facts: readonly SecFact[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const f of dedupe(facts)) if (f.start !== undefined && within(days(f.start, f.end), YEAR)) m.set(f.end, f.val);
  return m;
}

/**
 * The revenue guard: when the chosen concept's latest fiscal year shared with another candidate is below 70% of
 * that candidate's, the largest such candidate replaces it.
 */
export function subsetGuard(chosen: Chosen, others: readonly Chosen[]): Chosen {
  const mine = annualsOf(chosen.facts);
  let best = chosen;
  let bestRatio = 1;
  for (const o of others) {
    if (o.concept === chosen.concept || o.unit !== chosen.unit) continue;
    const theirs = annualsOf(o.facts);
    let common: string | null = null;
    for (const end of mine.keys()) if (theirs.has(end) && (!common || end > common)) common = end;
    if (!common) continue;
    const a = mine.get(common)!;
    const b = theirs.get(common)!;
    if (b > 0 && a < SUBSET_RATIO * b && b / Math.max(a, 1e-9) > bestRatio) {
      best = o;
      bestRatio = b / Math.max(a, 1e-9);
    }
  }
  return best;
}

/**
 * The chosen concept's facts with the periods it lacks filled from other candidates (in order), each only when every
 * period both report agrees within 0.5% (and at least one does).
 */
export function fillPeriods(chosen: Chosen, others: readonly Chosen[]): { facts: SecFact[]; filled: boolean } {
  const key = (f: SecFact) => `${f.start ?? ''}|${f.end}`;
  const have = new Map(dedupe(chosen.facts).map((f) => [key(f), f]));
  let filled = false;
  for (const o of others) {
    if (o.concept === chosen.concept || o.unit !== chosen.unit) continue;
    const od = dedupe(o.facts);
    const overlap = od.filter((f) => have.has(key(f)));
    if (!overlap.length || !overlap.every((f) => close(f.val, have.get(key(f))!.val, FILL_TOLERANCE))) continue;
    for (const f of od) {
      if (have.has(key(f))) continue;
      have.set(key(f), f);
      filled = true;
    }
  }
  return { facts: [...have.values()], filled };
}

// ---------------------------------------------------------------------------------------------------------------
// duration facts: quarters, fiscal years, TTM

export interface Period {
  start: string;
  end: string;
  val: number;
  /** the fact (for a derived Q4: the fiscal year's fact) */
  src: SecFact;
  derived: boolean;
}

export interface FlowSeries {
  /** by end date, one per end date */
  quarters: Period[];
  annuals: Period[];
}

/** Deduplicates by (start, end), the latest filed winning. */
export function dedupe(facts: readonly SecFact[]): SecFact[] {
  const m = new Map<string, SecFact>();
  for (const f of facts) {
    const k = `${f.start ?? ''}|${f.end}`;
    const prev = m.get(k);
    if (!prev || newer(f, prev)) m.set(k, f);
  }
  return [...m.values()];
}

const byEnd = (a: { end: string }, b: { end: string }): number => (a.end < b.end ? -1 : a.end > b.end ? 1 : 0);

/** Quarters and fiscal years from duration facts, with Q4s derived where possible (`deriveQ4` false: averages). */
export function flowSeries(facts: readonly SecFact[], deriveQ4 = true): FlowSeries {
  const qByEnd = new Map<string, Period>();
  const annuals: Period[] = [];
  for (const f of dedupe(facts)) {
    if (f.start === undefined) continue;
    const d = days(f.start, f.end);
    const p: Period = { start: f.start, end: f.end, val: f.val, src: f, derived: false };
    if (within(d, QUARTER)) {
      const prev = qByEnd.get(f.end);
      if (!prev || newer(f, prev.src)) qByEnd.set(f.end, p);
    } else if (within(d, YEAR)) annuals.push(p);
  }
  const reported = [...qByEnd.values()].sort(byEnd);
  annuals.sort(byEnd);
  const quarters = [...reported];
  const startsAfter = (prevEnd: string, start: string): boolean => Math.abs(days(prevEnd, start) - 1) <= CHAIN_DAYS;
  if (deriveQ4) {
    for (const a of annuals) {
      if (reported.some((q) => Math.abs(days(q.end, a.end)) <= CHAIN_DAYS)) continue;
      const inYear = reported.filter((q) => q.start >= addDays(a.start, -CHAIN_DAYS) && q.end <= a.end);
      const q1 = inYear.find((q) => Math.abs(days(a.start, q.start)) <= CHAIN_DAYS);
      const q2 = q1 && inYear.find((q) => startsAfter(q1.end, q.start));
      const q3 = q2 && inYear.find((q) => startsAfter(q2.end, q.start));
      if (!q1 || !q2 || !q3) continue;
      const start = addDays(q3.end, 1);
      if (!within(days(start, a.end), QUARTER)) continue;
      quarters.push({ start, end: a.end, val: a.val - q1.val - q2.val - q3.val, src: a.src, derived: true });
    }
  }
  quarters.sort(byEnd);
  return { quarters, annuals };
}

export interface Flow {
  value: number;
  end: string;
  basis: 'ttm' | 'annual';
  /** the newest filing among the facts used */
  src: SecFact;
  /** a derived Q4 is among the quarters summed */
  derivedQ4: boolean;
  /** the quarter ends summed (ttm) or the year's end (annual) */
  ends: string[];
}

/** The sum of quarters i-3..i when their end dates are consecutive, else null. */
export function ttmAt(quarters: readonly Period[], i: number): Flow | null {
  if (i < 3 || i >= quarters.length) return null;
  const four = quarters.slice(i - 3, i + 1);
  for (let k = 1; k < 4; k++) if (!within(days(four[k - 1]!.end, four[k]!.end), QUARTER)) return null;
  let src = four[0]!.src;
  for (const q of four) if (newer(q.src, src)) src = q.src;
  return { value: four.reduce((s, q) => s + q.val, 0), end: four[3]!.end, basis: 'ttm', src, derivedQ4: four.some((q) => q.derived), ends: four.map((q) => q.end) };
}

const annualFlow = (a: Period): Flow => ({ value: a.val, end: a.end, basis: 'annual', src: a.src, derivedQ4: false, ends: [a.end] });

/** The latest 12 months: TTM ending at the latest quarter, unless the latest fiscal year is newer (or TTM impossible). */
export function latestFlow(s: FlowSeries): Flow | null {
  const ttm = ttmAt(s.quarters, s.quarters.length - 1);
  const a = s.annuals.at(-1);
  if (ttm && (!a || ttm.end >= addDays(a.end, -CHAIN_DAYS))) return ttm;
  return a ? annualFlow(a) : null;
}

/** 12 months on `basis` ending within `tol` days of `target` (the closest); a TTM may be read from a fiscal year. */
export function flowNear(s: FlowSeries, basis: 'ttm' | 'annual', target: string, tol = NEAR_DAYS): Flow | null {
  const pickClosest = (cands: Array<Flow | null>): Flow | null => {
    let best: Flow | null = null;
    for (const f of cands) {
      if (!f) continue;
      const gap = Math.abs(days(f.end, target));
      if (gap <= tol && (!best || gap < Math.abs(days(best.end, target)))) best = f;
    }
    return best;
  };
  const ttm = basis === 'ttm' ? pickClosest(s.quarters.map((_, i) => ttmAt(s.quarters, i))) : null;
  return ttm ?? pickClosest(s.annuals.map(annualFlow));
}

// ---------------------------------------------------------------------------------------------------------------
// instant facts

export interface Instant {
  end: string;
  val: number;
  src: SecFact;
  /** values summed (share classes) */
  parts: number;
}

/**
 * Instants by end date: the filing filed last for each date wins; with `sumClasses`, several different values in that
 * filing for the same date are summed (share classes), otherwise the last listed is taken.
 */
export function instantSeries(facts: readonly SecFact[], sumClasses = false): Instant[] {
  const byEndAccn = new Map<string, SecFact[]>();
  for (const f of facts) {
    if (f.start !== undefined) continue;
    const k = `${f.end}|${f.accn}`;
    const g = byEndAccn.get(k);
    if (g) g.push(f);
    else byEndAccn.set(k, [f]);
  }
  const best = new Map<string, Instant>();
  for (const g of byEndAccn.values()) {
    const src = g.reduce((a, b) => (newer(b, a) ? b : a));
    const vals = [...new Set(g.map((f) => f.val))];
    const inst: Instant = sumClasses && vals.length > 1 ? { end: src.end, val: vals.reduce((s, v) => s + v, 0), src, parts: vals.length } : { end: src.end, val: g[g.length - 1]!.val, src, parts: 1 };
    const prev = best.get(src.end);
    if (!prev || newer(src, prev.src)) best.set(src.end, inst);
  }
  return [...best.values()].sort(byEnd);
}

const instantAt = (s: readonly Instant[], end: string): Instant | null => s.find((x) => x.end === end) ?? null;

function instantNear(s: readonly Instant[], target: string, tol: number): Instant | null {
  let best: Instant | null = null;
  for (const x of s) {
    const gap = Math.abs(days(x.end, target));
    if (gap <= tol && (!best || gap < Math.abs(days(best.end, target)))) best = x;
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------------------
// debt and leases

export interface DebtResult {
  value: number;
  end: string;
  rule: 'a' | 'b' | 'c' | 'lease';
  src: SecFact;
}

function usGaapAt(cf: CompanyFacts, currency: string, date: string) {
  return (concept: string): Instant | null => {
    const fs = cf.concepts[`us-gaap:${concept}`]?.[currency];
    return fs ? instantAt(instantSeries(fs), date) : null;
  };
}

function sumParts(rule: DebtResult['rule'], date: string, parts: Array<Instant | null>): DebtResult {
  const ps = parts.filter((p): p is Instant => p !== null);
  let src = ps[0]!.src;
  for (const p of ps) if (newer(p.src, src)) src = p.src;
  return { value: ps.reduce((s, p) => s + p.val, 0), end: date, rule, src };
}

/** Total borrowings (leases excluded) at `date` by the documented rules (a), (b), (c); null when none is complete. */
export function totalDebtAt(cf: CompanyFacts, currency: string, date: string): DebtResult | null {
  const at = usGaapAt(cf, currency, date);
  const ltdNon = at('LongTermDebtNoncurrent');
  const debtCur = at('DebtCurrent');
  const ltdCur = at('LongTermDebtCurrent');
  const ltd = at('LongTermDebt');
  const stb = at('ShortTermBorrowings');
  const short = stb ? [stb] : [at('CommercialPaper'), at('OtherShortTermBorrowings')];
  if (ltdNon && debtCur) return sumParts('a', date, [ltdNon, debtCur]);
  if (ltdNon && ltdCur) return sumParts('b', date, [ltdNon, ltdCur, ...short]);
  if (ltd) return sumParts('c', date, [ltd, ...short]);
  return null;
}

/** Finance lease liabilities at `date`: the total, else the current and noncurrent parts reported; null when none. */
export function financeLeasesAt(cf: CompanyFacts, currency: string, date: string): DebtResult | null {
  const at = usGaapAt(cf, currency, date);
  const total = at('FinanceLeaseLiability');
  if (total) return sumParts('lease', date, [total]);
  const parts = [at('FinanceLeaseLiabilityCurrent'), at('FinanceLeaseLiabilityNoncurrent')];
  return parts.some((p) => p) ? sumParts('lease', date, parts) : null;
}

// ---------------------------------------------------------------------------------------------------------------
// the section

export interface CompanyInputs {
  cik: string;
  name: string;
  sic: string | null;
  sicDescription: string | null;
}

export interface PriceInput {
  /** the latest close (raw), in `currency`; null when unknown */
  price: number | null;
  currency: string | null;
  /** the price history's split events ("10:1"); null or absent when unknown (no history) */
  splits?: ReadonlyArray<{ d: string; ratio: string }> | null;
}

const emptyFigures = (): CompanyFigures => Object.fromEntries(FIGURE_KEYS.map((k) => [k, null])) as CompanyFigures;

const fig = (value: number, unit: string, periodEnd: string, basis: FigureBasis, src: SecFact | null): CompanyFigure => ({ value, unit, periodEnd, basis, form: src?.form ?? null, filed: src?.filed ?? null, accn: src?.accn ?? null });
const newerSrc = (a: SecFact, b: SecFact): SecFact => (newer(b, a) ? b : a);
const pctChange = (cur: number, prev: number): number | null => (prev === 0 ? null : ((cur - prev) / Math.abs(prev)) * 100);
const isBank = (sic: string | null): boolean => sic !== null && /^\d{4}$/.test(sic) && Number(sic) >= 6000 && Number(sic) <= 6299;

/** figures exempt from the staleness rule (they are about earlier periods by design) */
const HISTORIC: ReadonlySet<FigureKey> = new Set(['netMarginPct1yAgo', 'netMarginPct3yAgo']);

/**
 * Section E from the trimmed facts (null facts: the company filed no XBRL data). `price` is the holding's latest close
 * for P/E, with the history's split events. Never throws on odd data: a figure that cannot be built is null with a
 * note.
 */
export function buildCompany(info: CompanyInputs, cf: CompanyFacts | null, price: PriceInput): CompanySection {
  const figures = emptyFigures();
  const notes: CompanyNote[] = [];
  const note = (code: NoteCode, figure: FigureKey | null, text: string) => {
    if (!notes.some((n) => n.code === code && n.figure === figure)) notes.push({ code, figure, text });
  };
  const out: CompanySection = { name: info.name, cik: info.cik, sic: info.sic, sicDescription: info.sicDescription, currency: null, figures, notes };
  if (!cf || !Object.keys(cf.concepts).length) {
    note('no_xbrl', null, 'The company has filed no XBRL financial data with SEC.');
    return out;
  }
  const splits = parseSplits(price.splits);

  // the reporting currency: the revenue concept's (else net income's)
  const pickAny = (cands: readonly string[]) => chooseConcept(cf, cands, (u) => moneyUnit(u, null, 'flow'), 'flow');
  const currency = (pickAny(CONCEPTS.revenue) ?? pickAny(CONCEPTS.netIncome))?.unit ?? null;
  out.currency = currency;
  if (!currency) note('no_currency', null, 'No revenue or net income in a currency was found in the filings.');
  else if (currency !== 'USD') note('foreign_currency', null, `Figures are in ${currency}, the filer's reporting currency.`);

  /** the chosen concept (with the revenue guard) and its facts, gaps filled from agreeing candidates */
  const select = (key: FigureKey, cands: readonly string[], unitOf: (u: Units) => string | null, kind: Kind, guard = false): Chosen | null => {
    const all = usable(cf, cands, unitOf, kind);
    let chosen = chooseConcept(cf, cands, unitOf, kind);
    if (!chosen) return null;
    if (guard) {
      const g = subsetGuard(chosen, all);
      if (g.concept !== chosen.concept) note('larger_revenue_concept', key, `${key}: ${chosen.concept} covers part of revenue only; ${g.concept} is used.`);
      chosen = g;
    }
    const others = all.filter((c) => c.concept !== chosen!.concept);
    const { facts, filled } = fillPeriods(chosen, others);
    if (filled) note('concept_filled', key, `${key}: periods missing from ${chosen.concept} were taken from a concept that agrees with it.`);
    return { ...chosen, facts };
  };
  const money = (key: FigureKey, cands: readonly string[], kind: Kind, guard = false) => (currency ? select(key, cands, (u) => moneyUnit(u, currency, kind), kind, guard) : null);
  const derivedQ4 = new Set<FigureKey>();

  // revenue and net income
  const rev = money('revenueTtm', CONCEPTS.revenue, 'flow', true);
  if (rev?.concept.startsWith('ifrs-full:')) note('foreign_ifrs', null, 'The filer reports under IFRS.');
  const ni = money('netIncomeTtm', CONCEPTS.netIncome, 'flow');
  const revS = rev ? flowSeries(rev.facts) : null;
  const niS = ni ? flowSeries(ni.facts) : null;
  let revenue = revS ? latestFlow(revS) : null;
  const netIncome = niS ? latestFlow(niS) : null;
  if (!revenue) note('not_reported', 'revenueTtm', 'revenueTtm: not reported.');
  else if (revenue.value < 0) {
    note('out_of_bounds', 'revenueTtm', 'revenueTtm: negative revenue is outside the sanity bounds.');
    revenue = null;
  }
  if (!netIncome) note('not_reported', 'netIncomeTtm', 'netIncomeTtm: not reported.');
  const flowFigure = (key: 'revenueTtm' | 'netIncomeTtm', f: Flow | null) => {
    if (!f || !currency) return;
    figures[key] = fig(Math.round(f.value), currency, f.end, f.basis, f.src);
    if (f.basis === 'annual') note('annual_basis', key, `${key}: the latest fiscal year (four consecutive quarters were not available).`);
    if (f.derivedQ4) derivedQ4.add(key);
  };
  flowFigure('revenueTtm', revenue);
  flowFigure('netIncomeTtm', netIncome);
  const yoy = (key: 'revenueYoYPct' | 'netIncomeYoYPct', s: FlowSeries | null, f: Flow | null) => {
    if (!s || !f) return;
    const prev = flowNear(s, f.basis, addDays(f.end, -365));
    if (!prev) return void note('no_prior_period', key, `${key}: no figure for the same period a year earlier.`);
    const p = pctChange(f.value, prev.value);
    if (p === null) return void note('prior_zero', key, `${key}: the figure a year earlier was 0.`);
    figures[key] = fig(round(p, 1), '%', f.end, f.basis, f.src);
  };
  yoy('revenueYoYPct', revS, revenue);
  yoy('netIncomeYoYPct', niS, netIncome);

  // net margin now, 1 and 3 years earlier (revenue and net income over the same 12 months)
  const marginAt = (key: 'netMarginPct' | 'netMarginPct1yAgo' | 'netMarginPct3yAgo', r: Flow | null) => {
    if (!r || !niS) return;
    const n = flowNear(niS, r.basis, r.end, CHAIN_DAYS);
    if (!n) return void note('no_matching_period', key, `${key}: no net income for the same period as revenue.`);
    if (!(r.value > 0)) return void note('revenue_not_positive', key, `${key}: revenue is not positive.`);
    const m = (n.value / r.value) * 100;
    if (Math.abs(m) > BOUNDS.maxAbsMarginPct) return void note('out_of_bounds', key, `${key}: outside the sanity bounds (±${BOUNDS.maxAbsMarginPct}%).`);
    figures[key] = fig(round(m, 1), '%', r.end, r.basis, newerSrc(r.src, n.src));
  };
  if (revenue && revS) {
    marginAt('netMarginPct', revenue);
    const r1 = flowNear(revS, revenue.basis, addDays(revenue.end, -365));
    const r3 = flowNear(revS, revenue.basis, addDays(revenue.end, -1095));
    if (r1) marginAt('netMarginPct1yAgo', r1);
    else note('no_prior_period', 'netMarginPct1yAgo', 'netMarginPct1yAgo: no revenue for the period a year earlier.');
    if (r3) marginAt('netMarginPct3yAgo', r3);
    else note('no_prior_period', 'netMarginPct3yAgo', 'netMarginPct3yAgo: no revenue for the period 3 years earlier.');
  }

  // diluted EPS (split-adjusted, checked against net income / diluted shares) and P/E
  const epsUnit = currency ? `${currency}/shares` : null;
  const epsC = epsUnit ? select('epsTtm', CONCEPTS.eps, (u) => (u[epsUnit]?.some((f) => relevant(f, 'flow')) ? epsUnit : null), 'flow') : null;
  const epsAdj = epsC ? splitAdjust(epsC.facts, splits, 'divide') : null;
  const epsS = epsAdj ? flowSeries(epsAdj.facts) : null;
  let eps = epsS ? latestFlow(epsS) : null;
  if (!eps || !epsC) note('not_reported', 'epsTtm', 'epsTtm: not reported.');
  else {
    const dil = chooseConcept(cf, CONCEPTS.dilutedShares, (u) => (u.shares?.some((f) => relevant(f, 'flow')) ? 'shares' : null), 'flow');
    const expected = dil && niS ? epsFromShares(eps, niS, flowSeries(splitAdjust(dil.facts, splits, 'multiply').facts, false)) : null;
    if (expected !== null && !close(eps.value, expected, EPS_TOLERANCE)) {
      note('eps_inconsistent', 'epsTtm', `epsTtm: the filed EPS (${round(eps.value, 4)}) disagrees with net income / diluted shares (${round(expected, 4)}); not shown.`);
      note('eps_inconsistent', 'pe', 'pe: not shown, EPS (TTM) failed its check.');
      eps = null;
    } else {
      figures.epsTtm = fig(round(eps.value, 4), epsC.unit, eps.end, eps.basis, eps.src);
      if (epsAdj!.adjusted) note('split_adjusted', 'epsTtm', 'epsTtm: earlier quarters scaled for a stock split.');
      if (eps.basis === 'annual') note('annual_basis', 'epsTtm', 'epsTtm: the latest fiscal year (four consecutive quarters were not available).');
      if (eps.derivedQ4) derivedQ4.add('epsTtm');
    }
  }
  if (eps && epsC) {
    const epsCur = epsC.unit.split('/')[0]!;
    if (FOREIGN_FORMS.test(eps.src.form)) note('adr_no_pe', 'pe', `pe: EPS comes from a ${eps.src.form}; the ratio of listed shares (ADR) to ordinary shares is unknown.`);
    else if (price.price === null || !(price.price > 0) || !price.currency) note('no_price', 'pe', 'pe: no current price.');
    else if (epsCur !== price.currency) note('eps_currency', 'pe', `pe: EPS is reported in ${epsCur}, the price is in ${price.currency}.`);
    else if (!(eps.value > 0)) note('eps_not_positive', 'pe', 'pe: shown only when EPS (TTM) is positive.');
    else {
      const pe = price.price / eps.value;
      if (pe > BOUNDS.maxPe) note('out_of_bounds', 'pe', `pe: above ${BOUNDS.maxPe}, outside the sanity bounds.`);
      else figures.pe = fig(round(pe, 2), 'x', eps.end, 'derived', eps.src);
    }
  }

  // balance sheet: cash, equity, borrowings, finance leases
  const cashC = money('cash', CONCEPTS.cash, 'instant');
  const cash = cashC ? (instantSeries(cashC.facts).at(-1) ?? null) : null;
  if (cash && currency) figures.cash = fig(Math.round(cash.val), currency, cash.end, 'instant', cash.src);
  else note('not_reported', 'cash', 'cash: not reported.');
  const eqC = money('debtToEquity', CONCEPTS.equity, 'instant');
  const equity = eqC ? (instantSeries(eqC.facts).at(-1) ?? null) : null;
  const bsDate = equity?.end ?? cash?.end ?? null;
  const debt = currency && bsDate ? totalDebtAt(cf, currency, bsDate) : null;
  if (debt && currency) {
    figures.totalDebt = fig(Math.round(debt.value), currency, debt.end, 'instant', debt.src);
    note('excludes_leases', 'totalDebt', 'totalDebt: borrowings only; lease liabilities are not included.');
    if (isBank(info.sic)) note('bank_debt_ratio', 'debtToEquity', 'debtToEquity: not meaningful for a bank.');
    else if (equity && equity.end === debt.end) {
      if (equity.val > 0) figures.debtToEquity = fig(round(debt.value / equity.val, 2), 'ratio', debt.end, 'instant', newerSrc(debt.src, equity.src));
      else note('equity_not_positive', 'debtToEquity', "debtToEquity: shareholders' equity is not positive.");
    }
  } else note('not_determinable', 'totalDebt', 'totalDebt: not determinable from the filed debt figures.');
  if (!equity) note('not_reported', 'debtToEquity', "debtToEquity: shareholders' equity not reported.");
  const leases = currency && bsDate ? financeLeasesAt(cf, currency, bsDate) : null;
  if (leases && currency) figures.financeLeases = fig(Math.round(leases.value), currency, leases.end, 'instant', leases.src);

  // shares outstanding (split-adjusted) and the change over a year
  const shC = chooseConcept(cf, CONCEPTS.shares, (u) => (u.shares?.some((f) => relevant(f, 'instant')) ? 'shares' : null), 'instant');
  const shAdj = shC ? splitAdjust(shC.facts, splits, 'multiply', shC.concept.startsWith('dei:')) : null;
  const shS = shAdj ? instantSeries(shAdj.facts, true) : [];
  const sh = shS.at(-1) ?? null;
  if (!sh) note('not_reported', 'sharesOutstanding', 'sharesOutstanding: not reported.');
  else if (!(sh.val > 0)) note('out_of_bounds', 'sharesOutstanding', 'sharesOutstanding: not positive, outside the sanity bounds.');
  else {
    figures.sharesOutstanding = fig(Math.round(sh.val), 'shares', sh.end, 'instant', sh.src);
    if (sh.parts > 1) note('share_classes_summed', 'sharesOutstanding', `sharesOutstanding: the sum of ${sh.parts} share classes.`);
    const prev = instantNear(shS, addDays(sh.end, -365), SHARES_NEAR_DAYS);
    if (!prev || !(prev.val > 0)) note('no_prior_shares', 'sharesChange1yPct', 'sharesChange1yPct: no share count about a year earlier.');
    else if (!splits && !within(sh.val / prev.val, SPLIT_SUSPECT)) note('split_suspected', 'sharesChange1yPct', 'sharesChange1yPct: a change this large suggests a stock split, which could not be checked.');
    else {
      figures.sharesChange1yPct = fig(round(((sh.val - prev.val) / prev.val) * 100, 1), '%', sh.end, 'instant', sh.src);
      if (splitFactorAfter(splits ?? [], prev.end) !== splitFactorAfter(splits ?? [], sh.end)) note('split_adjusted', 'sharesChange1yPct', 'sharesChange1yPct: the earlier count is scaled for a stock split.');
    }
  }
  if (derivedQ4.size) for (const k of derivedQ4) note('q4_derived', k, `${k}: Q4 derived as the fiscal year minus Q1 to Q3.`);

  // stale: anything (but the historic margins) ending over 15 months before the company's newest period
  let newest = '';
  for (const c of [rev, ni, cashC, eqC]) for (const f of c?.facts ?? []) if (f.end > newest && f.end <= f.filed) newest = f.end;
  if (newest) {
    const limit = addDays(newest, -STALE_DAYS);
    for (const k of FIGURE_KEYS) {
      const x = figures[k];
      if (!x || HISTORIC.has(k) || x.periodEnd >= limit) continue;
      figures[k] = null;
      note('stale_dropped', k, `${k}: the latest figure (period ending ${x.periodEnd}) is over 15 months older than the company's newest filings.`);
    }
  }
  return out;
}

/**
 * EPS implied by net income over the same 12 months ÷ the average diluted share count of those quarters (a missing
 * quarter, usually Q4, takes the fiscal year's average). Null when the inputs are not there (no check then).
 */
function epsFromShares(eps: Flow, ni: FlowSeries, shares: FlowSeries): number | null {
  const n = flowNear(ni, eps.basis, eps.end, CHAIN_DAYS);
  if (!n) return null;
  const counts: number[] = [];
  for (const end of eps.ends) {
    const q = eps.basis === 'ttm' ? shares.quarters.find((x) => Math.abs(days(x.end, end)) <= CHAIN_DAYS) : undefined;
    const a = shares.annuals.find((x) => Math.abs(days(x.end, end)) <= CHAIN_DAYS);
    const v = q?.val ?? a?.val;
    if (v === undefined || !(v > 0)) return null;
    counts.push(v);
  }
  const avg = counts.reduce((s, v) => s + v, 0) / counts.length;
  return n.value / avg;
}
