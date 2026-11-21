/**
 * Position view, step 2 (research_notes/proposals/position-view.md §2): the owner's own result on one holding, from
 * the bank's purchase lots (step 1) and the holding's current value. Pure: no I/O; the caller passes the lots, the
 * holding, SPY's history (already fetched for the insights panel) and the portfolio totals.
 *
 * Units: shekel amounts in agorot (integers), amounts in the paper's currency in major units rounded to 2 decimals,
 * percentages rounded to 2 decimals. Facts only: nothing here says what to do.
 *
 *  - your result: value − cost (cost = the bank's per-lot cost in shekels, purchase fee included);
 *  - per year: the money-weighted return (XIRR) over the lots' dates, only for bought lots held a year or more;
 *  - against the market: each bought lot's dollar cost put into SPY (dividend-adjusted closes) on its date;
 *  - the dollar's part: the result split into the paper's move (at today's rate) and the rate's move since buying;
 *  - if you sold today: value − fee (a rate, default 0) − an estimated tax on the nominal shekel gain (25%);
 *  - what if: the value at −30/−10/+10/+30%, and the price at which the shekel result is zero;
 *  - weight: share of the securities account and of net worth.
 */
import type { CostLotRow, TradeRow } from '../ingest/fibi-pages.js';

/** the general rate on capital gains for an individual in Israel (an estimate; the bank's calculation is binding) */
export const CAPITAL_GAINS_TAX_RATE = 0.25;
export const WHAT_IF_MOVES = [-30, -10, 10, 30] as const;
/** a lot's price on the bank's cost page and the holding's price may differ this much and still be the same paper */
const MATCH_PRICE_TOL = 0.05;
/** SPY's last session may be this old (days) and still count as today's */
const BENCH_MAX_AGE_DAYS = 7;
const DAY_MS = 86_400_000;

const r2 = (n: number): number => Math.round(n * 100) / 100;
const pct = (num: number, den: number): number | null => (den > 0 ? r2((num / den) * 100) : null);
const days = (a: string, b: string): number => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS;

export interface MatchHolding {
  id: number;
  quantity: number;
  price: number | null;
  currency: string;
}

/**
 * Which lots belong to which holding. The cost page names papers by the bank's number and a shortened name, the
 * holdings page by ticker, so they are joined by facts: a paper's lots must add up to the holding's quantity, in the
 * same currency, at about the same current price. A paper that fits no holding, or more than one, stays unmatched;
 * two papers never share a holding.
 */
export function matchLots(holdings: MatchHolding[], lots: CostLotRow[]): Map<number, CostLotRow[]> {
  const byPaper = new Map<string, CostLotRow[]>();
  for (const l of lots) byPaper.set(l.paperId, [...(byPaper.get(l.paperId) ?? []), l]);
  const claims = new Map<number, CostLotRow[][]>();
  for (const group of byPaper.values()) {
    const qty = group.reduce((a, l) => a + l.quantity, 0);
    const last = group.find((l) => l.lastPrice !== null && l.lastPrice > 0)?.lastPrice ?? null;
    const fits = holdings.filter(
      (h) =>
        Math.abs(h.quantity - qty) < 1e-6 &&
        h.currency === group[0]!.currency &&
        (last === null || (h.price !== null && h.price > 0 && Math.abs(h.price / last - 1) <= MATCH_PRICE_TOL)),
    );
    if (fits.length === 1) claims.set(fits[0]!.id, [...(claims.get(fits[0]!.id) ?? []), group]);
  }
  const out = new Map<number, CostLotRow[]>();
  for (const [id, groups] of claims) if (groups.length === 1) out.set(id, [...groups[0]!].sort((a, b) => a.tradeDate.localeCompare(b.tradeDate)));
  return out;
}

