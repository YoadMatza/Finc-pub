/** Excel/CSV statement → NormalizedRow[] → ingest. Source id is `import:<institution>`. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ensureAccount } from '../db/accounts.js';
import type { Db } from '../db/db.js';
import { finishRunError, finishRunOk, recordBalance, startRun } from '../db/runs.js';
import { ingestBatch } from '../ingest/ingest.js';
import { endOfLocalDayIso, toMinor } from '../ingest/normalize.js';
import type { IngestStats, NormalizedRow } from '../ingest/types.js';
import { INSTITUTIONS } from '../institutions.js';
import { type ColumnMapping, MAPPINGS, mappingScore, resolveColumns } from './mapping.js';
import { type Cell, type Grid, readGrid } from './parse.js';

export interface ParsedStatement {
  mapping: ColumnMapping;
  headerRow: number;
  headers: string[];
  rows: NormalizedRow[];
  skipped: Array<{ row: number; reason: string }>;
  /** Last running balance seen (bank exports), minor units. */
  lastBalance?: { date: string; balanceMinor: number };
  accountLabel: string;
}

export function detectHeaderRow(grid: Grid, mapping: ColumnMapping): number {
  if (mapping.headerRowIndex !== undefined) return mapping.headerRowIndex;
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < Math.min(grid.length, 30); i++) {
    const s = mappingScore(mapping, grid[i]!);
    if (s > bestScore) {
      best = i;
      bestScore = s;
    }
  }
  if (best < 0) throw new Error(`could not find a header row matching the ${mapping.id} mapping; run "finc import headers <file>" to see the columns`);
  return best;
}

export function detectMapping(grid: Grid): ColumnMapping | undefined {
  let best: ColumnMapping | undefined;
  let bestScore = 0;
  for (const m of Object.values(MAPPINGS)) {
    for (let i = 0; i < Math.min(grid.length, 30); i++) {
      const s = mappingScore(m, grid[i]!);
      if (s > bestScore) {
        best = m;
        bestScore = s;
      }
    }
  }
  return best;
}

