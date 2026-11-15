/**
 * Net worth (design §6): what finc knows you have minus what you owe, now and over time.
 *  - bank, foreign-currency and securities accounts: the latest balance snapshot
 *  - cards: what has been charged but not yet taken from the bank (rows whose charge date is still ahead)
 *  - manual holdings (pension, savings plan, a loan…): the latest hand-entered value
 * History is rebuilt from the same three sources at each date a balance was recorded.
 */
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/db.js';
import { manualAsset, manualAssetValue } from '../db/schema.js';
import { liveAccountValue } from '../prices/live.js';
import { LIVE_ACCOUNT_TYPES, type LiveOption } from './accounts.js';
import { todayLocal } from './overview.js';

export type Side = 'asset' | 'liability';

export interface NetWorthLine {
  key: string;
  name: string;
  kind: string; // checking | savings | foreign_currency | securities | credit_card | pension | investment | property | cash | loan | other
  side: Side;
  /** minor, positive */
  value: number;
  asOf: string | null;
  source: 'snapshot' | 'cards' | 'manual';
  accountId?: number;
  manualId?: number;
  currency: string;
  /** securities / foreign-currency lines: the value at live prices (agorot, positive), when any of it is live; totals stay on `value` */
  liveValueIls?: number;
  liveAsOf?: string;
  liveState?: 'live' | 'closed';
}

export interface ManualHolding {
  id: number;
  name: string;
  kind: string;
  side: Side;
  currency: string;
  note: string | null;
  archived: boolean;
  value: number | null;
  asOf: string | null;
  history: Array<{ date: string; value: number }>;
}

export interface NetWorthOverview {
  today: string;
  total: number;
  assets: number;
  liabilities: number;
  lines: NetWorthLine[];
  history: Array<{ date: string; total: number; assets: number; liabilities: number }>;
  manual: ManualHolding[];
}

const now = () => new Date().toISOString();
const BANK_TYPES = new Set(['checking', 'savings', 'foreign_currency', 'securities', 'cash']);

interface AccountRow {
  id: number;
  type: string;
  display_name: string | null;
  institution_id: string;
  currency: string;
}

/** Latest snapshot at or before the end of `date` per non-card account. */
function balancesAt(db: Db, accounts: AccountRow[], date: string): Map<number, { balance: number; takenAt: string }> {
  const out = new Map<number, { balance: number; takenAt: string }>();
  const stmt = db.$client.prepare('select balance, taken_at from balance_snapshot where account_id = ? and taken_at <= ? order by taken_at desc limit 1');
  for (const a of accounts) {
    const r = stmt.get(a.id, `${date}T23:59:59.999Z`) as { balance: number; taken_at: string } | undefined;
    if (r) out.set(a.id, { balance: r.balance, takenAt: r.taken_at });
  }
  return out;
}

/**
 * Charged on the card and not yet taken from the bank at `date` (positive = owed). For today every
 * booked row counts, including installment slices the card already dates ahead; for a past date only
 * what had been bought by then, since the booking date is not known.
 */
function cardOwedAt(db: Db, cardIds: number[], date: string, everythingBooked: boolean): Map<number, number> {
  const out = new Map<number, number>();
  const stmt = db.$client.prepare(`select coalesce(-sum(amount_ils), 0) v from "transaction" where account_id = ? and status = 'completed' and (txn_date <= ? or ?) and coalesce(charge_date, txn_date) > ?`);
  for (const id of cardIds) out.set(id, (stmt.get(id, date, everythingBooked ? 1 : 0, date) as { v: number }).v);
  return out;
}

function manualAt(db: Db, ids: number[], date: string): Map<number, { value: number; date: string }> {
  const out = new Map<number, { value: number; date: string }>();
  const stmt = db.$client.prepare('select value, date from manual_asset_value where asset_id = ? and date <= ? order by date desc limit 1');
  for (const id of ids) {
    const r = stmt.get(id, date) as { value: number; date: string } | undefined;
    if (r) out.set(id, r);
  }
  return out;
}

