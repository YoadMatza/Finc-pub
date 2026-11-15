/**
 * Categorizer (§5 step 5): rules → merchant memory → RiseUp's label → keyword heuristics → (AI, separate step)
 * → otherwise "needs review". Every assignment records its source and confidence; a user decision
 * (source 'user' or 'rule') is never overwritten by an automatic one.
 */
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../db/db.js';
import { nowIso } from '../db/db.js';
import { category, merchant, rule, transactions } from '../db/schema.js';
import { type CategoryRow, RISEUP_LABEL_MAP, categoryIndex } from './categories.js';
import { isPersonToPerson } from './p2p.js';

export type CategorySource = 'user' | 'rule' | 'memory' | 'riseup' | 'heuristic' | 'ai';
const PROTECTED: ReadonlySet<string> = new Set(['user', 'rule']);

export interface RuleConditions {
  merchantId?: number;
  descriptionContains?: string;
  accountId?: number;
  amountMin?: number;
  amountMax?: number;
  kind?: string;
}
export interface RuleActions {
  categoryId?: number;
  exclude?: boolean;
  kind?: string;
}

/** Keyword heuristics for merchants nobody has decided on yet. Hebrew and English, lowercase, matched on the normalized description. */
export const KEYWORD_RULES: Array<{ key: string; words: string[] }> = [
  { key: 'car.fuel', words: ['דלק', 'פז ', 'פז אפליקצית', 'yellow', 'סונול', 'דור אלון', 'ten ', 'תחנת'] },
  { key: 'car.parking', words: ['חניה', 'חניון', 'פנגו', 'pango', 'cellopark', 'סלופארק', 'כביש 6', 'נתיבי איילון', 'אגרת'] },
  { key: 'car.public_transport', words: ['רב-פס', 'רב פס', 'רכבת', 'אגד', 'דן ', 'מוניות', 'gett', 'yango', 'bolt', 'uber', 'מ.תחבורה', 'הופ און'] },
  { key: 'daily.supermarket', words: ['סופר', 'שופרסל', 'רמי לוי', 'יוחננוף', 'ויקטורי', 'טיב טעם', 'אושר עד', 'מגה', 'am:pm', 'אי.אם.פי.אם', 'ampm', 'מינימרקט', 'מרקט', 'ירקות', 'מכולת', 'מעדני', 'חצי חינם', 'יינות ביתן', 'קרפור', 'carrefour'] },
  { key: 'daily.pharm', words: ['סופר פארם', 'סופר-פארם', 'פארם', 'be ', 'גוד פארם', 'ניו פארם'] },
  { key: 'daily.pets', words: ['חיות', 'וטרינר', 'pet', 'גג לחיות', 'אניפט'] },
  { key: 'lifestyle.eating_out', words: ['קפה', 'מסעד', 'פיצה', 'בורגר', 'סושי', 'בר ', 'ביסטרו', 'wolt', 'וולט', '10bis', 'תן ביס', 'שווארמה', 'פלאפל', 'גריל', 'מאפ', 'בייקר', 'גלידה', 'ארומה', 'לנדוור', 'קפסולה', 'cafe', 'coffee', 'restaurant', 'bakery', 'pizza', 'burger', 'pub', 'בירה', 'בירות', 'יין', 'יקב', 'wine'] },
  { key: 'lifestyle.leisure', words: ['סינמה', 'קולנוע', 'יס פלאנט', 'תיאטרון', 'הופעה', 'כרטיסים', 'באולינג', 'escape', 'מוזיאון', 'ספא', 'netflix', 'spotify', 'steam', 'playstation', 'nintendo', 'youtube', 'disney', 'hot ', 'yes '] },
  { key: 'lifestyle.shopping', words: ['aliexpress', 'amazon', 'ebay', 'shein', 'temu', 'zara', 'h&m', 'castro', 'fox', 'טרמינל', 'terminal x', 'ksp', 'איביי', 'באג', 'אייס', 'ace ', 'איקאה', 'ikea', 'next', 'asos', 'nike', 'adidas', 'decathlon', 'דקטלון', 'מתנות', 'צעצוע'] },
  { key: 'lifestyle.travel', words: ['airlines', 'airline', 'el al', 'elal', 'ethiopian', 'wizz', 'ryanair', 'easyjet', 'booking', 'agoda', 'airbnb', 'hotel', 'מלון', 'jrpass', 'klook', 'navigo', 'metro'] },
  { key: 'fixed.digital', words: ['openai', 'chatgpt', 'claude', 'anthropic', 'google one', 'google storage', 'icloud', 'apple.com', 'microsoft', 'github', 'dropbox', 'notion', 'adobe', 'subscription', 'מנוי', 'riseup', 'רייזאפ', 'real debrid', 'real-debrid', 'songsterr', 'xai', 'grok', 'cursor', 'jetbrains', 'nordvpn', 'vpn'] },
  { key: 'fixed.communication', words: ['סלקום', 'פרטנר', 'הוט מובייל', 'פלאפון', 'גולן', 'we4g', '019', 'רמי לוי תקשורת', 'בזק', 'cellcom', 'partner'] },
  { key: 'fixed.health', words: ['מכבי', 'כללית', 'מאוחדת', 'לאומית', 'קופת חולים', 'רופא', 'שיניים', 'אופטיק', 'משקפ', 'פסיכולוג', 'ביטוח בריאות'] },
  { key: 'fixed.insurance', words: ['ביטוח', 'הראל', 'מגדל', 'כלל', 'הפניקס', 'מנורה', 'איילון', 'ליברה', 'ביטוח ישיר', 'aig', 'שלמה ביטוח'] },
  { key: 'fixed.utilities', words: ['חשמל', 'מים', 'ארנונה', 'עיריית', 'גז', 'סופרגז', 'אמישראגז', 'פזגז', 'מי ', 'ועד בית'] },
  { key: 'fixed.housing', words: ['שכר דירה', 'שכ"ד', 'שכד', 'משיכת שיק', 'דירה'] },
  { key: 'fixed.sport', words: ['קאנטרי', 'חדר כושר', 'כושר', 'gym', 'holmes', 'הולמס', 'ספורט', 'יוגה', 'פילאטיס', 'שחייה', 'speed'] },
  { key: 'fixed.taxes', words: ['ביטוח לאומי', 'מס הכנסה', 'רשות המיסים', 'משרד הפנים', 'משרד התחבורה', 'אגרת רישוי'] },
  { key: 'savings.pension', words: ['פנסיה', 'גמל', 'השתלמות'] },
  { key: 'savings.investments', words: ['חיסכון', 'פקדון', 'פיקדון', 'קרן', 'ני"ע', 'ניע', 'מניות', 'ibi', 'מיטב', 'אלטשולר'] },
  { key: 'fees', words: ['עמלת', 'עמלה', 'דמי כרטיס', 'דמי ניהול', 'ריבית', 'דנח ניע', 'דמי שימוש'] },
  { key: 'income.cashback', words: ['topcash', 'קאשבק', 'cashback'] },
];

