/**
 * The stock-insights panel answer (GET /api/holdings/:id/insights): sections B (price and trend), C (compared with
 * SPY and the company's sector fund) and D (risk) of research_notes/proposals/stock-insights.md, with the bank
 * cross-check, and (step 2) E (the company's numbers) and F (filings) from SEC EDGAR via withCompany(). Built from one
 * holding snapshot row, Yahoo histories and SEC filings; the only owner data in it is the bank's price per unit (never a quantity, value,
 * cost or gain). Percentages are percent numbers rounded to 2 decimals (benchmark differences to 1, as the app shows
 * them), prices are in the holding's currency (major units) rounded to 4 decimals, beta to 3.
 */
import { lastUsClose, localDate, US_TZ, wallTime } from '../prices/market.js';
import type { PriceHistory } from '../prices/history.js';
import { type CrossCheck, type Drawdown, type Returns, SESSIONS, benchmarkReturns, beta, chartSeries, crossCheck, maxDrawdown5y, maxDrawdownOver, returnsOf, trendOf, volatility } from './price.js';
import type { AnalystsSection, AnalystsUnavailableCode, EarningsSection } from './analysts.js';
import type { CompanySection } from './company.js';
import type { FilingEvent } from './sec.js';
import type { SectorFund } from './sector.js';

export const BENCHMARK_SYMBOL = 'SPY';
/** dividends shown: the last 5 years */
const DIVIDEND_YEARS = 5;

/** why the panel has no analytics: a stable code for the app to translate, with an English text next to it */
export type UnavailableCode = 'off' | 'not_covered' | 'busy' | 'unreachable' | 'unknown_symbol' | 'invalid';
export const UNAVAILABLE_TEXT: Record<UnavailableCode, string> = {
  off: 'stock insights are off',
  not_covered: 'this holding is not covered by the price source',
  busy: 'the price source is busy; try again later',
  unreachable: 'the price source could not be reached',
  unknown_symbol: 'the price source does not know this symbol',
  invalid: 'the price history failed validation',
};

export interface InsightsRow {
  id: number;
  symbol: string;
  name: string;
  currency: string;
  /** the bank's price per unit at the snapshot */
  price: number | null;
  takenAt: string;
}

type Nullable<T> = { [K in keyof T]: T[K] | null };

/** why the company sections (E, F and the sector benchmark) are missing: off (no SEC contact or insights off),
 * not_covered (not in SEC's ticker list, a non-US listing, an ETF or a shekel-priced security), busy (SEC rate limit,
 * or slower than the panel's deadline: the cache fills for the next open), unreachable, invalid (failed validation) */
export type CompanyUnavailableCode = 'off' | 'not_covered' | 'busy' | 'unreachable' | 'invalid';

export interface SectorBenchmark {
  symbol: string;
  name: string;
  returns: Returns;
  diffPts: Nullable<Returns>;
}

export interface HoldingInsights {
  id: number;
  symbol: string;
  name: string;
  currency: string;
  /** the last completed session in the history (YYYY-MM-DD); null only when `unavailable` is set */
  asOf: string | null;
  /** ISO time the history was fetched (or this answer made, when unavailable) */
  fetchedAt: string;
  source: 'yahoo';
  /** null only when `unavailable` is set */
  instrumentType: 'EQUITY' | 'ETF' | null;
  crossCheck: { bankPrice: number | null; bankAt: string | null; yahooClose: number | null; yahooDate: string | null; diffPct: number | null; ok: boolean | null; note: 'intraday_snapshot' | null };
  trend: {
    /** null only when `unavailable` is set */
    price: number | null;
    sma50: number | null;
    sma200: number | null;
    vsSma50Pct: number | null;
    vsSma200Pct: number | null;
    /** negative = sessions below */
    daysAboveSma200: number | null;
    daysAboveSma200IsLowerBound: boolean;
    high52: number | null;
    low52: number | null;
    fromHigh52Pct: number | null;
    fromLow52Pct: number | null;
  };
  returns: Returns;
  benchmark: { symbol: typeof BENCHMARK_SYMBOL; returns: Returns; diffPts: Nullable<Returns> } | null;
  risk: { volatility1y: number | null; maxDrawdown1y: Drawdown | null; maxDrawdown5y: Drawdown | null; beta1y: number | null };
  series: Array<{ d: string; c: number; sma50: number | null; sma200: number | null }>;
  events: { dividends: Array<{ d: string; amount: number }>; splits: Array<{ d: string; ratio: string }> };
  /** the company's SPDR sector fund over the same windows (SIC code → fund, sector.ts); null when unknown or stale */
  sector: SectorBenchmark | null;
  /** section E from SEC filings; null with `companyUnavailableCode` set */
  company: CompanySection | null;
  companyUnavailableCode?: CompanyUnavailableCode;
  /** section F: 10-K, 10-Q, 8-K (20-F, 40-F, 6-K) filed in the last 12 months, newest first, at most 20 */
  filings: FilingEvent[];
  /** Part B (stock-decision-aids.md): the analysts' ratings from Finnhub (third-party, attributed); null with
   * `analystsUnavailableCode` set. Stocks (EQUITY) only. */
  analysts: AnalystsSection | null;
  analystsUnavailableCode?: AnalystsUnavailableCode;
  /** the next and last earnings report from Finnhub; null when unavailable (an ETF, no key and nothing cached…) */
  earnings: EarningsSection | null;
  /** why the history could not be fetched or validated (English); the other sections are empty then */
  unavailable?: string;
  unavailableCode?: UnavailableCode;
}

