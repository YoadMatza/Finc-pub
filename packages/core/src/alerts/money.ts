/**
 * Money-out alerts (security research P1-02, P1-03), one per new transaction instead of from the month's
 * attention list: that list caps big purchases at three a month, skips excluded rows (transfers, card bills)
 * and instalments, so a wire out, a fraud split into payments or a fourth big charge never reached Telegram.
 *
 * Only transactions created after `alerts.moneySince` are considered (set on the first run, so turning this
 * on never replays history). Each alert is keyed by a transaction id, so a pending charge that later
 * completes is one alert, and the dispatcher's alert_log sends every key once.
 */
import { getSetting, setSetting } from '../ai/settings.js';
import type { Db } from '../db/db.js';
import { PERSON_TO_PERSON } from '../engine/p2p.js';

export const MONEY_SINCE_SETTING = 'alerts.moneySince';
/**
 * Only rows created in the last few days are looked at: the dispatcher runs hourly and after every sync, so
 * this is ample, and a later change of state (a recurring stream that ends, Telegram set up late, a card bill
 * relinked) can never replay months of old charges (independent review 2026-11-10).
 */
export const MONEY_LOOKBACK_DAYS = 3;
/** A completed charge within this share of an earlier pending one (same card, day, merchant) is the same purchase. */
const PENDING_TWIN_TOLERANCE = 0.15;
/** Charges at one merchant on one card in one day that look like card testing. */
export const CARD_TESTING_MIN = 4;
export const DEFAULT_AMOUNTS = { big: 1000, urgent: 5000 } as const;
/**
 * Unusual charge (wave 5 proposal research_notes/proposals/unusual-charge-alert.md): a charge more than `factor` times
 * the merchant's usual (median of its completed charges on the same account in the last year, at least `minHistory`
 * of them) and at least `minAboveIls` above it.
 */
export const UNUSUAL = { factor: 3, minHistory: 4, minAboveIls: 200, windowDays: 365 } as const;

export type MoneyAlertKind = 'money_out' | 'instalment_purchase' | 'card_bill_gap' | 'card_testing' | 'unusual_charge';

export interface MoneyAlert {
  kind: MoneyAlertKind;
  key: string;
  txnId: number;
  date: string;
  /** Negative agorot: the charge, the plan's total, the bill, or the burst's total. */
  amount: number;
  name: string;
  accountType: string;
  pending: boolean;
  transfer: boolean;
  /** card_bill_gap: debit minus the card rows it settles (negative = the bank took more); instalment_purchase: number of payments; card_testing: number of charges; unusual_charge: past charges counted. */
  detail?: number;
  /** unusual_charge: the merchant's usual charge (negative agorot, the median). */
  reference?: number;
  /** Sent even in quiet hours. */
  urgent: boolean;
}

interface Row {
  id: number;
  account_id: number;
  account_type: string;
  txn_date: string;
  amount_ils: number;
  status: string;
  kind: string | null;
  installment_plan_id: number | null;
  recurring_stream_id: number | null;
  stream_state: string | null;
  merchant_id: number | null;
  name: string;
}

/** The point in time money alerts start from; set to `now` the first time, so history is never sent. */
export function moneySince(db: Db, now: Date = new Date()): string {
  const s = getSetting(db, MONEY_SINCE_SETTING);
  if (s) return s;
  const iso = now.toISOString();
  setSetting(db, MONEY_SINCE_SETTING, iso);
  return iso;
}

/**
 * Every money-out alert for transactions created at or after `since`.
 * Exempt: a card bill that exactly matches its card cycle, a charge that belongs to a confirmed recurring
 * stream (its price changes have their own alert), and voided rows. Everything else that takes at least
 * `bigIls` out alerts, whatever its kind or exclusion (a transfer out is exactly what account takeover looks like).
 */
