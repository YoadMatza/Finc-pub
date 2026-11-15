/**
 * Person-to-person money: Bit, PayBox, "credit from <name>". One definition shared by the
 * categoriser (own category, counted as spending), the recurring detector (never a stream) and
 * the model layer (never sent). "ביט" matches only as its own word, also as "בביט" / "מביט", never
 * inside "ביטוח" (insurance).
 */
export const PERSON_TO_PERSON = /(^|[\s\-])[במ]?ביט($|[\s\-])|\bbit\b|paybox|פייבוקס|זיכוי מ/i;

export function isPersonToPerson(text: string): boolean {
  return PERSON_TO_PERSON.test(text);
}
