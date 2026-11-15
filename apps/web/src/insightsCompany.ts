/**
 * Stock insights step 2 (design research_notes/proposals/stock-insights.md §3 C, E, F): the pure parts of the
 * company numbers and the filings list — compact money, the "where this number came from" caption, the margin
 * direction, 8-K item titles and the guard that only lets SEC links out. No React; wording describes, never advises.
 */
import type { Key, Lang } from './i18n';
import { currencySymbol } from './format';
import type { HoldingInsights, InsightCompanyNote, InsightCompanyUnavailableCode, InsightFigure, InsightFigureKey, InsightFiling } from './types';

type T = (key: Key, vars?: Record<string, string | number>) => string;

const isNum = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/** Unicode isolates: keep "−$1.2" one left-to-right unit inside Hebrew text. */
const LRI = '⁦';
const PDI = '⁩';

/** A signed number ("+8.1%", "−3.0%") kept in reading order inside a sentence of either direction. */
export function isolateLtr(s: string): string {
  return `${LRI}${s}${PDI}`;
}

const UNITS: Array<{ size: number; key: Key }> = [
  { size: 1e12, key: 'ins_t' },
  { size: 1e9, key: 'ins_b' },
  { size: 1e6, key: 'ins_m' },
  { size: 1e3, key: 'ins_k' },
];

/**
 * A large number, compact: 394.3B / 1.2M / 850.0K (en) or 394.3 מיליארד (he), with the currency symbol when
 * given ($394.3B, $394.3 מיליארד) and a real minus for negatives. Below 1,000 the number is shown as is
 * (up to 2 decimals). One decimal always, so 999.96M becomes 1.0B rather than 1000.0M.
 */
export function compactNumber(t: T, lang: Lang, v: number | null | undefined, currency?: string): string {
  if (!isNum(v)) return '–';
  const abs = Math.abs(v);
  const sym = currency ? currencySymbol(currency) : '';
  const minus = v < 0 && abs >= 0.005 ? '−' : '';
  let num: string;
  let unit: Key | null = null;
  const idx = UNITS.findIndex((u) => abs >= u.size);
  if (idx === -1) {
    num = abs.toLocaleString('en-US', { maximumFractionDigits: 2 });
    // 999.996 rounds to 1,000: still under the K threshold by definition, shown as is
  } else {
    let i = idx;
    let scaled = Number((abs / UNITS[i]!.size).toFixed(1));
    if (scaled >= 1000 && i > 0) {
      i -= 1;
      scaled = Number((abs / UNITS[i]!.size).toFixed(1));
    }
    num = scaled.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    unit = UNITS[i]!.key;
  }
  const head = `${minus}${sym}${num}`;
  if (lang === 'he') return unit ? `${LRI}${head}${PDI} ${t(unit)}` : `${LRI}${head}${PDI}`;
  return unit ? `${head}${t(unit)}` : head;
}

/** 2026-09-30 → 30.9.2026 (the same in both languages); anything else as given. */
export function numericDate(iso: string | null | undefined): string {
  const m = typeof iso === 'string' ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null;
  if (!m) return iso ?? '';
  return `${Number(m[3])}.${Number(m[2])}.${m[1]}`;
}

/** "12 months to 30.9.2026 · 10-Q filed 31.10.2026" — the period the figure covers and the filing it came from. */
export function basisCaption(t: T, f: InsightFigure | null | undefined): string | null {
  if (!f) return null;
  const parts: string[] = [];
  const d = f.periodEnd ? numericDate(f.periodEnd) : null;
  if (f.basis === 'ttm' && d) parts.push(t('ins_basis_ttm', { d }));
  else if (f.basis === 'annual' && d) parts.push(t('ins_basis_annual', { d }));
  else if (f.basis === 'instant' && d) parts.push(t('ins_basis_instant', { d }));
  else if (f.basis === 'derived') parts.push(d ? t('ins_basis_derived', { d }) : t('ins_basis_derived_nodate'));
  if (f.form && f.filed) parts.push(t('ins_basis_filed', { f: f.form, d: numericDate(f.filed) }));
  else if (f.form) parts.push(f.form);
  return parts.length ? parts.join(' · ') : null;
}

export type MarginTrend = 'up' | 'down' | 'flat';

