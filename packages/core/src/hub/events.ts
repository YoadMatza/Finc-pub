/**
 * Events (design §7): tag transactions across months ("Trip to Rome", "Car repair 2026") and see
 * what they cost, with a breakdown by group and category. A transaction may belong to several events;
 * tagging never changes how a month is counted.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/db.js';
import { event, eventTxn, transactions } from '../db/schema.js';

export interface EventView {
  id: number;
  name: string;
  note: string | null;
  fromDate: string | null;
  toDate: string | null;
  archived: boolean;
  count: number;
  /** minor, positive: what went out */
  spent: number;
  /** minor, positive: credits tagged into the event (refunds, contributions) */
  income: number;
  /** income − spent, signed: the event's cost is −net when negative */
  net: number;
  firstDate: string | null;
  lastDate: string | null;
  byGroup: Array<{ group: string; sum: number }>;
  byCategory: Array<{ key: string | null; nameHe: string | null; nameEn: string | null; sum: number; count: number }>;
}

interface Totals {
  n: number;
  spent: number;
  income: number;
  d0: string | null;
  d1: string | null;
}

const now = () => new Date().toISOString();

function totals(db: Db, ids: number[]): Map<number, Totals> {
  if (!ids.length) return new Map();
  const rows = db.$client
    .prepare(
      `select et.event_id id, count(*) n,
              sum(case when t.amount_ils < 0 then -t.amount_ils else 0 end) spent,
              sum(case when t.amount_ils > 0 then t.amount_ils else 0 end) income,
              min(t.txn_date) d0, max(t.txn_date) d1
       from event_txn et join "transaction" t on t.id = et.txn_id
       where t.status <> 'voided' and et.event_id in (${ids.map(() => '?').join(',')})
       group by et.event_id`,
    )
    .all(...ids) as Array<Totals & { id: number }>;
  return new Map(rows.map((r) => [r.id, r]));
}

function breakdown(db: Db, id: number): Pick<EventView, 'byGroup' | 'byCategory'> {
  const rows = db.$client
    .prepare(
      `select coalesce(c.group_key, 'uncategorised') g, c.key, c.name_he, c.name_en, sum(-t.amount_ils) s, count(*) n
       from event_txn et join "transaction" t on t.id = et.txn_id left join category c on c.id = t.category_id
       where et.event_id = ? and t.amount_ils < 0 and t.status <> 'voided'
       group by 1, 2, 3, 4 order by s desc`,
    )
    .all(id) as Array<{ g: string; key: string | null; name_he: string | null; name_en: string | null; s: number; n: number }>;
  const groups = new Map<string, number>();
  for (const r of rows) groups.set(r.g, (groups.get(r.g) ?? 0) + r.s);
  return {
    byGroup: [...groups.entries()].map(([group, sum]) => ({ group, sum })).sort((a, b) => b.sum - a.sum),
    byCategory: rows.slice(0, 6).map((r) => ({ key: r.key, nameHe: r.name_he, nameEn: r.name_en, sum: r.s, count: r.n })),
  };
}

function toView(db: Db, e: typeof event.$inferSelect, t: Totals | undefined, withBreakdown: boolean): EventView {
  const spent = t?.spent ?? 0;
  const income = t?.income ?? 0;
  return {
    id: e.id,
    name: e.name,
    note: e.note,
    fromDate: e.fromDate,
    toDate: e.toDate,
    archived: e.archived,
    count: t?.n ?? 0,
    spent,
    income,
    net: income - spent,
    firstDate: t?.d0 ?? null,
    lastDate: t?.d1 ?? null,
    ...(withBreakdown ? breakdown(db, e.id) : { byGroup: [], byCategory: [] }),
  };
}

/** Active events (or all), newest first, each with its totals and group breakdown. */
export function listEvents(db: Db, opts: { includeArchived?: boolean } = {}): EventView[] {
  const rows = (opts.includeArchived ? db.select().from(event).all() : db.select().from(event).where(eq(event.archived, false)).all()).sort((a, b) => b.id - a.id);
  const tt = totals(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => toView(db, r, tt.get(r.id), true));
}

export function eventView(db: Db, id: number): EventView | null {
  const e = db.select().from(event).where(eq(event.id, id)).get();
  if (!e) return null;
  return toView(db, e, totals(db, [id]).get(id), true);
}

export interface EventPatch {
  name?: string;
  note?: string | null;
  fromDate?: string | null;
  toDate?: string | null;
  archived?: boolean;
}

export function createEvent(db: Db, input: { name: string; note?: string | null; fromDate?: string | null; toDate?: string | null }): EventView {
  const name = input.name.trim();
  if (!name) throw new Error('an event needs a name');
  const ts = now();
  const r = db
    .insert(event)
    .values({ name, note: input.note ?? null, fromDate: input.fromDate ?? null, toDate: input.toDate ?? null, archived: false, createdAt: ts, updatedAt: ts })
    .run();
  return eventView(db, Number(r.lastInsertRowid))!;
}

export function updateEvent(db: Db, id: number, patch: EventPatch): EventView {
  const e = db.select().from(event).where(eq(event.id, id)).get();
  if (!e) throw new Error(`no event #${id}`);
  const set: Partial<typeof event.$inferInsert> = { updatedAt: now() };
  if (patch.name !== undefined) {
    if (!patch.name.trim()) throw new Error('an event needs a name');
    set.name = patch.name.trim();
  }
  if (patch.note !== undefined) set.note = patch.note;
  if (patch.fromDate !== undefined) set.fromDate = patch.fromDate;
  if (patch.toDate !== undefined) set.toDate = patch.toDate;
  if (patch.archived !== undefined) set.archived = patch.archived;
  db.update(event).set(set).where(eq(event.id, id)).run();
  return eventView(db, id)!;
}

/** Removes the event and its tags; the transactions themselves are untouched. */
export function deleteEvent(db: Db, id: number): void {
  db.delete(eventTxn).where(eq(eventTxn.eventId, id)).run();
  db.delete(event).where(eq(event.id, id)).run();
}

/** Tag or untag transactions. Unknown ids are ignored, double tags are harmless. */
export function setEventTxns(db: Db, id: number, change: { add?: number[]; remove?: number[] }): EventView {
  const e = db.select().from(event).where(eq(event.id, id)).get();
  if (!e) throw new Error(`no event #${id}`);
  const ts = now();
  db.transaction((tx) => {
    const add = [...new Set(change.add ?? [])];
    if (add.length) {
      const existing = new Set(
        tx
          .select({ id: transactions.id })
          .from(transactions)
          .where(inArray(transactions.id, add))
          .all()
          .map((r) => r.id),
      );
      for (const txnId of add) if (existing.has(txnId)) tx.insert(eventTxn).values({ eventId: id, txnId, addedAt: ts }).onConflictDoNothing().run();
    }
    const remove = change.remove ?? [];
    if (remove.length) tx.delete(eventTxn).where(and(eq(eventTxn.eventId, id), inArray(eventTxn.txnId, remove))).run();
    tx.update(event).set({ updatedAt: ts }).where(eq(event.id, id)).run();
  });
  return eventView(db, id)!;
}

/** The events one transaction belongs to (for its detail sheet). */
export function eventsOfTxn(db: Db, txnId: number): Array<{ id: number; name: string }> {
  return db.$client.prepare('select e.id, e.name from event_txn et join event e on e.id = et.event_id where et.txn_id = ? order by e.id desc').all(txnId) as Array<{ id: number; name: string }>;
}