export interface CategorizeResult {
  considered: number;
  assigned: { rule: number; memory: number; riseup: number; heuristic: number };
  unchanged: number;
  uncategorized: number;
  memorySeeded: number;
}

/**
 * Merchant memory seeded from RiseUp: when ≥ 2 labelled rows of a merchant agree ≥ 90% on a label that
 * maps to one of our categories, the merchant's default category becomes that (source 'riseup' at the
 * merchant level; a user decision later replaces it).
 */
export function seedMerchantMemoryFromRiseup(db: Db): number {
  const { byKey } = categoryIndex(db);
  let seeded = 0;
  db.transaction((tx) => {
    const rows = tx
      .select({ merchantId: transactions.merchantId, label: sql<string | null>`json_extract(${transactions.annotationsJson}, '$.riseup.categoryLabel')`, n: sql<number>`count(*)` })
      .from(transactions)
      .where(and(eq(transactions.excluded, false), sql`${transactions.merchantId} is not null`))
      .groupBy(transactions.merchantId, sql`json_extract(${transactions.annotationsJson}, '$.riseup.categoryLabel')`)
      .all();
    const byMerchant = new Map<number, Array<{ label: string | null; n: number }>>();
    for (const r of rows) {
      if (r.merchantId === null) continue;
      byMerchant.set(r.merchantId, [...(byMerchant.get(r.merchantId) ?? []), { label: r.label, n: r.n }]);
    }
    for (const [merchantId, labels] of byMerchant) {
      const labelled = labels.filter((l) => l.label && RISEUP_LABEL_MAP[l.label] !== undefined && RISEUP_LABEL_MAP[l.label] !== null);
      const total = labelled.reduce((s, l) => s + l.n, 0);
      if (total < 2) continue;
      const top = [...labelled].sort((a, b) => b.n - a.n)[0]!;
      if (top.n / total < 0.9) continue;
      const cat = byKey.get(RISEUP_LABEL_MAP[top.label!]!);
      if (!cat) continue;
      const m = tx.select().from(merchant).where(eq(merchant.id, merchantId)).get();
      if (!m || m.defaultCategoryId !== null) continue;
      tx.update(merchant).set({ defaultCategoryId: cat.id }).where(eq(merchant.id, merchantId)).run();
      seeded++;
    }
  });
  return seeded;
}

