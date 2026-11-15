/** The review inbox: everything waiting for a decision, triaged like email. */
import type { Db } from '../db/db.js';
import { todayLocal } from './overview.js';

export interface TxnLite {
  id: number;
  date: string;
  amount: number;
  name: string;
  accountName: string | null;
}

export interface ReviewInbox {
  counts: { suggestedLinks: number; uncategorised: number; lowConfidence: number; candidates: number; overdue: number; exclusions: number; gapCycles: number };
  suggestedLinks: Array<{ linkId: number; type: string; confidence: number; from: TxnLite; to: TxnLite; explanation: Array<{ signal: string; score: number; note: string }> }>;
  uncategorised: Array<{ merchantId: number | null; name: string; rows: number; spend: number; lastDate: string; sampleTxnId: number; ai: { categoryId: number | null; confidence: number; reason: string | null } | null }>;
  lowConfidence: Array<{ merchantId: number; name: string; rows: number; categoryId: number; categoryKey: string; confidence: number; reason: string | null; sampleTxnId: number }>;
  candidates: Array<{ streamId: number; merchantId: number; name: string; frequency: string; expectedAmount: number; occurrences: number; lastDate: string | null; categoryKey: string | null }>;
  overdue: Array<{ streamId: number; name: string; expectedDate: string; amount: number; frequency: string }>;
  exclusions: Array<{ txnId: number; date: string; amount: number; name: string; comment: string | null }>;
  gapCycles: Array<{ linkId: number; date: string; bankAmount: number; txnId: number }>;
}

