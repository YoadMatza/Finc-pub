/**
 * Left-to-right runs inside Hebrew chat text (chat v2 step 4). A Hebrew answer mixes in amounts (₪1,234, 1,234 ₪),
 * dates (2026-09-22), month ranges (2026-01..2026-10), Latin merchant names (ELECTRO DEMO) and model names; in an
 * RTL bubble the bidi algorithm reorders such runs ("DEMO ELECTRO", "10-2026..01-2026"). The chat wraps each run this
 * returns in <bdi dir="ltr">, so the DOM text stays exactly the same characters: nothing is inserted, and selecting
 * or copying gives what the model wrote. (insightsCompany.ts isolateLtr inserts LRI/PDI characters into the string
 * instead, which is right for formatted figures but would change copied chat text.)
 */

export interface BidiRun {
  text: string;
  /** a left-to-right run to isolate (Latin letters or digits with their internal punctuation) */
  ltr: boolean;
}

/** Latin letters (accents included), digits, and the marks that belong to an amount: ₪ and %. */
const W = 'A-Za-z0-9\\u00C0-\\u024F₪%';
/**
 * One run: an optional sign (a minus not after a letter or digit, directly before a digit or ₪), then word characters,
 * joined across internal punctuation (. , : / - − ' .. and runs of them) and single spaces only when more word
 * characters follow, so a sentence's own period or comma, and the space before a Hebrew word, stay outside.
 */
const L = 'A-Za-z\\u00C0-\\u024F';
// A space joins only words of one name ("ELECTRO DEMO") or an amount and its sign ("1,234 ₪", "₪ 1,234"). Never a
// name and a number ("Wolt 120 ₪") or a date and an amount: isolated together, an RTL line would show them swapped.
const SPACE = `(?<=[${L}]) (?=[${L}])|(?<=[0-9]) (?=[₪%])|(?<=₪) (?=[0-9])`;
const RUN = new RegExp(`(?:(?<![\\p{L}\\p{N}])[-−](?=[0-9₪]))?[${W}](?:[${W}]|[.,:/'\\-−]+(?=[${W}])|${SPACE})*`, 'gu');
const HAS_WORD = /[A-Za-z0-9À-ɏ]/;

/** Is the text Hebrew for layout purposes: its first strong (letter) character is Hebrew? */
export function isHebrewText(s: string): boolean {
  const m = /\p{L}/u.exec(s);
  return !!m && /[֐-׿]/.test(m[0]);
}

/**
 * The text split into runs, in order; joined back they are exactly `s`. A run is `ltr` when it holds a Latin letter or
 * a digit (a lone ₪ or % is left to the surrounding text).
 */
export function bidiRuns(s: string): BidiRun[] {
  const out: BidiRun[] = [];
  let at = 0;
  for (const m of s.matchAll(RUN)) {
    if (!HAS_WORD.test(m[0])) continue;
    if (m.index > at) out.push({ text: s.slice(at, m.index), ltr: false });
    out.push({ text: m[0], ltr: true });
    at = m.index + m[0].length;
  }
  if (at < s.length) out.push({ text: s.slice(at), ltr: false });
  return out;
}
