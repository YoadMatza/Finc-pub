import { describe, expect, it } from 'vitest';
import { ensureAccount, openDb } from '../db/index.js';
import { recordHoldings } from '../hub/holdings.js';
import type { HoldingInsights } from '../insights/panel.js';
import { emptyPriceCache } from '../prices/live.js';
import type { Quote } from '../prices/yahoo.js';
import { PORTFOLIO_DEFINITION, assembleFacts, heldPositions, liveSource, snapshotSource } from './facts.js';
import {
  HoldingRuleError,
  MAX_HOLDING_RULES,
  createHoldingRule,
  deleteHoldingRule,
  evaluateAndStore,
  getHoldingRule,
  heldSymbols,
  listHoldingRules,
  pruneRuleStates,
  rulesApplyingBySymbol,
  rulesForSymbol,
  updateHoldingRule,
} from './store.js';

// Fictional tickers, quantities and prices.
const T0 = Date.parse('2026-11-11T12:32:00Z'); // 14:32 in Jerusalem, 07:32 in New York (US session shut)
const TAKEN = '2026-11-11T04:01:00.000Z'; // 06:01 in Jerusalem
const BANK = { kind: 'bank', date: '2026-11-11', time: '06:01', form: null } as const;

function setup() {
  const db = openDb(':memory:');
  const acc = (externalId: string, type: 'securities' | 'foreign_currency') => ensureAccount(db, { institutionId: 'beinleumi', institutionKind: 'bank', institutionDisplayName: 'FIBI', source: 'scraper:beinleumi', externalId, type }).accountId;
  const a1 = acc('b-sec-1', 'securities');
  const a2 = acc('b-sec-2', 'securities');
  const fx = acc('b-fx', 'foreign_currency');
  const s = (symbol: string, quantity: number, price: number, cost: number | null, valueIls: number) => ({ kind: 'security' as const, symbol, name: `${symbol} Corp`, quantity, price, currency: 'USD', valueIls, valueOrig: quantity * price, costPrice: cost, dailyChangePct: -1.5, fromCostPct: cost ? (price / cost - 1) * 100 : null });
  recordHoldings(db, { accountId: a1, runId: null, source: 't', takenAt: '2026-11-10T04:00:00.000Z', rows: [s('OLDSYM', 1, 10, 10, 3_600)] });
  recordHoldings(db, { accountId: a1, runId: null, source: 't', takenAt: TAKEN, rows: [s('TEST1', 10, 60, 80, 216_000), s('TEST2', 5, 100, 50, 180_000)] });
  recordHoldings(db, { accountId: a2, runId: null, source: 't', takenAt: TAKEN, rows: [s('test1 ', 30, 60, 40, 648_000)] });
  recordHoldings(db, { accountId: fx, runId: null, source: 't', takenAt: TAKEN, rows: [{ kind: 'currency', symbol: 'USD', name: 'Dollar', quantity: 1000, price: 3.6, currency: 'USD', valueIls: 360_000, valueOrig: 1000, costPrice: null, dailyChangePct: null, fromCostPct: null }] });
  const addStale = () => {
    const a3 = acc('b-sec-3', 'securities');
    recordHoldings(db, { accountId: a3, runId: null, source: 't', takenAt: '2026-11-01T04:00:00.000Z', rows: [s('TEST3', 10, 10, 10, 36_000), s('TEST2', 1, 100, 50, 36_000)] });
  };
  return { db, addStale };
}

