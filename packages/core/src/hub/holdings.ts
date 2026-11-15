/**
 * Holdings behind a securities or foreign-currency account: write a snapshot per sync, read the latest one
 * with each position's value over time (design §6 "Accounts": what is inside, which stocks, their trend).
 */
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/db.js';
import { holdingSnapshot } from '../db/schema.js';
import type { HoldingRow } from '../ingest/fibi-pages.js';

export function recordHoldings(db: Db, p: { accountId: number; runId: number | null; source: string; takenAt?: string; rows: HoldingRow[] }): number {
  if (!p.rows.length) return 0;
  const takenAt = p.takenAt ?? new Date().toISOString();
  db.transaction((tx) => {
    for (const r of p.rows) {
      tx.insert(holdingSnapshot)
        .values({ accountId: p.accountId, syncRunId: p.runId, takenAt, kind: r.kind, symbol: r.symbol, name: r.name, quantity: r.quantity, price: r.price, currency: r.currency, valueIls: r.valueIls, valueOrig: r.valueOrig, costPrice: r.costPrice, dailyChangePct: r.dailyChangePct, fromCostPct: r.fromCostPct, source: p.source })
        .run();
    }
  });
  return p.rows.length;
}

export interface HoldingView extends HoldingRow {
  /** holding_snapshot.id (the live rows carry the same id) */
  id: number;
  /** value in ILS per recorded day, oldest first */
  history: Array<{ date: string; valueIls: number }>;
  /** share of the account's latest total, 0..1 */
  share: number;
}

export interface HoldingsOverview {
  accountId: number;
  takenAt: string | null;
  totalIls: number;
  positions: HoldingView[];
  /** the account's total per recorded day, from the same snapshots */
  history: Array<{ date: string; totalIls: number }>;
}

export function holdingsOverview(db: Db, accountId: number): HoldingsOverview {
  const latest = db.select({ takenAt: holdingSnapshot.takenAt }).from(holdingSnapshot).where(eq(holdingSnapshot.accountId, accountId)).orderBy(desc(holdingSnapshot.takenAt)).limit(1).get();
  if (!latest) return { accountId, takenAt: null, totalIls: 0, positions: [], history: [] };
  const rows = db
    .select()
    .from(holdingSnapshot)
    .where(and(eq(holdingSnapshot.accountId, accountId), eq(holdingSnapshot.takenAt, latest.takenAt)))
    .all();
  const totalIls = rows.reduce((a, r) => a + r.valueIls, 0);
  // per day (latest snapshot of the day wins): each symbol's value and the total
  const days = db.$client
    .prepare(
      `select substr(taken_at, 1, 10) d, max(taken_at) t from holding_snapshot where account_id = ? group by 1 order by 1`,
    )
    .all(accountId) as Array<{ d: string; t: string }>;
  const bySymbol = new Map<string, Array<{ date: string; valueIls: number }>>();
  const history: HoldingsOverview['history'] = [];
  const stmt = db.$client.prepare('select symbol, value_ils v from holding_snapshot where account_id = ? and taken_at = ?');
  for (const day of days) {
    const snap = stmt.all(accountId, day.t) as Array<{ symbol: string; v: number }>;
    history.push({ date: day.d, totalIls: snap.reduce((a, s) => a + s.v, 0) });
    for (const s of snap) {
      const arr = bySymbol.get(s.symbol) ?? [];
      arr.push({ date: day.d, valueIls: s.v });
      bySymbol.set(s.symbol, arr);
    }
  }
  const positions: HoldingView[] = rows
    .map((r) => ({
      id: r.id,
      kind: r.kind as HoldingRow['kind'],
      symbol: r.symbol,
      name: r.name,
      quantity: r.quantity,
      price: r.price,
      currency: r.currency,
      valueIls: r.valueIls,
      valueOrig: r.valueOrig,
      costPrice: r.costPrice,
      dailyChangePct: r.dailyChangePct,
      fromCostPct: r.fromCostPct,
      history: bySymbol.get(r.symbol) ?? [],
      share: totalIls > 0 ? r.valueIls / totalIls : 0,
    }))
    .sort((a, b) => b.valueIls - a.valueIls);
  return { accountId, takenAt: latest.takenAt, totalIls, positions, history };
}
