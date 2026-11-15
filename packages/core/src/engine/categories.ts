/**
 * Category taxonomy (design/05 §4, editable) and the mapping from RiseUp's labels onto it.
 */
import { eq } from 'drizzle-orm';
import type { Db } from '../db/db.js';
import { nowIso } from '../db/db.js';
import { category } from '../db/schema.js';

export type Section = 'income' | 'fixed' | 'variable' | 'savings' | 'transfer';

export interface CategorySeed {
  key: string;
  he: string;
  en: string;
  group: string;
  section: Section;
  icon?: string;
  track?: boolean;
}

export const CATEGORY_SEED: CategorySeed[] = [
  // income
  { key: 'income.salary', he: 'משכורת', en: 'Salary', group: 'income', section: 'income', icon: '💼' },
  { key: 'income.other', he: 'הכנסות אחרות', en: 'Other income', group: 'income', section: 'income', icon: '💰' },
  { key: 'income.cashback', he: 'החזרים וקאשבק', en: 'Cashback & refunds', group: 'income', section: 'income', icon: '🪙' },
  { key: 'income.freelance', he: 'עבודה עצמאית', en: 'Freelance', group: 'income', section: 'income', icon: '🧾' },
  { key: 'income.home_project', he: 'פינוי־בינוי: פיצוי ושכירות', en: 'Urban renewal: compensation & rent', group: 'income', section: 'income', icon: '🏗️' },
  // fixed / recurring
  { key: 'fixed.housing', he: 'דיור', en: 'Housing', group: 'fixed', section: 'fixed', icon: '🏠' },
  { key: 'fixed.utilities', he: 'חשבונות בית', en: 'Utilities', group: 'fixed', section: 'fixed', icon: '💡' },
  { key: 'fixed.insurance', he: 'ביטוח', en: 'Insurance', group: 'fixed', section: 'fixed', icon: '🛡️' },
  { key: 'fixed.health', he: 'בריאות', en: 'Health', group: 'fixed', section: 'fixed', icon: '🏥' },
  { key: 'fixed.communication', he: 'תקשורת', en: 'Communication', group: 'fixed', section: 'fixed', icon: '📱' },
  { key: 'fixed.digital', he: 'דיגיטל ומנויים', en: 'Digital & subscriptions', group: 'fixed', section: 'fixed', icon: '💻' },
  { key: 'fixed.sport', he: 'ספורט', en: 'Sport', group: 'fixed', section: 'fixed', icon: '🏋️' },
  { key: 'fixed.education', he: 'חינוך ולימודים', en: 'Education', group: 'fixed', section: 'fixed', icon: '🎓' },
  { key: 'fixed.taxes', he: 'מיסים ואגרות', en: 'Taxes & government', group: 'fixed', section: 'fixed', icon: '🏛️' },
  // installments
  { key: 'installments', he: 'תשלומים', en: 'Installments', group: 'installments', section: 'fixed', icon: '📆' },
  // lifestyle
  { key: 'lifestyle.eating_out', he: 'אוכל בחוץ', en: 'Eating out', group: 'lifestyle', section: 'variable', icon: '🍽️' },
  { key: 'lifestyle.leisure', he: 'פנאי ובילויים', en: 'Leisure', group: 'lifestyle', section: 'variable', icon: '🎭' },
  { key: 'lifestyle.shopping', he: 'קניות', en: 'Shopping', group: 'lifestyle', section: 'variable', icon: '🛍️' },
  { key: 'lifestyle.travel', he: 'נסיעות לחו"ל', en: 'Travel', group: 'lifestyle', section: 'variable', icon: '✈️' },
  { key: 'lifestyle.gifts', he: 'מתנות ותרומות', en: 'Gifts & donations', group: 'lifestyle', section: 'variable', icon: '🎁' },
  { key: 'lifestyle.people', he: 'Bit והעברות לאנשים', en: 'Bit & transfers to people', group: 'lifestyle', section: 'variable', icon: '👥' },
  // car & transport
  { key: 'car.fuel', he: 'דלק', en: 'Fuel', group: 'car', section: 'variable', icon: '⛽' },
  { key: 'car.insurance', he: 'ביטוח רכב', en: 'Car insurance', group: 'car', section: 'fixed', icon: '🚗' },
  { key: 'car.maintenance', he: 'טיפולים ותיקונים', en: 'Maintenance', group: 'car', section: 'variable', icon: '🔧' },
  { key: 'car.parking', he: 'חניה וכבישי אגרה', en: 'Parking & tolls', group: 'car', section: 'variable', icon: '🅿️' },
  { key: 'car.public_transport', he: 'תחבורה ציבורית ומוניות', en: 'Public transport & taxis', group: 'car', section: 'variable', icon: '🚌' },
  // daily
  { key: 'daily.supermarket', he: 'סופר', en: 'Supermarket', group: 'daily', section: 'variable', icon: '🛒' },
  { key: 'daily.pharm', he: 'פארם וטיפוח', en: 'Pharmacy & care', group: 'daily', section: 'variable', icon: '🧴' },
  { key: 'daily.pets', he: 'חיות מחמד', en: 'Pets', group: 'daily', section: 'variable', icon: '🐾' },
  { key: 'daily.home', he: 'בית וריהוט', en: 'Home', group: 'daily', section: 'variable', icon: '🛋️' },
  { key: 'daily.kids', he: 'ילדים', en: 'Kids', group: 'daily', section: 'variable', icon: '🧒' },
  // savings
  { key: 'savings.pension', he: 'פנסיה וגמל', en: 'Pension', group: 'savings', section: 'savings', icon: '🏦' },
  { key: 'savings.investments', he: 'השקעות וחיסכון', en: 'Investments & savings', group: 'savings', section: 'savings', icon: '📈' },
  // transfers (hidden) & fees
  { key: 'transfers', he: 'העברות', en: 'Transfers', group: 'transfers', section: 'transfer', icon: '🔁', track: false },
  { key: 'fees', he: 'עמלות וריבית', en: 'Fees & interest', group: 'fees', section: 'variable', icon: '🏧' },
  { key: 'other', he: 'אחר', en: 'Other', group: 'other', section: 'variable', icon: '❔' },
  { key: 'other.home_project', he: 'פינוי־בינוי: שדרוג הדירה', en: 'Urban renewal: home upgrade', group: 'other', section: 'variable', icon: '🏗️' },
];

