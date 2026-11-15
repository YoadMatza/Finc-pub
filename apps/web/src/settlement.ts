import type { Key } from './i18n';
import type { Txn } from './types';

/** The engine does not store whether a debit matched immediate or monthly rows; a bank debit paying this few card rows is treated as an immediate charge. */
export const IMMEDIATE_MAX_ROWS = 3;

type T = (k: Key, vars?: Record<string, string | number>) => string;

/** "7.11": day and month without leading zeros. */
export function dayMonth(date: string): string {
  return `${Number(date.slice(8, 10))}.${Number(date.slice(5, 7))}`;
}

/**
 * What a card payment paid, or which bank payment paid a card row: one muted line for the list.
 * `targetId` is the row the line points to (the single card row, or the bank row), when there is one.
 */
export function settlementNote(x: Pick<Txn, 'settles' | 'settledBy'>, t: T): { text: string; targetId: number | null } | null {
  const s = x.settles;
  if (s && s.count > 0) {
    if (s.count === 1 && s.first) return { text: t('settles_one', { account: s.account, name: s.first.description, d: dayMonth(s.first.date) }), targetId: s.first.txnId };
    return { text: t('settles_many', { account: s.account, n: s.count }), targetId: null };
  }
  // only for immediate charges: on a monthly bill every card row would carry the same line
  if (x.settledBy && x.settledBy.count <= IMMEDIATE_MAX_ROWS) return { text: t('settled_by', { d: dayMonth(x.settledBy.date) }), targetId: x.settledBy.txnId };
  return null;
}
