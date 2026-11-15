import { beforeEach, describe, expect, it } from 'vitest';
import { getSetting, setSetting } from '../ai/settings.js';
import { ensureAccount } from '../db/accounts.js';
import { type Db, openDb } from '../db/db.js';
import { runEngine } from '../engine/run.js';
import { monthSummary } from '../engine/summary.js';
import { ingestBatch } from '../ingest/ingest.js';
import type { NormalizedRow } from '../ingest/types.js';
import { logForecast } from './forecast-log.js';
import { hubOverview } from './overview.js';
import { IncomeKindError, incomeKinds, setIncomeKindOverride, setIncomeKinds, setSpreadExtra, spreadExtraFor } from './now.js';
import { transactionDetail } from './transactions.js';

// fictional people and amounts (agorot)
const row = (date: string, amount: number, description: string): NormalizedRow => ({ externalAccountId: 'x', date, amount, description, status: 'completed', type: 'normal', identifier: `${description}${date}${amount}`, payload: {} });
const NOW = new Date('2026-11-10T10:00:00Z');
const T = '2026-11-01T00:00:00.000Z';

let db: Db;
let acc: number;
const q = <R>(sql: string, ...p: unknown[]) => db.$client.prepare(sql).get(...p) as R;
const run = (sql: string, ...p: unknown[]) => db.$client.prepare(sql).run(...p);
const catId = (key: string) => q<{ id: number }>('select id from category where key = ?', key).id;
const txn = (desc: string) => q<{ id: number }>('select id from "transaction" where description_raw = ?', desc).id;
const merchant = (name: string) => Number(run(`insert into merchant (key, name, created_at) values (?, ?, ?)`, name.toLowerCase(), name, T).lastInsertRowid);
const stream = (name: string, amount: number, day: number, direction: 'income' | 'expense', categoryId: number) =>
  Number(
    run(
      `insert into recurring_stream (account_id, merchant_id, category_id, frequency, expected_amount, amount_tolerance, amount_model, expected_day, last_txn_date, occurrences, state, state_source, direction, label, created_at, updated_at)
       values (?, ?, ?, 'monthly', ?, 1000, 'fixed', ?, '2026-10-01', 6, 'confirmed', 'user', ?, ?, ?, ?)`,
      acc, merchant(name), categoryId, amount, day, direction, name, T, T,
    ).lastInsertRowid,
  );
const hub = (month = '2026-11') => hubOverview(db, month, 'purchase', { now: NOW });