describe('holding_rule migration', () => {
  it('creates both tables on a fresh database, with the cascade and the composite key', () => {
    const { db } = setup();
    const cols = (t: string) => (db.$client.prepare(`pragma table_info(${t})`).all() as Array<{ name: string; pk: number; notnull: number; dflt_value: string | null }>).map((c) => [c.name, c.pk, c.notnull, c.dflt_value]);
    expect(cols('holding_rule')).toEqual([
      ['id', 1, 1, null],
      ['template', 0, 1, null],
      ['params', 0, 1, null],
      ['scope_symbol', 0, 0, null],
      ['notify', 0, 1, 'false'],
      ['enabled', 0, 1, 'true'],
      ['created_at', 0, 1, null],
      ['updated_at', 0, 1, null],
    ]);
    expect(cols('holding_rule_state')).toEqual([
      ['rule_id', 1, 1, null],
      ['symbol', 2, 1, null],
      ['state', 0, 1, null],
      ['since', 0, 0, null],
      ['last_value', 0, 0, null],
      ['last_known_state', 0, 0, null],
      ['last_known_at', 0, 0, null],
      ['last_evaluated_at', 0, 1, null],
      ['last_notified_at', 0, 0, null],
    ]);
    const fk = db.$client.prepare('pragma foreign_key_list(holding_rule_state)').all() as Array<{ table: string; on_delete: string }>;
    expect(fk).toMatchObject([{ table: 'holding_rule', on_delete: 'CASCADE' }]);
    db.$client.prepare(`insert into holding_rule (template, params, created_at, updated_at) values ('dilution_pct', '{"pct":5}', 'x', 'x')`).run();
    expect(listHoldingRules(db)[0]).toMatchObject({ notify: false, enabled: true, scopeSymbol: null });
    db.$client.prepare(`insert into holding_rule_state (rule_id, symbol, state, last_evaluated_at) values (1, 'TEST1', 'clear', 'x')`).run();
    db.$client.prepare('delete from holding_rule where id = 1').run();
    expect(db.$client.prepare('select count(*) n from holding_rule_state').get()).toEqual({ n: 0 });
  });
});

describe('rule CRUD', () => {
  it('creates, reads, updates and deletes; symbols upper-cased; params validated per template', () => {
    const { db } = setup();
    const r = createHoldingRule(db, { template: 'below_cost_pct', params: { pct: 25 }, scopeSymbol: ' test1' }, T0);
    expect(r).toEqual({ id: 1, template: 'below_cost_pct', params: { pct: 25 }, scopeSymbol: 'TEST1', notify: false, enabled: true, createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString() });
    expect(getHoldingRule(db, 1)).toEqual(r);
    expect(() => createHoldingRule(db, { template: 'below_cost_pct', params: { pct: 0 } })).toThrow(HoldingRuleError);
    expect(() => createHoldingRule(db, { template: 'nope', params: {} })).toThrow('unknown template');
    const u = updateHoldingRule(db, 1, { params: { pct: 30 }, notify: true }, T0 + 1000);
    expect(u).toMatchObject({ params: { pct: 30 }, notify: true, scopeSymbol: 'TEST1', updatedAt: new Date(T0 + 1000).toISOString(), createdAt: new Date(T0).toISOString() });
    expect(updateHoldingRule(db, 1, { scopeSymbol: null }).scopeSymbol).toBeNull();
    expect(() => updateHoldingRule(db, 1, { template: 'pe_above' })).toThrow('a new template needs its params');
    expect(() => updateHoldingRule(db, 1, { params: { x: 40 } })).toThrow('unknown param x');
    expect(updateHoldingRule(db, 1, { template: 'pe_above', params: { x: 40 } })).toMatchObject({ template: 'pe_above', params: { x: 40 } });
    expect(() => updateHoldingRule(db, 99, { notify: true })).toThrow('no such rule');
    expect(deleteHoldingRule(db, 1)).toBe(true);
    expect(deleteHoldingRule(db, 1)).toBe(false);
    expect(listHoldingRules(db)).toEqual([]);
  });

  it('holds at most 100 rules', () => {
    const { db } = setup();
    for (let i = 0; i < MAX_HOLDING_RULES; i++) createHoldingRule(db, { template: 'dilution_pct', params: { pct: 5 } });
    expect(() => createHoldingRule(db, { template: 'dilution_pct', params: { pct: 5 } })).toThrow(expect.objectContaining({ code: 'too_many' }));
    expect(listHoldingRules(db)).toHaveLength(MAX_HOLDING_RULES);
  });

  it('a change of numbers, scope or template, or disabling, forgets the stored states; notify alone does not', () => {
    const { db } = setup();
    const r = createHoldingRule(db, { template: 'dilution_pct', params: { pct: 5 } });
    const store = () => evaluateAndStore(db, 'TEST1', { sharesChange1yPct: { value: 6, source: BANK } }, T0);
    const n = () => (db.$client.prepare('select count(*) n from holding_rule_state').get() as { n: number }).n;
    store();
    expect(n()).toBe(1);
    updateHoldingRule(db, r.id, { notify: true });
    updateHoldingRule(db, r.id, { params: { pct: 5 } }); // same numbers
    updateHoldingRule(db, r.id, { enabled: true });
    expect(n()).toBe(1);
    updateHoldingRule(db, r.id, { params: { pct: 6 } });
    expect(n()).toBe(0);
    store();
    updateHoldingRule(db, r.id, { scopeSymbol: 'TEST2' });
    expect(n()).toBe(0);
    updateHoldingRule(db, r.id, { scopeSymbol: null });
    store();
    updateHoldingRule(db, r.id, { enabled: false });
    expect(n()).toBe(0);
  });
});