export function collectMoneyAlerts(
  db: Db,
  opts: {
    since: string;
    bigIls?: number;
    urgentIls?: number;
    /** Rows created after this have not been through the engine yet (mid-sync) and wait for the next dispatch. */
    processedUntil?: string;
    /** For the lookback window; omit to look back without a limit (tests, replays). */
    now?: Date;
    /** unusual_charge: how many times the merchant's usual (default UNUSUAL.factor) */
    unusualFactor?: number;
    /** only charges of this cash-flow month (the hub's attention list) */
    month?: string;
  },
): MoneyAlert[] {
  const big = Math.round((opts.bigIls ?? DEFAULT_AMOUNTS.big) * 100);
  const urgent = Math.round((opts.urgentIls ?? DEFAULT_AMOUNTS.urgent) * 100);
  const lookback = opts.now ? new Date(opts.now.getTime() - MONEY_LOOKBACK_DAYS * 86_400_000).toISOString() : '';
  const from = lookback > opts.since ? lookback : opts.since;
  const c = db.$client;
  const fresh = c
    .prepare(
      `select t.id, t.account_id, a.type account_type, t.txn_date, t.amount_ils, t.status, t.kind, t.installment_plan_id, t.recurring_stream_id,
              rs.state stream_state, t.merchant_id, coalesce(m.name, t.description_raw) name
       from "transaction" t join account a on a.id = t.account_id
       left join merchant m on m.id = t.merchant_id
       left join recurring_stream rs on rs.id = t.recurring_stream_id
       where t.created_at >= ? and t.created_at <= ? and t.status != 'voided' and t.amount_ils < 0 and (? = '' or t.cashflow_month = ?)
       order by t.txn_date, t.id`,
    )
    .all(from, opts.processedUntil ?? '9999', opts.month ?? '', opts.month ?? '') as Row[];

  const out: MoneyAlert[] = [];
  const base = (r: Row) => ({ txnId: r.id, date: r.txn_date, name: r.name, accountType: r.account_type, pending: r.status === 'pending', transfer: r.kind === 'transfer' });

  // card bills: exact ones are fine; a bill the engine accepted with a gap (5% tolerance) is not
  const gapOf = c.prepare(
    `select count(*) n, sum(case when l.zone = 'suggest' then 1 else 0 end) suggest, coalesce(sum(t.amount_ils), 0) cards
     from link l join "transaction" t on t.id = l.to_txn_id where l.type = 'card_settlement' and l.from_txn_id = ? and coalesce(l.decision, '') != 'rejected'`,
  );
  // shekel payments × count: original_amount can be in the purchase's own currency (a USD plan)
  const planOf = c.prepare(`select total_n, slice_amount from installment_plan where id = ?`);
  const firstSliceOf = c.prepare(`select id from "transaction" where installment_plan_id = ? and status != 'voided' order by txn_date, id limit 1`);
  // the same purchase seen earlier as pending at a different amount (FX, a tip) stays a separate row; alert once
  const earlierPending = c.prepare(
    `select 1 from "transaction" p where p.account_id = ? and p.txn_date = ? and p.id <> ? and p.status in ('pending', 'voided') and p.created_at <= ?
       and (p.merchant_id = ? or (p.merchant_id is null and p.description_raw = ?)) and abs(p.amount_ils - ?) <= abs(?) * ${PENDING_TWIN_TOLERANCE}
       and p.amount_ils <= ? limit 1`,
  );
  const createdAt = c.prepare(`select created_at from "transaction" where id = ?`);
  // the merchant's usual: its completed charges on the same account in the year before this one (instalments,
  // transfers and card bills are not "usual" spending)
  const history = c.prepare(
    `select amount_ils a from "transaction" where account_id = ? and merchant_id = ? and id <> ? and status = 'completed' and amount_ils < 0
       and installment_plan_id is null and coalesce(kind, '') not in ('transfer', 'settlement', 'refund')
       and txn_date < ? and txn_date >= date(?, '-${UNUSUAL.windowDays} days')`,
  );
  const factor = opts.unusualFactor ?? UNUSUAL.factor;
  const minAbove = UNUSUAL.minAboveIls * 100;
  const unusual = (r: Row): MoneyAlert | null => {
    if (r.merchant_id === null || r.kind === 'transfer' || r.kind === 'settlement' || PERSON_TO_PERSON.test(r.name)) return null;
    const past = (history.all(r.account_id, r.merchant_id, r.id, r.txn_date, r.txn_date) as Array<{ a: number }>).map((x) => -x.a).sort((x, y) => x - y);
    if (past.length < UNUSUAL.minHistory) return null;
    const mid = past.length / 2;
    const usual = past.length % 2 ? past[Math.floor(mid)]! : Math.round((past[mid - 1]! + past[mid]!) / 2);
    const amount = -r.amount_ils;
    const threshold = Math.max(usual * factor, usual + minAbove);
    if (amount <= usual * factor || amount - usual < minAbove) return null;
    if (r.status === 'completed') {
      const at = (createdAt.get(r.id) as { created_at: string }).created_at;
      // the same purchase seen earlier as pending, already unusual then: one alert
      if (earlierPending.get(r.account_id, r.txn_date, r.id, at, r.merchant_id, r.name, r.amount_ils, r.amount_ils, -threshold)) return null;
    }
    return { kind: 'unusual_charge', key: `unusual:${r.id}`, ...base(r), amount: r.amount_ils, reference: -usual, detail: past.length, urgent: false };
  };

  for (const r of fresh) {
    if (r.kind === 'settlement') {
      const g = gapOf.get(r.id) as { n: number; suggest: number; cards: number };
      if (g.n > 0 && g.suggest === 0) continue; // an exact card bill
      if (g.n > 0) {
        const gap = r.amount_ils - g.cards; // negative: the bank took more than the cards charged
        out.push({ kind: 'card_bill_gap', key: `billgap:${r.id}`, ...base(r), amount: r.amount_ils, detail: gap, urgent: false });
        continue;
      }
    }
    if (r.installment_plan_id !== null) {
      // one alert per new plan, on its full amount, from its first slice
      const first = firstSliceOf.get(r.installment_plan_id) as { id: number } | undefined;
      if (first?.id !== r.id) continue;
      const p = planOf.get(r.installment_plan_id) as { total_n: number; slice_amount: number } | undefined;
      const total = p ? -Math.abs(p.slice_amount * p.total_n) : r.amount_ils;
      if (-total < big) continue;
      out.push({ kind: 'instalment_purchase', key: `plan:${r.id}`, ...base(r), amount: total, detail: p?.total_n ?? 0, urgent: -total >= urgent });
      continue;
    }
    if (r.stream_state === 'confirmed') continue; // expected; price changes alert on their own
    if (-r.amount_ils < big) {
      const u = unusual(r);
      if (u) out.push(u);
      continue;
    }
    if (r.status === 'completed') {
      const at = (createdAt.get(r.id) as { created_at: string }).created_at;
      // skip only when that pending copy was itself big enough to have alerted
      if (earlierPending.get(r.account_id, r.txn_date, r.id, at, r.merchant_id, r.name, r.amount_ils, r.amount_ils, -big)) continue;
    }
    out.push({ kind: 'money_out', key: `out:${r.id}`, ...base(r), amount: r.amount_ils, urgent: -r.amount_ils >= urgent });
  }

  // card testing: several charges at one merchant on one card in one day. Completed charges only: a pending
  // copy of a purchase can sit next to its completed copy for days, which would double the count.
  const groups = new Map<string, Row[]>();
  for (const r of fresh) {
    if (r.account_type !== 'credit_card' || r.status !== 'completed') continue;
    const k = `${r.account_id}|${r.txn_date}|${r.merchant_id ?? r.name}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  for (const [k, rows] of groups) {
    // count the day's charges at that merchant, including ones that arrived before `since`
    const [acc, date] = k.split('|') as [string, string];
    const first = rows[0]!;
    const all = c
      .prepare(
        `select count(*) n, sum(amount_ils) s from "transaction" where account_id = ? and txn_date = ? and amount_ils < 0 and status = 'completed'
         and ${first.merchant_id !== null ? 'merchant_id = ?' : 'coalesce(merchant_id, -1) = -1 and description_raw = ?'}`,
      )
      .get(Number(acc), date, first.merchant_id ?? first.name) as { n: number; s: number };
    if (all.n < CARD_TESTING_MIN) continue;
    out.push({ kind: 'card_testing', key: `burst:${acc}:${date}:${first.merchant_id ?? first.name}`, ...base(first), amount: all.s, detail: all.n, urgent: true });
  }
  return out;
}