/** Direction of the net margin from `then` to `now`: within half a point counts as flat. Null when either is missing. */
export function marginTrend(now: number | null | undefined, then: number | null | undefined, flatPts = 0.5): MarginTrend | null {
  if (!isNum(now) || !isNum(then)) return null;
  const diff = now - then;
  if (Math.abs(diff) < flatPts) return 'flat';
  return diff > 0 ? 'up' : 'down';
}

export const TREND_ARROW: Record<MarginTrend, string> = { up: '↑', down: '↓', flat: '→' };

/** A plain ratio (P/E 28.4, debt-to-equity 1.52). */
export function ratioText(v: number | null | undefined, digits = 2): string {
  if (!isNum(v)) return '–';
  const s = Math.abs(v).toFixed(digits);
  return `${v < 0 && Number(s) !== 0 ? '−' : ''}${s}`;
}

/**
 * Only SEC pages leave the app: https, host exactly www.sec.gov, default port, no user info. Returns the
 * normalised URL, or null to refuse.
 */
export function secLink(url: unknown): string | null {
  if (typeof url !== 'string' || url.length > 2048 || !url.startsWith('https://www.sec.gov/')) return null;
  // printable ASCII only, no backslash: the same rule as ExternalLinkRules.secUrl on Android
  if (/[^\x21-\x7e]|\\/.test(url)) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname !== 'www.sec.gov' || u.port !== '' || u.username !== '' || u.password !== '') return null;
  return url;
}

/**
 * Opens an SEC link outside finc; refuses anything else. True when handed to `open`. The browser default is
 * window.open with noopener/noreferrer; the phone passes the vault plugin's openExternal (system browser),
 * which checks the URL again natively.
 */
export function openSecLink(url: unknown, open: (u: string) => unknown = (u) => window.open(u, '_blank', 'noopener,noreferrer')): boolean {
  const safe = secLink(url);
  if (!safe) return false;
  open(safe);
  return true;
}

const ITEM_KEYS: Record<string, Key> = {
  '1.01': 'ins_8k_1_01',
  '1.02': 'ins_8k_1_02',
  '1.03': 'ins_8k_1_03',
  '1.04': 'ins_8k_1_04',
  '1.05': 'ins_8k_1_05',
  '2.01': 'ins_8k_2_01',
  '2.02': 'ins_8k_2_02',
  '2.03': 'ins_8k_2_03',
  '2.04': 'ins_8k_2_04',
  '2.05': 'ins_8k_2_05',
  '2.06': 'ins_8k_2_06',
  '3.01': 'ins_8k_3_01',
  '3.02': 'ins_8k_3_02',
  '3.03': 'ins_8k_3_03',
  '4.01': 'ins_8k_4_01',
  '4.02': 'ins_8k_4_02',
  '5.01': 'ins_8k_5_01',
  '5.02': 'ins_8k_5_02',
  '5.03': 'ins_8k_5_03',
  '5.04': 'ins_8k_5_04',
  '5.05': 'ins_8k_5_05',
  '5.06': 'ins_8k_5_06',
  '5.07': 'ins_8k_5_07',
  '5.08': 'ins_8k_5_08',
  '6.01': 'ins_8k_6_01',
  '6.02': 'ins_8k_6_02',
  '6.03': 'ins_8k_6_03',
  '6.04': 'ins_8k_6_04',
  '6.05': 'ins_8k_6_05',
  '7.01': 'ins_8k_7_01',
  '8.01': 'ins_8k_8_01',
  '9.01': 'ins_8k_9_01',
};

/**
 * The hub sends "2.02 Results of operations" (or a bare "2.02" for unknown ones): a known code gets the app's
 * he/en title; an unknown one keeps the hub's English title when it has one, else "Item 6.03".
 */
export function itemTitle(t: T, item: string): string {
  const m = /^\s*(?:item\s+)?(\d{1,2})\.(\d{2})\b\s*(.*)$/i.exec(item);
  if (!m) return item.trim();
  const code = `${Number(m[1])}.${m[2]}`;
  const key = ITEM_KEYS[code];
  if (key) return t(key);
  const rest = m[3]!.trim();
  return rest || t('ins_8k_item', { n: code });
}

