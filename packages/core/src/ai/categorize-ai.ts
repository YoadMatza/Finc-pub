/**
 * Model-assisted categorisation for the long tail. Privacy contract (open question #12): what leaves
 * the machine is the normalized merchant name, a few amounts and dates, and our category list.
 * Never an account, a card number, a person's name, a raw bank description, or a memo.
 * Person-to-person transfers (Bit, PayBox, bank transfers) are never sent at all.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/db.js';
import { nowIso } from '../db/db.js';
import { aiSuggestion, category, merchant, transactions } from '../db/schema.js';
import { CATEGORY_SEED } from '../engine/categories.js';
import { PERSON_TO_PERSON } from '../engine/p2p.js';
import type { AiProvider } from './provider.js';

export interface MerchantPayload {
  key: string;
  count: number;
  samples: Array<{ amount: number; date: string }>; // ILS, YYYY-MM
}

export interface AiCategorizeOptions {
  /** merchants per run (biggest uncategorised first) */
  limit?: number;
  batchSize?: number;
  since?: string;
  /** build the payload, send nothing, apply nothing */
  dryRun?: boolean;
  minConfidence?: number;
}

export interface AiCategorizeResult {
  merchantsConsidered: number;
  batches: number;
  sent: number;
  applied: { merchants: number; transactions: number };
  lowConfidence: number;
  unknown: number;
  cached: number;
  payload: MerchantPayload[];
  errors: string[];
}

// "ביט" only as its own word (also "בביט"/"מביט"); insurers ("ביטוח") are ordinary merchants
const NEVER_SEND_EXTRA = /העברה|משיכת שיק|החזרת שיק|salary|משכורת/i;
const neverSend = (s: string): boolean => PERSON_TO_PERSON.test(s) || NEVER_SEND_EXTRA.test(s);

export function buildPayload(db: Db, opts: { limit: number; since: string }): Array<MerchantPayload & { merchantId: number }> {
  const rows = db
    .select({
      merchantId: transactions.merchantId,
      key: merchant.key,
      n: sql<number>`count(*)`,
    })
    .from(transactions)
    .innerJoin(merchant, eq(merchant.id, transactions.merchantId))
    .where(and(eq(transactions.excluded, false), eq(transactions.status, 'completed'), isNull(transactions.categoryId), sql`${transactions.txnDate} >= ${opts.since}`, sql`${transactions.kind} in ('expense','income')`))
    .groupBy(transactions.merchantId)
    .orderBy(sql`sum(abs(${transactions.amountIls})) desc`)
    .all();
  const out: Array<MerchantPayload & { merchantId: number }> = [];
  for (const r of rows) {
    if (r.merchantId === null || neverSend(r.key)) continue;
    const samples = db
      .select({ amount: transactions.amountIls, date: transactions.txnDate })
      .from(transactions)
      .where(and(eq(transactions.merchantId, r.merchantId), eq(transactions.excluded, false), eq(transactions.status, 'completed')))
      .orderBy(sql`${transactions.txnDate} desc`)
      .limit(3)
      .all()
      .map((s) => ({ amount: Math.round(s.amount) / 100, date: s.date.slice(0, 7) }));
    out.push({ merchantId: r.merchantId, key: sanitizeForModel(r.key), count: r.n, samples });
    if (out.length >= opts.limit) break;
  }
  return out;
}

/** Booking references, voucher numbers and the like ride inside merchant names ("skywayair51837260913"): drop digit runs. */
export function sanitizeForModel(key: string): string {
  return key.replace(/\d{4,}/g, '').replace(/\s+/g, ' ').trim() || key;
}

export function systemPrompt(): string {
  const cats = CATEGORY_SEED.filter((c) => c.key !== 'transfers').map((c) => `${c.key} = ${c.en} / ${c.he}`).join('\n');
  return [
    'You classify merchants from an Israeli personal bank/credit-card statement into spending categories.',
    'Input: a JSON array of merchants; each has "key" (normalized merchant name, Hebrew or English), "count" (how many charges) and "samples" (a few amounts in ILS, negative = spend, and months).',
    'Output: ONLY a JSON array, same order, one object per input: {"key": string, "category": one of the keys below or null, "confidence": 0..1, "reason": short}.',
    'Use null when you cannot tell. Prefer the most specific category. "installments" is never an answer. Hebrew merchants are common; think about what the business is.',
    'Category keys:',
    cats,
  ].join('\n');
}

