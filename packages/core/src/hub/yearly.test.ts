import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { ensureAccount } from '../db/accounts.js';
import { openDb } from '../db/db.js';
import { recordBalance } from '../db/runs.js';
import { transactions } from '../db/schema.js';
import { setStreamState } from '../engine/recurring.js';
import { runEngine } from '../engine/run.js';
import { monthSummary, monthsBetween } from '../engine/summary.js';
import { ingestBatch } from '../ingest/ingest.js';
import type { NormalizedRow } from '../ingest/types.js';
import { createEvent, setEventTxns } from './events.js';
import { yearlyReport } from './yearly.js';

const row = (date: string, amount: number, description: string, extra: Partial<NormalizedRow> = {}): NormalizedRow => ({ externalAccountId: 'x', date, amount, description, status: 'completed', type: 'normal', identifier: `${description}${date}${amount}`, payload: {}, ...extra });

const TODAY = '2026-11-09';

/** 23 months, 2025-01 to 2026-11: a salary, a growing supermarket habit, a streaming subscription whose price goes up. */
function seed() {
  const db = openDb(':memory:');
  const card = ensureAccount(db, { institutionId: 'max', institutionKind: 'card', institutionDisplayName: 'Max', source: 'scraper:max', externalId: 'm', type: 'credit_card' }).accountId;
  const bank = ensureAccount(db, { institutionId: 'beinleumi', institutionKind: 'bank', institutionDisplayName: 'Bank', source: 'scraper:beinleumi', externalId: 'b', type: 'checking' }).accountId;
  const rows: NormalizedRow[] = [];
  for (const m of monthsBetween('2025-01', '2026-11')) {
    const i = rows.length;
    rows.push(row(`${m}-01`, 1_400_000, 'SALARY'));
    rows.push(row(`${m}-05`, -(50_000 + i * 100), 'SUPERMARKET DEMO'));
    rows.push(row(`${m}-12`, -30_000, 'WOLT DEMO'));
    rows.push(row(`${m}-15`, m >= '2026-06' ? -5_990 : -5_490, 'STREAMFLIX'));
  }
  // one big purchase, and the first slice of a 10-payment plan
  rows.push(row('2026-03-20', -450_000, 'TV SHOP DEMO'));
  rows.push(row('2026-04-02', -30_000, 'SOFA DEMO', { type: 'installments', installmentN: 1, installmentTotal: 10, originalAmount: -300_000, identifier: 'ARN77_1' }));
  ingestBatch(db, { source: 'scraper:max', runId: null, accountId: card, rows });
  runEngine(db);
  const c = db.$client;
  const stream = c.prepare(`select rs.id from recurring_stream rs join merchant m on m.id = rs.merchant_id where m.name like 'STREAMFLIX%'`).get() as { id: number } | undefined;
  if (!stream) throw new Error('fixture: a STREAMFLIX stream expected');
  setStreamState(db, stream.id, 'confirmed');
  // one stream across the price step (the engine may split it at the step; here the fixture is explicit)
  c.prepare(`update "transaction" set recurring_stream_id = ? where description_raw = 'STREAMFLIX'`).run(stream.id);
  recordBalance(db, { accountId: bank, runId: null, balanceMinor: 5_000_000, takenAt: '2025-12-31T20:00:00.000Z', source: 'test' });
  recordBalance(db, { accountId: bank, runId: null, balanceMinor: 7_000_000, takenAt: '2026-06-30T20:00:00.000Z', source: 'test' });
  return { db, card, streamId: stream.id };
}

