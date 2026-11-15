/**
 * Anonymized "what does the real data look like" report over a raw scraper dump.
 * Safe to paste into chat: account numbers and identifiers are masked, memos that may
 * carry names are hidden, and only merchant / amount / date / type / status survive.
 */
import { readFileSync } from 'node:fs';
import { type ScraperAccount, type ScraperTransaction, fromScraperAccount, isoToLocalDate, maskNumber } from '@finc/core';

interface Dump {
  success: boolean;
  errorType?: string;
  errorMessage?: string;
  accounts?: ScraperAccount[];
}

const SAFE_MEMO = /^(תשלום\s*\d+\s*מתוך\s*\d+|זיכוי|ביטול|החזר|refund|reversal|\d+\/\d+)$/i;

export function safeMemo(memo: string | null | undefined): string {
  if (!memo) return '';
  const m = memo.trim();
  if (!m) return '';
  return SAFE_MEMO.test(m) ? m : `[memo ${m.length} chars]`;
}

function fmt(n: number): string {
  return (n / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function dumpReport(file: string): string {
  const dump = JSON.parse(readFileSync(file, 'utf8')) as Dump;
  const out: string[] = [];
  out.push(`# Dump report: ${file.split(/[\\/]/).pop()}`);
  out.push(`success: ${dump.success}${dump.errorType ? `  errorType: ${dump.errorType}  message: ${(dump.errorMessage ?? '').slice(0, 200)}` : ''}`);
  for (const acc of dump.accounts ?? []) {
    const rows = fromScraperAccount(acc);
    const txns = acc.txns;
    const dates = rows.map((r) => r.date).sort();
    const byStatus = count(txns, (t) => t.status);
    const byType = count(txns, (t) => t.type);
    const byCurrency = count(txns, (t) => t.originalCurrency || '?');
    const withId = txns.filter((t) => t.identifier !== undefined && t.identifier !== null && t.identifier !== '').length;
    const credits = rows.filter((r) => r.amount > 0);
    const installments = txns.filter((t) => t.installments);
    const fx = txns.filter((t) => t.originalCurrency && t.originalCurrency !== 'ILS');
    const dupKeys = new Map<string, number>();
    for (const r of rows) {
      const k = `${r.date}|${r.amount}|${r.description}`;
      dupKeys.set(k, (dupKeys.get(k) ?? 0) + 1);
    }
    const sameDayDupes = [...dupKeys.values()].filter((n) => n > 1).length;

    out.push('');
    out.push(`## account ${maskNumber(acc.accountNumber)}  balance: ${acc.balance === undefined ? 'n/a' : acc.balance}${acc.balanceDate ? ` @ ${acc.balanceDate.slice(0, 10)}` : ''}${acc.cardType ? `  cardType: ${acc.cardType}` : ''}`);
    out.push(`transactions: ${txns.length}   date range: ${dates[0] ?? '-'} → ${dates[dates.length - 1] ?? '-'}`);
    out.push(`status: ${show(byStatus)}   type: ${show(byType)}   currency: ${show(byCurrency)}`);
    out.push(`identifier present: ${withId}/${txns.length}   credits (positive): ${credits.length}   installment rows: ${installments.length}   FX rows: ${fx.length}   same-day identical groups: ${sameDayDupes}`);
    out.push(`sum of charged amounts: ${fmt(rows.reduce((s, r) => s + r.amount, 0))}`);

    const rawKeys = new Set<string>();
    for (const t of txns) {
      const raw = (t as ScraperTransaction & { rawTransaction?: unknown }).rawTransaction;
      if (raw && typeof raw === 'object') for (const k of Object.keys(raw as object)) rawKeys.add(k);
    }
    if (rawKeys.size) out.push(`raw source fields: ${[...rawKeys].sort().join(', ')}`);

    out.push('');
    out.push('samples (merchant | txn date | charge date | charged | original | status | type | n/N | memo):');
    const picks = [
      ...pick(txns, (t) => t.status === 'pending', 2),
      ...pick(txns, (t) => !!t.installments, 2),
      ...pick(txns, (t) => !!t.originalCurrency && t.originalCurrency !== 'ILS', 2),
      ...pick(txns, (t) => t.chargedAmount > 0, 3),
      ...pick(txns, (t) => t.status === 'completed' && !t.installments && t.chargedAmount < 0, 3),
    ];
    const seen = new Set<ScraperTransaction>();
    for (const t of picks) {
      if (seen.has(t)) continue;
      seen.add(t);
      const inst = t.installments ? `${t.installments.number}/${t.installments.total}` : '';
      out.push(
        `  ${t.description} | ${isoToLocalDate(t.date)} | ${t.processedDate ? isoToLocalDate(t.processedDate) : ''} | ${t.chargedAmount} ${t.chargedCurrency ?? 'ILS'} | ${t.originalAmount} ${t.originalCurrency} | ${t.status} | ${t.type} | ${inst} | ${safeMemo(t.memo)}`,
      );
    }
  }
  return out.join('\n');
}

function count<T>(xs: T[], key: (x: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
  return m;
}
const show = (m: Map<string, number>): string => [...m.entries()].map(([k, v]) => `${k}=${v}`).join(' ') || '-';
function pick<T>(xs: T[], pred: (x: T) => boolean, n: number): T[] {
  return xs.filter(pred).slice(0, n);
}
