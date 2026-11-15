import { type FetchFn, MAX_HOLDING_RULES, createHoldingRule, ensureAccount, listSecurityEvents, openDb, recordHoldings } from '@finc/core';
import { describe, expect, it, vi } from 'vitest';
import { HoldingRulesService } from '../holding-rules.js';
import { InsightsService } from '../insights.js';
import type { WorkerState } from '../server.js';
import { HOLDING_RULES_OUTSIDE_PER_HOUR, createApp } from './app.js';

// /api/holding-rules, the insights panel's `rules` and the holdings' `rulesApplying` (stock-decision-aids.md, Part A
// step 1). Fictional symbols, quantities and prices; no network.

const TOKEN = 'e'.repeat(64);
const HOME = { authorization: `Bearer ${TOKEN}` };
const EDGE = { 'x-finc-edge': 'public', 'x-forwarded-for': '198.51.100.52', 'x-forwarded-proto': 'https' };
const T0 = Date.parse('2026-11-11T08:00:00Z'); // 10:00 in Jerusalem
const LATEST = '2026-11-11T04:00:00.000Z'; // 06:00 in Jerusalem

/** 300 weekday bars ending on Tuesday 2026-11-10, the last close 55 */
function body(symbol: string): unknown {
  const ts: number[] = [];
  for (let t = Date.parse('2026-11-10T14:30:00Z'); ts.length < 300; t -= 86_400_000) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) ts.unshift(t / 1000);
  }
  const close = ts.map((_, i) => (i === ts.length - 1 ? 55 : 50 + (i % 5)));
  return { chart: { result: [{ meta: { symbol, instrumentType: symbol === 'SPY' ? 'ETF' : 'EQUITY', currency: 'USD', exchangeTimezoneName: 'America/New_York' }, timestamp: ts, events: {}, indicators: { quote: [{ close }], adjclose: [{ adjclose: close }] } }], error: null } };
}