export function parseStatement(grid: Grid, mapping: ColumnMapping, opts: { accountLabel?: string } = {}): ParsedStatement {
  const headerRow = detectHeaderRow(grid, mapping);
  const headers = grid[headerRow]!.map((c) => String(c ?? '').trim());
  const { index, missing } = resolveColumns(mapping, headers);
  if (missing.length) throw new Error(`${mapping.id} mapping: missing columns ${missing.join(', ')}; headers were: ${headers.join(' | ')}`);

  const rows: NormalizedRow[] = [];
  const skipped: ParsedStatement['skipped'] = [];
  let lastBalance: ParsedStatement['lastBalance'];
  let accountFromFile: string | undefined;
  const cell = (r: Cell[], f: string): Cell => (index[f] === null || index[f] === undefined ? null : (r[index[f]!] ?? null));

  for (let i = headerRow + 1; i < grid.length; i++) {
    const r = grid[i]!;
    const rawDate = cell(r, 'date');
    const date = parseDate(rawDate, mapping.dateFormats);
    if (!date) {
      skipped.push({ row: i + 1, reason: `no date (${String(rawDate ?? '').slice(0, 20)})` });
      continue;
    }
    const description = String(cell(r, 'description') ?? '').trim();
    const amount = parseAmount(r, index, mapping);
    if (amount === undefined) {
      skipped.push({ row: i + 1, reason: 'no amount' });
      continue;
    }
    if (!description && amount === 0) {
      skipped.push({ row: i + 1, reason: 'empty' });
      continue;
    }
    const acct = cell(r, 'account');
    if (acct !== null && acct !== '' && !accountFromFile) accountFromFile = String(acct).replace(/\D/g, '').slice(-4) || String(acct);

    const row: NormalizedRow = {
      externalAccountId: opts.accountLabel ?? accountFromFile ?? mapping.id,
      date,
      amount,
      description,
      status: 'completed',
      type: 'normal',
      payload: Object.fromEntries(headers.map((h, j) => [h || `col${j}`, serializable(r[j] ?? null)])),
    };
    const chargeDate = parseDate(cell(r, 'chargeDate'), mapping.dateFormats);
    if (chargeDate) row.chargeDate = chargeDate;
    const orig = parseNumber(cell(r, 'originalAmount'));
    if (orig !== undefined) {
      const cur = normalizeCurrency(cell(r, 'originalCurrency'));
      row.originalAmount = mapping.amountRule.kind === 'card-charge' ? -Math.abs(toMinor(orig)!) * Math.sign(-amount || -1) : toMinor(orig)!;
      if (cur) row.originalCurrency = cur;
    }
    const memo = String(cell(r, 'memo') ?? '').trim();
    if (memo) row.memo = memo;
    const ident = cell(r, 'identifier');
    if (ident !== null && String(ident).trim() !== '') row.identifier = String(ident).trim();
    const instText = [cell(r, 'installments'), memo].map((x) => String(x ?? '')).join(' ');
    const inst = parseInstallments(instText);
    if (inst) {
      row.type = 'installments';
      row.installmentN = inst.n;
      row.installmentTotal = inst.total;
    }
    const status = String(cell(r, 'status') ?? '');
    if (mapping.pendingMarker && status.includes(mapping.pendingMarker)) row.status = 'pending';
    const bal = parseNumber(cell(r, 'balance'));
    if (bal !== undefined) lastBalance = { date, balanceMinor: toMinor(bal)! };
    rows.push(row);
  }
  // Bank exports are newest-first; the running balance we want is the newest row's.
  if (lastBalance && rows.length) {
    const newest = rows.reduce((a, b) => (a.date >= b.date ? a : b));
    const idx = rows.indexOf(newest);
    const bal = parseNumber(cell(grid[headerRow + 1 + idx] ?? [], 'balance'));
    if (bal !== undefined) lastBalance = { date: newest.date, balanceMinor: toMinor(bal)! };
  }
  const accountLabel = opts.accountLabel ?? accountFromFile ?? mapping.id;
  return { mapping, headerRow, headers, rows, skipped, accountLabel, ...(lastBalance ? { lastBalance } : {}) };
}

export interface ImportFileResult {
  file: string;
  mapping: string;
  accountId: number;
  accountLabel: string;
  runId: number;
  parsed: number;
  skipped: number;
  stats: IngestStats;
  balanceRecorded: boolean;
}

export async function importFile(db: Db, file: string, o: { institutionId?: string; accountLabel?: string; dryRun?: boolean } = {}): Promise<ImportFileResult | ParsedStatement> {
  const { grid } = await readGrid(file);
  const mapping = o.institutionId ? MAPPINGS[o.institutionId] : detectMapping(grid);
  if (!mapping) throw new Error(`no mapping matched this file; pass --institution ${Object.keys(MAPPINGS).join('|')}`);
  const parsed = parseStatement(grid, mapping, o.accountLabel ? { accountLabel: o.accountLabel } : {});
  if (o.dryRun) return parsed;

  const spec = INSTITUTIONS[mapping.institutionId as keyof typeof INSTITUTIONS];
  const source = `import:${mapping.institutionId}`;
  const fileHash = createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12);
  const { accountId } = ensureAccount(db, {
    institutionId: mapping.institutionId,
    institutionKind: spec?.kind ?? 'manual',
    institutionDisplayName: spec?.displayName ?? mapping.institutionId,
    ...(spec?.scraperId ? { scraperId: spec.scraperId } : {}),
    source,
    externalId: parsed.accountLabel,
    type: mapping.accountType,
    ...(parsed.accountLabel.length === 4 ? { last4: parsed.accountLabel } : {}),
  });
  const runId = startRun(db, { institutionId: mapping.institutionId, source, trigger: 'import' });
  try {
    const stats = ingestBatch(db, { source, runId, accountId, rows: parsed.rows, batchIsComplete: false });
    let balanceRecorded = false;
    if (parsed.lastBalance) {
      recordBalance(db, { accountId, runId, balanceMinor: parsed.lastBalance.balanceMinor, source, takenAt: endOfLocalDayIso(parsed.lastBalance.date) });
      balanceRecorded = true;
    }
    finishRunOk(db, runId, stats, { file: path.basename(file), fileHash, headerRow: parsed.headerRow, skipped: parsed.skipped.length });
    return { file, mapping: mapping.id, accountId, accountLabel: parsed.accountLabel, runId, parsed: parsed.rows.length, skipped: parsed.skipped.length, stats, balanceRecorded };
  } catch (e) {
    finishRunError(db, runId, 'IMPORT', e instanceof Error ? e.message : String(e));
    throw e;
  }
}

