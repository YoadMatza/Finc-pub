/**
 * Per-institution column mappings for Excel/CSV statement exports (the fallback importer).
 *
 * Headers are matched case-insensitively after trimming; several candidates per field
 * because banks rename columns between site versions. The three shipped mappings are
 * UNVERIFIED guesses until a real export from each site has been seen; `finc import headers`
 * prints what a file actually contains so the mapping can be fixed.
 */
export type AmountRule =
  | { kind: 'signed' } // one column, negative = out
  | { kind: 'card-charge' } // one column, positive = charge (expense) → negate
  | { kind: 'debit-credit'; debit: string[]; credit: string[] }; // two columns, both positive

export interface ColumnMapping {
  id: string;
  institutionId: string;
  accountType: 'checking' | 'credit_card';
  /** Rows above the header (titles, account info). If undefined, the header row is auto-detected. */
  headerRowIndex?: number;
  columns: {
    date: string[];
    chargeDate?: string[];
    description: string[];
    amount: string[];
    originalAmount?: string[];
    originalCurrency?: string[];
    memo?: string[];
    identifier?: string[];
    installments?: string[]; // e.g. "תשלום 3 מתוך 12" or "3/12"
    balance?: string[]; // running balance (bank)
    status?: string[];
  };
  amountRule: AmountRule;
  /** Day-first date formats accepted. */
  dateFormats: Array<'DD/MM/YYYY' | 'DD/MM/YY' | 'DD.MM.YYYY' | 'DD.MM.YY' | 'YYYY-MM-DD' | 'excel-serial'>;
  /** Substring of the status column that means pending (card exports), if any. */
  pendingMarker?: string;
  /** Text the file shows as the account/card number, when available (used as externalId). */
  accountColumn?: string[];
  verified: boolean;
}

export const MAPPINGS: Record<string, ColumnMapping> = {
  beinleumi: {
    id: 'beinleumi',
    institutionId: 'beinleumi',
    accountType: 'checking',
    columns: {
      date: ['תאריך', 'תאריך ערך', 'תאריך פעולה'],
      chargeDate: ['תאריך ערך'],
      description: ['תיאור', 'תיאור פעולה', 'פרטים', 'תאור'],
      amount: ['סכום'],
      identifier: ['אסמכתא', 'אסמכתה', 'מספר אסמכתא'],
      balance: ['יתרה', 'יתרה בש"ח'],
      memo: ['הערות', 'פרטים נוספים'],
    },
    amountRule: { kind: 'debit-credit', debit: ['חובה', 'סכום חובה', 'חיוב'], credit: ['זכות', 'סכום זכות', 'זיכוי'] },
    dateFormats: ['DD/MM/YYYY', 'DD/MM/YY', 'DD.MM.YYYY', 'excel-serial'],
    verified: false,
  },
  isracard: {
    id: 'isracard',
    institutionId: 'isracard',
    accountType: 'credit_card',
    columns: {
      date: ['תאריך עסקה', 'תאריך רכישה', 'תאריך'],
      chargeDate: ['תאריך חיוב', 'מועד חיוב'],
      description: ['שם בית עסק', 'שם בית העסק', 'בית עסק', 'תיאור'],
      amount: ['סכום חיוב', 'סכום החיוב', 'סכום לחיוב'],
      originalAmount: ['סכום עסקה', 'סכום העסקה', 'סכום מקורי'],
      originalCurrency: ['מטבע עסקה', 'מטבע מקור', 'מטבע'],
      memo: ['הערות', 'פירוט נוסף', 'סוג עסקה'],
      identifier: ['מספר שובר', 'אסמכתא'],
      installments: ['תשלומים', 'פירוט נוסף', 'הערות'],
    },
    amountRule: { kind: 'card-charge' },
    dateFormats: ['DD/MM/YYYY', 'DD/MM/YY', 'DD.MM.YYYY', 'DD.MM.YY', 'excel-serial'],
    accountColumn: ['מספר כרטיס', 'כרטיס', '4 ספרות אחרונות'],
    verified: false,
  },
  max: {
    id: 'max',
    institutionId: 'max',
    accountType: 'credit_card',
    columns: {
      date: ['תאריך עסקה', 'תאריך רכישה', 'תאריך'],
      chargeDate: ['תאריך חיוב', 'מועד חיוב'],
      description: ['שם בית העסק', 'שם בית עסק', 'בית עסק'],
      amount: ['סכום חיוב', 'סכום החיוב'],
      originalAmount: ['סכום עסקה מקורי', 'סכום עסקה', 'סכום מקורי'],
      originalCurrency: ['מטבע עסקה מקורי', 'מטבע מקור', 'מטבע חיוב', 'מטבע'],
      memo: ['הערות', 'סוג עסקה'],
      identifier: ['אסמכתא', 'מספר שובר'],
      installments: ['הערות', 'סוג עסקה', 'תשלומים'],
      status: ['סטטוס', 'מצב'],
    },
    amountRule: { kind: 'card-charge' },
    dateFormats: ['DD/MM/YYYY', 'DD/MM/YY', 'DD.MM.YYYY', 'DD.MM.YY', 'excel-serial'],
    pendingMarker: 'טרם',
    accountColumn: ['4 ספרות אחרונות של כרטיס האשראי', '4 ספרות אחרונות', 'מספר כרטיס', 'כרטיס'],
    verified: false,
  },
};

export const normHeader = (h: unknown): string =>
  String(h ?? '')
    .replace(/[‎‏﻿]/g, '')
    .replace(/["'״׳]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/** Index of each mapped field in the header row, or null when no candidate matches. */
export function resolveColumns(mapping: ColumnMapping, headers: unknown[]): { index: Record<string, number | null>; missing: string[] } {
  const norm = headers.map(normHeader);
  const find = (cands: string[] | undefined): number | null => {
    if (!cands) return null;
    for (const c of cands) {
      const i = norm.indexOf(normHeader(c));
      if (i >= 0) return i;
    }
    for (const c of cands) {
      const i = norm.findIndex((h) => h.includes(normHeader(c)));
      if (i >= 0) return i;
    }
    return null;
  };
  const index: Record<string, number | null> = {};
  for (const [field, cands] of Object.entries(mapping.columns)) index[field] = find(cands);
  if (mapping.amountRule.kind === 'debit-credit') {
    index.debit = find(mapping.amountRule.debit);
    index.credit = find(mapping.amountRule.credit);
  }
  index.account = find(mapping.accountColumn);
  const required = ['date', 'description'];
  const missing = required.filter((f) => index[f] === null);
  const hasAmount = mapping.amountRule.kind === 'debit-credit' ? index.debit !== null || index.credit !== null : index.amount !== null;
  if (!hasAmount) missing.push('amount');
  return { index, missing };
}

/** Score how well a header row fits a mapping (used for auto-detection of the header row and the institution). */
export function mappingScore(mapping: ColumnMapping, headers: unknown[]): number {
  const { index, missing } = resolveColumns(mapping, headers);
  if (missing.length) return 0;
  return Object.values(index).filter((v) => v !== null).length;
}
