/**
 * Transactions as the hub shows them: merchant name, category, account, badges, linked refunds.
 * Buckets follow the counting rules of §7b exactly as monthSummary applies them, so a click on a
 * number in the hub lists precisely the rows behind it.
 */
import { eventsOfTxn } from './events.js';
import type { Db } from '../db/db.js';
import type { View } from '../engine/summary.js';
import { PAID_BACK } from '../engine/rules.js';
import { type PaidBackContext, paidBackContext } from './paidback.js';
import { type SplitPartView, splitOf } from './splits.js';

export type TxnBucket = 'income' | 'fixed' | 'variable' | 'installments' | 'savings' | 'settlements' | 'transfers' | 'refunds' | 'excluded';

export interface TxnFilters {
  month?: string;
  view?: View;
  from?: string;
  to?: string;
  accountId?: number;
  categoryId?: number;
  group?: string;
  bucket?: TxnBucket | 'uncategorised' | 'pending' | 'cancelled';
  status?: 'pending' | 'completed' | 'voided';
  merchantId?: number;
  streamId?: number;
  planId?: number;
  q?: string;
  /** only rows tagged into this event */
  eventId?: number;
  /** default: excluded rows (settlements, transfers, refunds) are hidden */
  includeExcluded?: boolean;
  limit?: number;
  offset?: number;
  sort?: 'date' | 'amount';
}

export interface LinkedRefund {
  linkId: number;
  txnId: number;
  date: string;
  amount: number;
  zone: string;
  decision: string | null;
  description: string;
}

export interface TxnListItem {
  id: number;
  date: string;
  chargeDate: string | null;
  month: string;
  amount: number;
  /** amount after its refunds are netted (what the month counts) */
  netAmount: number;
  originalAmount: number | null;
  originalCurrency: string;
  name: string;
  /** the merchant table's name only (null when the row has none); `name` falls back to the description */
  merchantName: string | null;
  descriptionRaw: string;
  memo: string | null;
  accountId: number;
  accountName: string | null;
  accountType: string;
  institutionId: string;
  status: string;
  kind: string | null;
  bucket: TxnBucket;
  excluded: boolean;
  categoryId: number | null;
  categoryKey: string | null;
  /** split across categories (hub/splits.ts); the parts are in the detail */
  split: boolean;
  categorySource: string | null;
  categoryConfidence: number | null;
  merchantId: number | null;
  installment: { n: number; total: number; planId: number | null } | null;
  streamId: number | null;
  note: string | null;
  /** the owner's re-tag of this income payment (Now screen); null = by its category */
  incomeKind: 'regular' | 'extra' | null;
  /** marked as paid back to the owner (kind 'paid_back'): counted against day-to-day spending, not as income */
  paidBack: boolean;
  /** paid back, and a 'paid_back' counterparty rule matches it (the owner answered "always" for this payer) */
  paidBackByRule: boolean;
  /** finc asks whether this payment is paying the owner back (hub/paidback.ts) */
  askPaidBack: boolean;
  /** the answers that remember the payer (always / no) are offered: the description is specific to one payer */
  canRemember: boolean;
  refunds: LinkedRefund[];
  /** when this row is a refund/cancellation of another purchase */
  refundOf: { linkId: number; txnId: number; date: string; amount: number; description: string; zone: string; decision: string | null } | null;
  /** on a bank row that pays a card (card_settlement links from it): what it paid */
  settles?: CardSettles;
  /** on a card row paid by a bank settlement: the bank row that paid it */
  settledBy?: SettledBy;
}

/**
 * `account` is the card's institution name ("Max"), never an account name or number. `first` is set
 * when the payment covers exactly one card row (an immediate charge); a monthly bill only has a count.
 */
export interface CardSettles {
  count: number;
  account: string;
  first?: { txnId: number; description: string; date: string; amount: number };
}

export interface SettledBy {
  txnId: number;
  date: string;
  account: string;
  /** how many card rows that bank debit paid (rejected links ignored): 1-3 is an immediate charge, more a monthly bill */
  count: number;
}

export interface TxnPage {
  items: TxnListItem[];
  total: number;
  sum: number;
  netSum: number;
}

const MONTH_EXPR = (view: View) =>
  view === 'billing' ? `case when a.type = 'credit_card' then substr(coalesce(t.charge_date, t.txn_date), 1, 7) else t.cashflow_month end` : `t.cashflow_month`;

