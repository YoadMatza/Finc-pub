/**
 * The institutions finc knows how to talk to, and what each one needs from the vault.
 * Field specs drive the `finc vault set` prompts; nothing here holds a value.
 */
export type InstitutionId = 'beinleumi' | 'isracard' | 'max' | 'riseup';

export interface CredentialField {
  key: string;
  label: string;
  /** Hidden while typing and never echoed. */
  secret: boolean;
  /** Optional validation regex (whole string). */
  pattern?: RegExp;
  hint?: string;
}

export interface InstitutionSpec {
  id: InstitutionId;
  displayName: string;
  displayNameHe: string;
  kind: 'bank' | 'card' | 'aggregator';
  /** israeli-bank-scrapers CompanyTypes key, when scraped. */
  scraperId?: 'beinleumi' | 'isracard' | 'max';
  fields: CredentialField[];
  /** Substrings (normalized, lowercase) that identify this card company's debit on a bank statement. */
  settlementPatterns?: string[];
}

export const INSTITUTIONS: Record<InstitutionId, InstitutionSpec> = {
  beinleumi: {
    id: 'beinleumi',
    displayName: 'Bank Beinleumi (FIBI)',
    displayNameHe: 'הבנק הבינלאומי',
    kind: 'bank',
    scraperId: 'beinleumi',
    fields: [
      { key: 'username', label: 'Username (קוד משתמש)', secret: true },
      { key: 'password', label: 'Password', secret: true },
    ],
  },
  isracard: {
    id: 'isracard',
    displayName: 'Isracard',
    displayNameHe: 'ישראכרט',
    kind: 'card',
    scraperId: 'isracard',
    fields: [
      { key: 'id', label: 'ID number (תעודת זהות)', secret: true, pattern: /^\d{9}$/, hint: '9 digits' },
      { key: 'card6Digits', label: 'Card: last 6 digits', secret: true, pattern: /^\d{6}$/, hint: '6 digits' },
      { key: 'password', label: 'Password', secret: true },
    ],
    settlementPatterns: ['ישראכרט'],
  },
  max: {
    id: 'max',
    displayName: 'Max',
    displayNameHe: 'מקס',
    kind: 'card',
    scraperId: 'max',
    fields: [
      { key: 'username', label: 'Username', secret: true },
      { key: 'password', label: 'Password', secret: true },
    ],
    settlementPatterns: ['מקס איט', 'מקס פיננסים', 'לאומי קארד', 'max it'],
  },
  riseup: {
    id: 'riseup',
    displayName: 'RiseUp (read-only API token)',
    displayNameHe: 'רייזאפ',
    kind: 'aggregator',
    fields: [
      {
        key: 'token',
        label: 'Personal access token',
        secret: true,
        pattern: /^riseup_pat_[A-Za-z0-9_-]{20,}$/,
        hint: 'starts with riseup_pat_; create it at Settings → חיבור לכלים חיצוניים',
      },
    ],
  },
};

export const SCRAPED_INSTITUTIONS = (Object.values(INSTITUTIONS) as InstitutionSpec[]).filter((i) => i.scraperId);

export function institutionSpec(id: string): InstitutionSpec | undefined {
  return (INSTITUTIONS as Record<string, InstitutionSpec>)[id];
}
