/**
 * Split one spending transaction across categories (research_notes/proposals/split-transaction.md). The editor
 * shows rows of category + amount in shekels; every row but the last is typed, and the last row takes the
 * remainder, so the parts always add up to the charge exactly. Amounts sent to the hub are negative agorot.
 */

export const SPLIT_MIN_PARTS = 2;
export const SPLIT_MAX_PARTS = 8;

export interface SplitRow {
  /** category id, '' while none is chosen */
  category: number | '';
  /** the typed amount in shekels (positive); ignored for the last row, which takes the remainder */
  shekels: string;
}

export interface SplitPlan {
  /** each row's amount in positive agorot (the last one is the remainder); null where the typed text is not a number */
  amounts: Array<number | null>;
  /** what is left for the last row, positive agorot (may be zero or negative while typing) */
  remainder: number;
  /** true when the parts can be saved: 2 to 8 rows, every row has a category and a positive amount */
  valid: boolean;
  /** the body's parts: negative agorot, adding up exactly to the transaction's amount */
  parts: Array<{ category: number; amount: number }>;
}

/** Shekels typed by the owner ("12", "12.5", "12,50", "1,234.5") as positive agorot, or null. */
export function parseShekels(text: string): number | null {
  let s = text.trim().replace(/[₪\s]/g, '');
  if (!s) return null;
  // one comma and no dot, with one or two digits after it, is a decimal comma; otherwise commas group thousands
  if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.');
  else s = s.replace(/,/g, '');
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

/** Agorot (either sign) as the shekel text the editor shows in an input: "150", "89.90". */
export function shekelsText(agorot: number): string {
  const a = Math.abs(agorot);
  return a % 100 === 0 ? String(a / 100) : (a / 100).toFixed(2);
}

/** The rows, the typed amounts and the remainder for a charge of `total` agorot (negative for spending). */
export function planSplit(total: number, rows: SplitRow[]): SplitPlan {
  const whole = Math.abs(total);
  const typed = rows.slice(0, -1).map((r) => parseShekels(r.shekels));
  const remainder = whole - typed.reduce<number>((a, v) => a + (v ?? 0), 0);
  const amounts: Array<number | null> = rows.length ? [...typed, remainder] : [];
  const valid =
    total < 0 &&
    rows.length >= SPLIT_MIN_PARTS &&
    rows.length <= SPLIT_MAX_PARTS &&
    rows.every((r) => r.category !== '') &&
    amounts.every((v) => v !== null && v > 0);
  const parts = valid ? rows.map((r, i) => ({ category: r.category as number, amount: -(amounts[i] as number) })) : [];
  return { amounts, remainder, valid, parts };
}

/** The editor's first rows: the existing parts, or the main category with the whole amount plus an empty row. */
export function startRows(total: number, categoryId: number | null, existing: Array<{ categoryId: number; amount: number }> | null): SplitRow[] {
  if (existing && existing.length >= SPLIT_MIN_PARTS) return existing.map((p) => ({ category: p.categoryId, shekels: shekelsText(p.amount) }));
  return [
    { category: categoryId ?? '', shekels: shekelsText(total) },
    { category: '', shekels: '' },
  ];
}

/**
 * Add a row at the end (up to 8). The old last row keeps the amount it showed (its remainder, written into its
 * input), and the new empty row takes the remainder from now on (zero until another row is lowered).
 */
export function addRow(total: number, rows: SplitRow[]): SplitRow[] {
  if (rows.length >= SPLIT_MAX_PARTS) return rows;
  const { remainder } = planSplit(total, rows);
  const kept = rows.map((r, i) => (i === rows.length - 1 ? { ...r, shekels: remainder > 0 ? shekelsText(remainder) : '' } : r));
  return [...kept, { category: '', shekels: '' }];
}

/** Remove a row (down to 2). Whatever row ends up last takes the remainder. */
export function removeRow(rows: SplitRow[], index: number): SplitRow[] {
  if (rows.length <= SPLIT_MIN_PARTS) return rows;
  return rows.filter((_, i) => i !== index);
}

/** Categories a split may use: no income section, not "transfers", and only real ids. */
export function splitChoices<C extends { id: number; key: string; section: string }>(cats: C[]): C[] {
  return cats.filter((c) => c.id > 0 && c.section !== 'income' && c.key !== 'transfers');
}