function matchesRule(c: RuleConditions, t: typeof transactions.$inferSelect): boolean {
  if (c.merchantId !== undefined && t.merchantId !== c.merchantId) return false;
  if (c.accountId !== undefined && t.accountId !== c.accountId) return false;
  if (c.kind !== undefined && t.kind !== c.kind) return false;
  if (c.descriptionContains !== undefined && !t.descriptionNorm.includes(c.descriptionContains.toLowerCase())) return false;
  if (c.amountMin !== undefined && t.amountIls < c.amountMin) return false;
  if (c.amountMax !== undefined && t.amountIls > c.amountMax) return false;
  return true;
}

export function heuristicCategory(descriptionNorm: string, byKey: Map<string, CategoryRow>): CategoryRow | null {
  const d = ` ${descriptionNorm} `;
  for (const r of KEYWORD_RULES) {
    if (r.words.some((w) => d.includes(w.toLowerCase()))) {
      const c = byKey.get(r.key);
      if (c) return c;
    }
  }
  return null;
}

export function categorize(db: Db, opts: { recomputeAutomatic?: boolean } = {}): CategorizeResult {
  const res: CategorizeResult = { considered: 0, assigned: { rule: 0, memory: 0, riseup: 0, heuristic: 0 }, unchanged: 0, uncategorized: 0, memorySeeded: 0 };
  res.memorySeeded = seedMerchantMemoryFromRiseup(db);
  const { byKey } = categoryIndex(db);
  const income = byKey.get('income.other');
  const salary = byKey.get('income.salary');
  const pension = byKey.get('savings.pension');
  const transfersCat = byKey.get('transfers');
  const installmentsCat = byKey.get('installments');
  const peopleCat = byKey.get('lifestyle.people');
  db.transaction((tx) => {
    const rules = tx
      .select()
      .from(rule)
      .where(eq(rule.enabled, true))
      .all()
      .sort((a, b) => a.priority - b.priority)
      .map((r) => ({ ...r, conditions: JSON.parse(r.conditionsJson) as RuleConditions, actions: JSON.parse(r.actionsJson) as RuleActions }));
    const memory = new Map(tx.select({ id: merchant.id, cat: merchant.defaultCategoryId }).from(merchant).all().map((m) => [m.id, m.cat]));
    const rows = tx
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.status, 'completed'),
          opts.recomputeAutomatic ? sql`coalesce(${transactions.categorySource}, '') not in ('user', 'rule')` : or(isNull(transactions.categoryId), sql`${transactions.categorySource} not in ('user','rule','memory')`),
        ),
      )
      .all();
    for (const t of rows) {
      res.considered++;
      if (t.categorySource && PROTECTED.has(t.categorySource)) {
        res.unchanged++;
        continue;
      }
      let cat: number | null = null;
      let source: CategorySource | null = null;
      let conf = 0;
      // 1. rules
      for (const r of rules) {
        if (!matchesRule(r.conditions, t)) continue;
        if (r.actions.categoryId !== undefined) {
          cat = r.actions.categoryId;
          source = 'rule';
          conf = 1;
        }
        if (r.actions.exclude) tx.update(transactions).set({ excluded: true, kind: 'ignore' }).where(eq(transactions.id, t.id)).run();
        if (r.actions.kind) tx.update(transactions).set({ kind: r.actions.kind }).where(eq(transactions.id, t.id)).run();
        break;
      }
      // structural kinds first: transfers, settlements, savings, income
      if (!cat && (t.kind === 'transfer' || t.kind === 'settlement') && transfersCat) {
        cat = transfersCat.id;
        source = 'heuristic';
        conf = 1;
      }
      // money sent to a person (Bit, PayBox) is spending in its own category, like RiseUp counted it
      if (!cat && t.amountIls < 0 && peopleCat && isPersonToPerson(t.descriptionNorm)) {
        cat = peopleCat.id;
        source = 'heuristic';
        conf = 0.9;
      }
      if (!cat && t.kind === 'savings' && pension) {
        cat = pension.id;
        source = 'heuristic';
        conf = 0.9;
      }
      // 2. merchant memory
      if (!cat && t.merchantId !== null) {
        const m = memory.get(t.merchantId);
        if (m) {
          cat = m;
          source = 'memory';
          conf = 0.9;
        }
      }
      // 3. RiseUp's row-level label
      if (!cat) {
        const label = riseupLabel(t.annotationsJson);
        const key = label ? RISEUP_LABEL_MAP[label] : undefined;
        const c = key ? byKey.get(key) : undefined;
        if (c) {
          cat = c.id;
          source = 'riseup';
          conf = 0.7;
        }
      }
      // 4. keyword heuristics
      if (!cat) {
        const c = heuristicCategory(t.descriptionNorm, byKey);
        if (c) {
          cat = c.id;
          source = 'heuristic';
          conf = 0.55;
        }
      }
      // 4b. a card charge in a currency other than ILS/USD/EUR is almost always spending abroad
      if (!cat && t.amountIls < 0 && t.originalCurrency && !['ILS', 'USD', 'EUR'].includes(t.originalCurrency)) {
        const c = byKey.get('lifestyle.travel');
        if (c) {
          cat = c.id;
          source = 'heuristic';
          conf = 0.5;
        }
      }
      // 5a. a credit from a card company is a refund or compensation, not income (decision 2026-11-09)
      if (!cat && t.kind === 'income' && t.amountIls > 0 && /מקס איט|max it|ישראכרט|isracard|(^|\s)כאל(\s|$)|\bcal\b|לאומי קארד|leumi card/i.test(t.descriptionNorm)) {
        const c = byKey.get('income.cashback');
        if (c) {
          cat = c.id;
          source = 'heuristic';
          conf = 0.6;
        }
      }
      // 5. income by kind: salary-sized early-month income → salary, else other income
      if (!cat && t.kind === 'income' && t.amountIls > 0) {
        const day = Number(t.txnDate.slice(8, 10));
        const isSalary = t.amountIls >= 300_000 && (day <= 3 || day >= 28);
        const c = isSalary ? salary : income;
        if (c) {
          cat = c.id;
          source = 'heuristic';
          conf = isSalary ? 0.75 : 0.5;
        }
      }
      // installments inherit their plan's merchant category; otherwise the generic bucket
      if (!cat && t.installmentPlanId !== null && installmentsCat) {
        cat = installmentsCat.id;
        source = 'heuristic';
        conf = 0.5;
      }
      if (cat === null || source === null) {
        if (t.categoryId !== null && !opts.recomputeAutomatic) res.unchanged++;
        else {
          if (t.categoryId !== null) tx.update(transactions).set({ categoryId: null, categorySource: null, categoryConfidence: null }).where(eq(transactions.id, t.id)).run();
          res.uncategorized++;
        }
        continue;
      }
      if (t.categoryId === cat && t.categorySource === source) {
        res.unchanged++;
        continue;
      }
      tx.update(transactions).set({ categoryId: cat, categorySource: source, categoryConfidence: conf, updatedAt: nowIso() }).where(eq(transactions.id, t.id)).run();
      res.assigned[source as keyof CategorizeResult['assigned']]++;
    }
  });
  return res;
}

