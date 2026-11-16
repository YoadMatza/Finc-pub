import { beforeEach, describe, expect, it } from 'vitest';
import { ensureAccount } from '../db/accounts.js';
import { type Db, openDb } from '../db/db.js';
import { recurringStream, transactions } from '../db/schema.js';
import { ingestBatch } from '../ingest/ingest.js';
import type { NormalizedRow } from '../ingest/types.js';
import { seedCategories } from './categories.js';
import { categorize } from './categorize.js';
import { assignMerchants } from './merchant.js';
import { buildRecurringStreams, clusterByAmount, detectCadence, expectedSlots, modelAmounts, setStreamState } from './recurring.js';
import { classifyRemaining } from './rules.js';

let db: Db;
let acc: number;
const row = (date: string, amount: number, description: string, extra: Partial<NormalizedRow> = {}): NormalizedRow => ({ externalAccountId: 'x', date, amount, description, status: 'completed', type: 'normal', identifier: `${description}${date}${amount}`, payload: {}, ...extra });

function prep(): void {
  assignMerchants(db);
  classifyRemaining(db);
  seedCategories(db);
  categorize(db);
}

beforeEach(() => {
  db = openDb(':memory:');
  acc = ensureAccount(db, { institutionId: 'max', institutionKind: 'card', institutionDisplayName: 'Max', source: 'scraper:max', externalId: 'm', type: 'credit_card' }).accountId;
});

describe('cadence and amount models', () => {
  it('detects monthly with drift, bimonthly, weekly; rejects noise', () => {
    expect(detectCadence(['2026-01-03', '2026-02-02', '2026-03-05', '2026-04-03'])).toMatchObject({ frequency: 'monthly', fit: 1 });
    expect(detectCadence(['2026-01-10', '2026-03-11', '2026-05-09'])).toMatchObject({ frequency: 'bimonthly' });
    expect(detectCadence(['2026-01-01', '2026-01-08', '2026-01-15', '2026-01-22', '2026-01-29'])).toMatchObject({ frequency: 'weekly' });
    expect(detectCadence(['2026-01-01', '2026-01-03', '2026-01-20', '2026-03-01'])).toBeNull();
    expect(detectCadence(['2026-01-01'])).toBeNull();
  });
  it('fixed vs variable amounts', () => {
    expect(modelAmounts([-19900, -19900, -19900])).toMatchObject({ model: 'fixed', expected: -19900 });
    expect(modelAmounts([-19800, -19900, -20700])).toMatchObject({ model: 'fixed' }); // FX drift under 5%
    expect(modelAmounts([-30000, -45000, -38000])).toMatchObject({ model: 'variable' });
    expect(modelAmounts([-1000, -90000])).toBeNull();
    expect(modelAmounts([-4990, -4990, -4990, -99900])).toMatchObject({ model: 'fixed', expected: -4990 }); // one outlier ignored
  });
});