/** The §7b bucket of a row, as SQL (mirrors monthSummary). */
const BUCKET_EXPR = `case
  when t.excluded = 1 then (case when t.kind = 'settlement' then 'settlements' when t.kind = 'transfer' then 'transfers' when t.kind = 'refund' then 'refunds' else 'excluded' end)
  when t.kind = 'paid_back' then 'variable'
  when t.kind = 'income' or (coalesce(t.kind,'') <> 'savings' and t.amount_ils > 0) then 'income'
  when t.kind = 'savings' then 'savings'
  when t.installment_plan_id is not null then 'installments'
  when t.recurring_stream_id is not null and exists (select 1 from recurring_stream rs where rs.id = t.recurring_stream_id and rs.state = 'confirmed') then 'fixed'
  else 'variable' end`;

interface Row {
  id: number;
  txn_date: string;
  charge_date: string | null;
  cashflow_month: string;
  amount_ils: number;
  original_amount: number | null;
  original_currency: string;
  description_raw: string;
  memo: string | null;
  account_id: number;
  account_name: string | null;
  account_type: string;
  institution_id: string;
  status: string;
  kind: string | null;
  bucket: TxnBucket;
  excluded: number;
  category_id: number | null;
  category_key: string | null;
  category_source: string | null;
  category_confidence: number | null;
  merchant_id: number | null;
  merchant_name: string | null;
  installment_n: number | null;
  installment_total: number | null;
  installment_plan_id: number | null;
  recurring_stream_id: number | null;
  note: string | null;
  income_kind_override: string | null;
  description_norm: string;
  netted: number;
  split: number;
}

const SELECT = `select t.id, t.txn_date, t.charge_date, t.cashflow_month, t.amount_ils, t.original_amount, t.original_currency, t.description_raw, t.memo,
  t.account_id, a.display_name account_name, a.type account_type, a.institution_id, t.status, t.kind, ${BUCKET_EXPR} bucket, t.excluded,
  t.category_id, c.key category_key, t.category_source, t.category_confidence, t.merchant_id, m.name merchant_name,
  t.installment_n, t.installment_total, t.installment_plan_id, t.recurring_stream_id, t.note, t.income_kind_override, t.description_norm,
  coalesce((select sum(l.amount) from link l where l.to_txn_id = t.id and l.type in ('refund','cancellation') and l.zone = 'auto' and coalesce(l.decision,'') <> 'rejected'), 0) netted,
  exists (select 1 from txn_split sp where sp.txn_id = t.id) split
  from "transaction" t
  join account a on a.id = t.account_id
  left join category c on c.id = t.category_id
  left join merchant m on m.id = t.merchant_id`;

function where(f: TxnFilters): { sql: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  const view = f.view ?? 'purchase';
  if (f.month) {
    conds.push(`${MONTH_EXPR(view)} = ?`);
    params.push(f.month);
  }
  if (f.from) {
    conds.push('t.txn_date >= ?');
    params.push(f.from);
  }
  if (f.to) {
    conds.push('t.txn_date <= ?');
    params.push(f.to);
  }
  if (f.accountId !== undefined) {
    conds.push('t.account_id = ?');
    params.push(f.accountId);
  }
  if (f.categoryId !== undefined) {
    conds.push('t.category_id = ?');
    params.push(f.categoryId);
  }
  if (f.group) {
    conds.push('c.group_key = ?');
    params.push(f.group);
  }
  if (f.merchantId !== undefined) {
    conds.push('t.merchant_id = ?');
    params.push(f.merchantId);
  }
  if (f.streamId !== undefined) {
    conds.push('t.recurring_stream_id = ?');
    params.push(f.streamId);
  }
  if (f.planId !== undefined) {
    conds.push('t.installment_plan_id = ?');
    params.push(f.planId);
  }
  if (f.eventId !== undefined) {
    conds.push('exists (select 1 from event_txn et where et.txn_id = t.id and et.event_id = ?)');
    params.push(f.eventId);
  }
  if (f.status) {
    conds.push('t.status = ?');
    params.push(f.status);
  } else if (f.bucket === 'pending') {
    conds.push(`t.status = 'pending'`);
  } else if (f.bucket === 'cancelled') {
    conds.push(`(t.status = 'voided' or exists (select 1 from link l where l.to_txn_id = t.id and l.type in ('refund','cancellation') and coalesce(l.decision,'') <> 'rejected'))`);
  } else {
    conds.push(`t.status <> 'voided'`);
  }
  if (f.bucket === 'uncategorised') {
    conds.push('t.category_id is null and t.excluded = 0');
  } else if (f.bucket && f.bucket !== 'pending' && f.bucket !== 'cancelled') {
    conds.push(`${BUCKET_EXPR} = ?`);
    params.push(f.bucket);
  } else if (!f.includeExcluded && f.bucket !== 'cancelled') {
    conds.push('t.excluded = 0');
  }
  if (f.q) {
    conds.push(`(t.description_raw like ? or m.name like ? or t.memo like ? or t.note like ? or cast(t.amount_ils / 100 as text) like ?)`);
    const like = `%${f.q}%`;
    params.push(like, like, like, like, like);
  }
  return { sql: conds.length ? `where ${conds.join(' and ')}` : '', params };
}

