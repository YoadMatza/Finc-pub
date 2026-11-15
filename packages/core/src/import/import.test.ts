import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDb } from '../db/db.js';
import { balanceSnapshot, transactions } from '../db/schema.js';
import { detectMapping, importFile, parseDate, parseInstallments, parseNumber, parseStatement } from './import.js';
import { MAPPINGS } from './mapping.js';
import { decodeText, parseCsv, readGrid } from './parse.js';

const FIX = fileURLToPath(new URL('../../../../fixtures/imports/', import.meta.url));
let db: Db;
let tmp: string;
beforeEach(() => {
  db = openDb(':memory:');
  tmp = mkdtempSync(path.join(os.tmpdir(), 'finc-import-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('cell parsers', () => {
  it('dates', () => {
    expect(parseDate('07/11/2026', ['DD/MM/YYYY'])).toBe('2026-11-07');
    expect(parseDate('7.11.26', ['DD.MM.YY'])).toBe('2026-11-07');
    expect(parseDate('2026-11-07T00:00:00', ['YYYY-MM-DD'])).toBe('2026-11-07');
    expect(parseDate(46333, ['excel-serial'])).toBe('2026-11-07');
    expect(parseDate('סה"כ', ['DD/MM/YYYY'])).toBeUndefined();
  });
  it('numbers', () => {
    expect(parseNumber('4,101.40')).toBe(4101.4);
    expect(parseNumber('(81.20)')).toBe(-81.2);
    expect(parseNumber('81.20-')).toBe(-81.2);
    expect(parseNumber('₪ 1,200')).toBe(1200);
    expect(parseNumber('')).toBeUndefined();
  });
  it('installments', () => {
    expect(parseInstallments('תשלום 3 מתוך 12')).toEqual({ n: 3, total: 12 });
    expect(parseInstallments('7/12')).toEqual({ n: 7, total: 12 });
    expect(parseInstallments('רגילה')).toBeUndefined();
    expect(parseInstallments('13/12')).toBeUndefined();
  });
});

describe('text decoding and CSV', () => {
  it('handles BOM, quotes and embedded commas', () => {
    const g = parseCsv('﻿a,b\n"x, y","he said ""hi"""\n');
    expect(g).toEqual([
      ['﻿a', 'b'],
      ['x, y', 'he said "hi"'],
    ]);
  });
  it('decodes windows-1255 when the bytes are not valid UTF-8', () => {
    const he = 'תאריך,סכום';
    const cp1255 = Buffer.from([...he].map((ch) => (ch === ',' ? 0x2c : 0xe0 + (ch.charCodeAt(0) - 0x05d0))));
    expect(decodeText(cp1255)).toBe(he);
    expect(decodeText(Buffer.from('﻿' + he, 'utf8'))).toBe(he);
  });
});

describe('statements', () => {
  it('parses the FIBI-style bank CSV: title rows, debit/credit columns, running balance', async () => {
    const { grid } = await readGrid(path.join(FIX, 'beinleumi.sample.csv'));
    expect(detectMapping(grid)?.id).toBe('beinleumi');
    const p = parseStatement(grid, MAPPINGS.beinleumi!);
    expect(p.headerRow).toBe(2);
    expect(p.rows).toHaveLength(4);
    expect(p.rows[0]).toMatchObject({ date: '2026-11-07', amount: -382040, description: 'ישראכרט', identifier: '1000101', status: 'completed' });
    expect(p.rows[1]).toMatchObject({ amount: 1250000, description: 'משכורת' });
    expect(p.lastBalance).toEqual({ date: '2026-11-07', balanceMinor: 1234567 });
    expect(p.skipped).toEqual([]);
  });

  it('parses the Max-style card CSV: charge sign flipped, FX, installments, pending marker, card last4', async () => {
    const { grid } = await readGrid(path.join(FIX, 'max.sample.csv'));
    expect(detectMapping(grid)?.id).toBe('max');
    const p = parseStatement(grid, MAPPINGS.max!);
    expect(p.accountLabel).toBe('6150');
    expect(p.rows).toHaveLength(5);
    expect(p.rows[0]).toMatchObject({ date: '2026-10-03', chargeDate: '2026-11-02', amount: -8990, originalCurrency: 'ILS' });
    expect(p.rows[1]).toMatchObject({ type: 'installments', installmentN: 3, installmentTotal: 12, amount: -30000, originalAmount: -360000 });
    expect(p.rows[2]).toMatchObject({ amount: -19260, originalAmount: -4900, originalCurrency: 'USD' });
    expect(p.rows[3]).toMatchObject({ amount: 8120, originalAmount: 8120 });
    expect(p.rows[4]).toMatchObject({ status: 'pending', date: '2026-11-07' });
    expect(p.rows[4]?.chargeDate).toBeUndefined();
  });

  it('reads an xlsx with Date cells and imports it, idempotently, with a balance snapshot', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('תנועות');
    ws.addRow(['פירוט תנועות']);
    ws.addRow(['תאריך', 'תיאור', 'אסמכתא', 'חובה', 'זכות', 'יתרה']);
    ws.addRow([new Date(Date.UTC(2026, 10, 7)), 'ישראכרט', 1000101, 3820.4, null, 12345.67]);
    ws.addRow([new Date(Date.UTC(2026, 10, 5)), 'משכורת', 1000100, null, 12500, 16166.07]);
    const file = path.join(tmp, 'fibi.xlsx');
    await wb.xlsx.writeFile(file);

    const r1 = await importFile(db, file, { institutionId: 'beinleumi', accountLabel: 'fibi-main' });
    expect(r1).toMatchObject({ mapping: 'beinleumi', parsed: 2, skipped: 0, balanceRecorded: true });
    if (!('stats' in r1)) throw new Error('expected import result');
    expect(r1.stats).toMatchObject({ seen: 2, new: 2 });
    const r2 = await importFile(db, file, { institutionId: 'beinleumi', accountLabel: 'fibi-main' });
    if (!('stats' in r2)) throw new Error('expected import result');
    expect(r2.stats).toMatchObject({ seen: 2, new: 0 });

    const t = db.select().from(transactions).all();
    expect(t).toHaveLength(2);
    expect(t.map((x) => x.amountIls).sort((a, b) => a - b)).toEqual([-382040, 1250000]);
    expect(t[0]?.source).toBe('import:beinleumi');
    const snaps = db.select().from(balanceSnapshot).all();
    expect(snaps).toHaveLength(1); // same file twice → one snapshot (recordBalance is idempotent)
    expect(snaps[0]).toMatchObject({ balance: 1234567, source: 'import:beinleumi' });
  });

  it('dry run returns the parsed statement without touching the DB', async () => {
    const file = path.join(tmp, 'max.csv');
    writeFileSync(file, 'תאריך עסקה,שם בית העסק,סכום חיוב\n01/11/2026,קפה,12.50\nסה"כ,,12.50\n');
    const p = await importFile(db, file, { institutionId: 'max', dryRun: true });
    if (!('rows' in p)) throw new Error('expected parsed statement');
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]).toMatchObject({ amount: -1250 });
    expect(p.skipped).toEqual([{ row: 3, reason: expect.stringContaining('no date') }]);
    expect(db.select().from(transactions).all()).toHaveLength(0);
  });

  it('fails clearly when no mapping fits', async () => {
    const file = path.join(tmp, 'x.csv');
    writeFileSync(file, 'foo,bar\n1,2\n');
    await expect(importFile(db, file)).rejects.toThrow(/no mapping matched/);
  });
});