describe('yearly report', () => {
  it("a finished year's totals are exactly the sum of its month summaries", () => {
    const { db } = seed();
    const r = yearlyReport(db, 2025, { today: TODAY });
    expect(r.empty).toBe(false);
    expect(r.partial).toBe(false);
    expect(r.months).toHaveLength(12);
    expect(r.months.every((m) => !m.partial)).toBe(true);
    const ss = monthsBetween('2025-01', '2025-12').map((m) => monthSummary(db, m));
    const income = ss.reduce((a, s) => a + s.income.sum, 0);
    const spending = -ss.reduce((a, s) => a + s.fixed.sum + s.variable.sum + s.installments.sum, 0);
    expect(r.totals.income).toBe(income);
    expect(r.totals.income).toBe(12 * 1_400_000);
    expect(r.totals.spending).toBe(spending);
    expect(r.totals.net).toBe(ss.reduce((a, s) => a + s.net, 0));
    expect(r.totals.saved).toBe(income - spending);
    expect(r.totals.savingsRate).toBeCloseTo((income - spending) / income, 10);
    // every month equals its own summary
    for (const [i, m] of r.months.entries()) expect(m.net).toBe(ss[i]!.net);
    // groups add up to the year's spending (no savings rows here)
    expect(r.groups.reduce((a, g) => a + g.total, 0)).toBe(spending);
    // no 2024 data: nothing to compare with
    expect(r.previous).toBeNull();
    expect(r.groups.every((g) => g.previous === null)).toBe(true);
    // best and worst finished month by net
    expect(r.best!.net).toBeGreaterThanOrEqual(r.worst!.net);
    expect(r.best!.month).toBe('2025-01'); // spending grows every month
    expect(r.worst!.month).toBe('2025-12');
    expect(r.availableYears).toEqual([2026, 2025]);
  });

  it('the current year is "so far": months to date, the current one partial and counted', () => {
    const { db } = seed();
    const r = yearlyReport(db, 2026, { today: TODAY });
    expect(r.partial).toBe(true);
    expect(r.months.map((m) => m.month)).toEqual(monthsBetween('2026-01', '2026-11'));
    expect(r.months.filter((m) => m.partial).map((m) => m.month)).toEqual(['2026-11']);
    const ss = monthsBetween('2026-01', '2026-11').map((m) => monthSummary(db, m));
    expect(r.totals.net).toBe(ss.reduce((a, s) => a + s.net, 0));
    expect(r.totals.months).toBe(11);
    // compared with the same eleven months of 2025, not the whole year
    expect(r.previous).toMatchObject({ year: 2025, months: 11, income: 11 * 1_400_000 });
    for (const g of r.groups) expect(g.previous).not.toBeNull();
    // the best / worst month never is the unfinished one
    expect(r.best!.month).not.toBe('2026-11');
    expect(r.worst!.month).not.toBe('2026-11');
  });

  it('a year with no finished month of data is empty, and so is a future year', () => {
    const { db } = seed();
    expect(yearlyReport(db, 2024, { today: TODAY })).toMatchObject({ empty: true, groups: [], merchants: [] });
    expect(yearlyReport(db, 2027, { today: TODAY })).toMatchObject({ empty: true, months: [] });
    // only the current month has data: not enough yet
    const fresh = openDb(':memory:');
    const acc = ensureAccount(fresh, { institutionId: 'max', institutionKind: 'card', institutionDisplayName: 'Max', source: 'scraper:max', externalId: 'm', type: 'credit_card' }).accountId;
    ingestBatch(fresh, { source: 'scraper:max', runId: null, accountId: acc, rows: [row('2027-01-03', -12_000, 'BAKERY DEMO')] });
    runEngine(fresh);
    const r = yearlyReport(fresh, 2027, { today: '2027-01-15' });
    expect(r.empty).toBe(true);
    expect(r.months).toHaveLength(1);
    expect(r.months[0]).toMatchObject({ partial: true, hasData: true });
    expect(r.totals.spending).toBe(0);
  });

  it('money paid back nets spending and is never income', () => {
    const { db, card } = seed();
    const before = yearlyReport(db, 2026, { today: TODAY });
    ingestBatch(db, { source: 'scraper:max', runId: null, accountId: card, rows: [row('2026-10-20', 20_700, 'PAYBACK FROM A FRIEND')] });
    runEngine(db);
    const pb = db.select().from(transactions).where(eq(transactions.descriptionRaw, 'PAYBACK FROM A FRIEND')).get()!;
    db.update(transactions).set({ kind: 'paid_back' }).where(eq(transactions.id, pb.id)).run();
    const r = yearlyReport(db, 2026, { today: TODAY });
    expect(r.totals.income).toBe(before.totals.income);
    expect(r.totals.spending).toBe(before.totals.spending - 20_700);
    expect(r.totals.paidBack).toBe(20_700);
    expect(r.totals.net).toBe(monthsBetween('2026-01', '2026-11').reduce((a, m) => a + monthSummary(db, m).net, 0));
    expect(r.merchants.some((m) => /payback/i.test(m.name))).toBe(false);
  });

  it('lists top merchants, fixed costs with a price change, big moments and net worth', () => {
    const { db, streamId } = seed();
    const tv = db.select().from(transactions).where(eq(transactions.descriptionRaw, 'TV SHOP DEMO')).get()!;
    const trip = createEvent(db, { name: 'Demo trip', fromDate: '2026-03-01', toDate: '2026-03-31' });
    setEventTxns(db, trip.id, { add: [tv.id] });
    const r = yearlyReport(db, 2026, { today: TODAY });

    expect(r.merchants.length).toBeLessThanOrEqual(10);
    expect(r.merchants[0]!.name).toMatch(/supermarket/i);
    expect(r.merchants[0]!.count).toBe(11);
    const sorted = [...r.merchants].sort((a, b) => b.total - a.total);
    expect(r.merchants).toEqual(sorted);

    const s = r.fixed.streams.find((x) => x.id === streamId)!;
    expect(s).toMatchObject({ count: 11, cost: 5 * 5_490 + 6 * 5_990, isNew: false, ended: false });
    expect(r.fixed.total).toBe(r.fixed.streams.reduce((a, x) => a + x.cost, 0));
    expect(r.fixed.priceChanges).toEqual([{ streamId, name: expect.any(String), from: 5_490, to: 5_990, date: '2026-06-15' }]);

    expect(r.big.purchases[0]).toMatchObject({ txnId: tv.id, amount: 450_000, date: '2026-03-20' });
    expect(r.big.plans).toEqual([expect.objectContaining({ totalN: 10, total: 300_000, firstDate: '2026-04-02' })]);
    expect(r.big.events).toEqual([expect.objectContaining({ id: trip.id, name: 'Demo trip', spent: 450_000 })]);
    // 2025 has no plans or events
    const y25 = yearlyReport(db, 2025, { today: TODAY });
    expect(y25.big.plans).toEqual([]);
    expect(y25.big.events).toEqual([]);
    expect(y25.fixed.priceChanges).toEqual([]);

    // net worth: start = end of the previous year where a balance was recorded; 2025 has none at its start
    expect(r.netWorth.start).toMatchObject({ date: '2025-12-31', assets: 5_000_000 });
    expect(r.netWorth.end!.date).toBe(TODAY);
    expect(r.netWorth.end!.assets).toBe(7_000_000);
    expect(y25.netWorth.start).toBeNull();
    expect(y25.netWorth.end).toMatchObject({ date: '2025-12-31', assets: 5_000_000 });
  });
});