describe('held symbols and positions', () => {
  it('lists the securities of each account’s latest snapshot, upper-cased and distinct', () => {
    expect(heldSymbols(setup().db)).toEqual(['TEST1', 'TEST2']);
  });

  it('aggregates a symbol over both accounts: weighted cost dated with the bank snapshot, summed value, the largest row’s price; no bank day change', () => {
    const { db } = setup();
    const h = heldPositions(db, emptyPriceCache(), T0);
    expect(h.portfolioIls).toBe(216_000 + 180_000 + 648_000 + 360_000);
    expect(h.portfolioSource).toEqual(BANK);
    const p = h.positions.get('TEST1')!;
    expect(p).toMatchObject({ symbol: 'TEST1', currency: 'USD', bankPrice: 60, takenAt: TAKEN, costPrice: { value: (10 * 80 + 30 * 40) / 40, source: BANK }, price: { value: 60, source: BANK }, dayChangePct: null, valueIls: { value: 864_000 } });
    expect(p.rowId).toBe((db.$client.prepare(`select id from holding_snapshot where symbol = 'test1 '`).get() as { id: number }).id);
    expect([...h.positions.keys()].sort()).toEqual(['TEST1', 'TEST2']);
  });

  it('the portfolio counts only accounts synced in the last 7 days; a stale account’s rows leave the position value too', () => {
    const { db, addStale } = setup();
    addStale();
    const h = heldPositions(db, emptyPriceCache(), T0);
    expect(h.portfolioIls).toBe(216_000 + 180_000 + 648_000 + 360_000);
    expect(h.positions.get('TEST2')!.valueIls!.value).toBe(180_000);
    expect(h.positions.get('TEST3')!.valueIls).toBeNull();
    expect(h.positions.get('TEST3')!.costPrice).toMatchObject({ value: 10 }); // still held: its other rules work
    expect(PORTFOLIO_DEFINITION).toEqual({ includes: ['securities', 'foreign_currency_cash'], maxSnapshotAgeDays: 7 });
  });

  it('a live quote gives the price and the day change dated with its US session; the portfolio source says mixed', () => {
    const { db } = setup();
    const q: Quote = { symbol: 'TEST2', price: 105, prevClose: 100, currency: 'USD', marketTime: Date.parse('2026-11-10T21:00:00Z'), marketState: 'CLOSED', exchangeTz: 'America/New_York', fetchedAt: T0 - 30_000 };
    const h = heldPositions(db, { quotes: new Map([['TEST2', q]]), fx: null }, T0);
    const live = { kind: 'live', date: '2026-11-10', time: '23:00', form: null };
    expect(h.positions.get('TEST2')).toMatchObject({ price: { value: 105, source: live }, dayChangePct: { value: 5, source: live }, costPrice: { value: 50, source: BANK } });
    expect(h.portfolioSource).toEqual({ ...BANK, kind: 'holdings' });
  });

  it('cost unknown when a row has no checked cost', () => {
    const { db } = setup();
    db.$client.prepare(`update holding_snapshot set cost_price = null where symbol = 'test1 '`).run();
    expect(heldPositions(db, emptyPriceCache(), T0).positions.get('TEST1')!.costPrice).toBeNull();
  });

  it('sources: Israel date and time; a live quote carries its New York session date', () => {
    expect(snapshotSource('bank', Date.parse('2026-11-09T04:01:00Z'))).toEqual({ kind: 'bank', date: '2026-11-09', time: '06:01', form: null });
    // 23:30 in New York on the 10th is 06:30 on the 11th in Jerusalem
    expect(liveSource(Date.parse('2026-11-11T04:30:00Z'))).toEqual({ kind: 'live', date: '2026-11-10', time: '06:30', form: null });
  });
});