function riseupLabel(json: string | null): string | null {
  if (!json) return null;
  try {
    return ((JSON.parse(json) as { riseup?: { categoryLabel?: string } }).riseup?.categoryLabel ?? null) as string | null;
  } catch {
    return null;
  }
}

/** User decision: set a category on one transaction, optionally on the whole merchant (memory) and as a rule. */
export function setCategory(
  db: Db,
  p: { txnId?: number; merchantId?: number; categoryId: number; applyToMerchant?: boolean; createRule?: boolean; note?: string },
): { transactions: number; merchantUpdated: boolean; ruleId: number | null } {
  let count = 0;
  let merchantUpdated = false;
  let ruleId: number | null = null;
  db.transaction((tx) => {
    let merchantId = p.merchantId ?? null;
    // a row moved to a non-income category loses its regular/extra re-tag (Now screen, hub/now.ts)
    const incomeCategory = (tx.select({ section: category.section }).from(category).where(eq(category.id, p.categoryId)).get()?.section ?? null) === 'income';
    const clearKind = incomeCategory ? {} : { incomeKindOverride: null };
    if (p.txnId !== undefined) {
      const t = tx.select().from(transactions).where(eq(transactions.id, p.txnId)).get();
      if (!t) throw new Error(`no transaction #${p.txnId}`);
      merchantId ??= t.merchantId;
      tx.update(transactions).set({ categoryId: p.categoryId, categorySource: 'user', categoryConfidence: 1, ...clearKind, updatedAt: nowIso() }).where(eq(transactions.id, t.id)).run();
      count++;
    }
    if ((p.applyToMerchant || p.txnId === undefined) && merchantId !== null) {
      tx.update(merchant).set({ defaultCategoryId: p.categoryId }).where(eq(merchant.id, merchantId)).run();
      merchantUpdated = true;
      const r = tx
        .update(transactions)
        .set({ categoryId: p.categoryId, categorySource: 'memory', categoryConfidence: 0.95, ...clearKind, updatedAt: nowIso() })
        .where(and(eq(transactions.merchantId, merchantId), sql`coalesce(${transactions.categorySource}, '') not in ('user', 'rule')`))
        .run();
      count += r.changes;
    }
    if (p.createRule && merchantId !== null) {
      const ins = tx
        .insert(rule)
        .values({ conditionsJson: JSON.stringify({ merchantId }), actionsJson: JSON.stringify({ categoryId: p.categoryId }), createdFromTxnId: p.txnId ?? null, note: p.note ?? null, createdAt: nowIso() })
        .run();
      ruleId = Number(ins.lastInsertRowid);
    }
  });
  return { transactions: count, merchantUpdated, ruleId };
}

