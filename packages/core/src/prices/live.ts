/**
 * Live values for the holdings of securities and foreign-currency accounts: the latest bank snapshot's positions
 * revalued with cached quotes and the live dollar rate. Pure (the cache and the clock come in), apart from the small
 * readers at the bottom.
 *
 * A row is 'live' when its quote is fresh: fetched within the last 5 minutes while the US session is open, or fetched
 * after the latest close while it is shut; and the live price is within 35% of the bank's own price (a split or a
 * symbol that means something else at Yahoo falls back). Anything else keeps the bank's own snapshot numbers and is
 * marked 'bank'. Values in a foreign currency go to shekels at the live USD/ILS rate when it is fresh (fetched within
 * the hour) and within 15% of the rate the bank's snapshot implies; otherwise at the row's snapshot-implied rate, and
 * the payload says so with `fx: null`.
 *
 * Gains are in dollars converted at today's rate (`gainBasis: 'usd_at_today_rate'`), from the bank's cost price, and
 * only when that cost price agrees with the bank's own from-cost percentage. The day change of a security is its
 * price change only (at today's rate); the dollar balance's day change is the rate's move, and
 * `dayChangeIncludesFx` says whether one is in the total.
 */
import type { Db } from '../db/db.js';
import { lastUsClose, usSessionOpen } from './market.js';
import { type Quote, USD_ILS_SYMBOL, validSymbol } from './yahoo.js';

export const LIVE_QUOTE_MAX_AGE_MS = 5 * 60 * 1000;
export const LIVE_FX_MAX_AGE_MS = 60 * 60 * 1000;
/** a live price further than this from the bank's own price is not believed (a split, a symbol collision) */
export const MAX_PRICE_DEVIATION = 0.35;
/** a live USD/ILS rate further than this from the snapshot-implied one is not believed */
export const MAX_FX_DEVIATION = 0.15;
/** the bank's cost price must reproduce its own from-cost percentage within this many points */
export const COST_CHECK_POINTS = 0.5;
/** holdings whose latest snapshot is older than this are not priced (an account that stopped syncing) */
export const HOLDINGS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** a quote whose own market time is older than this is not used even if just fetched (a delisted or stuck symbol) */
const MARKET_TIME_MAX_AGE_MS = 6 * 24 * 60 * 60 * 1000;
/** the session counts as open (not a holiday) when some quote moved within this window */
const OPEN_MARKET_TIME_MS = 30 * 60 * 1000;

export interface PriceCache {
  quotes: ReadonlyMap<string, Quote>;
  /** USD/ILS (Yahoo ILS=X) */
  fx: Quote | null;
}

export const emptyPriceCache = (): PriceCache => ({ quotes: new Map(), fx: null });

/** What a holding_snapshot row carries that the live view needs. */
export interface LiveInputRow {
  /** holding_snapshot.id */
  id: number;
  kind: 'security' | 'currency';
  symbol: string;
  quantity: number;
  price: number | null;
  currency: string;
  /** agorot */
  valueIls: number;
  valueOrig: number | null;
  costPrice: number | null;
  dailyChangePct: number | null;
  fromCostPct: number | null;
}

export interface LiveRow {
  /** holding_snapshot.id of the row (two rows can share a symbol) */
  id: number;
  symbol: string;
  source: 'live' | 'bank';
  price: number | null;
  prevClose: number | null;
  currency: string;
  valueOrig: number | null;
  /** agorot */
  valueIls: number;
  gainOrig: number | null;
  gainPct: number | null;
  dayChangeOrig: number | null;
  dayChangePct: number | null;
}

export interface LiveHoldings {
  asOf: string | null;
  marketState: 'open' | 'closed' | 'unavailable';
  fx: { pair: 'USD/ILS'; rate: number; at: string } | null;
  rows: LiveRow[];
  /** agorot */
  totalIls: number;
  /** agorot */
  gainIls: number | null;
  /** gainIls over the shekel cost basis of the rows that have a gain, percent */
  gainPct: number | null;
  /** agorot */
  dayChangeIls: number | null;
  /** dayChangeIls over the previous value of the rows that have a day change, percent */
  dayChangePct: number | null;
  /** true when the dollar balance's rate move is part of dayChangeIls (securities never include the rate's move) */
  dayChangeIncludesFx: boolean;
  gainBasis: 'usd_at_today_rate';
}

/** Is this quote fresh enough to call live at `now`? */
export function quoteIsLive(q: Quote, now: number): boolean {
  if (now - q.marketTime > MARKET_TIME_MAX_AGE_MS) return false;
  if (q.fetchedAt > now + 60_000) return false;
  if (usSessionOpen(now)) return now - q.fetchedAt <= LIVE_QUOTE_MAX_AGE_MS;
  return q.fetchedAt >= lastUsClose(now);
}

