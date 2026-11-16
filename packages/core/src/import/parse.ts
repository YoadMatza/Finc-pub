/** Read a CSV or XLSX statement into a grid of cells. */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';

export type Cell = string | number | Date | null;
export type Grid = Cell[][];

/**
 * Limits for a statement file (security research P3-03): a bank export is a few hundred KB and a few thousand rows.
 * An .xlsx is a zip, so its declared unpacked size is checked before anything is unpacked.
 */
export const IMPORT_LIMITS = { fileBytes: 25 * 1024 * 1024, rows: 100_000, xlsxUnpackedBytes: 200 * 1024 * 1024 };

export async function readGrid(file: string): Promise<{ grid: Grid; sheet?: string }> {
  const ext = path.extname(file).toLowerCase();
  const size = statSync(file).size;
  if (size > IMPORT_LIMITS.fileBytes) throw new Error(`the file is ${Math.round(size / 1024 / 1024)} MB; statements over ${IMPORT_LIMITS.fileBytes / 1024 / 1024} MB are refused`);
  if (ext === '.csv' || ext === '.txt' || ext === '.tsv') return { grid: capRows(parseCsv(decodeText(readFileSync(file)), ext === '.tsv' ? '\t' : undefined)) };
  if (ext === '.xlsx' || ext === '.xlsm') return readXlsx(file);
  if (ext === '.xls') throw new Error('legacy .xls is not supported; re-save the file as .xlsx or export CSV');
  throw new Error(`unsupported file type "${ext}"`);
}

/** UTF-8 (with or without BOM) first; fall back to windows-1255, which Israeli bank sites still emit. */
export function decodeText(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  if (!utf8.includes('�')) return utf8;
  try {
    return new TextDecoder('windows-1255').decode(buf);
  } catch {
    return utf8;
  }
}

/** RFC 4180-ish parser: quotes, escaped quotes, CRLF, auto delimiter (comma / semicolon / tab). */
export function parseCsv(text: string, delimiter?: string): Grid {
  const delim = delimiter ?? detectDelimiter(text);
  const rows: Grid = [];
  let row: Cell[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') quoted = true; // a quote mid-field (בע"מ) is literal text
    else if (ch === delim) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((c) => String(c).trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => String(c).trim() !== '')) rows.push(row);
  return rows;
}

function detectDelimiter(text: string): string {
  const head = text.split(/\r?\n/).slice(0, 5).join('\n');
  const counts = [',', ';', '\t'].map((d) => [d, (head.match(new RegExp(d === '\t' ? '\t' : `\\${d}`, 'g')) ?? []).length] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 0 ? counts[0]![0] : ',';
}

function capRows(grid: Grid): Grid {
  if (grid.length > IMPORT_LIMITS.rows) throw new Error(`the file has more than ${IMPORT_LIMITS.rows} rows; split it`);
  return grid;
}

/**
 * The total unpacked size a zip declares, from its central directory (no unpacking). Throws when the file is not a
 * readable zip. ZIP64 archives (only needed past 4 GB) are refused.
 */
export function zipDeclaredSize(buf: Buffer): number {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a readable .xlsx (zip directory missing)');
  const entries = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('not a readable .xlsx (zip directory damaged)');
    const unpacked = buf.readUInt32LE(p + 24);
    if (unpacked === 0xffffffff) throw new Error('zip64 .xlsx files are not supported');
    total += unpacked;
    p += 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return total;
}

async function readXlsx(file: string): Promise<{ grid: Grid; sheet?: string }> {
  const unpacked = zipDeclaredSize(readFileSync(file));
  if (unpacked > IMPORT_LIMITS.xlsxUnpackedBytes) throw new Error(`the .xlsx unpacks to ${Math.round(unpacked / 1024 / 1024)} MB; refused`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.worksheets.find((w) => w.rowCount > 0) ?? wb.worksheets[0];
  if (!ws) return { grid: [] };
  const grid: Grid = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells: Cell[] = [];
    const values = row.values as ExcelJS.CellValue[]; // 1-based
    for (let c = 1; c < values.length; c++) cells.push(toCell(values[c]));
    grid.push(cells);
  });
  return { grid: capRows(grid), sheet: ws.name };
}

function toCell(v: ExcelJS.CellValue): Cell {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') {
    if ('result' in v && v.result !== undefined) return toCell(v.result as ExcelJS.CellValue);
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('text' in v) return String(v.text);
    if ('hyperlink' in v) return String((v as { text?: unknown }).text ?? v.hyperlink);
  }
  return String(v);
}