const r = (v: number | null, dp: number): number | null => {
  if (v === null || !Number.isFinite(v)) return null;
  const f = 10 ** dp;
  const x = Math.round(v * f) / f;
  return Object.is(x, -0) ? 0 : x;
};
const rp = (v: number | null): number | null => r(v, 2);
const rPrice = (v: number | null): number | null => r(v, 4);
const roundReturns = (x: Returns): Returns => ({ m1: rp(x.m1), m3: rp(x.m3), m6: rp(x.m6), y1: rp(x.y1), y3Ann: rp(x.y3Ann) });
const roundDd = (d: Drawdown | null): Drawdown | null => (d ? { pct: rp(d.pct)!, peakDate: d.peakDate, troughDate: d.troughDate } : null);

/** The US session (New York date) whose close a bank snapshot taken at `t` stands for. */
export function bankSessionDate(t: number): string {
  return localDate(lastUsClose(t), US_TZ);
}

/**
 * Was the snapshot taken while a US session could still move the price: 09:30–16:05 New York, Monday to Friday
 * (the close settles a few minutes after 16:00; holidays are not known and count as session days).
 */
export function intradaySnapshot(t: number): boolean {
  const w = wallTime(t, US_TZ);
  const m = w.hour * 60 + w.minute;
  return w.weekday >= 1 && w.weekday <= 5 && m >= 9 * 60 + 30 && m < 16 * 60 + 5;
}

const bankCheck = (row: InsightsRow, bars: PriceHistory['bars']): CrossCheck => crossCheck(row.price, row.takenAt, bars, { expectedSession: bankSessionDate, intraday: intradaySnapshot });

function publicCheck(c: CrossCheck): HoldingInsights['crossCheck'] {
  return { bankPrice: rPrice(c.bankPrice), bankAt: c.bankAt, yahooClose: rPrice(c.yahooClose), yahooDate: c.yahooDate, diffPct: c.diffPct, ok: c.ok, note: c.note };
}

const emptyReturns = (): Returns => ({ m1: null, m3: null, m6: null, y1: null, y3Ann: null });

/** The answer when the history is missing: the bank price only, every computed section empty, with the reason. */
export function unavailableInsights(row: InsightsRow, code: UnavailableCode, now: number): HoldingInsights {
  return {
    id: row.id,
    symbol: row.symbol,
    name: row.name,
    currency: row.currency,
    asOf: null,
    fetchedAt: new Date(now).toISOString(),
    source: 'yahoo',
    instrumentType: null,
    crossCheck: publicCheck(bankCheck(row, [])),
    trend: { price: null, sma50: null, sma200: null, vsSma50Pct: null, vsSma200Pct: null, daysAboveSma200: null, daysAboveSma200IsLowerBound: false, high52: null, low52: null, fromHigh52Pct: null, fromLow52Pct: null },
    returns: emptyReturns(),
    benchmark: null,
    risk: { volatility1y: null, maxDrawdown1y: null, maxDrawdown5y: null, beta1y: null },
    series: [],
    events: { dividends: [], splits: [] },
    sector: null,
    company: null,
    companyUnavailableCode: 'off',
    filings: [],
    analysts: null,
    analystsUnavailableCode: 'off',
    earnings: null,
    unavailable: UNAVAILABLE_TEXT[code],
    unavailableCode: code,
  };
}

/** Does the benchmark history have a session on the holding's last session (after cutting at it)? */
export function benchmarkAligned(stockAsOf: string, spy: PriceHistory | null): boolean {
  if (!spy) return false;
  const cut = spy.bars.filter((b) => b.d <= stockAsOf);
  return cut.length > 0 && cut[cut.length - 1]!.d === stockAsOf;
}

/** Same-window returns of a benchmark and the holding's lead over it in points (1 decimal, from the shown values). */
function compare(bars: PriceHistory['bars'], returns: Returns, bench: PriceHistory['bars']): { returns: Returns; diffPts: Nullable<Returns> } {
  const sr = benchmarkReturns(bars, bench);
  const diff = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : r(r(a, 1)! - r(b, 1)!, 1));
  return {
    returns: roundReturns(sr),
    diffPts: { m1: diff(returns.m1, sr.m1), m3: diff(returns.m3, sr.m3), m6: diff(returns.m6, sr.m6), y1: diff(returns.y1, sr.y1), y3Ann: diff(returns.y3Ann, sr.y3Ann) },
  };
}

