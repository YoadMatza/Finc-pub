import { beforeEach, describe, expect, it } from 'vitest';
import { getSetting, setSetting } from '../ai/settings.js';
import { ensureAccount } from '../db/accounts.js';
import { type Db, openDb } from '../db/db.js';
import { runEngine } from '../engine/run.js';
import { ingestBatch } from '../ingest/ingest.js';
import type { NormalizedRow } from '../ingest/types.js';
import { LimitError, getSpendLimit, setSpendLimit, spendLimitEntries, variableTargetsSum } from './limit.js';
import { hubOverview } from './overview.js';
import { setGroupTarget } from './targets.js';

// fictional people and amounts (agorot). 2026-11-12 is a Thursday; its week runs Sun 8 – Sat 14 November.
const row = (date: string, amount: number, description: string): NormalizedRow => ({ externalAccountId: 'x', date, amount, description, status: 'completed', type: 'normal', identifier: `${description}${date}${amount}`, payload: {} });
const NOW = new Date('2026-11-12T10:00:00Z');

let db: Db;
const run = (sql: string, ...p: unknown[]) => db.$client.prepare(sql).run(...p);
const hub = (month = '2026-11') => hubOverview(db, month, 'purchase', { now: NOW });

beforeEach(() => {
  db = openDb(':memory:');
  const acc = ensureAccount(db, { institutionId: 'beinleumi', institutionKind: 'bank', institutionDisplayName: 'Bank', source: 'scraper:beinleumi', externalId: 'b', type: 'checking' }).accountId;
  ingestBatch(db, {
    source: 'scraper:beinleumi',
    runId: null,
    accountId: acc,
    rows: [row('2026-11-01', 1500000, 'EMPLOYER LTD'), row('2026-11-05', -52000, 'SUPERMARKET'), row('2026-11-09', -25000, 'GADGET STORE'), row('2026-10-07', -480000, 'OCTOBER SHOP')],
  });
  runEngine(db);
  run(`delete from link`);
  run(`update "transaction" set kind = case when amount_ils > 0 then 'income' else 'expense' end, excluded = 0, recurring_stream_id = null, installment_plan_id = null, category_id = null`);
  run(`delete from recurring_stream`);
  run(`delete from installment_plan`);
});

describe('spend.limit settings', () => {
  it('set from a month on: later entries are removed, "0" = off, earlier months keep theirs', () => {
    setSetting(db, 'spend.limit.2026-09', '500000');
    setSpendLimit(db, '2026-11', 600000, '2026-11');
    setSpendLimit(db, '2027-01', 700000, '2026-11');
    expect(getSpendLimit(db, '2026-10')).toBe(500000);
    expect(getSpendLimit(db, '2026-12')).toBe(600000);
    expect(getSpendLimit(db, '2027-03')).toBe(700000);
    setSpendLimit(db, '2026-12', null, '2026-11');
    expect(getSetting(db, 'spend.limit.2026-12')).toBe('0');
    expect(getSetting(db, 'spend.limit.2027-01')).toBeNull();
    expect(getSpendLimit(db, '2026-11')).toBe(600000);
    expect(getSpendLimit(db, '2027-03')).toBeNull();
    // a new value for the current month replaces the later ones
    setSpendLimit(db, '2026-11', 650000, '2026-11');
    expect(spendLimitEntries(db).map((e) => e.month).sort()).toEqual(['2026-09', '2026-11']);
    expect(getSpendLimit(db, '2027-03')).toBe(650000);
  });

  it('refuses a past month and bad amounts, writing nothing', () => {
    setSpendLimit(db, '2026-12', 600000, '2026-11');
    for (const [m, a] of [
      ['2026-10', 500000],
      ['2026-13', 500000],
      ['2026-11', 0],
      ['2026-11', -5],
      ['2026-11', 12.5],
      ['2026-11', 100_000_001],
    ] as const) {
      expect(() => setSpendLimit(db, m, a, '2026-11')).toThrow(LimitError);
    }
    expect(spendLimitEntries(db)).toEqual([{ month: '2026-12', amount: 600000 }]);
    expect(() => setSpendLimit(db, '2026-11', 100_000_000, '2026-11')).not.toThrow();
  });

  it('variableTargetsSum: effective targets of tracked variable groups only', () => {
    expect(variableTargetsSum(db)).toBeNull();
    run(`update category set monthly_target = 150000 where key = 'lifestyle.eating_out'`);
    run(`update category set monthly_target = 100000 where key = 'lifestyle.leisure'`);
    expect(variableTargetsSum(db)).toBe(250000);
    setGroupTarget(db, 'lifestyle', 300000); // a group target wins over its categories' sum
    setGroupTarget(db, 'income', 900000); // not a variable group
    expect(variableTargetsSum(db)).toBe(300000);
    // a mixed group: car insurance is fixed and never counts, not even through a car group target
    run(`update category set monthly_target = 50000 where key = 'car.insurance'`);
    expect(variableTargetsSum(db)).toBe(300000);
    run(`update category set monthly_target = 80000 where key = 'car.fuel'`);
    setGroupTarget(db, 'car', 999999);
    expect(variableTargetsSum(db)).toBe(380000);
  });
});

describe('hub limit', () => {
  it('no limit → null; the payload when set (week from Sunday the 8th)', () => {
    expect(hub().limit).toBeNull();
    setSpendLimit(db, '2026-11', 600000, '2026-11');
    const h = hub();
    // spent 77,000 (= forecast.variableSpent); pace 600,000 × 12 / 30 = 240,000; before the week 52,000:
    // (600,000 − 52,000) × 7 / 23 = 166,782.6 → 166,783
    expect(h.forecast.variableSpent).toBe(77000);
    expect(h.limit).toEqual({
      amount: 600000,
      spent: 77000,
      usedPct: 12.8,
      pace: { byToday: 240000, delta: -163000, state: 'under' },
      leftWithin: 523000,
      over: false,
      week: { limit: 166783, spent: 25000 },
      targets: null,
    });
    run(`update category set monthly_target = 650000 where key = 'lifestyle.eating_out'`);
    expect(hub().limit!.targets).toEqual({ sum: 650000, exceeds: true });
  });

  it('a past month uses its own entry and has no week; a future month has no card', () => {
    setSetting(db, 'spend.limit.2026-10', '500000');
    setSpendLimit(db, '2026-11', null, '2026-11');
    expect(hub().limit).toBeNull();
    expect(hub('2026-10').limit).toEqual({ amount: 500000, spent: 480000, usedPct: 96, pace: { byToday: 500000, delta: -20000, state: 'on' }, leftWithin: 20000, over: false, week: null, targets: null });
    setSpendLimit(db, '2026-11', 600000, '2026-11');
    expect(hub('2026-12').limit).toBeNull();
  });
});