interface AiAnswer {
  key: string;
  category: string | null;
  confidence: number;
  reason?: string | undefined;
}

function parseAnswers(text: string): AiAnswer[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end < start) throw new Error(`model did not return a JSON array: ${text.slice(0, 120)}`);
  const arr = JSON.parse(text.slice(start, end + 1)) as unknown;
  if (!Array.isArray(arr)) throw new Error('model answer is not an array');
  return arr.map((a) => {
    const o = a as Record<string, unknown>;
    return { key: String(o.key ?? ''), category: o.category === null || o.category === undefined ? null : String(o.category), confidence: Number(o.confidence ?? 0), reason: o.reason === undefined ? undefined : String(o.reason).slice(0, 200) };
  });
}

export async function categorizeWithAi(db: Db, provider: AiProvider, o: AiCategorizeOptions = {}): Promise<AiCategorizeResult> {
  const limit = o.limit ?? 50;
  const batchSize = o.batchSize ?? 25;
  const since = o.since ?? new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
  const minConf = o.minConfidence ?? 0.6;
  const res: AiCategorizeResult = { merchantsConsidered: 0, batches: 0, sent: 0, applied: { merchants: 0, transactions: 0 }, lowConfidence: 0, unknown: 0, cached: 0, payload: [], errors: [] };
  const cats = new Map(db.select().from(category).all().map((c) => [c.key, c]));

  const all = buildPayload(db, { limit: limit * 2, since });
  res.merchantsConsidered = all.length;
  // ask once per merchant per provider/model
  const cachedIds = new Set(
    db
      .select({ m: aiSuggestion.merchantId })
      .from(aiSuggestion)
      .where(and(eq(aiSuggestion.provider, provider.name), eq(aiSuggestion.model, provider.model)))
      .all()
      .map((r) => r.m),
  );
  const todo = all.filter((m) => !cachedIds.has(m.merchantId)).slice(0, limit);
  res.cached = all.length - all.filter((m) => !cachedIds.has(m.merchantId)).length;
  res.payload = todo.map(({ merchantId: _m, ...p }) => p);
  if (o.dryRun) return res;

  const system = systemPrompt();
  for (let i = 0; i < todo.length; i += batchSize) {
    const batch = todo.slice(i, i + batchSize);
    res.batches++;
    let answers: AiAnswer[];
    try {
      const text = await provider.complete({ system, user: `Classify these merchants:\n${JSON.stringify(batch.map(({ merchantId: _m, ...p }) => p))}` });
      answers = parseAnswers(text);
      res.sent += batch.length;
    } catch (e) {
      res.errors.push(e instanceof Error ? e.message : String(e));
      continue;
    }
    db.transaction((tx) => {
      for (const m of batch) {
        const a = answers.find((x) => x.key === m.key) ?? answers.find((x) => sanitizeForModel(x.key) === m.key) ?? answers[batch.indexOf(m)];
        const cat = a?.category ? cats.get(a.category) : undefined;
        const conf = Math.max(0, Math.min(1, a?.confidence ?? 0));
        tx.insert(aiSuggestion)
          .values({ merchantId: m.merchantId, provider: provider.name, model: provider.model, categoryId: cat?.id ?? null, confidence: conf, reason: a?.reason ?? null, sentJson: JSON.stringify({ key: m.key, count: m.count, samples: m.samples }), createdAt: nowIso() })
          .run();
        if (!cat) {
          res.unknown++;
          continue;
        }
        if (conf < minConf) {
          res.lowConfidence++;
          continue;
        }
        const r = tx
          .update(transactions)
          .set({ categoryId: cat.id, categorySource: 'ai', categoryConfidence: conf, updatedAt: nowIso() })
          .where(and(eq(transactions.merchantId, m.merchantId), isNull(transactions.categoryId)))
          .run();
        if (r.changes) {
          res.applied.merchants++;
          res.applied.transactions += r.changes;
        }
      }
    });
  }
  return res;
}

/** Forget cached answers (e.g. after switching models) for the given merchants, or all. */
export function clearAiSuggestions(db: Db, merchantIds?: number[]): number {
  const r = merchantIds?.length ? db.delete(aiSuggestion).where(inArray(aiSuggestion.merchantId, merchantIds)).run() : db.delete(aiSuggestion).run();
  return r.changes;
}
