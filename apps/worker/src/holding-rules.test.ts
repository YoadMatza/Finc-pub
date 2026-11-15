import { type HoldingInsights, type InsightsRow, createHoldingRule, ensureAccount, evaluateAndStore, openDb, recordHoldings } from '@finc/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The holding-rules service (daily / after-sync / after-edit runs). The panel builder is mocked: no Yahoo, no SEC.
// Fictional tickers and values.
const buildPanel = vi.hoisted(() => vi.fn());
vi.mock('./insights-panel.js', () => ({ buildPanel }));
const { HoldingRulesService, RULES_GAP_MS } = await import('./holding-rules.js');

const T0 = Date.parse('2026-11-11T20:29:30Z'); // 22:29:30 in Jerusalem (winter, UTC+2)
const TAKEN = '2026-11-11T04:01:00.000Z';
const quiet = { info: vi.fn(), warn: vi.fn() };

const panel = (row: InsightsRow, over: Partial<HoldingInsights> = {}): HoldingInsights =>
  ({ id: row.id, symbol: row.symbol, asOf: '2026-11-10', trend: { daysAboveSma200: -41, fromHigh52Pct: -30 }, returns: { m1: -12, m3: -20, m6: null, y1: null, y3Ann: null }, benchmark: null, company: null, ...over }) as unknown as HoldingInsights;