export interface CoverageReport {
  rows: number;
  categorized: number;
  share: number;
  bySource: Record<string, number>;
  uncategorizedByMerchant: Array<{ merchantId: number | null; name: string; rows: number; spend: number }>;
}

export function coverage(db: Db, since: string): CoverageReport {
  const rows = db
    .select({ source: transactions.categorySource, n: sql<number>`count(*)` })
    .from(transactions)
    .where(and(eq(transactions.excluded, false), eq(transactions.status, 'completed'), sql`${transactions.txnDate} >= ${since}`))
    .groupBy(transactions.categorySource)
    .all();
  const total = rows.reduce((s, r) => s + r.n, 0);
  const uncategorized = rows.find((r) => r.source === null)?.n ?? 0;
  const top = db
    .select({ merchantId: transactions.merchantId, name: sql<string>`coalesce(${merchant.name}, ${transactions.descriptionRaw})`, rows: sql<number>`count(*)`, spend: sql<number>`sum(case when ${transactions.amountIls} < 0 then -${transactions.amountIls} else 0 end)` })
    .from(transactions)
    .leftJoin(merchant, eq(merchant.id, transactions.merchantId))
    .where(and(eq(transactions.excluded, false), eq(transactions.status, 'completed'), sql`${transactions.txnDate} >= ${since}`, isNull(transactions.categoryId)))
    .groupBy(transactions.merchantId)
    .orderBy(sql`sum(case when ${transactions.amountIls} < 0 then -${transactions.amountIls} else 0 end) desc`)
    .limit(40)
    .all();
  return {
    rows: total,
    categorized: total - uncategorized,
    share: total ? (total - uncategorized) / total : 0,
    bySource: Object.fromEntries(rows.map((r) => [r.source ?? 'none', r.n])),
    uncategorizedByMerchant: top,
  };
}
