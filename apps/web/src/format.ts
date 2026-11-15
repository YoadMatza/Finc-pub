/** Money arrives in agorot, signed. These helpers render it; they never round the underlying data. */

export function money(minor: number, opts: { sign?: 'auto' | 'never' | 'always'; decimals?: 0 | 2; currency?: string } = {}): string {
  const sign = opts.sign ?? 'never';
  const abs = Math.abs(minor) / 100;
  const decimals = opts.decimals ?? (abs >= 1000 ? 0 : 2);
  const n = abs.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const cur = opts.currency && opts.currency !== 'ILS' ? `${opts.currency} ` : '₪';
  const prefix = sign === 'never' ? '' : minor < 0 ? '−' : sign === 'always' ? '+' : '';
  return `${prefix}${cur}${n}`;
}

export function monthLabel(month: string, locale: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(new Date(Date.UTC(y, m - 1, 1)));
}

export function dayLabel(date: string, locale: string, opts: { year?: boolean } = {}): string {
  const d = new Date(`${date}T00:00:00`);
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', ...(opts.year ? { year: 'numeric' } : {}) }).format(d);
}

export function shortDate(date: string): string {
  return `${date.slice(8, 10)}.${date.slice(5, 7)}`;
}

export function relTime(iso: string | null, locale: string): string {
  if (!iso) return '—';
  const diff = Date.now() - Date.parse(iso);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const min = Math.round(diff / 60_000);
  if (Math.abs(min) < 60) return rtf.format(-min, 'minute');
  const h = Math.round(min / 60);
  if (Math.abs(h) < 36) return rtf.format(-h, 'hour');
  return rtf.format(-Math.round(h / 24), 'day');
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function pct(part: number, whole: number): number {
  if (!whole) return 0;
  return Math.max(0, Math.min(1, Math.abs(part) / Math.abs(whole)));
}

const CURRENCY_SYMBOL: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', ILS: '₪', JPY: '¥' };

/** A sign-aware symbol for a currency code: $, €, ₪… or the code and a space when unknown. */
export function currencySymbol(code: string): string {
  return CURRENCY_SYMBOL[code] ?? `${code} `;
}

/**
 * An amount in a foreign (or any) currency given in MAJOR units (dollars, not cents), e.g. $1,234.56.
 * Unlike money() this does not take agorot: market prices and position values arrive in their own currency.
 */
export function foreignMoney(amount: number, currency: string, opts: { sign?: 'auto' | 'never' | 'always'; decimals?: number } = {}): string {
  const sign = opts.sign ?? 'never';
  const decimals = opts.decimals ?? 2;
  const n = Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const rounded = Number(Math.abs(amount).toFixed(decimals));
  const prefix = sign === 'never' || rounded === 0 ? '' : amount < 0 ? '−' : sign === 'always' ? '+' : '';
  return `${prefix}${currencySymbol(currency)}${n}`;
}