export function fxIsLive(q: Quote | null, now: number): q is Quote {
  return !!q && q.currency === 'ILS' && now - q.fetchedAt <= LIVE_FX_MAX_AGE_MS && q.fetchedAt <= now + 60_000 && now - q.marketTime <= MARKET_TIME_MAX_AGE_MS;
}

const finitePos = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const round2 = (v: number): number => Math.round(v * 100) / 100;
const round4 = (v: number): number => Math.round(v * 10_000) / 10_000;

/** Shekels per unit of the row's currency implied by the bank's own snapshot, or null. */
export function impliedRate(r: LiveInputRow): number | null {
  if (r.currency === 'ILS') return 1;
  if (r.kind === 'currency') {
    if (finitePos(r.price)) return r.price;
    return r.quantity > 0 ? r.valueIls / 100 / r.quantity : null;
  }
  if (finitePos(r.valueOrig)) return r.valueIls / 100 / r.valueOrig;
  if (finitePos(r.price) && r.quantity > 0) return r.valueIls / 100 / (r.price * r.quantity);
  return null;
}

/** The cost price, when it reproduces the bank's own from-cost percentage (or the bank gave none). */
export function trustedCost(r: LiveInputRow): number | null {
  if (r.kind !== 'security' || !finitePos(r.costPrice)) return null;
  if (r.fromCostPct === null || r.fromCostPct === undefined) return r.costPrice;
  if (!finitePos(r.price) || !Number.isFinite(r.fromCostPct)) return null;
  return Math.abs((r.price / r.costPrice - 1) * 100 - r.fromCostPct) <= COST_CHECK_POINTS ? r.costPrice : null;
}

interface Work extends LiveRow {
  /** the shekel rate this row was valued at */
  rate: number | null;
  cost: number | null;
  qty: number;
  /** previous value in agorot, for the day change percentage */
  prevIls: number | null;
  dayIls: number | null;
  fxDay: boolean;
}

/** The bank's own row, unchanged. */
function bankRow(r: LiveInputRow): Work {
  const cost = trustedCost(r);
  const priced = cost !== null && finitePos(r.price);
  return {
    id: r.id,
    symbol: r.symbol,
    source: 'bank',
    price: r.price,
    prevClose: null,
    currency: r.currency,
    valueOrig: r.kind === 'currency' ? r.quantity : r.valueOrig,
    valueIls: r.valueIls,
    gainOrig: priced ? round2((r.price! - cost) * r.quantity) : null,
    gainPct: priced ? round2((r.price! / cost - 1) * 100) : null,
    dayChangeOrig: null,
    dayChangePct: r.kind === 'security' ? r.dailyChangePct : null,
    rate: impliedRate(r),
    cost,
    qty: r.quantity,
    prevIls: null,
    dayIls: null,
    fxDay: false,
  };
}

/** The live USD/ILS rate, when fresh and close to what the bank's own rows imply. */
function believableFx(rows: LiveInputRow[], cache: PriceCache, now: number): Quote | null {
  if (!fxIsLive(cache.fx, now)) return null;
  const implied = rows.filter((r) => r.currency === 'USD').map(impliedRate).find((v): v is number => finitePos(v));
  if (implied !== undefined && Math.abs(cache.fx.price / implied - 1) > MAX_FX_DEVIATION) return null;
  return cache.fx;
}

/**
 * The live view of one account's latest snapshot rows. ILS rows convert at 1; USD rows at the live rate when
 * believable, else at their own snapshot-implied rate; other currencies always at their implied rate.
 */
