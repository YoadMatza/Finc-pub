import { describe, expect, it } from 'vitest';
import { ensureAccount } from '../db/accounts.js';
import { openDb } from '../db/db.js';
import { recordBalance } from '../db/runs.js';
import { accountsOverview } from '../hub/accounts.js';
import { holdingsOverview, recordHoldings } from '../hub/holdings.js';
import { netWorthOverview } from '../hub/networth.js';
import { type LiveInputRow, type PriceCache, accountLiveHoldings, computeLiveHoldings, holdingSymbols, holdingsMatchBalance, latestHoldingRows, liveAccountValue, quoteIsLive, trustedCost } from './live.js';
import type { Quote } from './yahoo.js';

const OPEN_NOW = Date.parse('2026-11-11T18:00:00Z'); // Wednesday 13:00 New York
const SAT_NOW = Date.parse('2026-11-14T16:00:00Z'); // Saturday
const FRI_CLOSE = Date.parse('2026-11-13T21:00:00Z');

const quote = (symbol: string, price: number, prevClose: number | null, fetchedAt: number, marketTime = fetchedAt - 30_000, currency = 'USD'): Quote => ({ symbol, price, prevClose, currency, marketTime, marketState: null, exchangeTz: 'America/New_York', fetchedAt });
const cache = (quotes: Quote[], fx: Quote | null = null): PriceCache => ({ quotes: new Map(quotes.map((q) => [q.symbol, q])), fx });
const fxq = (rate: number, prev: number | null, fetchedAt = OPEN_NOW - 60_000, marketTime = fetchedAt): Quote => quote('ILS=X', rate, prev, fetchedAt, marketTime, 'ILS');

// fictional positions: 10 TEST1 bought at $50, bank priced them at $55 (+10%) with a rate of 3.6
const sec = (o: Partial<LiveInputRow> = {}): LiveInputRow => ({ id: 1, kind: 'security', symbol: 'TEST1', quantity: 10, price: 55, currency: 'USD', valueIls: 198_000, valueOrig: 550, costPrice: 50, dailyChangePct: 1.5, fromCostPct: 10, ...o });
const usd = (o: Partial<LiveInputRow> = {}): LiveInputRow => ({ id: 2, kind: 'currency', symbol: 'USD', quantity: 100, price: 3.6, currency: 'USD', valueIls: 36_000, valueOrig: 100, costPrice: null, dailyChangePct: null, fromCostPct: null, ...o });