/** The yearly rate r with Σ cf·(1+r)^(−t/365) = 0, by bisection; null when the flows do not bracket a root. */
export function xirr(flows: Array<{ d: string; amount: number }>): number | null {
  if (flows.length < 2 || !flows.some((f) => f.amount < 0) || !flows.some((f) => f.amount > 0)) return null;
  const t0 = flows.reduce((m, f) => (f.d < m ? f.d : m), flows[0]!.d);
  const npv = (r: number): number => flows.reduce((a, f) => a + f.amount / (1 + r) ** (days(t0, f.d) / 365), 0);
  let lo = -0.9999;
  let hi = 10;
  let flo = npv(lo);
  const fhi = npv(hi);
  if (!Number.isFinite(flo) || !Number.isFinite(fhi) || Math.sign(flo) === Math.sign(fhi)) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fm = npv(mid);
    if (Math.abs(fm) < 1e-9 || hi - lo < 1e-10) return mid;
    if (Math.sign(fm) === Math.sign(flo)) {
      lo = mid;
      flo = fm;
    } else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface PositionInput {
  holding: {
    quantity: number;
    /** current price per unit in `currency` */
    price: number;
    currency: string;
    /** current value, agorot */
    valueIls: number;
    /** shekels per unit of `currency` now; null to read it from value / (quantity × price) */
    rate: number | null;
    priceSource: 'live' | 'bank';
    /** when the price is from (ISO) */
    asOf: string | null;
  };
  lots: CostLotRow[];
  /** SPY's daily bars (dividend-adjusted closes), oldest first; null when unavailable */
  spy: Array<{ d: string; adj: number }> | null;
  /** YYYY-MM-DD */
  today: string;
  /** the securities account's total and net worth, agorot (null when unknown) */
  portfolioIls: number | null;
  netWorthIls: number | null;
  /** fee on a sale as a fraction of its value (default 0, decided 2026-11-16) */
  feeRate?: number;
  taxRate?: number;
}

export type PositionUnavailable = 'no_lots' | 'not_matched';
/** why one block is missing */
export type BlockMissing = 'received_shares' | 'under_a_year' | 'no_benchmark' | 'benchmark_stale' | 'history_short' | 'not_foreign' | 'no_solution';

export interface PositionLotView {
  tradeDate: string;
  action: CostLotRow['action'];
  actionText: string;
  quantity: number;
  /** per unit, purchase fee included, in `currency` */
  costPrice: number;
  currency: string;
  /** the lot's cost in shekels, agorot */
  costIls: number;
}

export interface PositionView {
  asOf: string | null;
  priceSource: 'live' | 'bank';
  currency: string;
  quantity: number;
  price: number;
  /** shekels per unit of the currency now */
  rate: number;
  lots: PositionLotView[];
  result: { costIls: number; valueIls: number; gainIls: number; gainPct: number | null; costOrig: number; valueOrig: number; gainOrig: number; gainOrigPct: number | null; source: 'bank_lots' };
  perYear: { pct: number | null; missing: BlockMissing | null; since: string };
  benchmark: { symbol: 'SPY'; asOf: string; valueIls: number; gainIls: number; gainPct: number | null; diffIls: number; diffPts: number | null } | null;
  benchmarkMissing: BlockMissing | null;
  /** the shekel result split in two; null for a shekel paper */
  dollarPart: { stockIls: number; fxIls: number; rateAtBuy: number; rateNow: number } | null;
  dollarPartMissing: BlockMissing | null;
  ifSold: { valueIls: number; feeIls: number; feeRate: number; taxIls: number; taxRate: number; taxBasis: 'estimate_nominal_gain'; proceedsIls: number; netGainIls: number; realisedLossIls: number | null };
  whatIf: { moves: Array<{ movePct: number; valueIls: number; gainIls: number }>; breakEvenPrice: number; breakEvenMovePct: number | null };
  weight: { ofPortfolioPct: number | null; ofNetWorthPct: number | null };
}

/** The position view for one holding, or why there is none (no lots read, or none matched to it). */
export function computePosition(p: PositionInput): { ok: true; view: PositionView } | { ok: false; code: PositionUnavailable } {
  const h = p.holding;
  if (!p.lots.length) return { ok: false, code: 'no_lots' };
  if (Math.abs(p.lots.reduce((a, l) => a + l.quantity, 0) - h.quantity) > 1e-6) return { ok: false, code: 'not_matched' };
  const foreign = h.currency !== 'ILS';
  const rate = foreign ? (h.rate ?? (h.quantity > 0 && h.price > 0 ? h.valueIls / 100 / (h.quantity * h.price) : 0)) : 1;
  const lotIls = (l: CostLotRow): number => Math.round(l.quantity * l.costPriceIls * 100);
  const costIls = p.lots.reduce((a, l) => a + lotIls(l), 0);
  const costOrig = p.lots.reduce((a, l) => a + l.quantity * l.costPrice, 0);
  const valueOrig = h.quantity * h.price;
  const gainIls = h.valueIls - costIls;
  const allBought = p.lots.every((l) => l.action === 'buy');
  const first = p.lots.reduce((m, l) => (l.tradeDate < m ? l.tradeDate : m), p.lots[0]!.tradeDate);

  // per year: money-weighted, over the real dates; not for shares received (no money paid on their date) or under a year
  let perYear: PositionView['perYear'] = { pct: null, missing: null, since: first };
  if (!allBought) perYear.missing = 'received_shares';
  else if (days(first, p.today) < 365) perYear.missing = 'under_a_year';
  else {
    const rr = xirr([...p.lots.map((l) => ({ d: l.tradeDate, amount: -lotIls(l) })), { d: p.today, amount: h.valueIls }]);
    perYear = rr === null ? { ...perYear, missing: 'no_solution' } : { ...perYear, pct: r2(rr * 100) };
  }

  // against the market: the same dollars into SPY on the same dates
  let benchmark: PositionView['benchmark'] = null;
  let benchmarkMissing: BlockMissing | null = null;
  const bars = p.spy;
  if (!allBought) benchmarkMissing = 'received_shares';
  else if (h.currency !== 'USD') benchmarkMissing = 'not_foreign';
  else if (!bars || !bars.length) benchmarkMissing = 'no_benchmark';
  else if (days(bars[bars.length - 1]!.d, p.today) > BENCH_MAX_AGE_DAYS) benchmarkMissing = 'benchmark_stale';
  else if (first < bars[0]!.d) benchmarkMissing = 'history_short';
  else {
    const at = (d: string): number => {
      // the session on the trade date, or the last one before it
      let lo = 0;
      let hi = bars.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (bars[mid]!.d <= d) lo = mid;
        else hi = mid - 1;
      }
      return bars[lo]!.adj;
    };
    const units = p.lots.reduce((a, l) => a + (l.quantity * l.costPrice) / at(l.tradeDate), 0);
    const last = bars[bars.length - 1]!;
    const valueIls = Math.round(units * last.adj * rate * 100);
    benchmark = { symbol: 'SPY', asOf: last.d, valueIls, gainIls: valueIls - costIls, gainPct: pct(valueIls - costIls, costIls), diffIls: h.valueIls - valueIls, diffPts: null };
    const mine = pct(gainIls, costIls);
    if (mine !== null && benchmark.gainPct !== null) benchmark.diffPts = r2(mine - benchmark.gainPct);
  }

  // the dollar's part: the paper's move at today's rate, and the rest (the rate's move on the money paid)
  let dollarPart: PositionView['dollarPart'] = null;
  let dollarPartMissing: BlockMissing | null = null;
  if (!foreign || costOrig <= 0) dollarPartMissing = 'not_foreign';
  else {
    const stockIls = Math.round((valueOrig - costOrig) * rate * 100);
    dollarPart = { stockIls, fxIls: gainIls - stockIls, rateAtBuy: Math.round((costIls / 100 / costOrig) * 10_000) / 10_000, rateNow: Math.round(rate * 10_000) / 10_000 };
  }

  // if sold today
  const feeRate = p.feeRate ?? 0;
  const taxRate = p.taxRate ?? CAPITAL_GAINS_TAX_RATE;
  const feeIls = Math.round(h.valueIls * feeRate);
  const netBeforeTax = gainIls - feeIls;
  const taxIls = netBeforeTax > 0 ? Math.round(netBeforeTax * taxRate) : 0;
  const ifSold: PositionView['ifSold'] = {
    valueIls: h.valueIls,
    feeIls,
    feeRate,
    taxIls,
    taxRate,
    taxBasis: 'estimate_nominal_gain',
    proceedsIls: h.valueIls - feeIls - taxIls,
    netGainIls: netBeforeTax - taxIls,
    realisedLossIls: netBeforeTax < 0 ? netBeforeTax : null,
  };

  // what if, and the price at which the shekel result is zero (at today's rate, before tax)
  const breakEvenPrice = h.quantity > 0 && rate > 0 ? Math.round((costIls / 100 / rate / h.quantity) * 10_000) / 10_000 : 0;
  const whatIf: PositionView['whatIf'] = {
    moves: WHAT_IF_MOVES.map((m) => {
      const v = Math.round(h.valueIls * (1 + m / 100));
      return { movePct: m, valueIls: v, gainIls: v - costIls };
    }),
    breakEvenPrice,
    breakEvenMovePct: h.price > 0 && breakEvenPrice > 0 ? r2((breakEvenPrice / h.price - 1) * 100) : null,
  };

  return {
    ok: true,
    view: {
      asOf: h.asOf,
      priceSource: h.priceSource,
      currency: h.currency,
      quantity: h.quantity,
      price: h.price,
      rate: Math.round(rate * 10_000) / 10_000,
      lots: p.lots.map((l) => ({ tradeDate: l.tradeDate, action: l.action, actionText: l.actionText, quantity: l.quantity, costPrice: l.costPrice, currency: l.currency, costIls: lotIls(l) })),
      result: { costIls, valueIls: h.valueIls, gainIls, gainPct: pct(gainIls, costIls), costOrig: r2(costOrig), valueOrig: r2(valueOrig), gainOrig: r2(valueOrig - costOrig), gainOrigPct: pct(valueOrig - costOrig, costOrig), source: 'bank_lots' },
      perYear,
      benchmark,
      benchmarkMissing,
      dollarPart,
      dollarPartMissing,
      ifSold,
      whatIf,
      weight: {
        ofPortfolioPct: p.portfolioIls && p.portfolioIls > 0 ? pct(h.valueIls, p.portfolioIls) : null,
        ofNetWorthPct: p.netWorthIls && p.netWorthIls > 0 ? pct(h.valueIls, p.netWorthIls) : null,
      },
    },
  };
}