export function computeLiveHoldings(rows: LiveInputRow[], cache: PriceCache, now: number): LiveHoldings {
  const liveFx = believableFx(rows, cache, now);
  const open = usSessionOpen(now);
  const usedTimes: number[] = [];
  let fxUsed = false;

  const work: Work[] = rows.map((r) => {
    const liveRate = r.currency === 'USD' && liveFx ? liveFx.price : null;
    if (r.kind === 'security' && r.currency !== 'ILS') {
      const q = cache.quotes.get(r.symbol);
      const rate = liveRate ?? impliedRate(r);
      const sane = q && (!finitePos(r.price) || Math.abs(q.price / r.price - 1) <= MAX_PRICE_DEVIATION);
      if (q && sane && q.currency === r.currency && quoteIsLive(q, now) && rate !== null && Number.isFinite(r.quantity)) {
        const cost = trustedCost(r);
        const day = q.prevClose !== null ? (q.price - q.prevClose) * r.quantity : null;
        usedTimes.push(q.marketTime);
        if (liveRate !== null) fxUsed = true;
        return {
          id: r.id,
          symbol: r.symbol,
          source: 'live',
          price: q.price,
          prevClose: q.prevClose,
          currency: r.currency,
          valueOrig: round2(q.price * r.quantity),
          valueIls: Math.round(q.price * r.quantity * rate * 100),
          gainOrig: cost !== null ? round2((q.price - cost) * r.quantity) : null,
          gainPct: cost !== null ? round2((q.price / cost - 1) * 100) : null,
          dayChangeOrig: day !== null ? round2(day) : null,
          dayChangePct: q.prevClose !== null ? round2((q.price / q.prevClose - 1) * 100) : null,
          rate,
          cost,
          qty: r.quantity,
          prevIls: q.prevClose !== null ? Math.round(q.prevClose * r.quantity * rate * 100) : null,
          dayIls: day !== null ? Math.round(day * rate * 100) : null,
          fxDay: false,
        };
      }
      return bankRow(r);
    }
    if (r.kind === 'currency' && r.currency === 'USD' && liveFx) {
      const prev = liveFx.prevClose;
      fxUsed = true;
      return {
        id: r.id,
        symbol: r.symbol,
        source: 'live',
        price: round4(liveFx.price),
        prevClose: prev,
        currency: r.currency,
        valueOrig: r.quantity,
        valueIls: Math.round(r.quantity * liveFx.price * 100),
        gainOrig: null,
        gainPct: null,
        dayChangeOrig: null, // the dollars themselves did not change; their shekel value did (dayChangeIls)
        dayChangePct: prev !== null ? round2((liveFx.price / prev - 1) * 100) : null,
        rate: liveFx.price,
        cost: null,
        qty: r.quantity,
        prevIls: prev !== null ? Math.round(r.quantity * prev * 100) : null,
        dayIls: prev !== null ? Math.round(r.quantity * (liveFx.price - prev) * 100) : null,
        fxDay: prev !== null,
      };
    }
    return bankRow(r);
  });

  let gainIls = 0;
  let costIls = 0;
  let gainAny = false;
  let dayIls = 0;
  let prevIls = 0;
  let dayAny = false;
  let dayFx = false;
  for (const w of work) {
    if (w.gainOrig !== null && w.rate !== null && w.cost !== null) {
      gainIls += Math.round(w.gainOrig * w.rate * 100);
      costIls += Math.round(w.cost * w.qty * w.rate * 100);
      gainAny = true;
    }
    if (w.dayIls !== null && w.prevIls !== null) {
      dayIls += w.dayIls;
      prevIls += w.prevIls;
      dayAny = true;
      if (w.fxDay) dayFx = true;
    }
  }
  if (fxUsed && liveFx) usedTimes.push(liveFx.marketTime);
  const out: LiveRow[] = work.map(({ rate: _r, cost: _c, qty: _q, prevIls: _p, dayIls: _d, fxDay: _f, ...plain }) => plain);
  const anyLive = out.some((r) => r.source === 'live');
  const anyQuote = [...cache.quotes.values()].some((q) => quoteIsLive(q, now));
  let marketState: LiveHoldings['marketState'];
  if (!anyLive && !anyQuote && !liveFx) marketState = 'unavailable';
  else if (open && [...cache.quotes.values()].some((q) => quoteIsLive(q, now) && now - q.marketTime <= OPEN_MARKET_TIME_MS)) marketState = 'open';
  else if (open && cache.quotes.size === 0) marketState = 'open'; // an FX-only account: the session clock is all there is
  else marketState = 'closed';

  return {
    asOf: usedTimes.length ? new Date(Math.min(...usedTimes)).toISOString() : null,
    marketState,
    fx: liveFx ? { pair: 'USD/ILS', rate: round4(liveFx.price), at: new Date(liveFx.marketTime).toISOString() } : null,
    rows: out,
    totalIls: out.reduce((a, r) => a + r.valueIls, 0),
    gainIls: gainAny ? gainIls : null,
    gainPct: gainAny && costIls > 0 ? round2((gainIls / costIls) * 100) : null,
    dayChangeIls: dayAny ? dayIls : null,
    dayChangePct: dayAny && prevIls > 0 ? round2((dayIls / prevIls) * 100) : null,
    dayChangeIncludesFx: dayFx,
    gainBasis: 'usd_at_today_rate',
  };
}

