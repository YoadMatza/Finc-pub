import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { afterAll, describe, expect, it } from 'vitest';
import { isNumericToken, merchantKey } from '../engine/merchant.js';
import { parseDate, parseNumber } from './import.js';
import { IMPORT_LIMITS, readGrid, zipDeclaredSize } from './parse.js';

// security research P3-03: input handling in the importer and the merchant key

const dir = mkdtempSync(path.join(tmpdir(), 'finc-limits-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('merchant key on hostile input', () => {
  it('a long digit run is linear, not seconds', () => {
    const t = Date.now();
    merchantKey(`A ${'1'.repeat(20_000)}x`);
    expect(Date.now() - t).toBeLessThan(500);
  });

  it('the numeric-token check keeps its meaning', () => {
    for (const t of ['123', '12.345', '(054)123-4567', '+972123', '1234567890']) expect(isNumericToken(t)).toBe(true);
    for (const t of ['12', '1.2.3', 'a123', '12a3', '', '-']) expect(isNumericToken(t)).toBe(false);
  });
});

describe('dates and numbers in statements', () => {
  const formats = ['dmy', 'iso', 'excel-serial'] as never;
  it('only dates that exist', () => {
    expect(parseDate('2026-11-16', formats)).toBe('2026-11-16');
    expect(parseDate('16/11/2026', formats)).toBe('2026-11-16');
    expect(parseDate('5.1.26', formats)).toBe('2026-01-05');
    for (const bad of ['2026-00-10', '2026-11-00', '00/11/2026', '31/02/2026', '2026-02-30', '29/02/2025']) expect(parseDate(bad, formats)).toBeUndefined();
    expect(parseDate('29/02/2024', formats)).toBe('2024-02-29');
  });

  it('only plain decimal amounts', () => {
    expect(parseNumber('1,234.50')).toBe(1234.5);
    expect(parseNumber('(120.00)')).toBe(-120);
    expect(parseNumber('120.00-')).toBe(-120);
    expect(parseNumber('₪ 99')).toBe(99);
    expect(parseNumber('+5')).toBe(5);
    for (const bad of ['0x1F', '1e9', 'Infinity', '1.2.3', '12abc']) expect(parseNumber(bad)).toBeUndefined();
  });
});

describe('statement file limits', () => {
  it('refuses a file over the size limit before reading it', async () => {
    const f = path.join(dir, 'big.csv');
    writeFileSync(f, Buffer.alloc(IMPORT_LIMITS.fileBytes + 1, 0x41));
    await expect(readGrid(f)).rejects.toThrow(/refused/);
  });

  it('refuses a CSV with too many rows', async () => {
    const f = path.join(dir, 'rows.csv');
    writeFileSync(f, 'a,b\n'.repeat(IMPORT_LIMITS.rows + 1));
    await expect(readGrid(f)).rejects.toThrow(/rows/);
  });

  it('reads the unpacked size an xlsx declares, and refuses one that is not a zip', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('s').addRow(['date', 'amount']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const declared = zipDeclaredSize(buf);
    expect(declared).toBeGreaterThan(buf.length / 4);
    expect(declared).toBeLessThan(1024 * 1024);
    const f = path.join(dir, 'ok.xlsx');
    writeFileSync(f, buf);
    expect((await readGrid(f)).grid[0]).toEqual(['date', 'amount']);
    const fake = path.join(dir, 'fake.xlsx');
    writeFileSync(fake, 'not a zip at all');
    await expect(readGrid(fake)).rejects.toThrow(/not a readable/);
  });

  it('refuses an xlsx that declares a huge unpacked size (a zip bomb)', () => {
    // one central directory entry claiming 3 GB unpacked, then the end-of-directory record
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt32LE(3_000_000_000, 24);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(46, 12);
    eocd.writeUInt32LE(0, 16);
    expect(zipDeclaredSize(Buffer.concat([cd, eocd]))).toBeGreaterThan(IMPORT_LIMITS.xlsxUnpackedBytes);
  });
});