function setup() {
  const db = openDb(':memory:');
  const acc = ensureAccount(db, { institutionId: 'beinleumi', institutionKind: 'bank', institutionDisplayName: 'FIBI', source: 'scraper:beinleumi', externalId: 'b-securities', type: 'securities' }).accountId;
  const fx = ensureAccount(db, { institutionId: 'beinleumi', institutionKind: 'bank', institutionDisplayName: 'FIBI', source: 'scraper:beinleumi', externalId: 'b-fx', type: 'foreign_currency' }).accountId;
  const sRow = (symbol: string, price: number, valueIls: number) => ({ kind: 'security' as const, symbol, name: `${symbol} Corp`, quantity: 12, price, currency: 'USD', valueIls, valueOrig: 12 * price, costPrice: 50, dailyChangePct: 0.5, fromCostPct: (price / 50 - 1) * 100 });
  recordHoldings(db, { accountId: acc, runId: null, source: 't', takenAt: LATEST, rows: [sRow('TEST1', 55, 237_600), sRow('TEST2', 40, 172_800)] });
  recordHoldings(db, { accountId: fx, runId: null, source: 't', takenAt: LATEST, rows: [{ kind: 'currency', symbol: 'USD', name: 'Dollar', quantity: 100, price: 3.6, currency: 'USD', valueIls: 36_000, valueOrig: 100, costPrice: null, dailyChangePct: null, fromCostPct: null }] });
  const ids = db.$client.prepare('select id, symbol from holding_snapshot').all() as Array<{ id: number; symbol: string }>;
  const id = (symbol: string) => ids.find((r) => r.symbol === symbol)!.id;
  const f = vi.fn<FetchFn>(async (url) => new Response(JSON.stringify(body(decodeURIComponent(url.split('/chart/')[1]!.split('?')[0]!))), { status: 200 }));
  const clock = { t: T0 };
  const quiet = { debug() {}, info() {}, warn() {} };
  const insights = new InsightsService({ fetch: f, now: () => clock.t, log: quiet });
  const evaluateSymbols = vi.fn(async (_s: readonly string[] | null) => 0);
  const state: WorkerState = { db, vault: null, scheduler: { config: { times: [], jitterMinutes: 0, timezone: 'UTC', monthsBack: 3 }, isRunning: false, nextRun: () => null } as never, startedAt: T0, insights, holdingRules: { evaluateSymbols } };
  const { app } = createApp(state, { controlToken: TOKEN, webDist: '/nonexistent', now: () => clock.t });
  const call = async (method: string, path: string, headers: Record<string, string> = HOME, b?: unknown) => {
    const res = await app.request(path, { method, headers: { ...(b !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, ...(b !== undefined ? { body: JSON.stringify(b) } : {}) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any>, headers: res.headers };
  };
  const pair = async (name: string): Promise<Record<string, string>> => {
    const code = (await call('POST', '/api/devices/pairings', HOME, { name })).body.code as string;
    const r = await call('POST', '/api/devices/pair', EDGE, { code });
    return { ...EDGE, authorization: `Bearer ${r.body.token as string}` };
  };
  const events = (kind: string) => listSecurityEvents(db, { kind, limit: 200 }).events;
  return { db, acc, id, f, clock, call, pair, events, evaluateSymbols, state, insights };
}

describe('/api/holding-rules', () => {
  it('needs a signed-in caller', async () => {
    const env = setup();
    expect((await env.call('GET', '/api/holding-rules', {})).status).toBe(401);
    expect((await env.call('POST', '/api/holding-rules', {}, { template: 'dilution_pct', params: { pct: 5 } })).status).toBe(401);
    expect((await env.call('PATCH', '/api/holding-rules/1', {}, { notify: true })).status).toBe(401);
    expect((await env.call('DELETE', '/api/holding-rules/1', {})).status).toBe(401);
  });

  it('GET: the rules, the templates and the held symbols', async () => {
    const env = setup();
    const r = await env.call('GET', '/api/holding-rules');
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['portfolioDefinition', 'rules', 'symbols', 'templates']);
    expect(r.body.portfolioDefinition).toEqual({ includes: ['securities', 'foreign_currency_cash'], maxSnapshotAgeDays: 7 });
    expect(r.body.rules).toEqual([]);
    expect(r.body.symbols).toEqual(['TEST1', 'TEST2']);
    expect(r.body.templates).toHaveLength(18);
    expect(r.body.templates.at(-1)).toEqual({ id: 'earnings_within_days', params: [{ key: 'n', kind: 'int', min: 1, max: 60, default: 7 }] });
    expect(r.body.templates[0]).toEqual({ id: 'below_cost_pct', params: [{ key: 'pct', kind: 'pct', min: 1, max: 95, default: 20 }] });
    expect(r.body.templates.find((t: { id: string }) => t.id === 'below_sma200_sessions').params[0]).toMatchObject({ key: 'n', kind: 'int' });
  });

  it('POST, PATCH, DELETE: the rule back each time; each edit in the security log with the action and template only', async () => {
    const env = setup();
    const c = await env.call('POST', '/api/holding-rules', HOME, { template: 'below_cost_pct', params: { pct: 25 }, scopeSymbol: 'test1' });
    expect(c.status).toBe(200);
    const at = new Date(T0).toISOString();
    expect(c.body).toEqual({ id: 1, template: 'below_cost_pct', params: { pct: 25 }, scopeSymbol: 'TEST1', notify: false, enabled: true, createdAt: at, updatedAt: at });
    expect(env.evaluateSymbols).toHaveBeenCalledTimes(1);
    expect(env.evaluateSymbols).toHaveBeenLastCalledWith(['TEST1']);
    expect((await env.call('GET', '/api/holding-rules')).body.rules).toEqual([c.body]);
    env.clock.t += 60_000;
    const u = await env.call('PATCH', '/api/holding-rules/1', HOME, { params: { pct: 30 }, notify: true, scopeSymbol: null });
    expect(u.status).toBe(200);
    expect(u.body).toEqual({ ...c.body, params: { pct: 30 }, notify: true, scopeSymbol: null, updatedAt: new Date(T0 + 60_000).toISOString() });
    expect((await env.call('PATCH', '/api/holding-rules/1', HOME, { enabled: false })).body.enabled).toBe(false);
    expect((await env.call('PATCH', '/api/holding-rules/1', HOME, { template: 'pe_above', params: { x: 40 } })).body).toMatchObject({ template: 'pe_above', params: { x: 40 } });
    expect(env.evaluateSymbols).toHaveBeenCalledTimes(2); // not while the rule is disabled
    expect(env.evaluateSymbols).toHaveBeenLastCalledWith(null); // every holding
    expect((await env.call('PATCH', '/api/holding-rules/1', HOME, {})).status).toBe(400);
    expect((await env.call('DELETE', '/api/holding-rules/1')).body).toEqual({ ok: true });
    expect((await env.call('DELETE', '/api/holding-rules/1')).status).toBe(404);
    expect((await env.call('GET', '/api/holding-rules')).body.rules).toEqual([]);
    const ev = env.events('holding_rules.changed').reverse();
    expect(ev.map((e) => JSON.parse(e.detail!))).toEqual([
      { action: 'create', template: 'below_cost_pct' },
      { action: 'update', template: 'below_cost_pct' },
      { action: 'update', template: 'below_cost_pct' },
      { action: 'update', template: 'pe_above' },
      { action: 'delete', template: 'pe_above' },
    ]);
    expect(ev[0]).toMatchObject({ actor: 'control' });
  });

  it.each([
    [{ template: 'nope', params: { pct: 5 } }],
    [{ template: 'below_cost_pct' }],
    [{ template: 'below_cost_pct', params: {} }],
    [{ template: 'below_cost_pct', params: { pct: 5, other: 1 } }],
    [{ template: 'below_cost_pct', params: { n: 5 } }],
    [{ template: 'below_cost_pct', params: { pct: 0 } }],
    [{ template: 'below_cost_pct', params: { pct: 96 } }],
    [{ template: 'below_cost_pct', params: { pct: '5' } }],
    [{ template: 'below_sma200_sessions', params: { n: 2.5 } }],
    [{ template: 'below_cost_pct', params: { pct: 5 }, scopeSymbol: 'NOTHELD' }],
    [{ template: 'below_cost_pct', params: { pct: 5 }, scopeSymbol: 'USD' }],
    [{ template: 'below_cost_pct', params: { pct: 5 }, scopeSymbol: '' }],
    [{ template: 'below_cost_pct', params: { pct: 5 }, notify: 'yes' }],
    [{ template: 'below_cost_pct', params: { pct: 5 }, extra: 1 }],
    [[]],
  ])('POST refuses %j with 400', async (b) => {
    const env = setup();
    const r = await env.call('POST', '/api/holding-rules', HOME, b);
    expect(r.status).toBe(400);
    expect(typeof r.body.error).toBe('string');
    expect(env.events('holding_rules.changed')).toEqual([]);
    expect(env.evaluateSymbols).not.toHaveBeenCalled();
  });

  it('PATCH validation: params against the (new) template, held scope, unknown or malformed ids', async () => {
    const env = setup();
    await env.call('POST', '/api/holding-rules', HOME, { template: 'below_cost_pct', params: { pct: 25 } });
    expect((await env.call('PATCH', '/api/holding-rules/1', HOME, { template: 'pe_above' })).status).toBe(400);
    expect((await env.call('PATCH', '/api/holding-rules/1', HOME, { params: { x: 40 } })).status).toBe(400);
    expect((await env.call('PATCH', '/api/holding-rules/1', HOME, { params: { pct: 99 } })).status).toBe(400);
    expect((await env.call('PATCH', '/api/holding-rules/1', HOME, { scopeSymbol: 'NOTHELD' })).status).toBe(400);
    expect((await env.call('PATCH', '/api/holding-rules/1', HOME, { id: 7 })).status).toBe(400);
    const empty = await env.call('PATCH', '/api/holding-rules/1', HOME, {});
    expect(empty).toMatchObject({ status: 400, body: { error: 'nothing to change' } });
    for (const p of ['99', 'abc', '1.5', '-1', '0']) {
      expect((await env.call('PATCH', `/api/holding-rules/${p}`, HOME, { notify: true })).status).toBe(404);
      expect((await env.call('DELETE', `/api/holding-rules/${p}`)).status).toBe(404);
    }
    expect((await env.call('GET', '/api/holding-rules')).body.rules[0]).toMatchObject({ params: { pct: 25 }, scopeSymbol: null });
    expect(env.events('holding_rules.changed')).toHaveLength(1); // the create only
  });

  it('at most 100 rules (409)', async () => {
    const env = setup();
    for (let i = 0; i < MAX_HOLDING_RULES; i++) createHoldingRule(env.db, { template: 'dilution_pct', params: { pct: 5 } });
    const r = await env.call('POST', '/api/holding-rules', HOME, { template: 'dilution_pct', params: { pct: 5 } });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/at most 100/);
  });

  it('a paired phone away from home may edit, 30 edits an hour; reading is not limited; home is not limited', async () => {
    const env = setup();
    const phone = await env.pair('Test phone');
    expect((await env.call('POST', '/api/holding-rules', phone, { template: 'dilution_pct', params: { pct: 5 } })).status).toBe(200);
    for (let i = 1; i < HOLDING_RULES_OUTSIDE_PER_HOUR; i++) expect((await env.call('PATCH', '/api/holding-rules/1', phone, { params: { pct: 5 + i / 10 } })).status).toBe(200);
    const r = await env.call('DELETE', '/api/holding-rules/1', phone);
    expect(r.status).toBe(429);
    expect(Object.keys(r.body).sort()).toEqual(['error', 'retryAt']);
    expect(r.body.retryAt).toBe(new Date(T0 + 3_600_000).toISOString());
    expect(r.headers.get('retry-after')).toBe('3600');
    expect(env.events('holding_rules.limited')).toHaveLength(1);
    expect((await env.call('GET', '/api/holding-rules', phone)).status).toBe(200);
    expect((await env.call('PATCH', '/api/holding-rules/1', HOME, { notify: true })).status).toBe(200);
    for (let i = 0; i < 35; i++) expect((await env.call('PATCH', '/api/holding-rules/1', HOME, { params: { pct: 5 + i / 10 } })).status).toBe(200);
    // an hour later the phone may edit again
    env.clock.t += 3_600_000;
    expect((await env.call('DELETE', '/api/holding-rules/1', phone)).status).toBe(200);
    expect(env.events('holding_rules.changed')[0]).toMatchObject({ actor: expect.stringMatching(/^device:/), actorName: 'Test phone' });
  });
});

describe('the rules in the insights panel and the holdings list', () => {
  it('the panel lists the enabled rules for its symbol with state, value, source and since; the holdings count those that apply', async () => {
    const env = setup();
    const above = createHoldingRule(env.db, { template: 'above_cost_pct', params: { pct: 5 } }); // 55 vs 50: +10%
    const trend = createHoldingRule(env.db, { template: 'drop_1m_pct', params: { pct: 50 }, scopeSymbol: 'TEST1' });
    const pe = createHoldingRule(env.db, { template: 'pe_above', params: { x: 40 } }); // no SEC: unknown
    createHoldingRule(env.db, { template: 'dilution_pct', params: { pct: 5 }, scopeSymbol: 'TEST2' }); // another symbol
    createHoldingRule(env.db, { template: 'below_cost_pct', params: { pct: 5 }, enabled: false });
    const r = await env.call('GET', `/api/holdings/${env.id('TEST1')}/insights`);
    expect(r.status).toBe(200);
    const at = new Date(T0).toISOString();
    const bank = { kind: 'bank', date: '2026-11-11', time: '06:00', form: null };
    expect(r.body.rules).toEqual([
      { ruleId: above.id, template: 'above_cost_pct', params: { pct: 5 }, scopeSymbol: null, state: 'applies', value: 10, source: bank, costAsOf: '2026-11-11', since: at, lastKnownState: 'applies', lastKnownAt: at },
      { ruleId: trend.id, template: 'drop_1m_pct', params: { pct: 50 }, scopeSymbol: 'TEST1', state: 'clear', value: expect.any(Number), source: { kind: 'yahoo', date: '2026-11-10', time: null, form: null }, costAsOf: null, since: null, lastKnownState: 'clear', lastKnownAt: at },
      { ruleId: pe.id, template: 'pe_above', params: { x: 40 }, scopeSymbol: null, state: 'unknown', value: null, source: null, costAsOf: null, since: null, lastKnownState: null, lastKnownAt: null },
    ]);
    const h = await env.call('GET', `/api/accounts/${env.acc}/holdings`);
    expect(h.status).toBe(200);
    expect(h.body.positions.map((p: { symbol: string; rulesApplying: number }) => [p.symbol, p.rulesApplying])).toEqual([
      ['TEST1', 1],
      ['TEST2', 0],
    ]);
    // a second open keeps `since`
    env.clock.t += 60_000;
    expect((await env.call('GET', `/api/holdings/${env.id('TEST1')}/insights`)).body.rules[0]).toMatchObject({ state: 'applies', since: at });
  });

  it('no rules: an empty list; insights off: holdings-only rules still evaluate, the others are unknown', async () => {
    const env = setup();
    expect((await env.call('GET', `/api/holdings/${env.id('TEST2')}/insights`)).body.rules).toEqual([]);
    const db = env.db;
    createHoldingRule(db, { template: 'concentration_pct', params: { pct: 30 } }); // TEST2: 172800 / 446400 = 38.71%
    createHoldingRule(db, { template: 'from_high52_pct', params: { pct: 10 } });
    const off: WorkerState = { db, vault: null, scheduler: { config: { times: [], jitterMinutes: 0, timezone: 'UTC', monthsBack: 3 }, isRunning: false, nextRun: () => null } as never, startedAt: T0 };
    const { app } = createApp(off, { controlToken: TOKEN, webDist: '/nonexistent', now: () => T0 });
    const res = await app.request(`/api/holdings/${env.id('TEST2')}/insights`, { headers: HOME });
    const b = (await res.json()) as Record<string, any>;
    expect(b.unavailableCode).toBe('off');
    expect(b.rules).toMatchObject([
      { template: 'concentration_pct', state: 'applies', value: 38.7, source: { kind: 'bank', date: '2026-11-11', time: '06:00', form: null } },
      { template: 'from_high52_pct', state: 'unknown', value: null, source: null },
    ]);
  });
});

describe('a rule edit evaluates at once (the real service)', () => {
  it('after POST the next holdings fetch already shows the count; PATCH re-evaluates; DELETE drops it', async () => {
    const env = setup();
    const quiet = { info() {}, warn() {} };
    env.state.holdingRules = new HoldingRulesService({ db: env.db, panel: () => ({ insights: env.insights }), now: () => env.clock.t, gapMs: 0, log: quiet });
    const badges = async () => (await env.call('GET', `/api/accounts/${env.acc}/holdings`)).body.positions.map((p: { symbol: string; rulesApplying: number }) => [p.symbol, p.rulesApplying]);
    // TEST1 55 vs cost 50 (+10%), TEST2 40 vs 50 (-20%)
    expect((await env.call('POST', '/api/holding-rules', HOME, { template: 'above_cost_pct', params: { pct: 5 } })).status).toBe(200);
    expect(await badges()).toEqual([['TEST1', 1], ['TEST2', 0]]);
    expect((await env.call('PATCH', '/api/holding-rules/1', HOME, { params: { pct: 15 } })).status).toBe(200);
    expect(await badges()).toEqual([['TEST1', 0], ['TEST2', 0]]);
    expect((await env.call('PATCH', '/api/holding-rules/1', HOME, { template: 'below_cost_pct', params: { pct: 15 } })).status).toBe(200);
    expect(await badges()).toEqual([['TEST1', 0], ['TEST2', 1]]);
    // a rule that needs the panel: built at once through the (faked) Yahoo service
    expect((await env.call('POST', '/api/holding-rules', HOME, { template: 'drop_1m_pct', params: { pct: 1 }, scopeSymbol: 'TEST2' })).status).toBe(200);
    expect(env.f).toHaveBeenCalled();
    expect((await env.call('DELETE', '/api/holding-rules/1')).status).toBe(200);
    expect((await badges())[0]).toEqual(['TEST1', 0]);
  });
});
