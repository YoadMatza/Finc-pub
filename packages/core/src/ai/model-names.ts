/**
 * The one place that decides which name of a transaction may leave the machine for a cloud model
 * (security research P1-14). finc's rule: merchant names, amounts and dates may leave; people's
 * names and the bank's own descriptions may not.
 *
 * The engine names every row's merchant from the row's own description, so on a bank account the
 * "merchant name" IS the description, and no word list catches every format a bank uses for a
 * person. The default is therefore inverted. A bank-side (non-card) expense never goes out by name:
 * its category name, else a generic label. Income never carries the payer: its category name. A
 * card purchase keeps its merchant name, except: a payment processor or wallet ("PAYPAL *JANE DOE",
 * "PEPPER PAY ROY", "<word>*<name>") goes out as "<Processor> payment", and a merchant that also
 * appears on a bank-side row (so its name may be a person paid from the bank, "רון לוי בעמ" on the
 * card and "רון לוי" at the bank) goes out as its category. Person-to-person and transfer wording
 * wins everywhere. The user's own stream labels pass when they pass the same person/transfer rule.
 * Everything the chat sends goes through `modelName`, then `guardEgress` on the whole tool result.
 */
import type { Db } from '../db/db.js';
import { PROCESSOR_PREFIX } from '../engine/merchant.js';
import { isPersonToPerson } from '../engine/p2p.js';
import { normalizeDescription } from '../ingest/normalize.js';

export const MODEL_LABELS = {
  sentToPerson: 'money sent to a person',
  receivedFromPerson: 'money received from a person',
  bankTransfer: 'bank transfer',
  cardBill: 'card bill',
  otherIncome: 'other income',
  unnamed: 'unnamed transaction',
} as const;

/**
 * The same labels in Hebrew, for the chat prompt only (chat v2 step 4): a Hebrew answer writes "כסף שהתקבל מאדם", not
 * the English label. Tool results keep the English labels above: they are the canonical, egress-checked names.
 */
export const MODEL_LABELS_HE: Record<keyof typeof MODEL_LABELS, string> = {
  sentToPerson: 'כסף שנשלח לאדם',
  receivedFromPerson: 'כסף שהתקבל מאדם',
  bankTransfer: 'העברה בנקאית',
  cardBill: 'חיוב כרטיס',
  otherIncome: 'הכנסה אחרת',
  unnamed: 'עסקה ללא שם',
};

const GENERIC = new Set<string>(Object.values(MODEL_LABELS));

/** Second layer on top of the inverted default: person-to-person wording PERSON_TO_PERSON does not cover. */
const PERSON_EXTRA = /(^|[\s\-:.,])[במלה]?ביט($|[\s\-:.,])|(^|[^a-z])bit:|pay\s*box|פיי\s*בוקס|זיכוי מ/i;

/**
 * Bank-transfer, standing-order and cheque wording, on raw and normalised text (quotes are gone
 * after normalising: "העב' לאחר" → "העב לאחר", "הו"ק" → "הוק", "מס"ב" → "מסב", "צ'ק" → "צק").
 */