/**
 * The panel answer from the holding's row, its history, SPY's and (optionally) the sector fund's. The benchmarks'
 * windows use the holding's own start and end dates; a benchmark without a session on the holding's last session
 * (stale) is left out (SPY: benchmark and beta null; the sector fund: sector null). The company sections start empty
 * (`company` null, code 'off') and are filled by withCompany(). Returns the unavailable answer when the history is
 * empty.
 */
export function buildInsights(row: InsightsRow, h: PriceHistory, spy: PriceHistory | null, now: number, sector: { fund: SectorFund; history: PriceHistory | null } | null = null): HoldingInsights {
  const bars = h.bars;
  const trend = trendOf(bars);
  if (!trend || !bars.length) return unavailableInsights(row, 'invalid', now);
  const asOf = bars[bars.length - 1]!.d;
  const adj = bars.map((b) => b.adj);
  const returns = returnsOf(adj);
  let benchmark: HoldingInsights['benchmark'] = null;
  let beta1y: number | null = null;
  if (spy && benchmarkAligned(asOf, spy)) {
    const sb = spy.bars.filter((b) => b.d <= asOf);
    benchmark = { symbol: BENCHMARK_SYMBOL, ...compare(bars, returns, sb) };
    beta1y = r(beta(bars, sb), 3);
  }
  let sectorOut: SectorBenchmark | null = null;
  if (sector && h.instrumentType === 'EQUITY' && sector.history && benchmarkAligned(asOf, sector.history)) {
    sectorOut = { symbol: sector.fund.symbol, name: sector.fund.name, ...compare(bars, returns, sector.history.bars.filter((b) => b.d <= asOf)) };
  }
  const since = `${Number(asOf.slice(0, 4)) - DIVIDEND_YEARS}${asOf.slice(4)}`;
  return {
    id: row.id,
    symbol: row.symbol,
    name: row.name,
    currency: row.currency,
    asOf,
    fetchedAt: new Date(h.fetchedAt).toISOString(),
    source: 'yahoo',
    instrumentType: h.instrumentType,
    crossCheck: publicCheck(bankCheck(row, bars)),
    trend: {
      price: rPrice(trend.price),
      sma50: rPrice(trend.sma50),
      sma200: rPrice(trend.sma200),
      vsSma50Pct: rp(trend.vsSma50Pct),
      vsSma200Pct: rp(trend.vsSma200Pct),
      daysAboveSma200: trend.daysAboveSma200,
      daysAboveSma200IsLowerBound: trend.daysAboveSma200IsLowerBound,
      high52: rPrice(trend.high52),
      low52: rPrice(trend.low52),
      fromHigh52Pct: rp(trend.fromHigh52Pct),
      fromLow52Pct: rp(trend.fromLow52Pct),
    },
    returns: roundReturns(returns),
    benchmark,
    risk: { volatility1y: rp(volatility(adj, SESSIONS.y1)), maxDrawdown1y: roundDd(maxDrawdownOver(bars, SESSIONS.y1)), maxDrawdown5y: roundDd(maxDrawdown5y(bars)), beta1y },
    series: chartSeries(bars, SESSIONS.y1).map((p) => ({ d: p.d, c: rPrice(p.c)!, sma50: rPrice(p.sma50), sma200: rPrice(p.sma200) })),
    events: { dividends: h.dividends.filter((x) => x.d > since).map((x) => ({ d: x.d, amount: r(x.amount, 6)! })), splits: h.splits.map((x) => ({ ...x })) },
    sector: sectorOut,
    company: null,
    companyUnavailableCode: 'off',
    filings: [],
    analysts: null,
    analystsUnavailableCode: 'off',
    earnings: null,
  };
}

/**
 * The panel answer with the company sections: either the built section and filings, or the code saying why they are
 * missing (then company null, filings empty, and no sector benchmark, which needs the company's SIC code). An ETF
 * never has company sections ('not_covered').
 */
export function withCompany(out: HoldingInsights, part: { company: CompanySection; filings: FilingEvent[] } | { code: CompanyUnavailableCode }): HoldingInsights {
  const { companyUnavailableCode: _c, ...rest } = out;
  if ('code' in part || out.instrumentType === 'ETF') return { ...rest, sector: null, company: null, companyUnavailableCode: 'code' in part ? part.code : 'not_covered', filings: [] };
  return { ...rest, company: part.company, filings: part.filings };
}

/**
 * The panel answer with Part B: the analysts' section (or the code saying why it is missing) and the earnings dates
 * (null when unavailable). An ETF never has them (analysts 'not_covered', earnings null).
 */
export function withAnalysts(out: HoldingInsights, part: { analysts: AnalystsSection | null; code: AnalystsUnavailableCode | null; earnings: EarningsSection | null }): HoldingInsights {
  const { analystsUnavailableCode: _c, ...rest } = out;
  if (out.instrumentType === 'ETF') return { ...rest, analysts: null, analystsUnavailableCode: 'not_covered', earnings: null };
  if (part.analysts) return { ...rest, analysts: part.analysts, earnings: part.earnings };
  return { ...rest, analysts: null, analystsUnavailableCode: part.code ?? 'invalid', earnings: part.earnings };
}
