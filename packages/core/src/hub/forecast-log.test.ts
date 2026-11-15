import { describe, expect, it } from 'vitest';
import { ensureAccount } from '../db/accounts.js';
import { ingestBatch } from '../ingest/ingest.js';
import { openDb } from '../db/db.js';
import type { NormalizedRow } from '../ingest/types.js';
import { runEngine } from '../engine/run.js';
import { backtestBand, forecastAccuracy, forecastChange, logForecast, storedBand } from './forecast-log.js';

const row = (date: string, amount: number, description: string): NormalizedRow => ({ externalAccountId: 'x', date, amount, description, status: 'completed', type: 'normal', identifier: `${description}${date}${amount}`, payload: {} });

/** 16 months of a simple life: salary on the 1st, groceries spread over the month, growing a little. */
function seed() {
  const db = openDb(':memory:');
  const acc = ensureAccount(db, { institutionId: 'max', institutionKind: 'card', institutionDisplayName: 'Max', source: 'scraper:max', externalId: 'm', type: 'credit_card' }).accountId;
  const rows: NormalizedRow[] = [];
  for (let i = 0; i < 16; i++) {
    const d = new Date(Date.UTC(2025, 6 + i, 1));
    const m = d.toISOString().slice(0, 7);
    rows.push(row(`${m}-01`, 1400000, 'SALARY'));
    for (const day of [3, 8, 13, 18, 23, 27]) rows.push(row(`${m}-${String(day).padStart(2, '0')}`, -(40000 + i * 1000 + day * 100), 'SUPERMARKET'));
  }
  ingestBatch(db, { source: 'scraper:max', runId: null, accountId: acc, rows });
  runEngine(db);
  return db;
}

describe('forecast bookkeeping', () => {
  it('backtests the blend on finished months and stores a band once it rests on 12+ months', () => {
    const db = seed();
    const today = '2026-11-09';
    const b = backtestBand(db, { today });
    expect(b.monthsUsed).toBeGreaterThanOrEqual(12);
    expect(b.stored).toBe(true);
    expect(b.rows.map((r) => r.day)).toEqual([5, 10, 15, 20, 25]);
    for (const r of b.rows) expect(r.p10 <= r.p25 && r.p25 <= r.p75 && r.p75 <= r.p90).toBe(true);
    expect(storedBand(db)?.length).toBe(5);
  });

  it('logs today once and judges finished months against their log', () => {
    const db = seed();
    const today = '2026-11-09';
    logForecast(db, today);
    logForecast(db, today);
    const logs = db.$client.prepare('select count(*) n from forecast_log').get() as { n: number };
    expect(logs.n).toBe(1);
    // nothing finished yet with a log → nothing to judge
    expect(forecastAccuracy(db, today).monthsEvaluated).toBe(0);
    // pretend a log existed for October (a finished month) and judge it
    db.$client.prepare(`insert into forecast_log (month, date, day, left_to_spend, room_before_variable, variable_spent, predicted_variable, projected_end, band_lo, band_hi, created_at)
      values ('2026-10', '2026-10-10', 10, 0, 0, 0, 0, 0, -99999999, 99999999, 'x')`).run();
    const acc = forecastAccuracy(db, today);
    expect(acc.monthsEvaluated).toBe(1);
    expect(acc.insideBand).toBe(1);
    expect(acc.maeEnd).not.toBeNull();
  });

  it('explains what moved the number since the previous snapshot', () => {
    const db = seed();
    const today = '2026-11-09';
    // no earlier snapshot this month → nothing to compare against
    expect(forecastChange(db, { today })).toBeNull();
    logForecast(db, '2026-11-08');
    db.$client.prepare(`update forecast_log set created_at = '2026-11-08T18:00:00.000Z' where date = '2026-11-08'`).run();
    const before = forecastChange(db, { today });
    expect(before).toMatchObject({ since: '2026-11-08', delta: 0, arrivedCount: 0 });
    // a purchase arrives after that snapshot
    const acc = (db.$client.prepare('select id from account limit 1').get() as { id: number }).id;
    ingestBatch(db, { source: 'scraper:max', runId: null, accountId: acc, rows: [row('2026-11-09', -80500, 'ESCAPE ROOM')] });
    runEngine(db);
    const after = forecastChange(db, { today });
    expect(after?.delta).toBeLessThan(0);
    expect(after?.arrivedCount).toBe(1);
    expect(after?.arrived[0]).toMatchObject({ amount: -80500 });
    expect(after?.arrived[0]?.name.toLowerCase()).toContain('escape room');
  });
});
