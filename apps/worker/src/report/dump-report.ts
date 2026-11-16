/**
 * Masked "what does the real data look like" report over a raw scraper dump (security research P2-11).
 * Account numbers are masked, balances and totals are left out, error text is cleaned (cleanErrorText), memos that
 * may carry names are hidden, and every description goes through `modelName`, the same rule that decides what the AI
 * may see: bank-side rows and person-to-person payments show only a generic label, card merchants lose digit runs.
 * Amounts, dates, types and statuses stay, so read it before sharing it anywhere.
 */
import { readFileSync } from 'node:fs';
import { type ScraperAccount, type ScraperTransaction, cleanErrorText, fromScraperAccount, institutionSpec, isoToLocalDate, maskNumber, modelName } from '@finc/core';

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

/** The name a sample row may show: never a raw description. Unknown institutions count as bank-side (the stricter rule). */
export function sampleName(t: Pick<ScraperTransaction, 'description' | 'chargedAmount'>, onCard: boolean): string {
  return modelName({ merchantName: t.description, descriptions: [t.description], amount: t.chargedAmount, onCard, merchantOnBank: false });
}

export function dumpReport(file: string): string {
  const dump = JSON.parse(readFileSync(file, 'utf8')) as Dump;
  const name = file.split(/[\\/]/).pop() ?? '';
  const onCard = institutionSpec(name.split('-')[0] ?? '')?.kind === 'card';
  const out: string[] = [];
  out.push(`# Dump report: ${name}`);
  out.push('masked, but it still shows amounts and dates: read it before sharing it');
  out.push(`success: ${dump.success}${dump.errorType ? `  errorType: ${dump.errorType}  message: ${cleanErrorText(dump.errorMessage ?? '', 200)}` : ''}`);
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
    out.push(`## account ${maskNumber(acc.accountNumber)}  balance: ${acc.balance === undefined || acc.balance === null ? 'n/a' : 'present'}${acc.balanceDate ? ` @ ${acc.balanceDate.slice(0, 10)}` : ''}${acc.cardType ? `  cardType: ${acc.cardType}` : ''}`);
    out.push(`transactions: ${txns.length}   date range: ${dates[0] ?? '-'} → ${dates[dates.length - 1] ?? '-'}`);
    out.push(`status: ${show(byStatus)}   type: ${show(byType)}   currency: ${show(byCurrency)}`);
    out.push(`identifier present: ${withId}/${txns.length}   credits (positive): ${credits.length}   installment rows: ${installments.length}   FX rows: ${fx.length}   same-day identical groups: ${sameDayDupes}`);

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
        `  ${sampleName(t, onCard)} | ${isoToLocalDate(t.date)} | ${t.processedDate ? isoToLocalDate(t.processedDate) : ''} | ${t.chargedAmount} ${t.chargedCurrency ?? 'ILS'} | ${t.originalAmount} ${t.originalCurrency} | ${t.status} | ${t.type} | ${inst} | ${safeMemo(t.memo)}`,
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