/** What the bank's trade history adds to one holding's view (position-view.md §8). Amounts in their currency, 2 decimals. */
export interface PositionTrades {
  /** the oldest stored row of the account: the history reaches back this far (the bank shows about 3 years) */
  since: string;
  /** dividends on this paper, per currency: gross, net after tax, and the tax withheld (Israel and abroad, negative) */
  dividends: Array<{ currency: string; count: number; gross: number; net: number; tax: number; first: string; last: string }>;
  /** sales of this paper */
  sells: Array<{ date: string; quantity: number; price: number; currency: string; net: number; commission: number }>;
  /** the commission the bank charged on the account's buys and sells, as a fraction of their amount; null when none */
  commissionRate: number | null;
  /** how many trades that rate is from */
  commissionTrades: number;
  /** the account's custody fees in the last 12 months, agorot (negative) */
  custodyFees12mIls: number;
}

/**
 * The trade history for one holding: its papers' dividends and sales, and two account-level facts, the commission rate
 * on past trades (used for "if you sold today" instead of the assumed 0) and the custody fees of the last 12 months.
 * Null when no rows were stored. `paperIds` are the matched lots' numbers; leading zeros do not count.
 */
export function positionTrades(rows: TradeRow[], paperIds: string[], today: string): PositionTrades | null {
  if (!rows.length) return null;
  const mine = new Set(paperIds.map((x) => x.replace(/^0+/, '')));
  const own = rows.filter((r) => r.paperId !== null && mine.has(r.paperId));
  const byCur = new Map<string, PositionTrades['dividends'][number]>();
  for (const r of own.filter((x) => x.action === 'dividend')) {
    const d = byCur.get(r.currency) ?? { currency: r.currency, count: 0, gross: 0, net: 0, tax: 0, first: r.valueDate, last: r.valueDate };
    d.count++;
    d.gross += r.gross;
    d.net += r.net;
    d.tax += r.taxIl + r.taxAbroad;
    if (r.valueDate < d.first) d.first = r.valueDate;
    if (r.valueDate > d.last) d.last = r.valueDate;
    byCur.set(r.currency, d);
  }
  const traded = rows.filter((r) => (r.action === 'buy' || r.action === 'sell') && r.gross !== 0 && r.commission !== 0);
  const amount = traded.reduce((a, r) => a + Math.abs(r.gross), 0);
  const commission = traded.reduce((a, r) => a + Math.abs(r.commission), 0);
  const yearAgo = new Date(Date.parse(`${today}T00:00:00Z`) - 365 * DAY_MS).toISOString().slice(0, 10);
  const fees = rows.filter((r) => r.action === 'custody_fee' && r.currency === 'ILS' && r.valueDate > yearAgo && r.valueDate <= today);
  return {
    since: rows.reduce((m, r) => (r.valueDate < m ? r.valueDate : m), rows[0]!.valueDate),
    dividends: [...byCur.values()].map((d) => ({ ...d, gross: r2(d.gross), net: r2(d.net), tax: r2(d.tax) })),
    sells: own.filter((r) => r.action === 'sell').map((r) => ({ date: r.valueDate, quantity: r.quantity, price: r.price, currency: r.currency, net: r2(r.net), commission: r2(r.commission) })),
    commissionRate: amount > 0 ? Math.round((commission / amount) * 1_000_000) / 1_000_000 : null,
    commissionTrades: traded.length,
    custodyFees12mIls: Math.round(fees.reduce((a, r) => a + r.net, 0) * 100),
  };
}