/** The latest snapshot's rows of one account, as live-view input. */
export function latestHoldingRows(db: Db, accountId: number): LiveInputRow[] {
  return (
    db.$client
      .prepare(
        `select id, kind, symbol, quantity, price, currency, value_ils valueIls, value_orig valueOrig, cost_price costPrice, daily_change_pct dailyChangePct, from_cost_pct fromCostPct
           from holding_snapshot where account_id = ? and taken_at = (select max(taken_at) from holding_snapshot where account_id = ?) order by value_ils desc, id`,
      )
      .all(accountId, accountId) as LiveInputRow[]
  ).map((r) => ({ ...r, kind: r.kind === 'currency' ? 'currency' : 'security' }));
}

/**
 * Do the latest holdings describe the latest balance? True when they come from the same sync run, or were taken at
 * or after it, or there is no balance at all. A sync whose holdings page failed leaves older holdings behind a newer
 * balance; moving that balance by those holdings' live difference would count the market twice.
 */
export function holdingsMatchBalance(db: Db, accountId: number): boolean {
  const h = db.$client.prepare('select taken_at t, sync_run_id r from holding_snapshot where account_id = ? order by taken_at desc limit 1').get(accountId) as { t: string; r: number | null } | undefined;
  if (!h) return false;
  const b = db.$client.prepare('select taken_at t, sync_run_id r from balance_snapshot where account_id = ? order by taken_at desc limit 1').get(accountId) as { t: string; r: number | null } | undefined;
  if (!b) return true;
  if (h.r !== null && h.r === b.r) return true;
  return h.t >= b.t;
}

/**
 * What the price service fetches: each security symbol (with its currency) in the LATEST snapshot of each account
 * whose snapshot is at most 7 days old, and whether any of them holds dollars. Shekel-priced rows are left out
 * (nothing to fetch), and any symbol that does not pass validSymbol is never sent anywhere.
 */
export function holdingSymbols(db: Db, now: number = Date.now()): { quotes: Array<{ symbol: string; currency: string }>; fx: boolean } {
  const rows = db.$client
    .prepare(
      `select distinct h.kind, h.symbol, h.currency from holding_snapshot h
         where h.taken_at = (select max(taken_at) from holding_snapshot x where x.account_id = h.account_id) and h.taken_at >= ?`,
    )
    .all(new Date(now - HOLDINGS_MAX_AGE_MS).toISOString()) as Array<{ kind: string; symbol: string; currency: string }>;
  const quotes = new Map<string, string>();
  let fx = false;
  for (const r of rows) {
    if (r.currency === 'USD') fx = true;
    if (r.kind !== 'security' || r.currency === 'ILS') continue;
    const sym = r.symbol.trim().toUpperCase();
    if (validSymbol(sym) && sym !== USD_ILS_SYMBOL && /^[A-Z]{3}$/.test(r.currency)) quotes.set(sym, r.currency);
  }
  return { quotes: [...quotes].map(([symbol, currency]) => ({ symbol, currency })).sort((a, b) => a.symbol.localeCompare(b.symbol)), fx };
}

/** liveValueIls / liveAsOf / liveState for the Accounts screen and net worth: only when some of the value is live. */
export interface LiveAccountValue {
  liveValueIls: number;
  liveAsOf: string;
  /** 'live' while the session is open, 'closed' when it is the latest close */
  liveState: 'live' | 'closed';
}

/**
 * The account's live value: its bank balance moved by the difference between the live and the snapshot holdings
 * (the bank's balance may include parts finc has no rows for, such as deposits; those stay as the bank said). With no
 * balance, the live holdings total. Null when nothing is live, or when the holdings do not describe the latest
 * balance (holdingsMatchBalance).
 */
export function liveAccountValue(db: Db, accountId: number, balance: number | null, cache: PriceCache, now: number): LiveAccountValue | null {
  const rows = latestHoldingRows(db, accountId);
  if (!rows.length || !holdingsMatchBalance(db, accountId)) return null;
  const live = computeLiveHoldings(rows, cache, now);
  if (!live.asOf || !live.rows.some((r) => r.source === 'live')) return null;
  const snapshotTotal = rows.reduce((a, r) => a + r.valueIls, 0);
  return { liveValueIls: balance === null ? live.totalIls : balance + (live.totalIls - snapshotTotal), liveAsOf: live.asOf, liveState: live.marketState === 'open' ? 'live' : 'closed' };
}

/** The `live` block of GET /api/accounts/:id/holdings: every row the bank's when the holdings are behind the balance. */
export function accountLiveHoldings(db: Db, accountId: number, cache: PriceCache, now: number): LiveHoldings {
  const rows = latestHoldingRows(db, accountId);
  return computeLiveHoldings(rows, rows.length && holdingsMatchBalance(db, accountId) ? cache : emptyPriceCache(), now);
}