describe('live holdings', () => {
  it('revalues a security at the live price and rate: value, gain and day change, with header percentages', () => {
    const v = computeLiveHoldings([sec()], cache([quote('TEST1', 60, 58, OPEN_NOW - 60_000)], fxq(3.7, 3.65, OPEN_NOW - 60_000, OPEN_NOW - 90_000)), OPEN_NOW);
    expect(v.marketState).toBe('open');
    expect(v.fx).toEqual({ pair: 'USD/ILS', rate: 3.7, at: new Date(OPEN_NOW - 90_000).toISOString() });
    expect(v.rows[0]).toEqual({ id: 1, symbol: 'TEST1', source: 'live', price: 60, prevClose: 58, currency: 'USD', valueOrig: 600, valueIls: 222_000, gainOrig: 100, gainPct: 20, dayChangeOrig: 20, dayChangePct: 3.45 });
    expect(v).toMatchObject({ totalIls: 222_000, gainIls: 37_000, gainPct: 20, dayChangeIls: 7_400, dayChangePct: 3.45, dayChangeIncludesFx: false, gainBasis: 'usd_at_today_rate' });
    expect(v.asOf).toBe(new Date(OPEN_NOW - 90_000).toISOString()); // the older of the price and the rate
  });

  it('a currency row follows the live rate; its day change is the rate move, flagged in dayChangeIncludesFx', () => {
    const v = computeLiveHoldings([sec(), usd()], cache([quote('TEST1', 60, 58, OPEN_NOW - 60_000)], fxq(3.7, 3.65)), OPEN_NOW);
    expect(v.rows[1]).toEqual({ id: 2, symbol: 'USD', source: 'live', price: 3.7, prevClose: 3.65, currency: 'USD', valueOrig: 100, valueIls: 37_000, gainOrig: null, gainPct: null, dayChangeOrig: null, dayChangePct: 1.37 });
    expect(v.dayChangeIls).toBe(7_400 + 500);
    expect(v.dayChangePct).toBe(Math.round(((7_400 + 500) / (214_600 + 36_500)) * 10_000) / 100);
    expect(v.dayChangeIncludesFx).toBe(true);
    expect(v.gainPct).toBe(20); // the cash row has no gain and no cost basis
  });

  it('without a live rate, a live price converts at the row snapshot-implied rate and fx is null', () => {
    const v = computeLiveHoldings([sec(), usd()], cache([quote('TEST1', 60, null, OPEN_NOW - 60_000)]), OPEN_NOW);
    expect(v.fx).toBeNull();
    expect(v.rows[0]).toMatchObject({ source: 'live', valueIls: 216_000, dayChangeOrig: null, dayChangePct: null }); // 600 × 3.6
    expect(v.rows[1]).toMatchObject({ source: 'bank', valueIls: 36_000, price: 3.6 });
    expect(v).toMatchObject({ totalIls: 252_000, gainIls: 36_000, dayChangeIls: null, dayChangePct: null, dayChangeIncludesFx: false });
  });

  it('a stale rate (over an hour old) or one more than 15% from the bank-implied rate is not used', () => {
    expect(computeLiveHoldings([usd()], cache([], fxq(3.7, 3.65, OPEN_NOW - 61 * 60_000)), OPEN_NOW)).toMatchObject({ fx: null, marketState: 'unavailable', rows: [{ source: 'bank' }] });
    const far = computeLiveHoldings([sec(), usd()], cache([quote('TEST1', 60, 58, OPEN_NOW - 60_000)], fxq(4.2, 4.1)), OPEN_NOW); // 3.6 × 1.167
    expect(far.fx).toBeNull();
    expect(far.rows[0]).toMatchObject({ source: 'live', valueIls: 216_000 });
    expect(far.rows[1]!.source).toBe('bank');
    expect(computeLiveHoldings([usd()], cache([], fxq(4.1, 4.0)), OPEN_NOW).fx).not.toBeNull(); // within 15%
  });

  it('a stale quote (over 5 minutes in session) falls back to the bank row', () => {
    const v = computeLiveHoldings([sec()], cache([quote('TEST1', 60, 58, OPEN_NOW - 6 * 60_000)]), OPEN_NOW);
    expect(v.rows[0]).toEqual({ id: 1, symbol: 'TEST1', source: 'bank', price: 55, prevClose: null, currency: 'USD', valueOrig: 550, valueIls: 198_000, gainOrig: 50, gainPct: 10, dayChangeOrig: null, dayChangePct: 1.5 });
    expect(v).toMatchObject({ marketState: 'unavailable', asOf: null, totalIls: 198_000, gainIls: 18_000, gainPct: 10 });
  });

  it('a live price more than 35% from the bank price (a split, another company) falls back to the bank row', () => {
    expect(computeLiveHoldings([sec()], cache([quote('TEST1', 27.5, 27, OPEN_NOW - 60_000)]), OPEN_NOW).rows[0]!.source).toBe('bank'); // a 2:1 split
    expect(computeLiveHoldings([sec()], cache([quote('TEST1', 75, 74, OPEN_NOW - 60_000)]), OPEN_NOW).rows[0]!.source).toBe('bank');
    expect(computeLiveHoldings([sec()], cache([quote('TEST1', 73, 72, OPEN_NOW - 60_000)]), OPEN_NOW).rows[0]!.source).toBe('live');
  });

  it('the cost price counts only when it reproduces the bank from-cost percentage within half a point', () => {
    expect(trustedCost(sec())).toBe(50);
    expect(trustedCost(sec({ fromCostPct: 10.4 }))).toBe(50);
    expect(trustedCost(sec({ fromCostPct: 11 }))).toBeNull(); // a cost in another unit or currency
    expect(trustedCost(sec({ fromCostPct: null }))).toBe(50);
    expect(trustedCost(sec({ price: null }))).toBeNull();
    const v = computeLiveHoldings([sec({ fromCostPct: 25 })], cache([quote('TEST1', 60, 58, OPEN_NOW - 60_000)]), OPEN_NOW);
    expect(v.rows[0]).toMatchObject({ source: 'live', gainOrig: null, gainPct: null });
    expect(v).toMatchObject({ gainIls: null, gainPct: null });
  });

  it('outside the session the last close counts as live if fetched after it', () => {
    const after = quote('TEST1', 61, 60, FRI_CLOSE + 5 * 60_000, FRI_CLOSE);
    expect(quoteIsLive(after, SAT_NOW)).toBe(true);
    expect(quoteIsLive(quote('TEST1', 61, 60, FRI_CLOSE - 60_000, FRI_CLOSE - 90_000), SAT_NOW)).toBe(false);
    const v = computeLiveHoldings([sec()], cache([after]), SAT_NOW);
    expect(v.marketState).toBe('closed');
    expect(v.rows[0]!.source).toBe('live');
  });

  it('on a weekday holiday the session clock is open but nothing moves: closed', () => {
    const v = computeLiveHoldings([sec()], cache([quote('TEST1', 60, 58, OPEN_NOW - 60_000, OPEN_NOW - 26 * 60 * 60_000)]), OPEN_NOW);
    expect(v.rows[0]!.source).toBe('live');
    expect(v.marketState).toBe('closed');
  });

  it('a quote in another currency is never used; ILS rows convert at 1', () => {
    const v = computeLiveHoldings([sec(), sec({ id: 3, symbol: 'SHEKEL1', currency: 'ILS', price: 12, valueOrig: 120, valueIls: 12_000, costPrice: 10, fromCostPct: 20 })], cache([quote('TEST1', 60, 58, OPEN_NOW - 60_000, OPEN_NOW - 60_000, 'ILA')]), OPEN_NOW);
    expect(v.rows[0]!.source).toBe('bank');
    expect(v.rows[1]).toMatchObject({ id: 3, source: 'bank', valueIls: 12_000, gainOrig: 20 });
    expect(v.gainIls).toBe(18_000 + 2_000); // $50 at 3.6 + ₪20
    expect(v.gainPct).toBe(Math.round(((18_000 + 2_000) / (180_000 + 10_000)) * 10_000) / 100);
  });
});

