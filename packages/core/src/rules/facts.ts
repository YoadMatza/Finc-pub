/**
 * The facts a holding rule is evaluated against (evaluate.ts), assembled from payloads finc already has: the latest
 * holdings snapshots with live prices (prices/live.ts), and the stock-insights panel (insights/panel.ts, company.ts).
 * Nothing here fetches anything. Part B: the analysts' 3-month change and the days until the next earnings report
 * come from the panel's Finnhub sections (dated with the Israel date Finnhub answered).
 *
 * Positions are per symbol over every account's latest snapshot (a symbol held in both FIBI accounts is one position):
 *  - price: the largest row's, live when its quote is live, else the bank's;
 *  - day change: a live quote only (the open session's move, or after the close the completed session's), dated with
 *    its US session; the bank snapshot's daily change is never used. Without one, after the close, the Yahoo history's
 *    last session when it is the latest completed one (assembleFacts); otherwise unknown;
 *  - cost: the quantity-weighted average of the rows' checked cost prices (trustedCost), dated with the bank snapshot;
 *    unknown when any row lacks one or the rows are in different currencies;
 *  - value and the portfolio (PORTFOLIO_DEFINITION): every holding row (securities and foreign-currency cash) in the
 *    latest snapshot of each account synced within the last 7 days, live where live.
 */
import type { Db } from '../db/db.js';
import { EARNINGS_AHEAD_DAYS, daysUntilDate, israelDate } from '../insights/analysts.js';
import type { CompanyFigure } from '../insights/company.js';
import type { HoldingInsights } from '../insights/panel.js';
import { US_TZ, lastUsClose, localDate, usSessionOpen, wallTime } from '../prices/market.js';
import { HOLDINGS_MAX_AGE_MS, type PriceCache, accountLiveHoldings, latestHoldingRows, trustedCost } from '../prices/live.js';
import type { Fact, RuleFacts, RuleSource } from './evaluate.js';

export const RULES_TZ = 'Asia/Jerusalem';

/** What "the portfolio" means for concentration_pct (GET /api/holding-rules). */
export const PORTFOLIO_DEFINITION = { includes: ['securities', 'foreign_currency_cash'], maxSnapshotAgeDays: HOLDINGS_MAX_AGE_MS / 86_400_000 } as const;

/** Upper-case, trimmed: the form scopes and states use. */
export const normSymbol = (s: string): string => s.trim().toUpperCase();

const hhmm = (t: number): string => {
  const w = wallTime(t, RULES_TZ);
  return `${String(w.hour).padStart(2, '0')}:${String(w.minute).padStart(2, '0')}`;
};
/** a bank snapshot (or the holdings totals) taken at `t`: Israel date and time */
export const snapshotSource = (kind: 'bank' | 'holdings' | 'live', t: number): RuleSource => ({ kind, date: localDate(t, RULES_TZ), time: hhmm(t), form: null });
/** a live quote: its US session date (New York) and its market time in Israel */
export const liveSource = (marketTime: number): RuleSource => ({ kind: 'live', date: localDate(marketTime, US_TZ), time: hhmm(marketTime), form: null });

export interface HeldPosition {
  symbol: string;
  /** the largest row of the symbol (its holding_snapshot.id), for building its insights panel */
  rowId: number;
  name: string;
  currency: string;
  /** the bank's price of that row and when its snapshot was taken */
  bankPrice: number | null;
  takenAt: string;
  /** the checked cost, with the (oldest) bank snapshot it comes from */
  costPrice: Fact | null;
  price: Fact | null;
  /** live only */
  dayChangePct: Fact | null;
  /** agorot, from the accounts counted in the portfolio only (null when none) */
  valueIls: Fact | null;
}