/**
 * Display names of the category groups (the `group_key` of each category), as the web shows them, plus the
 * everyday words for a group ("car" / "רכב" → car). Fixed words, no personal data: approved for the chat's egress.
 */
export const CATEGORY_GROUPS: Array<{ key: string; en: string; he: string; aliases: string[] }> = [
  { key: 'income', en: 'Income', he: 'הכנסות', aliases: ['הכנסה'] },
  { key: 'fixed', en: 'Fixed', he: 'קבועות', aliases: ['הוצאות קבועות'] },
  { key: 'installments', en: 'Installments', he: 'תשלומים', aliases: [] },
  { key: 'lifestyle', en: 'Lifestyle', he: 'פנאי וסגנון חיים', aliases: ['סגנון חיים'] },
  { key: 'car', en: 'Car & transport', he: 'רכב ותחבורה', aliases: ['car', 'cars', 'vehicle', 'transport', 'transportation', 'רכב', 'הרכב', 'תחבורה', 'רכב ותחבורה'] },
  { key: 'daily', en: 'Daily', he: 'יומיומי', aliases: ['יומיום'] },
  { key: 'savings', en: 'Savings', he: 'חיסכון', aliases: [] },
  { key: 'transfers', en: 'Transfers', he: 'העברות', aliases: [] },
  { key: 'fees', en: 'Fees', he: 'עמלות', aliases: [] },
  { key: 'other', en: 'Other', he: 'אחר', aliases: [] },
];

/** RiseUp's labels (seen in the data) → our keys. null = no information. */
export const RISEUP_LABEL_MAP: Record<string, string | null> = {
  'אוכל בחוץ': 'lifestyle.eating_out',
  כלכלה: 'daily.supermarket',
  סופר: 'daily.supermarket',
  רכב: 'car.fuel',
  דיגיטל: 'fixed.digital',
  בריאות: 'fixed.health',
  כללי: null,
  פנאי: 'lifestyle.leisure',
  תשלומים: null,
  שיק: 'fixed.housing',
  'חיות מחמד': 'daily.pets',
  עמלות: 'fees',
  RiseUp: 'fixed.digital',
  תקשורת: 'fixed.communication',
  'השקעה וחיסכון': 'savings.investments',
  '__saving-hidden-category__': 'savings.investments',
  ביטוח: 'fixed.insurance',
  'תחבורה ציבורית': 'car.public_transport',
  זיכויים: null,
  ארנונה: 'fixed.utilities',
  חשמל: 'fixed.utilities',
  גז: 'fixed.utilities',
  מים: 'fixed.utilities',
  ספורט: 'fixed.sport',
  משכורת: 'income.salary',
  הכנסות: 'income.other',
  חינוך: 'fixed.education',
  ביגוד: 'lifestyle.shopping',
  קניות: 'lifestyle.shopping',
  'נסיעות לחו"ל': 'lifestyle.travel',
  'חו"ל': 'lifestyle.travel',
  מתנות: 'lifestyle.gifts',
  בית: 'daily.home',
  פארם: 'daily.pharm',
  אחר: null,
};

export function seedCategories(db: Db): number {
  let created = 0;
  db.transaction((tx) => {
    CATEGORY_SEED.forEach((c, i) => {
      const exists = tx.select({ id: category.id }).from(category).where(eq(category.key, c.key)).get();
      if (exists) return;
      tx.insert(category)
        .values({ key: c.key, nameHe: c.he, nameEn: c.en, groupKey: c.group, section: c.section, icon: c.icon ?? null, track: c.track ?? true, sortOrder: i, createdAt: nowIso() })
        .run();
      created++;
    });
  });
  return created;
}

export type CategoryRow = typeof category.$inferSelect;

export function categoryIndex(db: Db): { byKey: Map<string, CategoryRow>; byId: Map<number, CategoryRow> } {
  const rows = db.select().from(category).all();
  return { byKey: new Map(rows.map((r) => [r.key, r])), byId: new Map(rows.map((r) => [r.id, r])) };
}

/** Resolve a user-typed category: exact key, or a unique match on English/Hebrew name or key suffix. */
export function resolveCategory(db: Db, text: string): CategoryRow {
  const rows = db.select().from(category).all();
  const t = text.trim().toLowerCase();
  const exact = rows.find((r) => r.key === t);
  if (exact) return exact;
  const matches = rows.filter((r) => r.nameEn.toLowerCase() === t || r.nameHe === text.trim() || r.key.endsWith(`.${t}`) || r.key.split('.').pop() === t);
  if (matches.length === 1) return matches[0]!;
  const fuzzy = rows.filter((r) => r.key.includes(t) || r.nameEn.toLowerCase().includes(t) || r.nameHe.includes(text.trim()));
  if (fuzzy.length === 1) return fuzzy[0]!;
  throw new Error(`category "${text}" is ${matches.length + fuzzy.length ? 'ambiguous' : 'unknown'}; run finc cat list`);
}