function toItem(r: Row, pb: PaidBackContext): TxnListItem {
  const paidBack = r.kind === PAID_BACK && r.excluded === 0;
  return {
    id: r.id,
    date: r.txn_date,
    chargeDate: r.charge_date,
    month: r.cashflow_month,
    amount: r.amount_ils,
    netAmount: r.amount_ils + r.netted,
    originalAmount: r.original_amount,
    originalCurrency: r.original_currency,
    name: r.merchant_name ?? r.description_raw,
    merchantName: r.merchant_name,
    descriptionRaw: r.description_raw,
    memo: r.memo,
    accountId: r.account_id,
    accountName: r.account_name,
    accountType: r.account_type,
    institutionId: r.institution_id,
    status: r.status,
    kind: r.kind,
    bucket: r.bucket,
    excluded: r.excluded === 1,
    categoryId: r.category_id,
    categoryKey: r.category_key,
    split: r.split === 1,
    categorySource: r.category_source,
    categoryConfidence: r.category_confidence,
    merchantId: r.merchant_id,
    installment: r.installment_total ? { n: r.installment_n ?? 0, total: r.installment_total, planId: r.installment_plan_id } : null,
    streamId: r.recurring_stream_id,
    note: r.note,
    incomeKind: r.income_kind_override === 'regular' || r.income_kind_override === 'extra' ? r.income_kind_override : null,
    paidBack,
    paidBackByRule: paidBack && r.account_type !== 'credit_card' && pb.byRule({ descriptionNorm: r.description_norm, accountId: r.account_id }),
    askPaidBack:
      r.status === 'completed' &&
      pb.ask({ id: r.id, kind: r.kind, bucket: r.bucket, amount: r.amount_ils + r.netted, accountId: r.account_id, categoryId: r.category_id, incomeKindOverride: r.income_kind_override, recurringStreamId: r.recurring_stream_id, descriptionNorm: r.description_norm }),
    canRemember: r.status === 'completed' && pb.canRemember({ kind: r.kind, excluded: r.excluded === 1, amount: r.amount_ils, accountId: r.account_id, descriptionNorm: r.description_norm }),
    refunds: [],
    refundOf: null,
  };
}

function attachLinks(db: Db, items: TxnListItem[]): void {
  if (!items.length) return;
  const ids = items.map((i) => i.id);
  const marks = ids.map(() => '?').join(',');
  const byId = new Map(items.map((i) => [i.id, i]));
  const rows = db.$client
    .prepare(
      `select l.id link_id, l.from_txn_id, l.to_txn_id, l.amount, l.zone, l.decision, f.txn_date f_date, f.description_raw f_desc, f.amount_ils f_amount, p.txn_date p_date, p.description_raw p_desc, p.amount_ils p_amount
       from link l join "transaction" f on f.id = l.from_txn_id join "transaction" p on p.id = l.to_txn_id
       where l.type in ('refund','cancellation') and coalesce(l.decision,'') <> 'rejected' and (l.to_txn_id in (${marks}) or l.from_txn_id in (${marks}))`,
    )
    .all(...ids, ...ids) as Array<{ link_id: number; from_txn_id: number; to_txn_id: number; amount: number; zone: string; decision: string | null; f_date: string; f_desc: string; f_amount: number; p_date: string; p_desc: string; p_amount: number }>;
  for (const l of rows) {
    const purchase = byId.get(l.to_txn_id);
    if (purchase) purchase.refunds.push({ linkId: l.link_id, txnId: l.from_txn_id, date: l.f_date, amount: l.f_amount, zone: l.zone, decision: l.decision, description: l.f_desc });
    const refund = byId.get(l.from_txn_id);
    if (refund) refund.refundOf = { linkId: l.link_id, txnId: l.to_txn_id, date: l.p_date, amount: l.p_amount, description: l.p_desc, zone: l.zone, decision: l.decision };
  }
}