beforeEach(() => {
  db = openDb(':memory:');
  acc = ensureAccount(db, { institutionId: 'beinleumi', institutionKind: 'bank', institutionDisplayName: 'Bank', source: 'scraper:beinleumi', externalId: 'b', type: 'checking' }).accountId;
  ingestBatch(db, {
    source: 'scraper:beinleumi',
    runId: null,
    accountId: acc,
    rows: [
      row('2026-11-01', 1500000, 'EMPLOYER LTD'),
      row('2026-11-09', 1164000, 'CLIENT ALPHA'),
      row('2026-11-04', 5000, 'CARD CASHBACK'),
      row('2026-11-02', -400000, 'LANDLORD'),
      row('2026-11-03', -100000, 'SAVINGS PLAN'),
      row('2026-11-05', -52000, 'SUPERMARKET'),
      row('2026-11-06', -25000, 'GADGET STORE'),
    ],
  });
  runEngine(db);
  // pin everything so the test does not depend on the engine's heuristics
  run(`delete from link`);
  run(`update "transaction" set kind = case when amount_ils > 0 then 'income' else 'expense' end, excluded = 0, recurring_stream_id = null, installment_plan_id = null, category_id = null`);
  run(`delete from recurring_stream`);
  run(`delete from installment_plan`);
  run(`update "transaction" set category_id = ? where description_raw = 'EMPLOYER LTD'`, catId('income.salary'));
  run(`update "transaction" set category_id = ? where description_raw = 'CLIENT ALPHA'`, catId('income.freelance'));
  run(`update "transaction" set category_id = ? where description_raw = 'CARD CASHBACK'`, catId('income.cashback'));
  run(`update "transaction" set kind = 'savings' where description_raw = 'SAVINGS PLAN'`);
  const savingsCat = q<{ id: number }>(`select id from category where section = 'savings' order by id limit 1`).id;
  const fixedCat = q<{ id: number }>(`select id from category where section = 'fixed' order by id limit 1`).id;
  // rent: a confirmed stream, paid this month (matched); gym: still expected; a savings transfer still planned
  const rent = stream('Rent', -400000, 2, 'expense', fixedCat);
  run(`update "transaction" set recurring_stream_id = ? where description_raw = 'LANDLORD'`, rent);
  stream('Gym', -20000, 20, 'expense', fixedCat);
  stream('Pension top-up', -50000, 25, 'expense', savingsCat);
  // a confirmed income stream in income.other (so income.other becomes regular by default), still expected
  stream('Flat rent in', 300000, 28, 'income', catId('income.other'));
  // an instalment plan: slice 2 paid this month, slice 3 expected on the 15th
  const plan = Number(
    run(`insert into installment_plan (account_id, merchant_id, plan_key, total_n, slice_amount, first_date, seen_n, status, created_at, updated_at) values (?, ?, 'p1', 6, -30000, '2026-09-15', 2, 'active', ?, ?)`, acc, merchant('Gadget Store'), T, T)
      .lastInsertRowid,
  );
  run(`update "transaction" set installment_plan_id = ? where description_raw = 'GADGET STORE'`, plan);
});