const YAHOO = { kind: 'yahoo', date: '2026-11-10', time: null, form: null };
const FINN = { kind: 'finnhub', date: '2026-11-11', time: null, form: null };
const insights = (over: Partial<HoldingInsights> = {}): HoldingInsights =>
  ({
    asOf: '2026-11-10',
    trend: { daysAboveSma200: -41, daysAboveSma200IsLowerBound: true, fromHigh52Pct: -27.5 },
    returns: { m1: -12, m3: -3, m6: null, y1: 4, y3Ann: null },
    benchmark: { symbol: 'SPY', returns: {}, diffPts: { m1: null, m3: null, m6: null, y1: -16.2, y3Ann: null } },
    series: [
      { d: '2026-11-09', c: 50, sma50: null, sma200: null },
      { d: '2026-11-10', c: 47, sma50: null, sma200: null },
    ],
    company: {
      figures: {
        pe: { value: 46, unit: 'x', periodEnd: '2026-09-30', basis: 'derived', form: '10-Q', filed: '2026-10-31', accn: 'a' },
        revenueYoYPct: { value: -2, unit: '%', periodEnd: '2026-09-30', basis: 'ttm', form: '10-Q', filed: '2026-10-31', accn: 'a' },
        netMarginPct: { value: 10, unit: '%', periodEnd: '2026-09-30', basis: 'ttm', form: null, filed: null, accn: null },
        netMarginPct1yAgo: null,
        sharesChange1yPct: { value: 3, unit: '%', periodEnd: '2026-10-20', basis: 'instant', form: '10-Q', filed: '2026-10-31', accn: 'a' },
      },
    },
    // Part B (Finnhub): fetched 00:30 on the 11th in Jerusalem (22:30Z on the 10th)
    analysts: { buyShareChange3mPts: -12.5, fetchedAt: '2026-11-10T22:30:00.000Z' },
    earnings: { next: { date: '2026-11-13', hour: 'amc', epsEstimate: 1.2 }, last: null, fetchedAt: '2026-11-10T22:30:00.000Z' },
    ...over,
  }) as unknown as HoldingInsights;