const TRANSFER_WORDS =
  /(^|[\s\-.:,])(העברה|העברת|העברות|העבר|העב|הוראת קבע|הוראות קבע|הוק|הו ק|ה\.ק\.?|הק|מסב|מס"ב|משיכת שיק|החזרת שיק|שיק|צק|צ'ק|המחאה|המחאות|transfer|trf|swift|wire|standing order)($|[\s\-.:,])/i;

/** Display names for the processor prefixes the merchant step strips. */
const PROCESSORS: Array<[RegExp, string]> = [
  [/^paypal/i, 'PayPal'],
  [/^google/i, 'Google'],
  [/^apple/i, 'Apple'],
  [/^(amzn|amazon)/i, 'Amazon'],
  [/^uber/i, 'Uber'],
  [/^wlt/i, 'Wolt'],
  [/^grow/i, 'Grow'],
  [/^sumup/i, 'SumUp'],
  [/^(izettle|zettle)/i, 'Zettle'],
  [/^sq\b/i, 'Square'],
];

/** Wallets and person-to-person apps, as a word anywhere, with or without '*': whatever follows is a person or a shop behind them. */
const WALLETS: Array<[RegExp, string]> = [
  [/(^|[^\p{L}])(pepper(\s*pay)?|פפר)($|[^\p{L}])/iu, 'Pepper'],
  [/(^|[^\p{L}])venmo($|[^\p{L}])/iu, 'Venmo'],
  [/(^|[^\p{L}])revolut($|[^\p{L}])/iu, 'Revolut'],
  [/(^|[^\p{L}])wise($|[^\p{L}])/iu, 'Wise'],
  [/(^|[^\p{L}])cash\s*app($|[^\p{L}])/iu, 'Cash App'],
  [/(^|[^\p{L}])zelle($|[^\p{L}])/iu, 'Zelle'],
  [/(^|[^\p{L}])paypal($|[^\p{L}])/iu, 'PayPal'],
  [/(^|[^\p{L}])pay2house($|[^\p{L}])/iu, 'Pay2House'],
  [/(^|[^\p{L}])bitpay($|[^\p{L}])/iu, 'BitPay'],
];

/** The engine's processor prefixes written with a space instead of '*' ("SP JANE DOE"): still a processor (review round 3). */
const PREFIX_SPACE = /^(bh|pp|sq|sp|tst|dd|amzn mktp|amazon mktp|google|uber|wlt)\s+(?=\p{L})/iu;

/** "<word>*<rest>" / "<word> *<rest>" where the rest has letters: a processor in front of someone else's name. */
const STAR_SHAPE = /^\s*([\p{L}][\p{L}.]*)\s*\*\s*(?=.*\p{L})/u;

/**
 * "PayPal payment" for a description that goes through a payment processor or wallet
 * ("PAYPAL *JANE DOE", "PAYPAL JANE DOE", "PEPPER PAY ROY", "REVOLUT*KATE BELL", any "<word>*<name>");
 * otherwise null. Never the part after the processor. "WOLT*123" (digits only after '*') is not one.
 */
export function processorLabel(rawDescription: string | null | undefined): string | null {
  const raw = (rawDescription ?? '').trim();
  const wallet = WALLETS.find(([re]) => re.test(raw));
  if (wallet) return `${wallet[1]} payment`;
  const m = PROCESSOR_PREFIX.exec(raw);
  if (m) {
    const hit = PROCESSORS.find(([re]) => re.test(raw));
    if (hit) return `${hit[1]} payment`;
  }
  // the word in front of '*' is named only when it is a known processor: "DANI*COHEN" must not send "Dani" (review round 3)
  const s = STAR_SHAPE.exec(raw);
  if (s || m || PREFIX_SPACE.test(raw)) {
    const hit = PROCESSORS.find(([re]) => re.test(raw));
    return hit ? `${hit[1]} payment` : 'card payment';
  }
  return null;
}

export interface ModelNameInput {
  /** the merchant table's name (null when the row has no merchant) */
  merchantName: string | null | undefined;
  /** the row's descriptions (raw first, then normalised), checked locally only, never returned */
  descriptions?: Array<string | null | undefined>;
  kind?: string | null;
  categoryKey?: string | null;
  /** the category's English name: the label for income, bank-side rows and suspect card merchants */
  categoryName?: string | null | undefined;
  /** signed amount (any unit); decides sent/received and income */
  amount: number;
  /** the row (or stream) is on a credit-card account */
  onCard: boolean;
  /** the merchant also appears on a bank-side (non-card) row: its name may be a person's */
  merchantOnBank: boolean;
  /** the user's own label (recurring streams); sent when it passes the person/transfer rules */
  label?: string | null;
}

const norm = (s: string | null | undefined): string => (s ? normalizeDescription(s) : '');

/** Booking numbers and the like: everything from a '*' followed by digits, digit runs of 3+, extra spaces. */
export function cleanMerchantName(name: string | null | undefined): string {
  const s = (name ?? '')
    .replace(/\*+\s*\d.*$/s, '')
    .replace(/\d{3,}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return /[\p{L}]/u.test(s) ? s : '';
}

/** Whether a name is one of the generic labels (not a merchant's or the user's own). */
export const isGenericLabel = (name: string): boolean => GENERIC.has(name);

/** The only name of a transaction (or a stream) that may be sent to a model. Never a description. */
export function modelName(i: ModelNameInput): string {
  const texts = [i.merchantName, i.label, ...(i.descriptions ?? [])].filter((t): t is string => !!t).flatMap((t) => [t, norm(t)]);
  if (i.categoryKey === 'lifestyle.people' || texts.some((t) => isPersonToPerson(t) || PERSON_EXTRA.test(t))) return i.amount < 0 ? MODEL_LABELS.sentToPerson : MODEL_LABELS.receivedFromPerson;
  if (i.kind === 'transfer') return MODEL_LABELS.bankTransfer;
  if (i.kind === 'settlement') return MODEL_LABELS.cardBill;
  if (texts.some((t) => TRANSFER_WORDS.test(t))) return MODEL_LABELS.bankTransfer;
  const label = cleanMerchantName(i.label);
  if (label) return label;
  const category = cleanMerchantName(i.categoryName);
  if (i.amount > 0) return category || MODEL_LABELS.otherIncome;
  // bank-side expenses never go out by name
  if (!i.onCard) return category || MODEL_LABELS.unnamed;
  const proc = (i.descriptions ?? []).map(processorLabel).find((p) => p !== null);
  if (proc) return proc;
  if (i.merchantOnBank) return category || MODEL_LABELS.unnamed;
  return cleanMerchantName(i.merchantName) || category || MODEL_LABELS.unnamed;
}

/** Merchants seen on any bank-side (non-card) row: on the card too, their names are not sent. */
export function bankMerchantIds(db: Db): Set<number> {
  const rows = db.$client
    .prepare(`select distinct t.merchant_id id from "transaction" t join account a on a.id = t.account_id where a.type <> 'credit_card' and t.merchant_id is not null`)
    .all() as Array<{ id: number }>;
  return new Set(rows.map((r) => r.id));
}

/** What one chat call has approved to leave, and what it must never send verbatim. */
export interface EgressContext {
  /** names produced by modelName / the category table / the user's own names in this call */
  allowed: Set<string>;
  /** lazily loaded: every stored description_raw and description_norm */
  descriptions: () => { raw: Set<string>; norm: Set<string> };
}

/**
 * The last check before a tool result is added to what the model sees: every string value with a
 * digit run of 5+ has it replaced by "…", and a string that is exactly a stored bank description
 * (raw or normalised) becomes "unnamed transaction" unless this call approved it as a name.
 * Numbers (amounts) are left alone.
 */
export function guardEgress(value: unknown, ctx: EgressContext): unknown {
  if (typeof value === 'string') {
    const s = value.replace(/\d{5,}/g, '…');
    if (ctx.allowed.has(value) || ctx.allowed.has(s)) return s;
    const d = ctx.descriptions();
    const t = value.trim();
    if (t && (d.raw.has(t) || d.norm.has(normalizeDescription(t)))) return MODEL_LABELS.unnamed;
    return s;
  }
  if (Array.isArray(value)) return value.map((v) => guardEgress(v, ctx));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, guardEgress(v, ctx)]));
  return value;
}