/**
 * The currency to show a money figure in: the figure's own unit ('USD', 'EUR', 'USD/shares' → USD), else the
 * company's currency, else USD.
 */
export function figureCurrency(f: Pick<InsightFigure, 'unit'> | null | undefined, companyCurrency: string | null | undefined): string {
  const m = typeof f?.unit === 'string' ? /^([A-Z]{3})(?:\/shares?)?$/.exec(f.unit) : null;
  if (m) return m[1]!;
  return companyCurrency && /^[A-Z]{3}$/.test(companyCurrency) ? companyCurrency : 'USD';
}

const FORM_KEYS: Record<string, Key> = {
  '10-K': 'ins_form_10k',
  '10-Q': 'ins_form_10q',
  '8-K': 'ins_form_8k',
  '20-F': 'ins_form_20f',
  '6-K': 'ins_form_6k',
  'DEF 14A': 'ins_form_def14a',
};

/**
 * What a filing is about: the 8-K items as titles (9.01 "exhibits" dropped when there are others), else the
 * hub's title, else what the form is ("Quarterly report"), else nothing.
 */
export function filingText(t: T, f: Pick<InsightFiling, 'form' | 'title' | 'items'>): string | null {
  const items = (f.items ?? []).filter((s) => typeof s === 'string' && s.trim());
  if (items.length) {
    const titles = items.map((s) => itemTitle(t, s));
    const exhibits = t('ins_8k_9_01');
    const kept = titles.length > 1 ? titles.filter((s) => s !== exhibits) : titles;
    return [...new Set(kept)].join(' · ');
  }
  if (f.title && f.title.trim()) return f.title.trim();
  const base = f.form.replace(/\/A$/, '');
  const key = FORM_KEYS[base];
  return key ? t(key) : null;
}

export const FILINGS_VISIBLE = 8;

/** "Revenue (12 months)" for a TTM figure, "Revenue (last fiscal year)" for an annual one, else the bare label. */
export function periodLabel(t: T, base: string, basis: InsightFigure['basis'] | null | undefined): string {
  if (basis === 'ttm') return `${base} ${t('ins_co_p_ttm')}`;
  if (basis === 'annual') return `${base} ${t('ins_co_p_annual')}`;
  return base;
}

const NOTE_KEYS: Record<string, Key> = {
  no_xbrl: 'ins_note_no_xbrl',
  no_currency: 'ins_note_no_currency',
  foreign_currency: 'ins_note_foreign_currency',
  foreign_ifrs: 'ins_note_foreign_ifrs',
  not_reported: 'ins_note_not_reported',
  annual_basis: 'ins_note_annual_basis',
  q4_derived: 'ins_note_q4_derived',
  concept_filled: 'ins_note_concept_filled',
  larger_revenue_concept: 'ins_note_larger_revenue_concept',
  stale_dropped: 'ins_note_stale_dropped',
  no_prior_period: 'ins_note_no_prior_period',
  prior_zero: 'ins_note_prior_zero',
  no_matching_period: 'ins_note_no_matching_period',
  revenue_not_positive: 'ins_note_revenue_not_positive',
  out_of_bounds: 'ins_note_out_of_bounds',
  split_adjusted: 'ins_note_split_adjusted',
  split_suspected: 'ins_note_split_suspected',
  eps_inconsistent: 'ins_note_eps_inconsistent',
  no_price: 'ins_note_no_price',
  eps_currency: 'ins_note_eps_currency',
  eps_not_positive: 'ins_note_eps_not_positive',
  adr_no_pe: 'ins_note_adr_no_pe',
  not_determinable: 'ins_note_not_determinable',
  excludes_leases: 'ins_note_excludes_leases',
  equity_not_positive: 'ins_note_equity_not_positive',
  bank_debt_ratio: 'ins_note_bank_debt_ratio',
  share_classes_summed: 'ins_note_share_classes_summed',
  no_prior_shares: 'ins_note_no_prior_shares',
  filings_unavailable: 'ins_note_filings_unavailable',
};

/** How-it-was-computed notes, kept behind a toggle: the labels already say enough for everyday reading. */
export const METHOD_NOTE_CODES: ReadonlySet<string> = new Set(['q4_derived', 'concept_filled', 'excludes_leases']);

