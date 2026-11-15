import { createHash } from 'node:crypto';

export const TZ = 'Asia/Jerusalem';

/** Float ILS → integer agorot, exact for 2-decimal inputs. */
export function toMinor(amount: number | null | undefined): number | undefined {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return undefined;
  return Math.round(amount * 100);
}

export const fromMinor = (minor: number): number => minor / 100;

/** ISO datetime → 'YYYY-MM-DD' in Israel local time (scrapers emit local-midnight ISO strings). */
export function isoToLocalDate(iso: string, tz: string = TZ): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`bad date: ${iso}`);
  // en-CA gives YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** RiseUp dates are UTC midnight; the date part is the day. */
export const isoDatePart = (iso: string): string => iso.slice(0, 10);

/**
 * The UTC instant of 23:59:59 on a calendar day in Israel. Used for balances that are "as of a date"
 * (RiseUp history, statement files) so they fall on the right local day when compared with transactions.
 */
export function endOfLocalDayIso(date: string, tz: string = TZ): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const noonUtc = new Date(Date.UTC(y, m - 1, d, 12));
  const localHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(noonUtc));
  const offsetHours = ((localHour - 12 + 36) % 24) - 12; // +2 or +3 for Israel
  return new Date(Date.UTC(y, m - 1, d, 23, 59, 59) - offsetHours * 3_600_000).toISOString();
}

export const monthOf = (date: string): string => date.slice(0, 7);

/**
 * Stable description for hashing and cross-source matching. Deliberately conservative:
 * it must not merge different merchants, only different spellings of the same string.
 * Strips the symbol set RiseUp's API removes (so scraper and RiseUp text hash alike),
 * quotes, collapses whitespace, lowercases Latin, and normalizes Unicode (NFKC).
 */
export function normalizeDescription(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[<>&%!{}()[\]@#\\/"'`´׳״*]/g, '') // removed, not spaced: RiseUp strips these the same way
    .replace(/[‎‏‪-‮⁦-⁩]/g, '') // bidi controls
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const sha = (parts: Array<string | number | undefined>): string =>
  createHash('sha256')
    .update(parts.map((p) => (p === undefined ? '' : String(p))).join('|'))
    .digest('hex');

/** Unique within a source. Identifier-aware, status-agnostic. */
export function sourceHash(p: {
  source: string;
  externalAccountId: string;
  date: string;
  amount: number;
  descriptionNorm: string;
  identifier?: string;
  installmentN?: number;
  installmentTotal?: number;
  occurrence: number;
}): string {
  return sha([
    'v1',
    p.source,
    p.externalAccountId,
    p.date,
    p.amount,
    p.descriptionNorm,
    p.identifier,
    p.installmentN,
    p.installmentTotal,
    p.occurrence,
  ]);
}

/** Cross-source identity of a transaction (§4a). Identifier-agnostic, status-agnostic. */
export function fingerprint(p: {
  accountId: number;
  date: string;
  amount: number;
  descriptionNorm: string;
  installmentN?: number;
  occurrence: number;
}): string {
  return sha(['v1', p.accountId, p.date, p.amount, p.descriptionNorm, p.installmentN, p.occurrence]);
}

/**
 * Assigns each row an occurrence index among rows in the same batch that share
 * (date, amount, normalized description, installment #). Two identical coffees on one
 * day become occurrence 0 and 1 instead of collapsing into one. Order-stable.
 */
export function assignOccurrences<T extends { date: string; amount: number; descriptionNorm: string; installmentN?: number }>(
  rows: T[],
): Array<T & { occurrence: number }> {
  const counters = new Map<string, number>();
  return rows.map((r) => {
    const key = `${r.date}|${r.amount}|${r.descriptionNorm}|${r.installmentN ?? ''}`;
    const n = counters.get(key) ?? 0;
    counters.set(key, n + 1);
    return { ...r, occurrence: n };
  });
}