/** An institution's name without digits, so no card or account number can ride along. */
function institutionLabel(name: string | null, fallback: string): string {
  const clean = (name ?? '').replace(/[0-9]+/g, '').replace(/\s+/g, ' ').trim();
  return clean || fallback.replace(/[0-9]+/g, '').trim();
}

/**
 * card_settlement links touching the page's rows, in one query. Only accepted links count: zone 'auto'
 * (not rejected) or confirmed by the user; unreviewed suggestions are not shown as fact.
 */
const ACCEPTED = (l: string) => `(${l}.decision = 'confirmed' or (${l}.zone = 'auto' and coalesce(${l}.decision,'') <> 'rejected'))`;
function attachSettlements(db: Db, items: TxnListItem[]): void {
  if (!items.length) return;
  const ids = items.map((i) => i.id);
  const marks = ids.map(() => '?').join(',');
  const byId = new Map(items.map((i) => [i.id, i]));
  const rows = db.$client
    .prepare(
      `select l.from_txn_id, l.to_txn_id, f.txn_date f_date,
              (select count(*) from link l2 where l2.from_txn_id = l.from_txn_id and l2.type = 'card_settlement' and ${ACCEPTED('l2')}) f_count, fi.display_name f_inst, fa.institution_id f_inst_id,
              p.txn_date p_date, p.amount_ils p_amount, coalesce(pm.name, p.description_raw) p_name, pi.display_name p_inst, pa.institution_id p_inst_id
       from link l
       join "transaction" f on f.id = l.from_txn_id join account fa on fa.id = f.account_id left join institution fi on fi.id = fa.institution_id
       join "transaction" p on p.id = l.to_txn_id join account pa on pa.id = p.account_id left join institution pi on pi.id = pa.institution_id
       left join merchant pm on pm.id = p.merchant_id
       where l.type = 'card_settlement' and ${ACCEPTED('l')} and (l.from_txn_id in (${marks}) or l.to_txn_id in (${marks}))
       order by p.txn_date, p.id`,
    )
    .all(...ids, ...ids) as Array<{ from_txn_id: number; to_txn_id: number; f_date: string; f_count: number; f_inst: string | null; f_inst_id: string; p_date: string; p_amount: number; p_name: string; p_inst: string | null; p_inst_id: string }>;
  for (const l of rows) {
    const bank = byId.get(l.from_txn_id);
    if (bank) {
      if (!bank.settles) bank.settles = { count: 0, account: institutionLabel(l.p_inst, l.p_inst_id), first: { txnId: l.to_txn_id, description: l.p_name, date: l.p_date, amount: l.p_amount } };
      bank.settles.count += 1;
      if (bank.settles.count > 1) delete bank.settles.first;
    }
    const card = byId.get(l.to_txn_id);
    if (card && !card.settledBy) card.settledBy = { txnId: l.from_txn_id, date: l.f_date, account: institutionLabel(l.f_inst, l.f_inst_id), count: l.f_count };
  }
}

export function listTransactions(db: Db, f: TxnFilters = {}): TxnPage {
  const w = where(f);
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 1000);
  const offset = Math.max(f.offset ?? 0, 0);
  const order = f.sort === 'amount' ? 'abs(t.amount_ils) desc, t.txn_date desc' : 't.txn_date desc, t.id desc';
  const rows = db.$client.prepare(`${SELECT} ${w.sql} order by ${order} limit ? offset ?`).all(...w.params, limit, offset) as Row[];
  const agg = db.$client
    .prepare(
      `select count(*) n, coalesce(sum(t.amount_ils),0) s, coalesce(sum(t.amount_ils + coalesce((select sum(l.amount) from link l where l.to_txn_id = t.id and l.type in ('refund','cancellation') and l.zone = 'auto' and coalesce(l.decision,'') <> 'rejected'),0)),0) ns
       from "transaction" t join account a on a.id = t.account_id left join category c on c.id = t.category_id left join merchant m on m.id = t.merchant_id ${w.sql}`,
    )
    .get(...w.params) as { n: number; s: number; ns: number };
  const pb = paidBackContext(db);
  const items = rows.map((r) => toItem(r, pb));
  attachLinks(db, items);
  attachSettlements(db, items);
  return { items, total: agg.n, sum: agg.s, netSum: agg.ns };
}

