/**
 * Scoring for the chat eval: amounts read back out of a free-text answer (Hebrew or English), compared with a
 * tolerance one-to-one, a "did it ask instead of answering" test, and whole-word checks for forbidden strings and
 * required names. Pure functions, no database.
 */

/** Direction marks and isolates (LRM, RLM, ALM, LRE…PDF, LRI…PDI) that Hebrew answers carry around numbers. */
const BIDI = /[‎‏؜‪-‮⁦-⁩]/g;

/** Answer text with direction marks removed, odd spaces made plain and the minus sign made ASCII. */
export function normalizeAnswer(s: string): string {
  return s.replace(BIDI, '').replace(/[    ]/g, ' ').replace(/−/g, '-');
}

export interface ParsedNumber {
  /** the value written, with its sign; "1.2K" → 1200 */
  value: number;
  text: string;
  /** written with K / אלף / thousand */
  thousands: boolean;
  /** a currency mark next to it (₪, ש״ח, ILS, NIS, $, €…) */
  currency: boolean;
  /** followed by % / percent / אחוז */
  percent: boolean;
  /** followed by a time word: months, days, years, weeks (he + en) */
  unit: boolean;
  /** part of a date: 2026-11-20, 20/11, 20/11/2026, 11/2025, 20.11, 20.11.2026 */
  dateLike: boolean;
  /** a plain four-digit 1900–2100 (a year unless a currency mark says otherwise) */
  year: boolean;
}

const DATE = /(?<![\d.,])(?:\d{4}-\d{1,2}(?:-\d{1,2})?|\d{1,2}\/\d{4}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{1,2}\.(?:0?[1-9]|1[0-2])\.\d{2,4}|\d{1,2}\.(?:0[1-9]|1[0-2]))(?![\d,]|\.\d)/g;
const PERCENT_AFTER = /^\s*(%|percent|אחוז)/i;
const UNIT_AFTER = /^\s*(?:full\s+)?(?:months?|days?|years?|weeks?|חודשים|חודש|ימים|יום|שנים|שנה|שבועות|שבוע)(?![\p{L}])/iu;
const CURRENCY_BEFORE = /(₪|\$|€|\bILS|\bNIS)\s*-?\s*$/i;
const CURRENCY_AFTER = /^\s*(₪|ש״ח|ש"ח|שח(?!\p{L})|שקל|ILS\b|NIS\b|shekel|EUR\b|USD\b|€|\$|dollars?\b|euros?\b)/iu;

/**
 * Every number in an answer: 1,234 / 1234 / 1234.50 / ₪1,234 / 1,234 ₪ / ‏1,234‏ ש״ח / -50 / 1.2K / 12 אלף, each with
 * what surrounds it (currency, %, a time word, a date, a year). A "-" counts as a sign only when it does not follow a
 * digit or a letter (so the 11 in 2026-11 is not negative).
 */
export function parseNumbers(answer: string): ParsedNumber[] {
  const s = normalizeAnswer(answer);
  const dates: Array<[number, number]> = [];
  for (let d = DATE.exec(s); d; d = DATE.exec(s)) dates.push([d.index, d.index + d[0].length]);
  const out: ParsedNumber[] = [];
  const re = /(?<![\d.,])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?:\s?([kK])(?![A-Za-z])|\s?(אלף|thousand))?/g;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const int = m[1]!.replace(/,/g, '');
    const dec = m[2] ?? '';
    const thousands = !!(m[3] || m[4]);
    let value = Number(`${int}${dec ? `.${dec}` : ''}`);
    if (thousands) value *= 1000;
    const before = s.slice(0, m.index);
    const after = s.slice(m.index + m[0].length);
    // a sign directly before (spaces allowed), unless the dash joins two numbers or words (2026-11, ש״ח-50)
    const sign = /(^|[^\p{L}\p{N}])-\s*(₪\s*)?$/u.test(before);
    const currency = CURRENCY_BEFORE.test(before.slice(-8)) || CURRENCY_AFTER.test(after);
    const year = !thousands && !dec && /^\d{4}$/.test(m[1]!) && value >= 1900 && value <= 2100;
    out.push({
      value: sign ? -value : value,
      text: m[0],
      thousands,
      currency,
      percent: PERCENT_AFTER.test(after),
      unit: UNIT_AFTER.test(after),
      dateLike: dates.some(([a, b]) => m!.index >= a && m!.index < b),
      year,
    });
  }
  return out;
}

/** An amount of money rather than a date, a year, a count of months or a percentage: currency-marked or ≥ 100. */
export const isAmount = (n: ParsedNumber): boolean => !n.percent && !n.unit && !n.dateLike && !(n.year && !n.currency) && (n.currency || Math.abs(n.value) >= 100);

/** "No numbers" (a refusal): no amount in the sense of isAmount. */
export const hasAmounts = (answer: string): boolean => parseNumbers(answer).some(isAmount);

