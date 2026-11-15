/** Accounts screen: balances with history, card cycles with the next billing, connection health. */
import type { Db } from '../db/db.js';
import { type ConnectionHealth, connectionHealth, recentRuns } from '../health.js';
import { type PriceCache, liveAccountValue } from '../prices/live.js';
import { addDays, todayLocal } from './overview.js';

export interface AccountView {
  id: number;
  institutionId: string;
  displayName: string | null;
  type: string;
  last4: string | null;
  currency: string;
  balance: { amount: number; takenAt: string; source: string } | null;
  balanceHistory: Array<{ date: string; balance: number }>;
  txns: number;
  pending: number;
  newestTxnDate: string | null;
  /**
   * Cards: what the card company will take next, computed from our own rows, not from the scraper's
   * opaque "balance". A bill is every row whose charge_date falls in the same month as the earliest
   * upcoming charge date (Max spreads one bill over several charge dates; Isracard uses one).
   * Checked 2026-11-09 against the Max and Isracard apps to the agora.
   */
  card: {
    /** first charge date of the next bill and the month's total booked so far */
    nextBillingDate: string | null;
    nextBillingAmount: number;
    nextBillingRows: number;
    /** the bill that was most recently charged */
    lastBillingDate: string | null;
    lastBillingAmount: number;
    /** spend since the last billing date, by purchase date */
    cycleSpend: number;
  } | null;
  /** securities / foreign-currency accounts: the balance revalued at live prices (agorot), when any of it is live */
  liveValueIls?: number;
  /** ISO time of the oldest live price or rate behind liveValueIls */
  liveAsOf?: string;
  /** 'live' while the US session is open, 'closed' when the values are the latest close */
  liveState?: 'live' | 'closed';
}

/** The price cache and clock for the live fields; without it the payload is exactly the bank's. */
export interface LiveOption {
  live?: { cache: PriceCache; now: number };
}

export const LIVE_ACCOUNT_TYPES = new Set(['securities', 'foreign_currency']);

export interface AccountsOverview {
  accounts: AccountView[];
  connections: ConnectionHealth[];
  runs: ReturnType<typeof recentRuns>;
}

export function accountsOverview(db: Db, opts: LiveOption = {}): AccountsOverview {
  const c = db.$client;
  const today = todayLocal();
  const rows = c.prepare('select * from account order by case type when \'checking\' then 0 else 1 end, id').all() as Array<Record<string, unknown>>;
  const accounts: AccountView[] = rows.map((a) => {
    const id = a.id as number;
    const latest = c.prepare('select balance, taken_at, source from balance_snapshot where account_id = ? order by taken_at desc limit 1').get(id) as { balance: number; taken_at: string; source: string } | undefined;
    const history = (
      c.prepare(`select substr(taken_at, 1, 10) d, balance from balance_snapshot where account_id = ? and taken_at >= ? group by 1 order by 1`).all(id, `${addDays(today, -180)}T00:00:00`) as Array<{ d: string; balance: number }>
    ).map((h) => ({ date: h.d, balance: h.balance }));
    const stats = c.prepare(`select count(*) n, sum(case when status = 'pending' then 1 else 0 end) p, max(txn_date) newest from "transaction" where account_id = ? and status <> 'voided'`).get(id) as { n: number; p: number; newest: string | null };
    let card: AccountView['card'] = null;
    if ((a.type as string) === 'credit_card') {
      const next = c
        .prepare(
          `select min(charge_date) d, sum(amount_ils) v, count(*) n from "transaction" where account_id = ? and status <> 'voided'
             and substr(charge_date, 1, 7) = (select substr(min(charge_date), 1, 7) from "transaction" where account_id = ? and status <> 'voided' and charge_date >= ?)`,
        )
        .get(id, id, today) as { d: string | null; v: number | null; n: number } | undefined;
      const last = c
        .prepare(
          `select max(charge_date) d, sum(amount_ils) v from "transaction" where account_id = ? and status = 'completed'
             and substr(charge_date, 1, 7) = (select substr(max(charge_date), 1, 7) from "transaction" where account_id = ? and status = 'completed' and charge_date < ?)`,
        )
        .get(id, id, today) as { d: string | null; v: number | null } | undefined;
      const cycle = c.prepare(`select coalesce(sum(amount_ils),0) v from "transaction" where account_id = ? and status <> 'voided' and txn_date > ? and amount_ils < 0`).get(id, last?.d ?? '1970-01-01') as { v: number };
      card = { nextBillingDate: next?.d ?? null, nextBillingAmount: next?.v ?? 0, nextBillingRows: next?.n ?? 0, lastBillingDate: last?.d ?? null, lastBillingAmount: last?.v ?? 0, cycleSpend: cycle.v };
    }
    return {
      id,
      institutionId: a.institution_id as string,
      displayName: (a.display_name as string | null) ?? null,
      type: a.type as string,
      last4: (a.last4 as string | null) ?? null,
      currency: a.currency as string,
      balance: latest ? { amount: latest.balance, takenAt: latest.taken_at, source: latest.source } : null,
      balanceHistory: history,
      txns: stats.n,
      pending: stats.p,
      newestTxnDate: stats.newest,
      card,
      ...(opts.live && LIVE_ACCOUNT_TYPES.has(a.type as string) ? (liveAccountValue(db, id, latest ? latest.balance : null, opts.live.cache, opts.live.now) ?? {}) : {}),
    };
  });
  return { accounts, connections: connectionHealth(db), runs: recentRuns(db, 30) };
}
