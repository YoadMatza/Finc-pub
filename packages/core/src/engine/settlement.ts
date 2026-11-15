/**
 * Card settlement links (§5 4a/4a', §7b): the bank's debit to a card company is not spending, it
 * pays for card rows already counted. Two modes, both verified on real data (2026-11-08):
 *   - monthly cycle: debit on the billing day = sum of regular card rows with that charge date
 *   - immediate charges (Max "חיוב עסקות מיידי"): debit on day D = sum of immediate rows charged on D
 * Each card row gets a link to the bank debit; the debit becomes kind=settlement, excluded.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/db.js';
import { nowIso } from '../db/db.js';
import { account, link, rawTransaction, transactions } from '../db/schema.js';
import { INSTITUTIONS } from '../institutions.js';

type TxnRow = typeof transactions.$inferSelect;

export interface SettlementGap {
  bankTxnId: number;
  date: string;
  bankAmount: number;
  cardAccountId: number;
  cardSum: number;
  gap: number; // bankAmount - cardSum (minor)
  rows: number;
  mode: 'regular' | 'immediate' | 'all';
}

export interface SettlementResult {
  bankDebitsSeen: number;
  matchedExact: number;
  matchedWithGap: number;
  unmatched: Array<{ bankTxnId: number; date: string; amount: number; description: string }>;
  gaps: SettlementGap[];
  linksCreated: number;
}

const IMMEDIATE_PLAN = 'חיוב עסקות מיידי';

function shiftDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const TOLERANCE_MINOR = 200; // ₪2 rounding
const GAP_SUGGEST_PCT = 0.05;

export function linkCardSettlements(db: Db): SettlementResult {
  const res: SettlementResult = { bankDebitsSeen: 0, matchedExact: 0, matchedWithGap: 0, unmatched: [], gaps: [], linksCreated: 0 };
  db.transaction((tx) => {
    const accounts = tx.select().from(account).all();
    const banks = accounts.filter((a) => a.type === 'checking');
    const cards = accounts.filter((a) => a.type === 'credit_card');
    if (!banks.length || !cards.length) return;

    for (const bank of banks) {
      for (const card of cards) {
        const spec = INSTITUTIONS[card.institutionId as keyof typeof INSTITUTIONS];
        const patterns = spec?.settlementPatterns ?? [];
        if (!patterns.length) continue;
        const debits = tx
          .select()
          .from(transactions)
          .where(and(eq(transactions.accountId, bank.id), eq(transactions.status, 'completed'), sql`${transactions.amountIls} < 0`))
          .all()
          .filter((t) => patterns.some((p) => t.descriptionNorm.includes(p.toLowerCase())));
        if (!debits.length) continue;
        res.bankDebitsSeen += debits.length;

        // Reset previous automatic settlement links for these debits (user links are kept).
        const debitIds = debits.map((d) => d.id);
        tx.delete(link).where(and(eq(link.type, 'card_settlement'), eq(link.source, 'auto'), inArray(link.fromTxnId, debitIds))).run();

        const byDate = new Map<string, TxnRow[]>();
        for (const d of debits) byDate.set(d.txnDate, [...(byDate.get(d.txnDate) ?? []), d]);

        for (const [date, dayDebits] of byDate) {
          // The card says "charged on the 2nd"; when the 2nd is a weekend the bank posts it on the 3rd or 4th.
          let rows: Array<{ t: TxnRow; plan: string | null }> = [];
          for (const shift of [0, -1, -2, -3]) {
            const chargeDate = shiftDays(date, shift);
            rows = tx
              .select({ t: transactions, plan: sql<string | null>`json_extract(${rawTransaction.payloadJson}, '$.rawTransaction.planName')` })
              .from(transactions)
              .innerJoin(rawTransaction, eq(rawTransaction.id, transactions.rawId))
              .where(and(eq(transactions.accountId, card.id), eq(transactions.chargeDate, chargeDate), eq(transactions.status, 'completed')))
              .all();
            if (rows.length) break;
          }
          const immediate = rows.filter((r) => r.plan === IMMEDIATE_PLAN).map((r) => r.t);
          const regular = rows.filter((r) => r.plan !== IMMEDIATE_PLAN).map((r) => r.t);
          // RiseUp-only rows sometimes sit on a charge date the card itself does not report (seen 2026-11-02):
          // the scraped rows alone are a candidate group too.
          const regularScraped = regular.filter((r) => r.source.startsWith('scraper:'));
          const allGroups: Array<{ mode: SettlementGap['mode']; rows: TxnRow[] }> = [
            { mode: 'regular', rows: regular },
            ...(regularScraped.length !== regular.length ? [{ mode: 'regular' as const, rows: regularScraped }] : []),
            { mode: 'immediate', rows: immediate },
            { mode: 'all', rows: [...regular, ...immediate] },
          ];
          const groups = allGroups.filter((g) => g.rows.length > 0);
          const usedRows = new Set<number>();

          for (const debit of [...dayDebits].sort((a, b) => a.amountIls - b.amountIls)) {
            const target = debit.amountIls;
            const available = groups.map((g) => ({ ...g, rows: g.rows.filter((r) => !usedRows.has(r.id)) })).filter((g) => g.rows.length);
            const withSums = available.map((g) => ({ ...g, sum: g.rows.reduce((s, r) => s + r.amountIls, 0) }));
            const exact = withSums.find((g) => g.sum === target) ?? withSums.find((g) => Math.abs(g.sum - target) <= TOLERANCE_MINOR);
            const pick = exact ?? withSums.filter((g) => Math.abs(g.sum - target) / Math.abs(target) <= GAP_SUGGEST_PCT).sort((a, b) => Math.abs(a.sum - target) - Math.abs(b.sum - target))[0];
            if (!pick) {
              res.unmatched.push({ bankTxnId: debit.id, date, amount: debit.amountIls, description: debit.descriptionRaw });
              if (debit.kind === 'settlement') tx.update(transactions).set({ kind: null, excluded: false, updatedAt: nowIso() }).where(eq(transactions.id, debit.id)).run();
              continue;
            }
            const gap = target - pick.sum;
            const isExact = exact !== undefined;
            if (isExact) res.matchedExact++;
            else {
              res.matchedWithGap++;
              res.gaps.push({ bankTxnId: debit.id, date, bankAmount: target, cardAccountId: card.id, cardSum: pick.sum, gap, rows: pick.rows.length, mode: pick.mode });
            }
            const confidence = gap === 0 ? 1 : isExact ? 0.95 : 0.7;
            const explanation = [
              { signal: 'cycle', score: confidence, weight: 1, note: `${pick.rows.length} ${pick.mode} card row(s) charged ${date} sum to ${(pick.sum / 100).toFixed(2)}; bank debit ${(target / 100).toFixed(2)}${gap ? `; gap ${(gap / 100).toFixed(2)}` : ''}` },
            ];
            for (const r of pick.rows) {
              usedRows.add(r.id);
              tx.insert(link)
                .values({ type: 'card_settlement', fromTxnId: debit.id, toTxnId: r.id, amount: r.amountIls, confidence, zone: isExact ? 'auto' : 'suggest', source: 'auto', explanationJson: JSON.stringify(explanation), createdAt: nowIso() })
                .run();
              res.linksCreated++;
            }
            tx.update(transactions).set({ kind: 'settlement', excluded: true, updatedAt: nowIso() }).where(eq(transactions.id, debit.id)).run();
          }
        }
      }
    }
  });
  return res;
}