/** The tolerance for one expected amount written in full: ±1% or ±₪2, whichever is larger. */
export const toleranceFor = (expected: number): number => Math.max(Math.abs(expected) * 0.01, 2);
/** Written with K / אלף: ±₪20 or ±0.25%, whichever is larger ("10K" is not 9,960; "9.96K" is). */
export const toleranceForThousands = (expected: number): number => Math.max(Math.abs(expected) * 0.0025, 20);

/** Does a written number stand for the expected amount? Signs are ignored (spending may be written -50 or 50). */
export function numberMatches(expected: number, n: ParsedNumber): boolean {
  if (n.percent || n.dateLike) return false;
  return Math.abs(Math.abs(n.value) - Math.abs(expected)) <= (n.thousands ? toleranceForThousands(expected) : toleranceFor(expected));
}

/**
 * Which expected amounts appear in the answer, one to one: each written number stands for one expected value at most,
 * pairs taken closest first.
 */
export function matchNumbers(answer: string, expected: readonly number[]): { matched: number[]; missing: number[] } {
  const found = parseNumbers(answer);
  const pairs: Array<{ e: number; f: number; d: number }> = [];
  expected.forEach((ev, e) =>
    found.forEach((n, f) => {
      if (numberMatches(ev, n)) pairs.push({ e, f, d: Math.abs(Math.abs(n.value) - Math.abs(ev)) });
    }),
  );
  pairs.sort((a, b) => a.d - b.d || a.e - b.e || a.f - b.f);
  const usedE = new Set<number>();
  const usedF = new Set<number>();
  for (const p of pairs) {
    if (usedE.has(p.e) || usedF.has(p.f)) continue;
    usedE.add(p.e);
    usedF.add(p.f);
  }
  return { matched: expected.filter((_, i) => usedE.has(i)), missing: expected.filter((_, i) => !usedE.has(i)) };
}

/** A follow-up offer at the start of a question ("Do you want to see…?", "Anything else?", "רוצה לראות…?"). */
const OFFER_START = /^[\s\-–•*(]*(do you want (me )?to|would you like (me )?to|would you like to see|want me to|shall i|can i help|anything else|is there anything|let me know|רוצה לראות|רוצה ש|רוצה פירוט|תרצה|האם תרצה|אפשר גם|משהו נוסף|יש עוד משהו)/i;
/** A refusal or a "cannot see that" statement (an answer to a question finc must not or cannot answer). */
const REFUSAL = /(can't|can’t|cannot|can not|don't|don’t|do not|unable|not able|no access|only see|not allowed|לא יכול|אין לי|איני|אינני|לא נותן|לא מספק|לא רואה|לא זמין|לא אוכל|לא ניתן)/i;

const sentencesOf = (answer: string): string[] =>
  normalizeAnswer(answer)
    .split(/(?<=[.!?؟])\s+|\n+/)
    .map((x) => x.trim())
    .filter(Boolean);
const isQuestion = (sentence: string): boolean => /[?؟]\s*[)"'״»]*$/.test(sentence);

/** The question sentences of an answer that are questions back (follow-up offers left out). */
export function questionsIn(answer: string): string[] {
  return sentencesOf(answer).filter((x) => isQuestion(x) && !OFFER_START.test(x));
}

/**
 * Asked instead of answering: the question is the substance of the reply. None of the expected amounts appear, it
 * holds a question back (not a trailing offer such as "Do you want to see the amounts?"), and nothing before that
 * question answers: no amount, and with no amounts expected, no refusal either.
 */
export function isAsk(answer: string, expected: readonly number[]): boolean {
  if (expected.length && matchNumbers(answer, expected).matched.length) return false;
  const sentences = sentencesOf(answer);
  const first = sentences.findIndex((x) => isQuestion(x) && !OFFER_START.test(x));
  if (first < 0) return false;
  const before = sentences.slice(0, first).filter((x) => !isQuestion(x));
  if (before.some((x) => hasAmounts(x))) return false;
  if (!expected.length && before.some((x) => REFUSAL.test(x))) return false;
  return true;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * `word` as a whole word in `text` (case-insensitive; no letter or digit on either side). A Hebrew word may carry up
 * to two attached prefix letters (ו ב ל מ ש ה כ: "מיעל", "ליעל", "בדיור").
 */
export function containsWord(text: string, word: string): boolean {
  const hebrew = /^[א-ת]/.test(word);
  return new RegExp(`(?<![\\p{L}\\p{N}])${hebrew ? '[ובלמשהכ]{0,2}' : ''}${escapeRe(word)}(?![\\p{L}\\p{N}])`, 'iu').test(normalizeAnswer(text));
}

/** The forbidden strings a text contains, each as a whole word. */
export function forbiddenIn(text: string, forbid: readonly string[]): string[] {
  return forbid.filter((f) => containsWord(text, f));
}