describe('the Now income split and explain (hub/now.ts)', () => {
  it('migration: transaction.income_kind_override exists and starts null', () => {
    const cols = db.$client.prepare(`pragma table_info("transaction")`).all() as Array<{ name: string; type: string; notnull: number }>;
    expect(cols.find((c) => c.name === 'income_kind_override')).toMatchObject({ type: 'TEXT', notnull: 0 });
    expect(q<{ n: number }>(`select count(*) n from "transaction" where income_kind_override is not null`).n).toBe(0);
  });

  it('splits income, computes without-extra, moves the envelope off a large extra, and explains every shekel', () => {
    const h = hub();
    const f = h.forecast;
    // left = 1,500,000 + 2,058,000 + 5,000 + 300,000 − 400,000 − 20,000 − 25,000 − 30,000 − 100,000 − 50,000 − 52,000
    expect(f.left).toBe(2292000);
    expect(h.incomeSplit.regular).toEqual({ received: 1500000, expected: 300000 });
    expect(h.incomeSplit.extra).toMatchObject({ received: 1169000, expected: 0 });
    expect(h.incomeSplit.extra.items.map((i) => [i.id, i.amount, i.categoryKey, i.status])).toEqual([
      [txn('CLIENT ALPHA'), 1164000, 'income.freelance', 'received'],
      [txn('CARD CASHBACK'), 5000, 'income.cashback', 'received'],
    ]);
    expect(h.incomeSplit.kinds).toMatchObject({ 'income.salary': 'regular', 'income.other': 'regular', 'income.freelance': 'extra', 'income.cashback': 'extra' });
    expect(h.withoutExtra).toEqual({ left: 1123000, tone: 'positive' });

    // explain: the terms sum exactly to left
    const byKey = Object.fromEntries(h.explain.map((t) => [t.key, t]));
    expect(h.explain.reduce((a, t) => a + t.amount, 0)).toBe(f.left);
    expect(Object.fromEntries(h.explain.map((t) => [t.key, t.amount]))).toEqual({
      income_regular_received: 1500000,
      income_regular_expected: 300000,
      income_extra_received: 1169000,
      income_extra_expected: 0,
      fixed_paid: -400000,
      fixed_expected: -20000,
      installments_paid: -25000,
      installments_expected: -30000,
      savings_actual: -100000,
      savings_planned: -50000,
      variable_spent: -52000,
    });
    expect(byKey.fixed_expected!.items).toEqual([{ id: null, name: 'Gym', amount: -20000, date: '2026-11-20', status: 'expected' }]);
    expect(byKey.installments_expected!.items).toEqual([{ id: null, name: 'Gadget Store 3/6', amount: -30000, date: '2026-11-15', status: 'expected' }]);
    expect(byKey.income_regular_expected!.items).toEqual([{ id: null, name: 'Flat rent in', amount: 300000, date: '2026-11-28', status: 'expected' }]);
    expect(byKey.variable_spent!.items).toMatchObject([{ id: txn('SUPERMARKET'), amount: -52000, date: '2026-11-05', status: 'paid' }]);
    // the terms match the forecast's own parts
    expect(byKey.income_regular_received!.amount + byKey.income_extra_received!.amount).toBe(f.income.actual);
    expect(-(byKey.fixed_paid!.amount + byKey.fixed_expected!.amount + byKey.installments_paid!.amount + byKey.installments_expected!.amount)).toBe(f.committed.total);

    // large extra (2,063,000 of 3,863,000): envelope and projection on the regular part
    expect(h.spread).toMatchObject({ extraExcluded: true, extraIncluded: false, reason: 'large_extra', weeklyAll: Math.round((2292000 * 7) / 21) });
    expect(f.weekly.envelope).toBe(Math.round((1123000 * 7) / 21));
    expect(f.projected.end).toBe(1123000 - f.variable.remaining);
    expect(h.spread.projectedAll!.end).toBe(2292000 - f.variable.remaining);
    expect(h.projected.end).toBe(f.projected.end);
    // the accuracy log keeps the projection on all income
    // (logForecast reads the real clock; only check when it runs in November 2026)
    logForecast(db, '2026-11-10');
    const logged = q<{ projected_end: number } | undefined>(`select projected_end from forecast_log where date = '2026-11-10'`);
    if (logged) expect(logged.projected_end).toBe(hubOverview(db).spread.projectedAll?.end ?? hubOverview(db).forecast.projected.end);
  });

  it('the weekly summary and the chat tool state the large-extra rule (only while the real clock is in 2026-11)', async () => {
    if (new Date().toISOString().slice(0, 7) !== '2026-11') return;
    const { weeklySummaryText } = await import('../alerts/index.js');
    const { CHAT_TOOLS } = await import('../ai/chat.js');
    expect(weeklySummaryText(db, { lang: 'en' }).text).toMatch(/On your regular income: the month ends around .*; including the extra .*: around /);
    const out = CHAT_TOOLS.find((t) => t.name === 'month_summary')!.run(db, { month: '2026-11' }, new Date().toISOString().slice(0, 10)) as Record<string, unknown>;
    expect(out).toMatchObject({ extraExcluded: true, leftWithoutExtra: expect.anything(), projectedAll: expect.anything() });
  });

  it('spreadExtra for the month restores the envelope on all income', () => {
    setSpreadExtra(db, '2026-11', true);
    expect(spreadExtraFor(db, '2026-11')).toBe(true);
    const h = hub();
    expect(h.spread).toEqual({ extraExcluded: false, extraIncluded: true, reason: 'large_extra', weeklyAll: null, projectedAll: null, stateRegular: 'comfortable', weeklyRegular: Math.round((1123000 * 7) / 21) });
    expect(h.forecast.weekly.envelope).toBe(Math.round((2292000 * 7) / 21));
    setSpreadExtra(db, '2026-11', false);
    expect(getSetting(db, 'spend.spreadExtra.2026-11')).toBeNull();
    expect(hub().spread.extraExcluded).toBe(true);
    expect(() => setSpreadExtra(db, '2026-13', true)).toThrow(IncomeKindError);
  });

  it('category settings and a per-payment override move income between the parts; explain still sums to left', () => {
    setIncomeKinds(db, { 'income.freelance': 'regular' });
    expect(getSetting(db, 'income.kind.income.freelance')).toBe('regular');
    expect(incomeKinds(db)['income.freelance']).toBe('regular');
    let h = hub();
    expect(h.incomeSplit.regular.received).toBe(2664000);
    expect(h.incomeSplit.extra.received).toBe(5000);
    expect(h.spread.extraExcluded).toBe(false);
    expect(h.withoutExtra.left).toBe(2292000 - 5000);

    expect(setIncomeKindOverride(db, txn('CLIENT ALPHA'), 'extra')).toBe('ok');
    expect(transactionDetail(db, txn('CLIENT ALPHA'))!.incomeKind).toBe('extra');
    h = hub();
    expect(h.incomeSplit.extra.received).toBe(1169000);
    expect(h.explain.reduce((a, t) => a + t.amount, 0)).toBe(h.forecast.left);
    expect(h.forecast.left).toBe(2292000);

    // back to defaults
    setIncomeKinds(db, { 'income.freelance': null });
    expect(getSetting(db, 'income.kind.income.freelance')).toBeNull();
    expect(setIncomeKindOverride(db, txn('CLIENT ALPHA'), null)).toBe('ok');
    expect(transactionDetail(db, txn('CLIENT ALPHA'))!.incomeKind).toBeNull();
    // salary can be made extra too
    setIncomeKinds(db, { 'income.salary': 'extra' });
    expect(hub().incomeSplit.regular.received).toBe(0);
  });

  it('a row of a confirmed income stream is regular whatever its category; non-income positives do not trigger the rule', () => {
    // the freelance payment belongs to a confirmed income stream with no category: regular
    const s = stream('Client Alpha retainer', 1164000, 9, 'income', catId('income.freelance'));
    run(`update recurring_stream set category_id = null where id = ?`, s);
    run(`update "transaction" set recurring_stream_id = ?, category_id = null where description_raw = 'CLIENT ALPHA'`, s);
    let h = hub();
    expect(h.incomeSplit.regular.received).toBe(1500000 + 1164000);
    expect(h.spread.reason).toBeNull();
    // an explicit setting on its category still wins over the stream rule
    run(`update "transaction" set category_id = ? where description_raw = 'CLIENT ALPHA'`, catId('income.freelance'));
    setIncomeKinds(db, { 'income.freelance': 'extra' });
    expect(hub().incomeSplit.extra.received).toBe(1164000 + 5000);
    setIncomeKinds(db, { 'income.freelance': null });

    // a big card credit outside the income categories: extra, listed, but not a trigger for the 20% rule
    run(`update "transaction" set recurring_stream_id = null, category_id = ? where description_raw = 'CLIENT ALPHA'`, q<{ id: number }>(`select id from category where section = 'variable' order by id limit 1`).id);
    h = hub();
    expect(h.incomeSplit.extra.received).toBe(1169000);
    expect(h.incomeSplit.extra.counted).toBe(5000);
    expect(h.incomeSplit.extra.items[0]).toMatchObject({ id: txn('CLIENT ALPHA'), incomeCategory: false });
    expect(h.spread).toMatchObject({ extraExcluded: false, reason: null, stateRegular: null, weeklyRegular: null });
    expect(h.explain.reduce((a, t) => a + t.amount, 0)).toBe(h.forecast.left);
  });

  it('moving a row to a non-income category, excluding it or marking it a transfer clears its re-tag', async () => {
    const { setCategory } = await import('../engine/categorize.js');
    const { setExcluded, markTransfer } = await import('./actions.js');
    const id = txn('CLIENT ALPHA');
    const over = () => q<{ o: string | null }>(`select income_kind_override o from "transaction" where id = ?`, id).o;
    setIncomeKindOverride(db, id, 'regular');
    setCategory(db, { txnId: id, categoryId: catId('income.other') });
    expect(over()).toBe('regular'); // still an income category
    setCategory(db, { txnId: id, categoryId: q<{ id: number }>(`select id from category where section = 'variable' order by id limit 1`).id });
    expect(over()).toBeNull();
    setCategory(db, { txnId: id, categoryId: catId('income.freelance') });
    setIncomeKindOverride(db, id, 'regular');
    setExcluded(db, id, true);
    expect(over()).toBeNull();
    setExcluded(db, id, false);
    setIncomeKindOverride(db, id, 'extra');
    markTransfer(db, id, true);
    expect(over()).toBeNull();
  });

  it('refuses a kind on a non-income category key, a non-income row, or a missing row', () => {
    expect(() => setIncomeKinds(db, { 'lifestyle.nope': 'regular' })).toThrow(IncomeKindError);
    expect(() => setIncomeKinds(db, { 'income.freelance': 'sometimes' as never })).toThrow(IncomeKindError);
    expect(getSetting(db, 'income.kind.income.freelance')).toBeNull();
    expect(setIncomeKindOverride(db, txn('SUPERMARKET'), 'extra')).toBe('not_income');
    expect(setIncomeKindOverride(db, txn('SUPERMARKET'), null)).toBe('ok');
    expect(setIncomeKindOverride(db, 999999, 'regular')).toBe('missing');
  });

  it('typical month: medians of the complete months with data, null under three', () => {
    expect(hub().typical).toBeNull();
    const salary = catId('income.salary');
    const freelance = catId('income.freelance');
    const add = (rows: NormalizedRow[]) => ingestBatch(db, { source: 'scraper:beinleumi', runId: null, accountId: acc, rows });
    add([row('2026-10-02', 1500000, 'EMPLOYER OCT'), row('2026-10-10', -300000, 'SHOP OCT'), row('2026-10-12', 500000, 'CLIENT OCT')]);
    add([row('2026-09-02', 1600000, 'EMPLOYER SEP'), row('2026-09-10', -200000, 'SHOP SEP')]);
    run(`update "transaction" set kind = case when amount_ils > 0 then 'income' else 'expense' end, excluded = 0, recurring_stream_id = null, installment_plan_id = null where cashflow_month in ('2026-09','2026-10')`);
    run(`update "transaction" set category_id = ? where description_raw like 'EMPLOYER %'`, salary);
    run(`update "transaction" set category_id = ? where description_raw = 'CLIENT OCT'`, freelance);
    run(`delete from link`);
    expect(hub().typical).toBeNull(); // two months only
    add([row('2026-06-02', 1400000, 'EMPLOYER JUN'), row('2026-06-10', -900000, 'SHOP JUN')]);
    run(`update "transaction" set kind = case when amount_ils > 0 then 'income' else 'expense' end, excluded = 0, recurring_stream_id = null, installment_plan_id = null, category_id = case when amount_ils > 0 then ? else null end where cashflow_month = '2026-06'`, salary);
    run(`delete from link`);
    const t = hub().typical;
    // Jun 1,400,000 / Sep 1,600,000 / Oct 2,000,000 (of it 1,500,000 regular); variable 900,000 / 200,000 / 300,000
    expect(t).toEqual({ months: 3, income: 1600000, regularIncome: 1500000, fixed: 0, variable: 300000 });
    // same definition as the summary
    expect(-monthSummary(db, '2026-10').variable.sum).toBe(300000);
  });

  it('a finished month: nothing expected, no large-extra rule, explain still sums to left', () => {
    const h = hubOverview(db, '2026-11', 'purchase', { now: new Date('2026-12-15T10:00:00Z') });
    expect(h.forecast.isCurrentMonth).toBe(false);
    expect(h.incomeSplit.regular.expected).toBe(0);
    expect(h.spread).toMatchObject({ extraExcluded: false, reason: null });
    expect(h.explain.reduce((a, t) => a + t.amount, 0)).toBe(h.forecast.left);
    expect(h.explain.filter((t) => t.key.endsWith('_expected') || t.key === 'savings_planned').every((t) => t.amount === 0)).toBe(true);
  });
});

void setSetting;