describe('symbols and account values from the database', () => {
  const T = '2026-11-11T04:00:00.000Z';
  function seed() {
    const db = openDb(':memory:');
    const secAcc = ensureAccount(db, { institutionId: 'beinleumi', institutionKind: 'bank', institutionDisplayName: 'FIBI', source: 'scraper:beinleumi', externalId: 'b-securities', type: 'securities' }).accountId;
    const fxAcc = ensureAccount(db, { institutionId: 'beinleumi', institutionKind: 'bank', institutionDisplayName: 'FIBI', source: 'scraper:beinleumi', externalId: 'b-fx', type: 'foreign_currency' }).accountId;
    const oldAcc = ensureAccount(db, { institutionId: 'beinleumi', institutionKind: 'bank', institutionDisplayName: 'FIBI', source: 'scraper:beinleumi', externalId: 'b-old', type: 'securities' }).accountId;
    const base = { name: 'x', dailyChangePct: null, fromCostPct: null };
    recordHoldings(db, { accountId: secAcc, runId: 6, source: 't', takenAt: '2026-11-10T04:00:00.000Z', rows: [{ ...base, kind: 'security', symbol: 'OLD1', quantity: 1, price: 1, currency: 'USD', valueIls: 360, valueOrig: 1, costPrice: 1 }] });
    recordHoldings(db, {
      accountId: secAcc,
      runId: 7,
      source: 't',
      takenAt: T,
      rows: [
        { ...base, kind: 'security', symbol: 'TEST1', quantity: 10, price: 55, currency: 'USD', valueIls: 198_000, valueOrig: 550, costPrice: 50 },
        { ...base, kind: 'security', symbol: 'נייר', quantity: 1, price: 1, currency: 'USD', valueIls: 360, valueOrig: 1, costPrice: null },
        { ...base, kind: 'security', symbol: 'SHEKEL1', quantity: 1, price: 1, currency: 'ILS', valueIls: 100, valueOrig: 1, costPrice: null },
      ],
    });
    recordHoldings(db, { accountId: fxAcc, runId: 7, source: 't', takenAt: T, rows: [{ ...base, kind: 'currency', symbol: 'USD', quantity: 100, price: 3.6, currency: 'USD', valueIls: 36_000, valueOrig: 100, costPrice: null }] });
    // an account that stopped syncing three weeks ago
    recordHoldings(db, { accountId: oldAcc, runId: 1, source: 't', takenAt: '2026-10-20T04:00:00.000Z', rows: [{ ...base, kind: 'security', symbol: 'GONE1', quantity: 1, price: 1, currency: 'USD', valueIls: 360, valueOrig: 1, costPrice: null }] });
    return { db, secAcc, fxAcc };
  }
  const live = () => cache([quote('TEST1', 60, 58, OPEN_NOW - 60_000)], fxq(3.6, 3.6));

  it('fetches only valid, foreign-priced symbols of latest snapshots at most 7 days old, plus the rate when dollars are held', () => {
    const { db } = seed();
    expect(holdingSymbols(db, OPEN_NOW)).toEqual({ quotes: [{ symbol: 'TEST1', currency: 'USD' }], fx: true });
    expect(holdingSymbols(db, Date.parse('2026-10-21T00:00:00Z')).quotes.map((q) => q.symbol)).toEqual(['GONE1', 'TEST1']);
    expect(holdingSymbols(openDb(':memory:'))).toEqual({ quotes: [], fx: false });
  });

  it('account live value moves the bank balance by the live difference, only when something is live', () => {
    const { db, secAcc, fxAcc } = seed();
    expect(latestHoldingRows(db, secAcc).map((r) => r.symbol)).toEqual(['TEST1', 'נייר', 'SHEKEL1']);
    // the balance includes ₪500 the bank has no rows for (a deposit, say); it stays
    expect(liveAccountValue(db, secAcc, 198_460 + 50_000, live(), OPEN_NOW)).toEqual({ liveValueIls: 198_460 + 50_000 + 18_000, liveAsOf: new Date(OPEN_NOW - 90_000).toISOString(), liveState: 'live' });
    expect(liveAccountValue(db, fxAcc, null, live(), OPEN_NOW)!.liveValueIls).toBe(36_000);
    expect(liveAccountValue(db, secAcc, 1, cache([]), OPEN_NOW)).toBeNull();
    expect(liveAccountValue(db, 999, 1, live(), OPEN_NOW)).toBeNull();
    const closed = cache([quote('TEST1', 60, 58, FRI_CLOSE + 60_000, FRI_CLOSE)]);
    expect(liveAccountValue(db, secAcc, null, closed, SAT_NOW)!.liveState).toBe('closed');
  });

  it('holdings older than the latest balance (a sync whose holdings page failed) get no live value and bank rows', () => {
    const { db, secAcc } = seed();
    recordBalance(db, { accountId: secAcc, runId: 7, balanceMinor: 198_460, takenAt: '2026-11-11T03:59:00.000Z', source: 't' });
    expect(holdingsMatchBalance(db, secAcc)).toBe(true);
    recordBalance(db, { accountId: secAcc, runId: 7, balanceMinor: 198_460, takenAt: '2026-11-11T04:00:30.000Z', source: 't' });
    expect(holdingsMatchBalance(db, secAcc)).toBe(true); // same sync run
    recordBalance(db, { accountId: secAcc, runId: 8, balanceMinor: 210_000, takenAt: '2026-11-11T16:00:00.000Z', source: 't' });
    expect(holdingsMatchBalance(db, secAcc)).toBe(false);
    expect(liveAccountValue(db, secAcc, 210_000, live(), OPEN_NOW)).toBeNull();
    const view = accountLiveHoldings(db, secAcc, live(), OPEN_NOW);
    expect(view.rows.every((r) => r.source === 'bank')).toBe(true);
    expect(view.totalIls).toBe(198_460);
  });

  it('positions and live rows carry the same holding_snapshot id', () => {
    const { db, secAcc } = seed();
    const ids = holdingsOverview(db, secAcc).positions.map((p) => p.id).sort();
    expect(ids).toHaveLength(3);
    expect(accountLiveHoldings(db, secAcc, live(), OPEN_NOW).rows.map((r) => r.id).sort()).toEqual(ids);
  });

  it('accounts and net worth carry liveValueIls/liveAsOf/liveState on those lines only; every total stays on the bank values', () => {
    const { db, secAcc, fxAcc } = seed();
    recordBalance(db, { accountId: secAcc, runId: 7, balanceMinor: 198_460, takenAt: T, source: 't' });
    recordBalance(db, { accountId: fxAcc, runId: 7, balanceMinor: 36_000, takenAt: T, source: 't' });
    const c = cache([quote('TEST1', 60, 58, OPEN_NOW - 60_000)], fxq(3.7, 3.6));
    const opt = { cache: c, now: OPEN_NOW };
    const plain = netWorthOverview(db, { today: '2026-11-11' });
    const nw = netWorthOverview(db, { today: '2026-11-11', live: opt });
    expect(nw.total).toBe(plain.total);
    expect(nw.assets).toBe(plain.assets);
    expect(nw.history).toEqual(plain.history);
    const sl = nw.lines.find((l) => l.accountId === secAcc)!;
    expect(sl).toMatchObject({ value: 198_460, liveValueIls: 222_460, liveAsOf: new Date(OPEN_NOW - 90_000).toISOString(), liveState: 'live' });
    expect(nw.lines.find((l) => l.accountId === fxAcc)).toMatchObject({ value: 36_000, liveValueIls: 37_000, liveState: 'live' });
    expect(plain.lines.every((l) => l.liveValueIls === undefined && l.liveAsOf === undefined && l.liveState === undefined)).toBe(true);
    const acc = accountsOverview(db, { live: opt }).accounts.find((a) => a.id === secAcc)!;
    expect(acc).toMatchObject({ balance: { amount: 198_460 }, liveValueIls: sl.liveValueIls, liveAsOf: sl.liveAsOf, liveState: 'live' });
    expect('liveValueIls' in accountsOverview(db).accounts.find((a) => a.id === secAcc)!).toBe(false);
  });
});
