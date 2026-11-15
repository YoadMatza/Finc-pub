/**
 * Merchant normalization (§5 step 3): turn the bank's free-text description into a stable merchant
 * key. Deliberately conservative: it removes noise (legal suffixes, branch numbers, cities, card
 * processor prefixes, country codes), never guesses that two different names are one business.
 * Source-specific ids (Max merchantNumber, Isracard supplierId) are kept as external ids.
 */
import { eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/db.js';
import { nowIso } from '../db/db.js';
import { merchant, rawTransaction, transactions } from '../db/schema.js';
import { normalizeDescription } from '../ingest/normalize.js';

const LEGAL = new Set(['בעמ', 'בע"מ', 'בע', 'מ', 'ltd', 'ltd.', 'inc', 'inc.', 'llc', 'co', 'co.', 'corp', 'gmbh', 'bv', 'b.v.', 'sa', 's.a.', 'plc', 'limited']);
const COUNTRY = new Set(['us', 'usa', 'gb', 'uk', 'il', 'cn', 'lu', 'kr', 'fr', 'de', 'nl', 'ie', 'sg', 'hk', 'jp', 'it', 'es', 'ae', 'et', 'ch', 'se', 'ca', 'au', 'tr', 'gr', 'cy', 'pt', 'be', 'at', 'cz', 'pl', 'th', 'vn']);
const CITIES = [
  'תל אביב', 'ת"א', 'תא', 'רמת השרון', 'הרצליה', 'יהוד', 'גבעתיים', 'רמת גן', 'קרית אונו', 'פתח תקווה', 'פתח תקוה', 'ראשון לציון', 'ירושלים', 'חיפה',
  'באר שבע', 'נתניה', 'הוד השרון', 'כפר סבא', 'רעננה', 'חולון', 'בת ים', 'אור יהודה', 'סביון', 'הרצליה פיתוח', 'מודיעין', 'אשדוד', 'אילת', 'רמת ישי',
  'tel aviv', 'tel-aviv', 'telaviv', 'jerusalem', 'haifa', 'herzliya', 'herzlia', 'ramat gan', 'london', 'paris', 'seoul', 'busan', 'shanghai', 'luxembourg', 'new york', 'dublin', 'amsterdam', 'berlin', 'singapore', 'hong kong', 'dubai', 'bangkok',
];
export const PROCESSOR_PREFIX = /^(bh|pp|sq|sp|tst|dd|amzn mktp|amazon mktp|paypal|google|apple\.com\/bill|uber|wlt)\s*\*\s*/i;
const BRANCH_TOKEN = /^(סניף|branch|store|#\d*)$/; // "חנות" stays: it is part of real names ("חנות הספרים")
/** Pure numbers / phone-like groups ("650", "253", "0000", "10000"), not alphanumeric names ("shopxyz1234"). */
const NUMERIC_TOKEN = /^[\d.()+-]*\d{3,}[\d.()+-]*$/;

export interface MerchantNorm {
  key: string;
  name: string;
}

/** Normalize a description into a merchant key and a display name. */
export function merchantKey(description: string): MerchantNorm {
  // processor prefixes ("SP* STREAMLY", "PAYPAL *SONGSTERR") must go before normalizeDescription drops the '*'
  let s = normalizeDescription(description.trim().toLowerCase().replace(PROCESSOR_PREFIX, ''));
  s = s.replace(/[-–—]/g, ' ').replace(/\s+/g, ' ').trim();
  // strip trailing city names (longest first)
  for (const city of [...CITIES].sort((a, b) => b.length - a.length)) {
    const c = city.toLowerCase();
    if (s.endsWith(` ${c}`)) s = s.slice(0, -c.length - 1).trim();
    else if (s.includes(` ${c} `)) s = s.replace(` ${c} `, ' ').trim();
  }
  let tokens = s.split(' ').filter(Boolean);
  // drop legal suffixes, country codes at the end, long digit runs, branch tokens, lone punctuation
  tokens = tokens.filter((t) => !LEGAL.has(t) && !BRANCH_TOKEN.test(t) && !NUMERIC_TOKEN.test(t) && !/^[.,:;|]+$/.test(t));
  while (tokens.length > 1 && COUNTRY.has(tokens[tokens.length - 1]!)) tokens.pop();
  // a bare country code left alone means we stripped the whole name: fall back to the normalized text
  if (tokens.length === 1 && COUNTRY.has(tokens[0]!)) tokens = normalizeDescription(description).split(' ').filter(Boolean);
  // "בע מ" split by the quote removal
  tokens = tokens.filter((t, i) => !(t === 'בע' && tokens[i + 1] === 'מ')).filter((t, i, arr) => !(t === 'מ' && arr[i - 1] === undefined));
  // strip trailing lone short numbers (branch numbers) like "אלונית 12"
  while (tokens.length > 1 && /^\d{1,3}$/.test(tokens[tokens.length - 1]!)) tokens.pop();
  // dotted domains: "aliexpress.com" → "aliexpress", "www.x.com" → "x"
  tokens = tokens.map((t) => t.replace(/^www\./, '').replace(/\.(com|co\.il|net|org|io|ai|co)$/i, '')).filter(Boolean);
  const key = tokens.join(' ').trim() || normalizeDescription(description) || 'unknown';
  return { key, name: titleCase(key) };
}

function titleCase(s: string): string {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** Pull a source-specific merchant id from the raw payload, when the source has one. */
export function externalMerchantId(source: string, payload: unknown): string | undefined {
  const raw = (payload as { rawTransaction?: Record<string, unknown> } | null)?.rawTransaction;
  if (!raw) return undefined;
  if (source === 'scraper:max') {
    const md = raw.merchantData as { merchantNumber?: string; merchant?: string } | undefined;
    return md?.merchantNumber ?? md?.merchant ?? undefined;
  }
  if (source === 'scraper:isracard') {
    const id = raw.supplierId;
    return id === undefined || id === null || id === '' ? undefined : String(id);
  }
  return undefined;
}

export interface AssignMerchantsResult {
  transactionsAssigned: number;
  merchantsCreated: number;
}

/** Assign merchant_id to every transaction that lacks one; create merchants on first sight. */
export function assignMerchants(db: Db, opts: { reassignAll?: boolean } = {}): AssignMerchantsResult {
  let assigned = 0;
  let created = 0;
  db.transaction((tx) => {
    const rows = tx
      .select({ id: transactions.id, description: transactions.descriptionRaw, source: transactions.source, rawId: transactions.rawId })
      .from(transactions)
      .where(opts.reassignAll ? sql`1=1` : isNull(transactions.merchantId))
      .all();
    const cache = new Map<string, { id: number; aliases: Set<string>; ext: Record<string, Set<string>>; dirty: boolean }>();
    const load = (key: string, name: string) => {
      let m = cache.get(key);
      if (m) return m;
      const existing = tx.select().from(merchant).where(eq(merchant.key, key)).get();
      if (existing) {
        m = { id: existing.id, aliases: new Set(JSON.parse(existing.aliasesJson) as string[]), ext: parseExt(existing.externalIdsJson), dirty: false };
      } else {
        const ins = tx.insert(merchant).values({ key, name, createdAt: nowIso() }).run();
        created++;
        m = { id: Number(ins.lastInsertRowid), aliases: new Set(), ext: {}, dirty: true };
      }
      cache.set(key, m);
      return m;
    };
    for (const r of rows) {
      const { key, name } = merchantKey(r.description);
      const m = load(key, name);
      if (!m.aliases.has(r.description)) {
        m.aliases.add(r.description);
        m.dirty = true;
      }
      const raw = tx.select({ payload: rawTransaction.payloadJson, source: rawTransaction.source }).from(rawTransaction).where(eq(rawTransaction.id, r.rawId)).get();
      if (raw) {
        const ext = externalMerchantId(raw.source, JSON.parse(raw.payload));
        if (ext) {
          const k = raw.source.replace('scraper:', '');
          m.ext[k] ??= new Set();
          if (!m.ext[k].has(ext)) {
            m.ext[k].add(ext);
            m.dirty = true;
          }
        }
      }
      tx.update(transactions).set({ merchantId: m.id }).where(eq(transactions.id, r.id)).run();
      assigned++;
    }
    for (const m of cache.values()) {
      if (!m.dirty) continue;
      tx.update(merchant)
        .set({ aliasesJson: JSON.stringify([...m.aliases].slice(0, 50)), externalIdsJson: JSON.stringify(Object.fromEntries(Object.entries(m.ext).map(([k, v]) => [k, [...v]]))) })
        .where(eq(merchant.id, m.id))
        .run();
    }
  });
  return { transactionsAssigned: assigned, merchantsCreated: created };
}

/**
 * Cross-source aliasing: when a RiseUp row was folded into a scraped row, RiseUp's spelling of the
 * same merchant is known ("Anthropic Claude Su" on Isracard, "Claude Ai Subscription" at RiseUp).
 * If that spelling is a merchant of its own (from RiseUp-only history), the two are one business:
 * the smaller merges into the larger, keeping every alias and external id.
 */
export function mergeCrossSourceMerchants(db: Db): { merged: number; pairs: Array<{ from: string; into: string }> } {
  const pairs: Array<{ from: string; into: string }> = [];
  db.transaction((tx) => {
    const rows = tx
      .select({ merchantId: transactions.merchantId, other: sql<string | null>`json_extract(${transactions.annotationsJson}, '$.riseup.descriptionRaw')` })
      .from(transactions)
      .where(sql`${transactions.merchantId} is not null and json_extract(${transactions.annotationsJson}, '$.riseup.descriptionRaw') is not null`)
      .all();
    const byKey = new Map(tx.select().from(merchant).all().map((m) => [m.key, m]));
    const counts = new Map<number, number>(tx.select({ id: transactions.merchantId, n: sql<number>`count(*)` }).from(transactions).groupBy(transactions.merchantId).all().map((r) => [r.id ?? -1, r.n]));
    const redirected = new Map<number, number>();
    const resolve = (id: number): number => {
      let cur = id;
      while (redirected.has(cur)) cur = redirected.get(cur)!;
      return cur;
    };
    const votes = new Map<string, number>();
    for (const r of rows) {
      if (r.merchantId === null || !r.other) continue;
      const otherKey = merchantKey(r.other).key;
      const otherMerchant = byKey.get(otherKey);
      if (!otherMerchant || otherMerchant.id === r.merchantId) continue;
      const k = `${r.merchantId}|${otherMerchant.id}`;
      votes.set(k, (votes.get(k) ?? 0) + 1);
    }
    for (const [k, n] of votes) {
      if (n < 2) continue; // one coincidence is not evidence
      const [a, b] = k.split('|').map(Number) as [number, number];
      const ra = resolve(a);
      const rb = resolve(b);
      if (ra === rb) continue;
      const [into, from] = (counts.get(ra) ?? 0) >= (counts.get(rb) ?? 0) ? [ra, rb] : [rb, ra];
      const mInto = tx.select().from(merchant).where(eq(merchant.id, into)).get();
      const mFrom = tx.select().from(merchant).where(eq(merchant.id, from)).get();
      if (!mInto || !mFrom) continue;
      const aliases = new Set<string>([...(JSON.parse(mInto.aliasesJson) as string[]), ...(JSON.parse(mFrom.aliasesJson) as string[]), mFrom.name]);
      const ext = parseExt(mInto.externalIdsJson);
      for (const [src, ids] of Object.entries(parseExt(mFrom.externalIdsJson))) {
        ext[src] ??= new Set();
        for (const id of ids) ext[src].add(id);
      }
      tx.update(merchant)
        .set({
          aliasesJson: JSON.stringify([...aliases].slice(0, 50)),
          externalIdsJson: JSON.stringify(Object.fromEntries(Object.entries(ext).map(([s, v]) => [s, [...v]]))),
          defaultCategoryId: mInto.defaultCategoryId ?? mFrom.defaultCategoryId,
        })
        .where(eq(merchant.id, into))
        .run();
      tx.update(transactions).set({ merchantId: into }).where(eq(transactions.merchantId, from)).run();
      tx.delete(merchant).where(eq(merchant.id, from)).run();
      redirected.set(from, into);
      counts.set(into, (counts.get(into) ?? 0) + (counts.get(from) ?? 0));
      pairs.push({ from: mFrom.name, into: mInto.name });
    }
  });
  return { merged: pairs.length, pairs };
}

function parseExt(json: string): Record<string, Set<string>> {
  try {
    const o = JSON.parse(json) as Record<string, string[]>;
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, new Set(v)]));
  } catch {
    return {};
  }
}