describe('buildRecurringStreams', () => {
  it('Streamly: USD stream with drifting shekel amounts is one confirmed monthly stream, and the month slot is consumed by the real charge', () => {
    const bh = (date: string, ils: number) => row(date, -ils, 'SP* STREAMLY STREAMLY.CO US', { originalAmount: -4900, originalCurrency: 'USD' });
    ingestBatch(db, { source: 'scraper:max', runId: null, accountId: acc, rows: [bh('2026-07-03', 18900), bh('2026-08-03', 19000), bh('2026-09-04', 18950), bh('2026-10-03', 19260), row('2026-10-15', -4500, 'WOLT'), row('2026-10-16', -6200, 'WOLT'), row('2026-10-17', -5100, 'WOLT')] });
    prep();
    const r = buildRecurringStreams(db, { today: '2026-11-08' });
    expect(r.created).toBe(1); // WOLT is variable spend, not a stream
    const s = db.select().from(recurringStream).get()!;
    expect(s).toMatchObject({ frequency: 'monthly', state: 'confirmed', originalCurrency: 'USD', expectedOriginalAmount: -4900, occurrences: 4, expectedDay: 3, direction: 'expense' });
    expect(s.nextExpectedDate).toBe('2026-11-03');
    expect(db.select().from(transactions).where(eq(transactions.recurringStreamId, s.id)).all()).toHaveLength(4);

    // October: the ₪192.60 charge consumed the expected slot → no duplicate expectation
    const oct = expectedSlots(db, '2026-10', { today: '2026-11-08' });
    expect(oct).toHaveLength(1);
    expect(oct[0]).toMatchObject({ status: 'matched', expectedDate: '2026-10-03' });
    // November, nothing charged yet and 5 days past the expected day → missing (one alert per stream)
    const nov = expectedSlots(db, '2026-11', { today: '2026-11-12' });
    expect(nov).toHaveLength(1);
    expect(nov[0]).toMatchObject({ status: 'missing', amount: s.expectedAmount });
    expect(expectedSlots(db, '2026-11', { today: '2026-11-05' })[0]?.status).toBe('upcoming');
  });

  it('a one-off large purchase at a subscription merchant stays outside the stream; user rejection sticks', () => {
    ingestBatch(db, { source: 'scraper:max', runId: null, accountId: acc, rows: [row('2026-06-10', -4990, 'NETFLIX.COM'), row('2026-07-10', -4990, 'NETFLIX.COM'), row('2026-08-10', -4990, 'NETFLIX.COM'), row('2026-08-20', -99900, 'NETFLIX.COM')] });
    prep();
    buildRecurringStreams(db, { today: '2026-09-01' });
    const s = db.select().from(recurringStream).get()!;
    expect(s.occurrences).toBe(3);
    expect(db.select().from(transactions).where(eq(transactions.recurringStreamId, s.id)).all().map((t) => t.amountIls)).toEqual([-4990, -4990, -4990]);
    setStreamState(db, s.id, 'rejected');
    buildRecurringStreams(db, { today: '2026-09-01' });
    expect(db.select().from(recurringStream).get()?.state).toBe('rejected');
    expect(db.select().from(transactions).where(eq(transactions.recurringStreamId, s.id)).all()).toHaveLength(0);
  });

  it('an insurer billing three policies on the same day forms three streams, not none', () => {
    const rows: NormalizedRow[] = [];
    for (const m of ['06', '07', '08', '09']) for (const amt of [-14200, -3950, -8800]) rows.push(row(`2026-${m}-28`, amt, 'מבטח א-ביטוח בריאות'));
    ingestBatch(db, { source: 'scraper:isracard', runId: null, accountId: acc, rows });
    prep();
    const r = buildRecurringStreams(db, { today: '2026-10-05' });
    expect(r.created).toBe(3);
    const streams = db.select().from(recurringStream).all();
    expect(streams.map((s) => s.expectedAmount).sort((a, b) => a - b)).toEqual([-14200, -8800, -3950]);
    expect(streams.every((s) => s.frequency === 'monthly' && s.state === 'confirmed')).toBe(true);
    // stable across runs: same three streams, nothing duplicated
    buildRecurringStreams(db, { today: '2026-10-05' });
    expect(db.select().from(recurringStream).all()).toHaveLength(3);
    expect(clusterByAmount([10000, 10300, 25000, 26000, 900000], (x) => x).map((c) => c.length)).toEqual([2, 2, 1]);
  });

  it('a stream that stopped arriving ends; two hits are only a candidate', () => {
    ingestBatch(db, { source: 'scraper:max', runId: null, accountId: acc, rows: [row('2025-11-05', -11900, 'CELLCOM'), row('2025-12-05', -11900, 'CELLCOM'), row('2026-01-05', -11900, 'CELLCOM'), row('2026-09-01', -4600, 'GROK XAI'), row('2026-10-01', -4600, 'GROK XAI')] });
    prep();
    buildRecurringStreams(db, { today: '2026-11-08' });
    const by = Object.fromEntries(db.select().from(recurringStream).all().map((s) => [s.frequency + s.expectedAmount, s]));
    expect(by['monthly-11900']?.state).toBe('ended');
    expect(by['monthly-4600']?.state).toBe('candidate');
    expect(expectedSlots(db, '2026-11', { today: '2026-11-08' })).toHaveLength(0); // candidates and ended streams expect nothing
  });
});

import { eq } from 'drizzle-orm';