/** A hub note in the app's language; an unknown code falls back to the hub's English text (flagged raw). */
export function noteText(t: T, n: Pick<InsightCompanyNote, 'code' | 'text'>): { text: string; raw: boolean } {
  const c = typeof n.code === 'string' ? n.code.trim() : '';
  if (c && Object.prototype.hasOwnProperty.call(NOTE_KEYS, c)) return { text: t(NOTE_KEYS[c]!), raw: false };
  const text = typeof n.text === 'string' && n.text.trim() ? n.text.trim() : c;
  return { text, raw: true };
}

/** The figures each company row shows (its main figure first); a note about any of them is shown under that row. */
export const ROW_FIGURES: Record<string, InsightFigureKey[]> = {
  rev: ['revenueTtm', 'revenueYoYPct'],
  ni: ['netIncomeTtm', 'netIncomeYoYPct'],
  margin: ['netMarginPct', 'netMarginPct1yAgo', 'netMarginPct3yAgo'],
  eps: ['epsTtm'],
  pe: ['pe'],
  cash: ['cash'],
  debt: ['totalDebt'],
  leases: ['financeLeases'],
  de: ['debtToEquity'],
  shares: ['sharesOutstanding'],
  sharesChg: ['sharesChange1yPct'],
};

export interface PlacedNotes {
  /** row key → notes shown under it */
  byRow: Record<string, InsightCompanyNote[]>;
  /** section-wide notes and notes about figures that are not shown (e.g. EPS left out) */
  bottom: InsightCompanyNote[];
  /** the how-it-was-computed notes, for the toggle */
  method: InsightCompanyNote[];
}

/**
 * Where each note goes: method codes to the toggle; a note about a figure whose row is shown, under that row;
 * everything else at the bottom. Duplicates (same code and figure) are dropped; bad entries are skipped.
 */
export function placeNotes(notes: unknown, shownRows: Iterable<string>): PlacedNotes {
  const out: PlacedNotes = { byRow: {}, bottom: [], method: [] };
  const rowOf = new Map<string, string>();
  for (const r of shownRows) for (const k of ROW_FIGURES[r] ?? []) if (!rowOf.has(k)) rowOf.set(k, r);
  const seen = new Set<string>();
  for (const n of Array.isArray(notes) ? (notes as unknown[]) : []) {
    if (!n || typeof n !== 'object') continue;
    const note = n as InsightCompanyNote;
    if (typeof note.code !== 'string' || !note.code.trim()) continue;
    const figure = typeof note.figure === 'string' ? note.figure : null;
    const id = `${note.code}|${figure ?? ''}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const clean: InsightCompanyNote = { code: note.code.trim(), figure, text: typeof note.text === 'string' ? note.text : '' };
    if (METHOD_NOTE_CODES.has(clean.code)) out.method.push(clean);
    else if (figure && rowOf.has(figure)) (out.byRow[rowOf.get(figure)!] ??= []).push(clean);
    else out.bottom.push(clean);
  }
  return out;
}

const CO_UNAVAILABLE_KEYS: Record<InsightCompanyUnavailableCode, Key> = {
  off: 'ins_co_unav_off',
  not_covered: 'ins_co_unav_not_covered',
  busy: 'ins_co_unav_busy',
  unreachable: 'ins_co_unav_unreachable',
  invalid: 'ins_co_unav_invalid',
};

/** The muted one-liner when the company's numbers are missing for a known reason; null otherwise. */
export function companyUnavailableReason(t: T, code: string | undefined | null): string | null {
  if (!code || !Object.prototype.hasOwnProperty.call(CO_UNAVAILABLE_KEYS, code)) return null;
  return t(CO_UNAVAILABLE_KEYS[code as InsightCompanyUnavailableCode]);
}

/** The newest filing date behind the company figures (falls back to the newest filing listed); null when neither. */
export function latestSecDate(d: Pick<HoldingInsights, 'company' | 'filings'> | undefined): string | null {
  let best: string | null = null;
  const consider = (s: string | null | undefined) => {
    if (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s) && (best === null || s.slice(0, 10) > best)) best = s.slice(0, 10);
  };
  for (const f of Object.values(d?.company?.figures ?? {})) consider(f?.filed);
  if (best === null) for (const f of d?.filings ?? []) consider(f.filed);
  return best;
}