export interface HeldPositions {
  /** agorot (PORTFOLIO_DEFINITION) */
  portfolioIls: number;
  /** 'live' when every counted row is live, 'bank' when none is, 'holdings' when mixed; dated with the oldest snapshot (live: now) */
  portfolioSource: RuleSource | null;
  positions: Map<string, HeldPosition>;
}

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/** Every held security (by symbol) with what the rules need, from the latest snapshot of each account. */
export function heldPositions(db: Db, cache: PriceCache, now: number): HeldPositions {
  const accounts = db.$client.prepare('select account_id a, max(taken_at) t from holding_snapshot group by account_id order by account_id').all() as Array<{ a: number; t: string }>;
  const freshSince = now - HOLDINGS_MAX_AGE_MS;
  let portfolioIls = 0;
  let rowsLive = 0;
  let rowsBank = 0;
  let oldestFresh: number | null = null;
  type Item = { row: ReturnType<typeof latestHoldingRows>[number]; live: ReturnType<typeof accountLiveHoldings>['rows'][number] | undefined; takenAt: string; fresh: boolean; name: string };
  const groups = new Map<string, Item[]>();
  const names = db.$client.prepare('select name from holding_snapshot where id = ?');
  for (const acc of accounts) {
    const rows = latestHoldingRows(db, acc.a);
    const live = accountLiveHoldings(db, acc.a, cache, now);
    const takenMs = Date.parse(acc.t);
    const fresh = Number.isFinite(takenMs) && takenMs >= freshSince;
    if (fresh) {
      portfolioIls += live.totalIls;
      for (const r of live.rows) {
        if (r.source === 'live') rowsLive++;
        else rowsBank++;
      }
      if (oldestFresh === null || takenMs < oldestFresh) oldestFresh = takenMs;
    }
    for (const r of rows) {
      if (r.kind !== 'security') continue;
      const sym = normSymbol(r.symbol);
      if (!sym) continue;
      const arr = groups.get(sym) ?? [];
      arr.push({ row: r, live: live.rows.find((x) => x.id === r.id), takenAt: acc.t, fresh, name: (names.get(r.id) as { name: string } | undefined)?.name ?? sym });
      groups.set(sym, arr);
    }
  }
  const positions = new Map<string, HeldPosition>();
  for (const [symbol, arr] of groups) {
    const value = (x: Item): number => x.live?.valueIls ?? x.row.valueIls;
    const top = [...arr].sort((a, b) => value(b) - value(a) || a.row.id - b.row.id)[0]!;
    const q = top.live?.source === 'live' ? cache.quotes.get(top.row.symbol) : undefined;
    const priceSrc: RuleSource = q ? liveSource(q.marketTime) : snapshotSource('bank', Date.parse(top.takenAt));
    const priceV = q ? top.live!.price : top.row.price;
    // cost: every row must carry a checked cost in the same currency
    let cost: Fact | null = null;
    const costs = arr.map((x) => trustedCost(x.row));
    if (arr.every((x) => x.row.currency === top.row.currency) && costs.every(finite)) {
      const qty = arr.reduce((a, x) => a + x.row.quantity, 0);
      const oldest = Math.min(...arr.map((x) => Date.parse(x.takenAt)));
      if (qty > 0) cost = { value: arr.reduce((a, x, i) => a + costs[i]! * x.row.quantity, 0) / qty, source: snapshotSource('bank', oldest) };
    }
    const day = q ? top.live!.dayChangePct : null;
    const freshItems = arr.filter((x) => x.fresh);
    positions.set(symbol, {
      symbol,
      rowId: top.row.id,
      name: top.name,
      currency: top.row.currency,
      bankPrice: finite(top.row.price) && top.row.price > 0 ? top.row.price : null,
      takenAt: top.takenAt,
      costPrice: cost,
      price: finite(priceV) && priceV > 0 ? { value: priceV, source: priceSrc } : null,
      dayChangePct: q && finite(day) ? { value: day, source: priceSrc } : null,
      valueIls: freshItems.length ? { value: freshItems.reduce((a, x) => a + value(x), 0), source: priceSrc } : null,
    });
  }
  let portfolioSource: RuleSource | null = null;
  if (oldestFresh !== null && rowsLive + rowsBank > 0) {
    portfolioSource = rowsBank === 0 ? snapshotSource('live', now) : snapshotSource(rowsLive === 0 ? 'bank' : 'holdings', oldestFresh);
  }
  return { portfolioIls, portfolioSource, positions };
}