export function netWorthOverview(db: Db, opts: { today?: string } & LiveOption = {}): NetWorthOverview {
  const today = opts.today ?? todayLocal();
  const accounts = db.$client.prepare('select id, type, display_name, institution_id, currency from account').all() as AccountRow[];
  const banks = accounts.filter((a) => BANK_TYPES.has(a.type));
  const cards = accounts.filter((a) => a.type === 'credit_card');
  const manuals = db.select().from(manualAsset).where(eq(manualAsset.archived, false)).all();

  const lines: NetWorthLine[] = [];
  const bal = balancesAt(db, banks, today);
  for (const a of banks) {
    const b = bal.get(a.id);
    if (!b) continue;
    const live = opts.live && LIVE_ACCOUNT_TYPES.has(a.type) && b.balance >= 0 ? liveAccountValue(db, a.id, b.balance, opts.live.cache, opts.live.now) : null;
    lines.push({ key: `account:${a.id}`, name: a.display_name ?? a.institution_id, kind: a.type, side: b.balance >= 0 ? 'asset' : 'liability', value: Math.abs(b.balance), asOf: b.takenAt.slice(0, 10), source: 'snapshot', accountId: a.id, currency: a.currency, ...(live && live.liveValueIls >= 0 ? live : {}) });
  }
  const owed = cardOwedAt(
    db,
    cards.map((c) => c.id),
    today,
    true,
  );
  for (const a of cards) {
    const v = owed.get(a.id) ?? 0;
    lines.push({ key: `account:${a.id}`, name: a.display_name ?? a.institution_id, kind: 'credit_card', side: v >= 0 ? 'liability' : 'asset', value: Math.abs(v), asOf: today, source: 'cards', accountId: a.id, currency: a.currency });
  }
  const mv = manualAt(
    db,
    manuals.map((m) => m.id),
    today,
  );
  for (const m of manuals) {
    const v = mv.get(m.id);
    if (!v) continue;
    lines.push({ key: `manual:${m.id}`, name: m.name, kind: m.kind, side: m.side as Side, value: v.value, asOf: v.date, source: 'manual', manualId: m.id, currency: m.currency });
  }
  const assets = lines.filter((l) => l.side === 'asset').reduce((a, l) => a + l.value, 0);
  const liabilities = lines.filter((l) => l.side === 'liability').reduce((a, l) => a + l.value, 0);

  // history: every day a bank balance or a manual value was recorded, thinned, plus today
  const days = new Set<string>();
  for (const a of banks) for (const r of db.$client.prepare('select distinct substr(taken_at, 1, 10) d from balance_snapshot where account_id = ? and taken_at <= ?').all(a.id, `${today}T23:59:59.999Z`) as Array<{ d: string }>) days.add(r.d);
  for (const r of db.$client.prepare('select distinct date d from manual_asset_value where date <= ?').all(today) as Array<{ d: string }>) days.add(r.d);
  days.add(today);
  let dates = [...days].sort();
  if (dates.length > 90) {
    const step = (dates.length - 1) / 89;
    dates = Array.from({ length: 90 }, (_, i) => dates[Math.round(i * step)]!);
  }
  const history = dates.map((d) => {
    const b = balancesAt(db, banks, d);
    const o = cardOwedAt(
      db,
      cards.map((c) => c.id),
      d,
      d === today,
    );
    const m = manualAt(
      db,
      manuals.map((x) => x.id),
      d,
    );
    let as = 0;
    let li = 0;
    for (const v of b.values()) v.balance >= 0 ? (as += v.balance) : (li += -v.balance);
    for (const v of o.values()) v >= 0 ? (li += v) : (as += -v);
    for (const x of manuals) {
      const v = m.get(x.id);
      if (!v) continue;
      x.side === 'liability' ? (li += v.value) : (as += v.value);
    }
    return { date: d, total: as - li, assets: as, liabilities: li };
  });

  const manual: ManualHolding[] = db
    .select()
    .from(manualAsset)
    .all()
    .sort((a, b) => a.id - b.id)
    .map((m) => {
      const hist = db.select({ date: manualAssetValue.date, value: manualAssetValue.value }).from(manualAssetValue).where(eq(manualAssetValue.assetId, m.id)).orderBy(manualAssetValue.date).all();
      const last = hist[hist.length - 1];
      return { id: m.id, name: m.name, kind: m.kind, side: m.side as Side, currency: m.currency, note: m.note, archived: m.archived, value: last?.value ?? null, asOf: last?.date ?? null, history: hist };
    });

  return { today, total: assets - liabilities, assets, liabilities, lines, history, manual };
}

export const MANUAL_KINDS = ['pension', 'savings', 'investment', 'property', 'cash', 'loan', 'other'] as const;

export function createManual(db: Db, input: { name: string; kind: string; side?: Side; currency?: string; note?: string | null; value: number; date?: string }): ManualHolding {
  const name = input.name.trim();
  if (!name) throw new Error('a holding needs a name');
  const ts = now();
  const side: Side = input.side ?? (input.kind === 'loan' ? 'liability' : 'asset');
  const r = db
    .insert(manualAsset)
    .values({ name, kind: input.kind, side, currency: input.currency ?? 'ILS', note: input.note ?? null, archived: false, createdAt: ts, updatedAt: ts })
    .run();
  const id = Number(r.lastInsertRowid);
  setManualValue(db, id, { value: input.value, date: input.date ?? todayLocal() });
  return manualHolding(db, id)!;
}

export function updateManual(db: Db, id: number, patch: { name?: string; kind?: string; side?: Side; note?: string | null; archived?: boolean }): ManualHolding {
  const set: Partial<typeof manualAsset.$inferInsert> = { updatedAt: now() };
  if (patch.name !== undefined) {
    if (!patch.name.trim()) throw new Error('a holding needs a name');
    set.name = patch.name.trim();
  }
  if (patch.kind !== undefined) set.kind = patch.kind;
  if (patch.side !== undefined) set.side = patch.side;
  if (patch.note !== undefined) set.note = patch.note;
  if (patch.archived !== undefined) set.archived = patch.archived;
  db.update(manualAsset).set(set).where(eq(manualAsset.id, id)).run();
  const h = manualHolding(db, id);
  if (!h) throw new Error(`no holding #${id}`);
  return h;
}

/** Record the value as of a date (one per day; a second entry for the same day replaces the first). */
export function setManualValue(db: Db, id: number, v: { value: number; date: string }): ManualHolding {
  if (!Number.isFinite(v.value) || v.value < 0) throw new Error('a value is a positive amount');
  db.delete(manualAssetValue).where(and(eq(manualAssetValue.assetId, id), eq(manualAssetValue.date, v.date))).run();
  db.insert(manualAssetValue).values({ assetId: id, date: v.date, value: Math.round(v.value), createdAt: now() }).run();
  db.update(manualAsset).set({ updatedAt: now() }).where(eq(manualAsset.id, id)).run();
  const h = manualHolding(db, id);
  if (!h) throw new Error(`no holding #${id}`);
  return h;
}

export function deleteManual(db: Db, id: number): void {
  db.delete(manualAssetValue).where(eq(manualAssetValue.assetId, id)).run();
  db.delete(manualAsset).where(eq(manualAsset.id, id)).run();
}

function manualHolding(db: Db, id: number): ManualHolding | null {
  return netWorthOverview(db).manual.find((m) => m.id === id) ?? null;
}