/** `split` here is the parts (the list's `split` flag is true when there are any) */
export interface TxnDetail extends Omit<TxnListItem, 'split'> {
  identifier: string | null;
  source: string;
  annotations: Record<string, unknown> | null;
  merchantAliases: string[];
  /** every link touching this row, with the engine's explanation */
  links: Array<{ id: number; type: string; direction: 'from' | 'to'; otherTxnId: number; otherDate: string; otherDescription: string; otherAmount: number; amount: number; confidence: number; zone: string; decision: string | null; explanation: Array<{ signal: string; score: number; note: string }> }>;
  aiSuggestion: { categoryId: number | null; confidence: number; reason: string | null; model: string } | null;
  /** the events this row is tagged into */
  events: Array<{ id: number; name: string }>;
  /** the parts of a split transaction (hub/splits.ts), or null */
  split: SplitPartView[] | null;
}

export function transactionDetail(db: Db, id: number): TxnDetail | null {
  const r = db.$client.prepare(`${SELECT} where t.id = ?`).get(id) as Row | undefined;
  if (!r) return null;
  const item = toItem(r, paidBackContext(db));
  attachLinks(db, [item]);
  attachSettlements(db, [item]);
  const extra = db.$client.prepare(`select identifier, source, annotations_json from "transaction" where id = ?`).get(id) as { identifier: string | null; source: string; annotations_json: string | null };
  const aliases = r.merchant_id ? (db.$client.prepare('select aliases_json from merchant where id = ?').get(r.merchant_id) as { aliases_json: string } | undefined) : undefined;
  const links = (
    db.$client
      .prepare(
        `select l.id, l.type, l.from_txn_id, l.to_txn_id, l.amount, l.confidence, l.zone, l.decision, l.explanation_json,
                o.txn_date o_date, o.description_raw o_desc, o.amount_ils o_amount
         from link l join "transaction" o on o.id = case when l.from_txn_id = ? then l.to_txn_id else l.from_txn_id end
         where l.from_txn_id = ? or l.to_txn_id = ?`,
      )
      .all(id, id, id) as Array<{ id: number; type: string; from_txn_id: number; to_txn_id: number; amount: number; confidence: number; zone: string; decision: string | null; explanation_json: string; o_date: string; o_desc: string; o_amount: number }>
  ).map((l) => ({
    id: l.id,
    type: l.type,
    direction: l.from_txn_id === id ? ('from' as const) : ('to' as const),
    otherTxnId: l.from_txn_id === id ? l.to_txn_id : l.from_txn_id,
    otherDate: l.o_date,
    otherDescription: l.o_desc,
    otherAmount: l.o_amount,
    amount: l.amount,
    confidence: l.confidence,
    zone: l.zone,
    decision: l.decision,
    explanation: safeJson<Array<{ signal: string; score: number; note: string }>>(l.explanation_json) ?? [],
  }));
  const ai = r.merchant_id
    ? (db.$client.prepare('select category_id, confidence, reason, model from ai_suggestion where merchant_id = ? order by id desc limit 1').get(r.merchant_id) as { category_id: number | null; confidence: number; reason: string | null; model: string } | undefined)
    : undefined;
  return {
    ...item,
    identifier: extra.identifier,
    source: extra.source,
    annotations: safeJson<Record<string, unknown>>(extra.annotations_json),
    merchantAliases: safeJson<string[]>(aliases?.aliases_json ?? null) ?? [],
    links,
    aiSuggestion: ai ? { categoryId: ai.category_id, confidence: ai.confidence, reason: ai.reason, model: ai.model } : null,
    events: eventsOfTxn(db, id),
    split: splitOf(db, id),
  };
}

function safeJson<T>(s: string | null | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}