/** a filing date and form; the period end when the filing is unknown */
function figureSource(f: CompanyFigure): RuleSource {
  return f.form && f.filed ? { kind: 'sec', date: f.filed, time: null, form: f.form } : { kind: 'sec', date: f.periodEnd, time: null, form: f.form };
}

/**
 * The day change from the panel's history: only while the US session is shut, and only when the history's last
 * session is the latest completed one (so it is that session's move, not an older day's).
 */
function historyDayChange(i: HoldingInsights, now: number): Fact | null {
  if (usSessionOpen(now) || !i.asOf || i.asOf !== localDate(lastUsClose(now), US_TZ)) return null;
  const s = i.series;
  const last = s.at(-1);
  const prev = s.at(-2);
  if (!last || !prev || last.d !== i.asOf || !(prev.c > 0)) return null;
  return { value: (last.c / prev.c - 1) * 100, source: { kind: 'yahoo', date: i.asOf, time: null, form: null } };
}

/**
 * The facts for one symbol: its position (null when not held), the portfolio total, and the insights panel (null when
 * none was built; an unavailable panel simply has no trend, returns, benchmark or company figures).
 */
export function assembleFacts(o: { position: HeldPosition | null; portfolio: Pick<HeldPositions, 'portfolioIls' | 'portfolioSource'> | null; insights: HoldingInsights | null; now?: number }): RuleFacts {
  const facts: RuleFacts = {};
  const p = o.position;
  if (p) {
    facts.costPrice = p.price ? p.costPrice : null;
    facts.price = p.price;
    facts.dayChangePct = p.dayChangePct;
    facts.valueIls = p.valueIls;
  }
  if (o.portfolio?.portfolioSource && o.portfolio.portfolioIls > 0) facts.portfolioIls = { value: o.portfolio.portfolioIls, source: o.portfolio.portfolioSource };
  const i = o.insights;
  if (i && !i.unavailable && i.asOf) {
    const y: RuleSource = { kind: 'yahoo', date: i.asOf, time: null, form: null };
    const of = (v: number | null | undefined): Fact | null => (finite(v) ? { value: v, source: { ...y } } : null);
    facts.daysAboveSma200 = finite(i.trend.daysAboveSma200) ? { value: i.trend.daysAboveSma200, source: { ...y }, lowerBound: i.trend.daysAboveSma200IsLowerBound } : null;
    facts.fromHigh52Pct = of(i.trend.fromHigh52Pct);
    facts.returnM1 = of(i.returns.m1);
    facts.returnM3 = of(i.returns.m3);
    facts.spyDiffY1 = of(i.benchmark?.diffPts.y1);
    if (!facts.dayChangePct && o.now !== undefined) facts.dayChangePct = historyDayChange(i, o.now);
  }
  const figs = i?.company?.figures;
  if (figs) {
    const of = (f: CompanyFigure | null): Fact | null => (f && finite(f.value) ? { value: f.value, source: figureSource(f) } : null);
    facts.pe = of(figs.pe);
    facts.revenueYoYPct = of(figs.revenueYoYPct);
    facts.netMarginPct = of(figs.netMarginPct);
    facts.netMarginPct1yAgo = of(figs.netMarginPct1yAgo);
    facts.sharesChange1yPct = of(figs.sharesChange1yPct);
  }
  if (i) {
    const fh = (fetchedAt: string): RuleSource => ({ kind: 'finnhub', date: Number.isFinite(Date.parse(fetchedAt)) ? israelDate(Date.parse(fetchedAt)) : null, time: null, form: null });
    const a = i.analysts;
    facts.buyShareChange3mPts = a && finite(a.buyShareChange3mPts) ? { value: a.buyShareChange3mPts, source: fh(a.fetchedAt) } : null;
    const next = i.earnings?.next;
    const days = next && o.now !== undefined ? daysUntilDate(israelDate(o.now), next.date) : null;
    // Finnhub answered and lists no report within the window: the rule is clear (not unknown)
    facts.earningsDays = !i.earnings ? null : !next ? { value: EARNINGS_AHEAD_DAYS, source: fh(i.earnings.fetchedAt), noneWithin: true } : finite(days) && days >= 0 ? { value: days, source: fh(i.earnings.fetchedAt) } : null;
  }
  return facts;
}