describe('assembleFacts', () => {
  it('takes the trend (with the lower-bound flag), returns, benchmark and company figures with their sources', () => {
    const f = assembleFacts({ position: null, portfolio: null, insights: insights() });
    const sec = (date: string, form: string | null) => ({ kind: 'sec', date, time: null, form });
    expect(f).toEqual({
      daysAboveSma200: { value: -41, source: YAHOO, lowerBound: true },
      fromHigh52Pct: { value: -27.5, source: YAHOO },
      returnM1: { value: -12, source: YAHOO },
      returnM3: { value: -3, source: YAHOO },
      spyDiffY1: { value: -16.2, source: YAHOO },
      pe: { value: 46, source: sec('2026-10-31', '10-Q') },
      revenueYoYPct: { value: -2, source: sec('2026-10-31', '10-Q') },
      netMarginPct: { value: 10, source: sec('2026-09-30', null) },
      netMarginPct1yAgo: null,
      sharesChange1yPct: { value: 3, source: sec('2026-10-31', '10-Q') },
      buyShareChange3mPts: { value: -12.5, source: FINN },
      earningsDays: null, // days need `now`
    });
  });

  it('Part B: the analysts’ 3-month change and the days to the next earnings (Israel date), dated with Finnhub’s answer', () => {
    // T0 is the 11th in Jerusalem: the 13th is 2 days away
    expect(assembleFacts({ position: null, portfolio: null, insights: insights(), now: T0 })).toMatchObject({ buyShareChange3mPts: { value: -12.5, source: FINN }, earningsDays: { value: 2, source: FINN } });
    // 22:30Z on the 12th is already the 13th in Jerusalem: today (0)
    expect(assembleFacts({ position: null, portfolio: null, insights: insights(), now: Date.parse('2026-11-12T22:30:00Z') }).earningsDays).toEqual({ value: 0, source: FINN });
    // a date that has passed (a stale cache), no next date, no analysts' change, no sections: unknown
    expect(assembleFacts({ position: null, portfolio: null, insights: insights(), now: Date.parse('2026-11-14T12:00:00Z') }).earningsDays).toBeNull();
    const none = assembleFacts({ position: null, portfolio: null, insights: insights({ analysts: { buyShareChange3mPts: null, fetchedAt: '2026-11-10T22:30:00.000Z' }, earnings: { next: null, last: null, fetchedAt: '2026-11-10T22:30:00.000Z' } } as unknown as Partial<HoldingInsights>), now: T0 });
    // Finnhub answered with no report in its window: a known 'none within 120 days' (the rule is clear, value null)
    expect(none).toMatchObject({ buyShareChange3mPts: null, earningsDays: { value: 120, source: FINN, noneWithin: true } });
    expect(assembleFacts({ position: null, portfolio: null, insights: insights({ analysts: null, earnings: null }), now: T0 })).toMatchObject({ buyShareChange3mPts: null, earningsDays: null });
  });

  it('day change without a live quote: the history’s last session only after the close and only when it is the latest completed session', () => {
    // 14:32 Jerusalem on Wednesday the 11th: New York shut, the latest completed session is Tuesday the 10th
    expect(assembleFacts({ position: null, portfolio: null, insights: insights(), now: T0 }).dayChangePct).toEqual({ value: expect.closeTo(-6, 9), source: YAHOO });
    // an older history (last session the 9th) is not today's move
    expect(assembleFacts({ position: null, portfolio: null, insights: insights({ asOf: '2026-11-09' }), now: T0 }).dayChangePct).toBeNull();
    // during the session (16:00 New York): no live quote → unknown
    expect(assembleFacts({ position: null, portfolio: null, insights: insights(), now: Date.parse('2026-11-11T21:00:00Z') }).dayChangePct).toBeNull();
    // a live quote wins
    const { db } = setup();
    const q: Quote = { symbol: 'TEST2', price: 105, prevClose: 100, currency: 'USD', marketTime: Date.parse('2026-11-10T21:00:00Z'), marketState: 'CLOSED', exchangeTz: 'America/New_York', fetchedAt: T0 - 30_000 };
    const h = heldPositions(db, { quotes: new Map([['TEST2', q]]), fx: null }, T0);
    expect(assembleFacts({ position: h.positions.get('TEST2')!, portfolio: h, insights: insights(), now: T0 }).dayChangePct).toMatchObject({ value: 5, source: { kind: 'live' } });
  });

  it('an unavailable panel gives no Yahoo facts; no benchmark gives no SPY fact; the position gives cost, price, value', () => {
    const { db } = setup();
    const h = heldPositions(db, emptyPriceCache(), T0);
    const f = assembleFacts({ position: h.positions.get('TEST2')!, portfolio: h, insights: insights({ unavailable: 'x', company: null } as Partial<HoldingInsights>), now: T0 });
    expect(f).toEqual({
      costPrice: { value: 50, source: BANK },
      price: { value: 100, source: BANK },
      dayChangePct: null,
      valueIls: { value: 180_000, source: BANK },
      portfolioIls: { value: 1_404_000, source: BANK },
      // Finnhub is independent of Yahoo: still read from an unavailable panel
      buyShareChange3mPts: { value: -12.5, source: FINN },
      earningsDays: { value: 2, source: FINN },
    });
    expect(assembleFacts({ position: null, portfolio: null, insights: insights({ benchmark: null, company: null }) }).spyDiffY1).toBeNull();
  });
});

