/**
 * Refund / cancellation engine (§6) on top of the matching engine (§7a).
 * A credit on a card (or a bank credit that says החזר/ביטול) is matched against earlier debits on
 * the same account: same merchant, same or smaller amount (FX via original currency), within 90
 * days. High scores link automatically, medium ones are suggestions for the review inbox, and a
 * purchase can absorb several partial refunds but never more than its own amount.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/db.js';
import { nowIso } from '../db/db.js';
import { account, link, merchant, transactions } from '../db/schema.js';
import { descriptionSimilarity } from '../ingest/ingest.js';
import { daysBetween } from './installments.js';
import { type Signal, ZONES, amountSignal, combine, dateSignal, fxSignal, keywordSignal, merchantSignal, referenceSignal, zoneOf } from './match.js';

type TxnRow = typeof transactions.$inferSelect;

export interface RefundResult {
  creditsSeen: number;
  auto: number;
  suggest: number;
  unmatched: Array<{ txnId: number; date: string; amount: number; description: string; memo: string | null }>;
  linksCreated: number;
}

const REFUND_WORDS = ['ביטול', 'זיכוי', 'החזר', 'refund', 'reversal', 'credit', 'chargeback'];
const BANK_REFUND_WORDS = ['החזר', 'ביטול', 'refund', 'reversal', 'chargeback'];
const WINDOW_DAYS = 90;

export function linkRefunds(db: Db): RefundResult {
  const res: RefundResult = { creditsSeen: 0, auto: 0, suggest: 0, unmatched: [], linksCreated: 0 };
  db.transaction((tx) => {
    const merchantRows = tx.select().from(merchant).all();
    const merchants = new Map(merchantRows.map((m) => [m.id, m.key]));
    // merchants that share a source-specific id (Max merchant number, Isracard supplier id) are the same business
    const extIds = new Map<number, Set<string>>();
    for (const m of merchantRows) {
      const ext = JSON.parse(m.externalIdsJson) as Record<string, string[]>;
      extIds.set(m.id, new Set(Object.entries(ext).flatMap(([k, v]) => v.map((x) => `${k}:${x}`))));
    }
    const shareExtId = (a: number | null, b: number | null): boolean => {
      if (a === null || b === null) return false;
      const sa = extIds.get(a);
      const sb = extIds.get(b);
      if (!sa || !sb) return false;
      for (const x of sa) if (sb.has(x)) return true;
      return false;
    };
    const accounts = tx.select().from(account).all();
    for (const acc of accounts) {
      const all = tx
        .select()
        .from(transactions)
        .where(and(eq(transactions.accountId, acc.id), eq(transactions.status, 'completed'), sql`(${transactions.kind} is null or ${transactions.kind} in ('income','expense','refund'))`))
        .all();
      const isCard = acc.type === 'credit_card';
      // On a bank account only explicit refund wording counts; "זיכוי" there is any incoming credit (Bit, salary).
      const credits = all.filter((t) => t.amountIls > 0 && (isCard || BANK_REFUND_WORDS.some((w) => `${t.descriptionNorm} ${t.memo ?? ''}`.toLowerCase().includes(w))));
      if (!credits.length) continue;
      res.creditsSeen += credits.length;
      const creditIds = credits.map((c) => c.id);
      tx.delete(link).where(and(inArray(link.type, ['refund', 'cancellation']), eq(link.source, 'auto'), inArray(link.fromTxnId, creditIds))).run();
      // What the owner already decided stands: a confirmed link keeps its credit and its share of the purchase,
      // a rejected pair is never proposed again. Only automatic links are rebuilt below.
      const decided = tx
        .select()
        .from(link)
        .where(and(inArray(link.type, ['refund', 'cancellation']), eq(link.source, 'user'), inArray(link.fromTxnId, creditIds)))
        .all();
      const rejectedPairs = new Set(decided.filter((l) => l.decision === 'rejected').map((l) => `${l.fromTxnId}:${l.toTxnId}`));
      const confirmed = decided.filter((l) => l.decision === 'confirmed');
      const debits = all.filter((t) => t.amountIls < 0);

      // score every plausible pair
      const pairs: Array<{ credit: TxnRow; debit: TxnRow; score: number; signals: Signal[] }> = [];
      for (const c of credits) {
        for (const d of debits) {
          if (rejectedPairs.has(`${c.id}:${d.id}`)) continue;
          const days = daysBetween(d.txnDate, c.txnDate);
          if (days < -3 || days > WINDOW_DAYS) continue;
          if (Math.abs(d.amountIls) * 1.05 < c.amountIls) continue; // credit larger than purchase (beyond FX drift)
          // the same cheque / authorization number IS the same thing, whatever the wording around it
          const ref = referenceSignal(`${c.descriptionRaw} ${c.memo ?? ''}`, `${d.descriptionRaw} ${d.memo ?? ''}`);
          const sameRef = ref?.score === 1;
          const sameMerchant = (c.merchantId !== null && c.merchantId === d.merchantId) || shareExtId(c.merchantId, d.merchantId);
          const sim = sameMerchant ? 1 : descriptionSimilarity(merchants.get(c.merchantId ?? -1) ?? c.descriptionNorm, merchants.get(d.merchantId ?? -1) ?? d.descriptionNorm);
          if (!sameMerchant && !sameRef && sim < 0.4) continue;
          const signals: Signal[] = [
            sameRef && !sameMerchant ? { ...merchantSignal(true, 1), note: 'same reference number' } : merchantSignal(sameMerchant, sim),
            amountSignal(c.amountIls, Math.abs(d.amountIls), { allowPartial: true }),
            dateSignal(days, WINDOW_DAYS),
            keywordSignal(`${c.descriptionNorm} ${c.memo ?? ''}`, REFUND_WORDS),
          ];
          const fx = fxSignal(c.originalCurrency, c.originalAmount, d.originalCurrency, d.originalAmount);
          if (fx) signals.push(fx);
          if (ref) signals.push(ref);
          const { score } = combine(signals);
          if (score >= ZONES.suggest) pairs.push({ credit: c, debit: d, score, signals });
        }
      }

      // global assignment: best first; a credit links once; a debit absorbs up to its own amount
      pairs.sort((a, b) => b.score - a.score);
      const remaining = new Map<number, number>(debits.map((d) => [d.id, Math.abs(d.amountIls)]));
      const linkedCredits = new Set<number>();
      for (const l of confirmed) {
        linkedCredits.add(l.fromTxnId);
        remaining.set(l.toTxnId, Math.max(0, (remaining.get(l.toTxnId) ?? 0) - l.amount));
      }
      for (const p of pairs) {
        if (linkedCredits.has(p.credit.id)) continue;
        const left = remaining.get(p.debit.id) ?? 0;
        if (left < p.credit.amountIls * 0.95) continue;
        linkedCredits.add(p.credit.id);
        remaining.set(p.debit.id, left - p.credit.amountIls);
        // On a bank account whoever sends the money writes the description, so wording, a shared number or a matching
        // name cannot hide a credit by themselves (security research P2-04): only a source merchant id both rows carry
        // links one automatically; anything else is a suggestion the owner confirms in the review inbox.
        const scored = zoneOf(p.score);
        const zone = scored === 'auto' && !isCard && !shareExtId(p.credit.merchantId, p.debit.merchantId) ? 'suggest' : scored;
        const full = p.credit.amountIls === Math.abs(p.debit.amountIls) || p.signals.some((s) => s.signal === 'fx' && s.score === 1);
        tx.insert(link)
          .values({ type: full ? 'cancellation' : 'refund', fromTxnId: p.credit.id, toTxnId: p.debit.id, amount: p.credit.amountIls, confidence: p.score, zone, source: 'auto', explanationJson: JSON.stringify(p.signals), createdAt: nowIso() })
          .run();
        res.linksCreated++;
        if (zone === 'auto') {
          res.auto++;
          tx.update(transactions).set({ kind: 'refund', excluded: true, updatedAt: nowIso() }).where(eq(transactions.id, p.credit.id)).run();
        } else {
          res.suggest++;
        }
      }
      for (const c of credits) {
        if (linkedCredits.has(c.id)) continue;
        if (c.kind === 'refund') tx.update(transactions).set({ kind: null, excluded: false, updatedAt: nowIso() }).where(eq(transactions.id, c.id)).run();
        res.unmatched.push({ txnId: c.id, date: c.txnDate, amount: c.amountIls, description: c.descriptionRaw, memo: c.memo });
      }
    }
  });
  return res;
}
