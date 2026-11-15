import { describe, expect, it } from 'vitest';
import { ensureAccount } from '../db/accounts.js';
import { openDb } from '../db/db.js';
import { runEngine } from '../engine/run.js';
import { ingestBatch } from '../ingest/ingest.js';
import type { NormalizedRow } from '../ingest/types.js';
import { createEvent, deleteEvent, eventView, eventsOfTxn, listEvents, setEventTxns, updateEvent } from './events.js';
import { listTransactions } from './transactions.js';

const row = (date: string, amount: number, description: string): NormalizedRow => ({ externalAccountId: 'x', date, amount, description, status: 'completed', type: 'normal', identifier: `${description}${date}${amount}`, payload: {} });

function seed() {
  const db = openDb(':memory:');
  const acc = ensureAccount(db, { institutionId: 'max', institutionKind: 'card', institutionDisplayName: 'Max', source: 'scraper:max', externalId: 'm', type: 'credit_card' }).accountId;
  ingestBatch(db, {
    source: 'scraper:max',
    runId: null,
    accountId: acc,
    rows: [row('2026-06-18', -268450, 'SKYWAY AIRLINES'), row('2026-07-03', -45000, 'HOTEL ROMA'), row('2026-07-04', -12000, 'TRATTORIA'), row('2026-07-20', 5000, 'HOTEL ROMA'), row('2026-08-02', -8990, 'SUPERMARKET')],
  });
  runEngine(db);
  // keyed by name, the hotel's refund separately
  const ids = Object.fromEntries(db.$client.prepare('select id, description_norm d, amount_ils a from "transaction"').all().map((r) => [(r as { a: number }).a > 0 ? `${(r as { d: string }).d} refund` : (r as { d: string }).d, (r as { id: number }).id])) as Record<string, number>;
  return { db, ids };
}

describe('events', () => {
  it('tags transactions across months and sums them with a breakdown', () => {
    const { db, ids } = seed();
    const trip = createEvent(db, { name: ' Trip to Rome ', fromDate: '2026-06-01', toDate: '2026-07-31' });
    expect(trip.name).toBe('Trip to Rome');
    expect(trip.count).toBe(0);
    const after = setEventTxns(db, trip.id, { add: [ids['skyway airlines']!, ids['hotel roma']!, ids['trattoria']!, 999_999] });
    expect(after.count).toBe(3);
    expect(after.spent).toBe(268450 + 45000 + 12000);
    expect(after.net).toBe(-(268450 + 45000 + 12000));
    expect(after.firstDate).toBe('2026-06-18');
    expect(after.lastDate).toBe('2026-07-04');
    expect(after.byGroup.length).toBeGreaterThan(0);
    expect(after.byGroup.reduce((a, g) => a + g.sum, 0)).toBe(after.spent);
    expect(after.byCategory.reduce((a, c) => a + c.sum, 0)).toBe(after.spent);
    // the refund from the hotel counts as income inside the event; tagging twice is harmless
    const withRefund = setEventTxns(db, trip.id, { add: [ids['hotel roma']!, ids['hotel roma refund']!] });
    expect(withRefund.count).toBe(4);
    expect(withRefund.income).toBe(5000);
    expect(withRefund.net).toBe(5000 - (268450 + 45000 + 12000));
    // the event's transactions come through the ordinary list filter
    const page = listTransactions(db, { eventId: trip.id, limit: 50 });
    expect(page.total).toBe(4);
    expect(eventsOfTxn(db, ids['trattoria']!)).toEqual([{ id: trip.id, name: 'Trip to Rome' }]);
    expect(eventsOfTxn(db, ids['supermarket']!)).toEqual([]);
  });

  it('edits, archives, untags and deletes', () => {
    const { db, ids } = seed();
    const car = createEvent(db, { name: 'Car repair' });
    setEventTxns(db, car.id, { add: [ids['supermarket']!, ids['trattoria']!] });
    expect(setEventTxns(db, car.id, { remove: [ids['trattoria']!] }).count).toBe(1);
    const renamed = updateEvent(db, car.id, { name: 'Car repair 2026', note: 'gearbox', archived: true });
    expect(renamed).toMatchObject({ name: 'Car repair 2026', note: 'gearbox', archived: true });
    expect(listEvents(db).map((e) => e.id)).not.toContain(car.id);
    expect(listEvents(db, { includeArchived: true }).map((e) => e.id)).toContain(car.id);
    expect(() => updateEvent(db, car.id, { name: '  ' })).toThrow();
    deleteEvent(db, car.id);
    expect(eventView(db, car.id)).toBeNull();
    expect(eventsOfTxn(db, ids['supermarket']!)).toEqual([]);
  });
});