describe('evaluateAndStore, prune, counts', () => {
  it('stores the raw state; an unknown run keeps since and the last known state; a known clear resets since', () => {
    const { db } = setup();
    const all = createHoldingRule(db, { template: 'below_cost_pct', params: { pct: 20 } });
    const only2 = createHoldingRule(db, { template: 'dilution_pct', params: { pct: 5 }, scopeSymbol: 'TEST2' });
    createHoldingRule(db, { template: 'pe_above', params: { x: 40 }, enabled: false });
    expect(rulesForSymbol(db, 'test1').map((r) => r.id)).toEqual([all.id]);
    expect(rulesForSymbol(db, 'TEST2').map((r) => r.id)).toEqual([all.id, only2.id]);
    const live = { kind: 'live', date: '2026-11-10', time: '23:00', form: null } as const;
    const facts = (price: number) => ({ costPrice: { value: 100, source: BANK }, price: { value: price, source: live } });
    const iso = (dt: number) => new Date(T0 + dt).toISOString();
    expect(evaluateAndStore(db, 'TEST1', facts(75), T0)).toEqual([
      { ruleId: all.id, template: 'below_cost_pct', params: { pct: 20 }, scopeSymbol: null, state: 'applies', value: 25, source: live, costAsOf: '2026-11-11', since: iso(0), lastKnownState: 'applies', lastKnownAt: iso(0) },
    ]);
    expect(rulesApplyingBySymbol(db)).toEqual(new Map([['TEST1', 1]]));
    // unknown: the history stays, the badge does not count it
    expect(evaluateAndStore(db, 'TEST1', {}, T0 + 60_000)[0]).toMatchObject({ state: 'unknown', value: null, source: null, since: iso(0), lastKnownState: 'applies', lastKnownAt: iso(0) });
    expect(db.$client.prepare('select * from holding_rule_state').get()).toEqual({ rule_id: all.id, symbol: 'TEST1', state: 'unknown', since: iso(0), last_value: 25, last_known_state: 'applies', last_known_at: iso(0), last_evaluated_at: iso(60_000), last_notified_at: null });
    expect(rulesApplyingBySymbol(db)).toEqual(new Map());
    // applies again after the unknown: the same `since`
    expect(evaluateAndStore(db, 'TEST1', facts(78), T0 + 120_000)[0]).toMatchObject({ state: 'applies', value: 22, since: iso(0), lastKnownAt: iso(120_000) });
    // 19.9% below: raw clear at once (no hysteresis), since reset
    expect(evaluateAndStore(db, 'TEST1', facts(80.1), T0 + 180_000)[0]).toMatchObject({ state: 'clear', value: 19.9, since: null, lastKnownState: 'clear' });
    expect(evaluateAndStore(db, 'TEST1', {}, T0 + 240_000)[0]).toMatchObject({ state: 'unknown', since: null, lastKnownState: 'clear', lastKnownAt: iso(180_000) });
    expect(evaluateAndStore(db, 'TEST1', facts(70), T0 + 300_000)[0]).toMatchObject({ state: 'applies', since: iso(300_000) });
  });

  it('no rules for a symbol: nothing stored', () => {
    const { db } = setup();
    expect(evaluateAndStore(db, 'TEST1', {}, T0)).toEqual([]);
  });

  it('counts only enabled rules of a known template whose scope matches; prunes gone symbols, disabled and re-scoped rules', () => {
    const { db } = setup();
    const r1 = createHoldingRule(db, { template: 'dilution_pct', params: { pct: 5 } });
    const r2 = createHoldingRule(db, { template: 'pe_above', params: { x: 40 } });
    const facts = { sharesChange1yPct: { value: 9, source: BANK }, pe: { value: 50, source: BANK } };
    evaluateAndStore(db, 'TEST1', facts, T0);
    evaluateAndStore(db, 'TEST2', facts, T0);
    evaluateAndStore(db, 'GONE', facts, T0);
    expect(rulesApplyingBySymbol(db)).toEqual(new Map([['TEST1', 2], ['TEST2', 2], ['GONE', 2]]));
    // a template this version does not know is not counted
    db.$client.prepare(`update holding_rule set template = 'retired_template' where id = ?`).run(r2.id);
    expect(rulesApplyingBySymbol(db)).toEqual(new Map([['TEST1', 1], ['TEST2', 1], ['GONE', 1]]));
    db.$client.prepare(`update holding_rule set template = 'pe_above' where id = ?`).run(r2.id);
    // stale rows written behind the store's back (a disabled rule, a re-scoped rule) are neither counted nor kept
    db.$client.prepare('update holding_rule set enabled = 0 where id = ?').run(r2.id);
    db.$client.prepare(`update holding_rule set scope_symbol = 'TEST2' where id = ?`).run(r1.id);
    expect(rulesApplyingBySymbol(db)).toEqual(new Map([['TEST2', 1]]));
    expect(pruneRuleStates(db)).toBe(5);
    expect(db.$client.prepare('select rule_id r, symbol s from holding_rule_state').all()).toEqual([{ r: r1.id, s: 'TEST2' }]);
    expect(pruneRuleStates(db)).toBe(0);
  });
});