describe('a price change does not break a stream (gaps plan 1.8)', () => {
  const bill = (date: string, amount: number) => row(date, amount, 'HOT MOBILE');
  const months = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];

  it('one charge at the new price on the expected day stays in the stream, consumes its slot, and keeps the old expectation for now', () => {
    ingestBatch(db, { source: 'scraper:max', runId: null, accountId: acc, rows: [...months.map((m) => bill(`${m}-25`, -10000)), bill('2026-10-25', -12000)] });
    prep();
    buildRecurringStreams(db, { today: '2026-11-16' });
    const streams = db.select().from(recurringStream).all();
    expect(streams).toHaveLength(1);
    const s = streams[0]!;
    expect(s).toMatchObject({ state: 'confirmed', frequency: 'monthly', expectedAmount: -10000, nextExpectedDate: '2026-11-25', occurrences: 7 });
    expect(db.select().from(transactions).where(eq(transactions.recurringStreamId, s.id)).all()).toHaveLength(7);
    // the last charge is the new price, so the price-change insight (last charge vs expected) can fire
    expect(db.select().from(transactions).where(eq(transactions.id, s.lastTxnId!)).get()?.amountIls).toBe(-12000);
    expect(expectedSlots(db, '2026-10', { today: '2026-11-16' })[0]).toMatchObject({ status: 'matched' });
  });

  it('after the second charge at the new price the stream expects the new price, still one stream', () => {
    ingestBatch(db, { source: 'scraper:max', runId: null, accountId: acc, rows: [...months.map((m) => bill(`${m}-25`, -10000)), bill('2026-10-25', -12000), bill('2026-11-25', -12000)] });
    prep();
    buildRecurringStreams(db, { today: '2026-11-26' });
    buildRecurringStreams(db, { today: '2026-11-26' }); // stable across runs
    const streams = db.select().from(recurringStream).all();
    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({ state: 'confirmed', expectedAmount: -12000, nextExpectedDate: '2026-12-25', occurrences: 8 });
  });

  it('two subscriptions at one merchant, running side by side, stay two streams', () => {
    const rows: NormalizedRow[] = [];
    for (const m of months) rows.push(row(`${m}-05`, -4990, 'APPLE.COM/BILL'), row(`${m}-18`, -1990, 'APPLE.COM/BILL'));
    ingestBatch(db, { source: 'scraper:max', runId: null, accountId: acc, rows });
    prep();
    buildRecurringStreams(db, { today: '2026-10-01' });
    expect(db.select().from(recurringStream).all().map((s) => s.expectedAmount).sort((a, b) => a - b)).toEqual([-4990, -1990]);
  });

  it('single charges at new prices do not walk a stream up step by step', () => {
    const rows: NormalizedRow[] = months.map((m) => bill(`${m}-25`, -1000));
    // one charge at each new price, every month on the day, each step 1.4x: 10 -> 14 -> 19.5 -> 27
    rows.push(bill('2026-10-25', -1400), bill('2026-11-25', -1950), bill('2026-12-25', -2700));
    ingestBatch(db, { source: 'scraper:max', runId: null, accountId: acc, rows });
    prep();
    buildRecurringStreams(db, { today: '2026-12-26' });
    const s = db.select().from(recurringStream).all().find((x) => x.expectedAmount === -1000)!;
    // the first new price joins, the next single charges do not chain on from it
    expect(db.select().from(transactions).where(eq(transactions.recurringStreamId, s.id)).all().map((t) => t.amountIls).sort((a, b) => a - b)).toEqual([-1400, -1000, -1000, -1000, -1000, -1000, -1000]);
  });

  it('an older stream whose charges all moved to the new-price stream is removed, not left empty', () => {
    const rows: NormalizedRow[] = [...months.map((m) => bill(`${m}-25`, -10000))];
    for (const m of ['2026-10', '2026-11', '2026-12']) rows.push(bill(`${m}-25`, -12000));
    ingestBatch(db, { source: 'scraper:max', runId: null, accountId: acc, rows: rows.slice(0, 6) });
    prep();
    buildRecurringStreams(db, { today: '2026-10-01' });
    expect(db.select().from(recurringStream).all()).toHaveLength(1);
    ingestBatch(db, { source: 'scraper:max', runId: null, accountId: acc, rows: rows.slice(6) });
    prep();
    // what the code before the fix left: a second stream for the new price, holding the new charges
    const old = db.select().from(recurringStream).get()!;
    const ins = db.insert(recurringStream).values({ ...old, id: undefined, expectedAmount: -12000, amountTolerance: 600, nextExpectedDate: '2027-01-25', occurrences: 3, createdAt: '2026-12-01' }).run();
    db.update(transactions).set({ recurringStreamId: Number(ins.lastInsertRowid) }).where(eq(transactions.amountIls, -12000)).run();
    buildRecurringStreams(db, { today: '2026-12-26' });
    const streams = db.select().from(recurringStream).all();
    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({ expectedAmount: -12000, occurrences: 9 });
  });

  it('a charge on the expected day at three times the price is not taken as a price change', () => {
    ingestBatch(db, { source: 'scraper:max', runId: null, accountId: acc, rows: [...months.map((m) => bill(`${m}-25`, -10000)), bill('2026-10-25', -30000)] });
    prep();
    buildRecurringStreams(db, { today: '2026-11-16' });
    const s = db.select().from(recurringStream).get()!;
    expect(db.select().from(transactions).where(eq(transactions.recurringStreamId, s.id)).all()).toHaveLength(6);
  });
});

describe('stream hygiene', () => {
  it('two hits a year apart form nothing, Bit transfers never form a stream, and a quiet candidate is dropped', () => {
    ingestBatch(db, {
      source: 'scraper:max',
      runId: null,
      accountId: acc,
      rows: [
        row('2025-05-27', -20737, 'דלק מנטה'),
        row('2026-05-27', -20737, 'דלק מנטה'), // 2 hits, annual → not even a candidate
        row('2026-09-01', -4600, 'GROK XAI'),
        row('2026-10-01', -4600, 'GROK XAI'), // 2 hits monthly → candidate
        row('2026-01-09', 6600, 'זיכוי מביט ישראל ישראלי'),
        row('2026-02-09', 6600, 'זיכוי מביט ישראל ישראלי'),
        row('2026-03-09', 6600, 'זיכוי מביט ישראל ישראלי'), // person-to-person: never a stream
      ],
    });
    prep();
    const r1 = buildRecurringStreams(db, { today: '2026-11-08' });
    expect(r1.created).toBe(1);
    expect(db.select().from(recurringStream).all().map((s) => s.state)).toEqual(['candidate']);
    // months later the candidate never came back: it is deleted, not shown as "ended"
    const r2 = buildRecurringStreams(db, { today: '2027-06-01' });
    expect(r2.dropped).toBe(1);
    expect(db.select().from(recurringStream).all()).toHaveLength(0);
  });
});