export function reviewInbox(db: Db): ReviewInbox {
  const c = db.$client;
  const today = todayLocal();
  const since = `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`;

  const linkRows = c
    .prepare(
      `select l.id, l.type, l.confidence, l.explanation_json,
              f.id f_id, f.txn_date f_date, f.amount_ils f_amount, coalesce(fm.name, f.description_raw) f_name, fa.display_name f_acc,
              p.id p_id, p.txn_date p_date, p.amount_ils p_amount, coalesce(pm.name, p.description_raw) p_name, pa.display_name p_acc
       from link l
       join "transaction" f on f.id = l.from_txn_id left join merchant fm on fm.id = f.merchant_id join account fa on fa.id = f.account_id
       join "transaction" p on p.id = l.to_txn_id left join merchant pm on pm.id = p.merchant_id join account pa on pa.id = p.account_id
       where l.zone = 'suggest' and l.decision is null and l.type in ('refund','cancellation','transfer') order by l.confidence desc`,
    )
    .all() as Array<Record<string, never> & { id: number; type: string; confidence: number; explanation_json: string; f_id: number; f_date: string; f_amount: number; f_name: string; f_acc: string | null; p_id: number; p_date: string; p_amount: number; p_name: string; p_acc: string | null }>;
  const suggestedLinks = linkRows.map((l) => ({
    linkId: l.id,
    type: l.type,
    confidence: l.confidence,
    from: { id: l.f_id, date: l.f_date, amount: l.f_amount, name: l.f_name, accountName: l.f_acc },
    to: { id: l.p_id, date: l.p_date, amount: l.p_amount, name: l.p_name, accountName: l.p_acc },
    explanation: parse<Array<{ signal: string; score: number; note: string }>>(l.explanation_json) ?? [],
  }));

  const uncategorised = (
    c
      .prepare(
        `select t.merchant_id, coalesce(m.name, t.description_raw) name, count(*) rows_n, sum(case when t.amount_ils < 0 then -t.amount_ils else 0 end) spend, max(t.txn_date) last_date, max(t.id) sample_id
         from "transaction" t left join merchant m on m.id = t.merchant_id
         where t.excluded = 0 and t.status = 'completed' and t.category_id is null and t.txn_date >= ?
         group by t.merchant_id, coalesce(m.name, t.description_raw) order by spend desc limit 100`,
      )
      .all(since) as Array<{ merchant_id: number | null; name: string; rows_n: number; spend: number; last_date: string; sample_id: number }>
  ).map((r) => {
    const ai = r.merchant_id ? (c.prepare('select category_id, confidence, reason from ai_suggestion where merchant_id = ? order by id desc limit 1').get(r.merchant_id) as { category_id: number | null; confidence: number; reason: string | null } | undefined) : undefined;
    return { merchantId: r.merchant_id, name: r.name, rows: r.rows_n, spend: r.spend, lastDate: r.last_date, sampleTxnId: r.sample_id, ai: ai ? { categoryId: ai.category_id, confidence: ai.confidence, reason: ai.reason } : null };
  });

  const lowConfidence = (
    c
      .prepare(
        `select t.merchant_id, m.name, count(*) rows_n, t.category_id, c.key cat_key, min(t.category_confidence) conf, max(t.id) sample_id
         from "transaction" t join merchant m on m.id = t.merchant_id join category c on c.id = t.category_id
         where t.category_source = 'ai' and t.category_confidence < 0.75 and t.excluded = 0 and t.status = 'completed' and t.txn_date >= ?
         group by t.merchant_id, t.category_id order by conf asc, rows_n desc limit 100`,
      )
      .all(since) as Array<{ merchant_id: number; name: string; rows_n: number; category_id: number; cat_key: string; conf: number; sample_id: number }>
  ).map((r) => {
    const ai = c.prepare('select reason from ai_suggestion where merchant_id = ? order by id desc limit 1').get(r.merchant_id) as { reason: string | null } | undefined;
    return { merchantId: r.merchant_id, name: r.name, rows: r.rows_n, categoryId: r.category_id, categoryKey: r.cat_key, confidence: r.conf, reason: ai?.reason ?? null, sampleTxnId: r.sample_id };
  });

  const candidates = (
    c
      .prepare(
        `select rs.id, rs.merchant_id, m.name, rs.frequency, rs.expected_amount, rs.occurrences, rs.last_txn_date, c.key cat_key
         from recurring_stream rs join merchant m on m.id = rs.merchant_id left join category c on c.id = rs.category_id where rs.state = 'candidate' order by abs(rs.expected_amount) desc`,
      )
      .all() as Array<{ id: number; merchant_id: number; name: string; frequency: string; expected_amount: number; occurrences: number; last_txn_date: string | null; cat_key: string | null }>
  ).map((r) => ({ streamId: r.id, merchantId: r.merchant_id, name: r.name, frequency: r.frequency, expectedAmount: r.expected_amount, occurrences: r.occurrences, lastDate: r.last_txn_date, categoryKey: r.cat_key }));

  const overdue = (
    c
      .prepare(
        `select rs.id, coalesce(rs.label, m.name) name, rs.next_expected_date, rs.expected_amount, rs.frequency from recurring_stream rs join merchant m on m.id = rs.merchant_id
         where rs.state = 'confirmed' and rs.next_expected_date < date(?, '-7 days') order by rs.next_expected_date`,
      )
      .all(today) as Array<{ id: number; name: string; next_expected_date: string; expected_amount: number; frequency: string }>
  ).map((r) => ({ streamId: r.id, name: r.name, expectedDate: r.next_expected_date, amount: r.expected_amount, frequency: r.frequency }));

  const exclusions = (
    c
      .prepare(
        `select t.id, t.txn_date, t.amount_ils, coalesce(m.name, t.description_raw) name, json_extract(t.annotations_json, '$.riseup.comment') comment
         from "transaction" t left join merchant m on m.id = t.merchant_id where t.excluded = 0 and json_extract(t.annotations_json, '$.riseup.isExcluded') = 1 order by t.txn_date desc`,
      )
      .all() as Array<{ id: number; txn_date: string; amount_ils: number; name: string; comment: string | null }>
  ).map((r) => ({ txnId: r.id, date: r.txn_date, amount: r.amount_ils, name: r.name, comment: r.comment }));

  const gapCycles = (
    c
      .prepare(
        `select l.id, f.txn_date, f.amount_ils, f.id txn_id from link l join "transaction" f on f.id = l.from_txn_id
         where l.zone = 'suggest' and l.decision is null and l.type = 'card_settlement' group by l.from_txn_id order by f.txn_date desc`,
      )
      .all() as Array<{ id: number; txn_date: string; amount_ils: number; txn_id: number }>
  ).map((r) => ({ linkId: r.id, date: r.txn_date, bankAmount: r.amount_ils, txnId: r.txn_id }));

  return {
    counts: {
      suggestedLinks: suggestedLinks.length,
      uncategorised: uncategorised.reduce((a, u) => a + u.rows, 0),
      lowConfidence: lowConfidence.length,
      candidates: candidates.length,
      overdue: overdue.length,
      exclusions: exclusions.length,
      gapCycles: gapCycles.length,
    },
    suggestedLinks,
    uncategorised,
    lowConfidence,
    candidates,
    overdue,
    exclusions,
    gapCycles,
  };
}

function parse<T>(s: string | null): T | null {
  try {
    return s ? (JSON.parse(s) as T) : null;
  } catch {
    return null;
  }
}