function setup() {
  const db = openDb(':memory:');
  const a = ensureAccount(db, { institutionId: 'beinleumi', institutionKind: 'bank', institutionDisplayName: 'FIBI', source: 'scraper:beinleumi', externalId: 'b-sec', type: 'securities' }).accountId;
  const s = (symbol: string, price: number, cost: number) => ({ kind: 'security' as const, symbol, name: `${symbol} Corp`, quantity: 10, price, currency: 'USD', valueIls: Math.round(price * 10 * 360), valueOrig: price * 10, costPrice: cost, dailyChangePct: 0.4, fromCostPct: (price / cost - 1) * 100 });
  recordHoldings(db, { accountId: a, runId: null, source: 't', takenAt: TAKEN, rows: [s('TEST1', 60, 80), s('TEST2', 100, 50), s('TEST3', 10, 10)] });
  const clock = { t: T0 };
  const svc = new HoldingRulesService({ db, panel: () => ({}), now: () => clock.t, log: quiet });
  const states = () => db.$client.prepare('select rule_id r, symbol s, state, last_value v from holding_rule_state order by rule_id, symbol').all();
  return { db, svc, clock, states };
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  buildPanel.mockReset();
  buildPanel.mockImplementation(async (_deps: unknown, row: InsightsRow) => panel(row));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('HoldingRulesService.runAll', () => {
  it('evaluates every held security with rules, one panel after another with a pause, and stores the states', async () => {
    const { db, svc, states } = setup();
    const cost = createHoldingRule(db, { template: 'below_cost_pct', params: { pct: 20 } }); // holdings data only
    const trend = createHoldingRule(db, { template: 'below_sma200_sessions', params: { n: 20 }, scopeSymbol: 'TEST2' });
    const drop = createHoldingRule(db, { template: 'drop_1m_pct', params: { pct: 10 }, scopeSymbol: 'TEST3' });
    const run = svc.runAll('daily');
    await vi.advanceTimersByTimeAsync(0);
    expect(buildPanel).toHaveBeenCalledTimes(1); // TEST2 (TEST1 needs no panel)
    expect(buildPanel.mock.calls[0]![1]).toEqual({ id: expect.any(Number), symbol: 'TEST2', name: 'TEST2 Corp', currency: 'USD', price: 100, takenAt: TAKEN });
    await vi.advanceTimersByTimeAsync(RULES_GAP_MS - 1);
    expect(buildPanel).toHaveBeenCalledTimes(1); // the pause between two panels
    await vi.advanceTimersByTimeAsync(1);
    expect(buildPanel).toHaveBeenCalledTimes(2);
    expect(await run).toEqual({ symbols: 3, evaluated: 3, panels: 2, failed: 0, pruned: 0 });
    expect(states()).toEqual([
      { r: cost.id, s: 'TEST1', state: 'applies', v: 25 },
      { r: cost.id, s: 'TEST2', state: 'clear', v: -100 },
      { r: cost.id, s: 'TEST3', state: 'clear', v: 0 },
      { r: trend.id, s: 'TEST2', state: 'applies', v: 41 },
      { r: drop.id, s: 'TEST3', state: 'applies', v: 12 },
    ]);
    expect(JSON.stringify(quiet.info.mock.calls)).not.toMatch(/TEST/); // counts only in the log
  });

  it('a holding without rules builds no panel; a failing panel is counted and the run goes on', async () => {
    const { db, svc, states } = setup();
    const r = createHoldingRule(db, { template: 'from_high52_pct', params: { pct: 25 } });
    buildPanel.mockImplementation(async (_d: unknown, row: InsightsRow) => {
      if (row.symbol === 'TEST1') throw new Error('boom');
      return panel(row, row.symbol === 'TEST3' ? ({ unavailable: 'x', asOf: null } as Partial<HoldingInsights>) : {});
    });
    const run = svc.runAll();
    await vi.runAllTimersAsync();
    expect(await run).toMatchObject({ evaluated: 2, failed: 1, panels: 2 });
    expect(states()).toEqual([
      { r: r.id, s: 'TEST2', state: 'applies', v: 30 },
      { r: r.id, s: 'TEST3', state: 'unknown', v: null }, // an unavailable panel: unknown, never clear
    ]);
  });

  it('nothing to do without rules: no panel at all', async () => {
    const { svc } = setup();
    expect(await svc.runAll()).toEqual({ symbols: 3, evaluated: 0, panels: 0, failed: 0, pruned: 0 });
    expect(buildPanel).not.toHaveBeenCalled();
  });

  it('prunes the states of symbols no longer held', async () => {
    const { db, svc, states } = setup();
    const r = createHoldingRule(db, { template: 'dilution_pct', params: { pct: 5 }, enabled: true });
    evaluateAndStore(db, 'SOLD', { sharesChange1yPct: { value: 9, source: 'S' } }, T0);
    const run = svc.runAll();
    await vi.runAllTimersAsync();
    expect((await run).pruned).toBe(1);
    expect(states()).toEqual(['TEST1', 'TEST2', 'TEST3'].map((s) => ({ r: r.id, s, state: 'unknown', v: null })));
  });

  it('one run at a time: a run asked for meanwhile runs once more after it', async () => {
    const { db, svc } = setup();
    createHoldingRule(db, { template: 'drop_1m_pct', params: { pct: 10 }, scopeSymbol: 'TEST1' });
    let release!: () => void;
    buildPanel.mockImplementationOnce(async (_d: unknown, row: InsightsRow) => {
      await new Promise<void>((res) => (release = res));
      return panel(row);
    });
    const a = svc.runAll('daily');
    await vi.advanceTimersByTimeAsync(0);
    const b = svc.runAll('sync');
    const c = svc.runAll('sync');
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(buildPanel).toHaveBeenCalledTimes(1);
    release();
    await vi.runAllTimersAsync();
    await a;
    expect(buildPanel).toHaveBeenCalledTimes(2); // the first run, then exactly one more
  });
});

describe('HoldingRulesService timing', () => {
  it('runs daily at 23:30 Israel time', async () => {
    const { db, svc } = setup();
    createHoldingRule(db, { template: 'drop_1m_pct', params: { pct: 10 }, scopeSymbol: 'TEST1' });
    svc.start();
    await vi.advanceTimersByTimeAsync(60 * 60_000 + 29_000); // 23:29:59
    expect(buildPanel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000); // 23:30:01
    expect(buildPanel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(23 * 60 * 60_000);
    expect(buildPanel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * 60_000); // the next day's 23:30
    expect(buildPanel).toHaveBeenCalledTimes(2);
    svc.stop();
    await vi.advanceTimersByTimeAsync(48 * 60 * 60_000);
    expect(buildPanel).toHaveBeenCalledTimes(2);
  });

  it('evaluateSymbols: only the symbols asked for (null = all held), no pause, no prune; not-held symbols ignored', async () => {
    const { db, svc, states } = setup();
    const r = createHoldingRule(db, { template: 'drop_1m_pct', params: { pct: 10 } });
    evaluateAndStore(db, 'SOLD', { returnM1: { value: -20, source: { kind: 'yahoo', date: '2026-11-10', time: null, form: null } } }, T0);
    expect(await svc.evaluateSymbols(['test2', 'NOTHELD'])).toBe(1);
    expect(buildPanel).toHaveBeenCalledTimes(1);
    expect(await svc.evaluateSymbols(null)).toBe(3); // no timers needed: no pause between panels
    expect(buildPanel).toHaveBeenCalledTimes(4);
    expect(states()).toEqual(['SOLD', 'TEST1', 'TEST2', 'TEST3'].map((x) => ({ r: r.id, s: x, state: 'applies', v: x === 'SOLD' ? 20 : 12 })));
  });
});
