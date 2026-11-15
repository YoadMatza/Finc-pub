/**
 * israeli-bank-scrapers output → NormalizedRow. Structural types only, so core does not
 * depend on the scraper package (the worker does).
 */
import { isoToLocalDate, toMinor } from './normalize.js';
import type { NormalizedRow } from './types.js';

export interface ScraperTransaction {
  type: 'normal' | 'installments';
  identifier?: string | number;
  date: string;
  processedDate: string;
  originalAmount: number;
  originalCurrency: string;
  chargedAmount: number;
  chargedCurrency?: string;
  description: string;
  memo?: string | null;
  installments?: { number: number; total: number };
  status: 'completed' | 'pending';
  category?: string;
}

export interface ScraperAccount {
  accountNumber: string;
  balance?: number;
  balanceDate?: string;
  cardFrame?: number;
  cardType?: string;
  currency?: string;
  savingsAccount?: boolean;
  txns: ScraperTransaction[];
}

export function scraperSource(scraperId: string): string {
  return `scraper:${scraperId}`;
}

export function fromScraperTransaction(accountNumber: string, t: ScraperTransaction): NormalizedRow {
  let amount = toMinor(t.chargedAmount);
  if (amount === undefined) throw new Error(`scraper row without chargedAmount: ${t.description}`);
  let original = toMinor(t.originalAmount);
  const currency = t.originalCurrency || 'ILS';
  // Max (seen 2026-11-08): pending rows carry chargedAmount 0 and the real amount in originalAmount.
  // For ILS we can use it directly; FX pending stays 0 until it completes (no rate yet).
  if (t.status === 'pending' && amount === 0 && original !== undefined && original !== 0 && currency === 'ILS') amount = original;
  // Max credits (refunds) come as chargedAmount > 0 but originalAmount < 0: align the original's sign.
  if (original !== undefined && amount !== 0 && Math.sign(original) !== Math.sign(amount)) original = -original;
  const row: NormalizedRow = {
    externalAccountId: accountNumber,
    date: isoToLocalDate(t.date),
    amount,
    description: t.description ?? '',
    status: t.status,
    type: t.type,
    payload: t,
  };
  if (t.processedDate) row.chargeDate = isoToLocalDate(t.processedDate);
  if (original !== undefined) row.originalAmount = original;
  row.originalCurrency = currency;
  if (t.memo) row.memo = t.memo;
  if (t.identifier !== undefined && t.identifier !== null && t.identifier !== '') row.identifier = String(t.identifier);
  if (t.installments) {
    row.installmentN = t.installments.number;
    row.installmentTotal = t.installments.total;
  }
  if (t.category) row.annotations = { category: t.category };
  return row;
}

export function fromScraperAccount(acc: ScraperAccount): NormalizedRow[] {
  return acc.txns.map((t) => fromScraperTransaction(acc.accountNumber, t));
}