// ---------- cell parsing ----------

export function parseDate(v: Cell, formats: ColumnMapping['dateFormats']): string | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  if (v instanceof Date) return isoLocal(v);
  if (typeof v === 'number') {
    if (!formats.includes('excel-serial') || v < 20000 || v > 80000) return undefined;
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86_400_000);
    return d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
  if (m) {
    const [, d, mo, y] = m;
    const year = y!.length === 2 ? `20${y}` : y!;
    const day = d!.padStart(2, '0');
    const month = mo!.padStart(2, '0');
    if (Number(month) > 12 || Number(day) > 31) return undefined;
    return `${year}-${month}-${day}`;
  }
  return undefined;
}

const isoLocal = (d: Date): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

export function parseNumber(v: Cell): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (v instanceof Date) return undefined;
  let s = String(v).replace(/[‎‏\s₪$€]/g, '').replace(/,/g, '');
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  if (s.endsWith('-')) {
    neg = true;
    s = s.slice(0, -1);
  }
  if (s === '' || s === '-') return undefined;
  const n = Number(s);
  if (!Number.isFinite(n)) return undefined;
  return neg ? -n : n;
}

function parseAmount(r: Cell[], index: Record<string, number | null>, mapping: ColumnMapping): number | undefined {
  const rule = mapping.amountRule;
  const at = (f: string): Cell => (index[f] === null || index[f] === undefined ? null : (r[index[f]!] ?? null));
  if (rule.kind === 'debit-credit') {
    const debit = parseNumber(at('debit'));
    const credit = parseNumber(at('credit'));
    if (debit === undefined && credit === undefined) {
      const single = parseNumber(at('amount'));
      return single === undefined ? undefined : toMinor(single);
    }
    return toMinor((credit ?? 0) - (debit ?? 0));
  }
  const n = parseNumber(at('amount'));
  if (n === undefined) return undefined;
  return rule.kind === 'card-charge' ? -toMinor(n)! : toMinor(n);
}

export function parseInstallments(text: string): { n: number; total: number } | undefined {
  let m = text.match(/תשלום\s*(\d{1,2})\s*מתוך\s*(\d{1,2})/);
  if (!m) m = text.match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
  if (!m) return undefined;
  const n = Number(m[1]);
  const total = Number(m[2]);
  if (n < 1 || total < 2 || n > total) return undefined;
  return { n, total };
}

const CURRENCY: Record<string, string> = { '₪': 'ILS', 'ש"ח': 'ILS', שח: 'ILS', nis: 'ILS', ils: 'ILS', $: 'USD', usd: 'USD', 'דולר': 'USD', '€': 'EUR', eur: 'EUR', 'אירו': 'EUR', gbp: 'GBP', '£': 'GBP' };
export function normalizeCurrency(v: Cell): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  if (!s) return undefined;
  const k = s.toLowerCase().replace(/["״]/g, '"');
  return CURRENCY[k] ?? CURRENCY[s] ?? (/^[A-Z]{3}$/.test(s) ? s : undefined);
}

const serializable = (c: Cell): string | number | null => (c instanceof Date ? c.toISOString() : c);
