/**
 * SEC EDGAR for the stock-insights panel (research_notes/proposals/stock-insights.md, step 2: sections E and F).
 *
 * Three public JSON files, no key:
 *  - https://www.sec.gov/files/company_tickers.json — every listed ticker with its CIK (company number) and name;
 *    downloaded whole, so the ticker itself never leaves the machine;
 *  - https://data.sec.gov/submissions/CIK##########.json — the company's name, SIC industry code and recent filings;
 *  - https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json — every XBRL figure the company has filed.
 * What leaves the machine: the CIK in the URL path, and the User-Agent SEC requires: "finc personal finance app
 * <contact>", the contact (an e-mail address) read from FINC_SEC_CONTACT by the caller. Never a quantity or amount.
 *
 * Rules (as for Yahoo): fixed hosts www.sec.gov and data.sec.gov only (checked on every URL), no redirects followed,
 * no cookies, a timeout, a cap on the answer's size, CIK validated and zero-padded to 10 digits. Every answer is
 * validated; companyfacts is trimmed at once to the concepts company.ts uses (and to 6 years), so the multi-megabyte
 * answer is not kept.
 */
import type { FetchFn } from '../prices/yahoo.js';

export const SEC_HOSTS = ['www.sec.gov', 'data.sec.gov'] as const;
export const SEC_TIMEOUT_MS = 10_000;
export const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
/** answer size caps (bytes, after decompression) */
export const SEC_MAX_BYTES = { tickers: 8 * 1024 * 1024, submissions: 32 * 1024 * 1024, facts: 32 * 1024 * 1024 } as const;
/** filings kept from submissions' `recent` list: the section F forms only, newest first (SEC's order) */
export const SUBMISSIONS_MAX_FILINGS = 2000;
/** entries scanned at most (a large bank lists over 26,000, mostly prospectus supplements) */
export const SUBMISSIONS_MAX_SCAN = 60_000;
/** facts kept per company after trimming (the newest by period end) */
export const SEC_MAX_FACTS = 6000;
/** years of facts kept, back from the newest period end */
const KEEP_YEARS = 6;

const CONTACT_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ACCN_RE = /^\d{10}-\d{2}-\d{6}$/;

/** The contact for SEC's User-Agent, or null when it is empty or does not look like an e-mail address. */
export function secContact(raw: string | undefined | null): string | null {
  const s = (raw ?? '').trim();
  return CONTACT_RE.test(s) ? s : null;
}

/** "finc personal finance app <contact>" (exactly), or null without a valid contact. */
export function secUserAgent(contact: string | null | undefined): string | null {
  const c = secContact(contact);
  return c ? `finc personal finance app ${c}` : null;
}

/** A CIK as SEC's 10-digit zero-padded string, or null when it is not a CIK. */
export function padCik(cik: unknown): string | null {
  const n = typeof cik === 'number' ? cik : typeof cik === 'string' && /^\d{1,10}$/.test(cik) ? Number(cik) : Number.NaN;
  if (!Number.isSafeInteger(n) || n <= 0 || n > 9_999_999_999) return null;
  return String(n).padStart(10, '0');
}

export const submissionsUrl = (cik10: string): string => `https://data.sec.gov/submissions/CIK${cik10}.json`;
export const companyFactsUrl = (cik10: string): string => `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik10}.json`;

/** The SEC filing index page of one filing (www.sec.gov only), or null when the CIK or accession number is bad. */
export function filingIndexUrl(cik: string | number, accn: string): string | null {
  const c = padCik(cik);
  if (!c || !ACCN_RE.test(accn)) return null;
  return `https://www.sec.gov/Archives/edgar/data/${Number(c)}/${accn.replace(/-/g, '')}/`;
}

/**
 * How SEC lists class shares: BRK.B (the bank's and Yahoo's dot form, or a slash) is BRK-B there. Other suffixes
 * (TEVA.TA, an exchange) are not US listings and stay as they are (and are then not found).
 */
export function secTicker(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  return /^[A-Z]{1,5}[./][A-Z]$/.test(s) ? s.replace(/[./]/, '-') : s;
}

export type SecFetchResult = { ok: true; body: unknown } | { ok: false; reason: 'off' | 'rate_limited' | 'server' | 'network' | 'not_found' | 'bad_answer' | 'too_large'; status?: number };

/** Reads a response body as text, refusing anything over `max` bytes (streamed, so a huge answer is cut early). */
export async function readCapped(res: Response, max: number): Promise<string | null> {
  const len = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(len) && len > max) return null;
  if (!res.body) {
    const t = await res.text();
    return Buffer.byteLength(t) > max ? null : t;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * One GET to SEC: the URL must be https on a fixed SEC host; the User-Agent names finc and the contact. 429 and 403
 * (SEC's answer to too many requests) are rate_limited. Never throws.
 */
export async function secGet(url: string, opts: { contact: string | null; fetch?: FetchFn; timeoutMs?: number; maxBytes: number }): Promise<SecFetchResult> {
  const ua = secUserAgent(opts.contact);
  if (!ua) return { ok: false, reason: 'off' };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: 'bad_answer' };
  }
  if (u.protocol !== 'https:' || !(SEC_HOSTS as readonly string[]).includes(u.hostname) || u.port || u.username || u.password) return { ok: false, reason: 'bad_answer' };
  const doFetch = opts.fetch ?? ((x, i) => fetch(x, i));
  let res: Response;
  try {
    res = await doFetch(u.toString(), { method: 'GET', headers: { 'user-agent': ua, accept: 'application/json' }, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(opts.timeoutMs ?? SEC_TIMEOUT_MS) });
  } catch {
    return { ok: false, reason: 'network' };
  }
  if (res.status === 429 || res.status === 403) return { ok: false, reason: 'rate_limited', status: res.status };
  if (res.status === 404) return { ok: false, reason: 'not_found', status: 404 };
  if (res.status >= 500) return { ok: false, reason: 'server', status: res.status };
  if (res.status !== 200) return { ok: false, reason: 'bad_answer', status: res.status };
  let text: string | null;
  try {
    text = await readCapped(res, opts.maxBytes);
  } catch {
    return { ok: false, reason: 'network' };
  }
  if (text === null) return { ok: false, reason: 'too_large' };
  try {
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: 'bad_answer', status: res.status };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// company_tickers.json

export interface TickerEntry {
  cik: string;
  title: string;
}

/** company_tickers.json ({"0": {cik_str, ticker, title}, …}) to ticker → {cik, title}; null when the shape is wrong. */
export function parseTickerMap(body: unknown): Map<string, TickerEntry> | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const out = new Map<string, TickerEntry>();
  for (const v of Object.values(body as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const e = v as { cik_str?: unknown; ticker?: unknown; title?: unknown };
    const cik = padCik(e.cik_str);
    if (!cik || typeof e.ticker !== 'string' || !/^[A-Z0-9.-]{1,15}$/i.test(e.ticker)) continue;
    const t = e.ticker.toUpperCase();
    // the first entry of a ticker wins (SEC lists each once)
    if (!out.has(t)) out.set(t, { cik, title: typeof e.title === 'string' ? e.title.slice(0, 200) : '' });
  }
  return out.size ? out : null;
}

/** The SEC entry of a holding's symbol (class shares in either form), or null when SEC does not list it. */
export function lookupTicker(map: ReadonlyMap<string, TickerEntry>, symbol: string): TickerEntry | null {
  return map.get(secTicker(symbol)) ?? map.get(symbol.trim().toUpperCase()) ?? null;
}

// ---------------------------------------------------------------------------------------------------------------
// submissions

export interface SecFilingRaw {
  form: string;
  filed: string;
  reportDate: string | null;
  accn: string;
  /** 8-K item codes ("2.02"), as filed */
  items: string[];
}

export interface SecSubmissions {
  cik: string;
  name: string;
  sic: string | null;
  sicDescription: string | null;
  filings: SecFilingRaw[];
}

const str = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.length <= max ? v : null);

/** submissions/CIK##########.json to the parts finc uses, or null when the shape is wrong or it is another company. */
export function parseSubmissions(body: unknown, cik10: string): SecSubmissions | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { cik?: unknown; name?: unknown; sic?: unknown; sicDescription?: unknown; filings?: { recent?: Record<string, unknown> } };
  if (padCik(b.cik) !== cik10) return null;
  const name = str(b.name)?.trim();
  if (!name) return null;
  const sic = typeof b.sic === 'string' && /^\d{3,4}$/.test(b.sic) ? b.sic.padStart(4, '0') : null;
  const rec = b.filings?.recent;
  if (!rec || typeof rec !== 'object') return null;
  const forms = rec.form, dates = rec.filingDate, accns = rec.accessionNumber, reports = rec.reportDate, items = rec.items;
  if (!Array.isArray(forms) || !Array.isArray(dates) || !Array.isArray(accns)) return null;
  const total = forms.length;
  if (dates.length !== total || accns.length !== total) return null;
  // newest first: the section F forms among the first SUBMISSIONS_MAX_SCAN entries, at most SUBMISSIONS_MAX_FILINGS
  const n = Math.min(total, SUBMISSIONS_MAX_SCAN);
  const filings: SecFilingRaw[] = [];
  for (let i = 0; i < n && filings.length < SUBMISSIONS_MAX_FILINGS; i++) {
    const form = str(forms[i], 20);
    if (!form || !FORM_TITLES[form.endsWith('/A') ? form.slice(0, -2) : form]) continue;
    const filed = str(dates[i], 10);
    const accn = str(accns[i], 20);
    if (!form || !filed || !DATE_RE.test(filed) || !accn || !ACCN_RE.test(accn)) continue;
    const rd = Array.isArray(reports) ? str(reports[i], 10) : null;
    const it = Array.isArray(items) ? str(items[i], 400) : null;
    filings.push({ form, filed, reportDate: rd && DATE_RE.test(rd) ? rd : null, accn, items: it ? it.split(',').map((x) => x.trim()).filter((x) => /^\d{1,2}\.\d{2}$/.test(x)) : [] });
  }
  return { cik: cik10, name: name.slice(0, 200), sic, sicDescription: str(b.sicDescription)?.trim() || null, filings };
}

/** Short English titles of the 8-K items (Form 8-K, General Instructions B). Unknown codes show as "Item x.xx". */
export const EIGHT_K_ITEMS: Readonly<Record<string, string>> = {
  '1.01': 'Material agreement',
  '1.02': 'Material agreement ended',
  '1.03': 'Bankruptcy or receivership',
  '1.04': 'Mine safety',
  '1.05': 'Cybersecurity incident',
  '2.01': 'Acquisition or sale of assets',
  '2.02': 'Results of operations',
  '2.03': 'New debt or obligation',
  '2.04': 'Debt acceleration',
  '2.05': 'Exit or restructuring costs',
  '2.06': 'Material impairment',
  '3.01': 'Delisting or listing rule notice',
  '3.02': 'Unregistered sale of shares',
  '3.03': "Change to shareholders' rights",
  '4.01': 'Auditor change',
  '4.02': 'Earlier financial statements not to be relied on',
  '5.01': 'Change in control',
  '5.02': 'Director/officer change',
  '5.03': 'Bylaws or fiscal year change',
  '5.04': 'Pension plan trading suspension',
  '5.05': 'Code of ethics change',
  '5.06': 'Shell company status change',
  '5.07': 'Shareholder vote results',
  '5.08': 'Director nominations',
  '6.01': 'Asset-backed securities information',
  '6.02': 'Asset-backed securities servicer change',
  '6.03': 'Asset-backed securities credit change',
  '6.04': 'Asset-backed securities distribution failure',
  '6.05': 'Asset-backed securities law disclosure',
  '7.01': 'Reg FD disclosure',
  '8.01': 'Other events',
  '9.01': 'Financial statements and exhibits',
};

export function eightKItemTitle(code: string): string {
  return EIGHT_K_ITEMS[code] ?? `Item ${code}`;
}

/** An 8-K item as the panel lists it: the code, then its short English title ("2.02 Results of operations"); the app
 * reads the code to show its own translation. An unknown code stays a bare code. */
export function eightKItem(code: string): string {
  const t = EIGHT_K_ITEMS[code];
  return t ? `${code} ${t}` : code;
}

/** Forms shown in section F, with a short title (amendments add "(amended)"). */
const FORM_TITLES: Readonly<Record<string, string>> = {
  '10-K': 'Annual report',
  '10-Q': 'Quarterly report',
  '8-K': 'Current report',
  '20-F': 'Annual report (foreign issuer)',
  '40-F': 'Annual report (Canadian issuer)',
  '6-K': 'Report of foreign issuer',
};

export interface FilingEvent {
  form: string;
  filed: string;
  reportDate: string | null;
  title: string | null;
  /** 8-K items in the order filed, each "code title" ("2.02 Results of operations"); empty for other forms */
  items: string[];
  /** the filing's index page on www.sec.gov */
  url: string;
}

export const FILINGS_MAX = 20;
const FILINGS_DAYS = 365;

/**
 * Section F's filings: 10-K, 10-Q and 8-K (20-F, 40-F and 6-K for foreign filers, and their amendments) filed in the
 * 365 days up to `today` (YYYY-MM-DD), newest first, at most 20.
 */
export function recentFilings(sub: SecSubmissions, today: string): FilingEvent[] {
  const from = new Date(Date.parse(today) - FILINGS_DAYS * 86_400_000).toISOString().slice(0, 10);
  const out: Array<FilingEvent & { accn: string }> = [];
  for (const f of sub.filings) {
    const base = f.form.endsWith('/A') ? f.form.slice(0, -2) : f.form;
    const title = FORM_TITLES[base];
    if (!title || f.filed < from || f.filed > today) continue;
    const url = filingIndexUrl(sub.cik, f.accn);
    if (!url) continue;
    out.push({ form: f.form, filed: f.filed, reportDate: f.reportDate, title: f.form.endsWith('/A') ? `${title} (amended)` : title, items: base === '8-K' ? f.items.map(eightKItem) : [], url, accn: f.accn });
  }
  out.sort((a, b) => (a.filed === b.filed ? (a.accn < b.accn ? 1 : a.accn > b.accn ? -1 : 0) : a.filed < b.filed ? 1 : -1));
  return out.slice(0, FILINGS_MAX).map(({ accn: _a, ...e }) => e);
}

// ---------------------------------------------------------------------------------------------------------------
// companyfacts

/** One XBRL fact (companyfacts' fields; `start` absent for an instant such as a balance-sheet figure). */
export interface SecFact {
  start?: string;
  end: string;
  val: number;
  form: string;
  filed: string;
  accn: string;
}

/** companyfacts trimmed: concept ("us-gaap:Revenues") → unit ("USD", "USD/shares", "shares", "EUR") → facts. */
export interface CompanyFacts {
  cik: string;
  entityName: string;
  concepts: Record<string, Record<string, SecFact[]>>;
}

/** Every concept company.ts reads. */
export const FACT_CONCEPTS = [
  'us-gaap:Revenues',
  'us-gaap:RevenuesNetOfInterestExpense',
  'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax',
  'us-gaap:SalesRevenueNet',
  'us-gaap:RevenueFromContractWithCustomerIncludingAssessedTax',
  'ifrs-full:Revenue',
  'us-gaap:NetIncomeLoss',
  'ifrs-full:ProfitLossAttributableToOwnersOfParent',
  'ifrs-full:ProfitLoss',
  'us-gaap:EarningsPerShareDiluted',
  'ifrs-full:DilutedEarningsLossPerShare',
  'us-gaap:CashAndCashEquivalentsAtCarryingValue',
  'us-gaap:CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
  'ifrs-full:CashAndCashEquivalents',
  'us-gaap:LongTermDebt',
  'us-gaap:LongTermDebtNoncurrent',
  'us-gaap:LongTermDebtCurrent',
  'us-gaap:DebtCurrent',
  'us-gaap:ShortTermBorrowings',
  'us-gaap:CommercialPaper',
  'us-gaap:OtherShortTermBorrowings',
  'us-gaap:FinanceLeaseLiability',
  'us-gaap:FinanceLeaseLiabilityCurrent',
  'us-gaap:FinanceLeaseLiabilityNoncurrent',
  'us-gaap:WeightedAverageNumberOfDilutedSharesOutstanding',
  'us-gaap:StockholdersEquity',
  'us-gaap:StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest',
  'ifrs-full:EquityAttributableToOwnersOfParent',
  'ifrs-full:Equity',
  'dei:EntityCommonStockSharesOutstanding',
  'us-gaap:CommonStockSharesOutstanding',
] as const;

/** Forms whose facts are used: periodic reports (and amendments). Facts from 8-Ks, S-1s, proxies… are ignored. */
const FACT_FORMS = new Set(['10-K', '10-K/A', '10-Q', '10-Q/A', '10-KT', '10-KT/A', '20-F', '20-F/A', '40-F', '40-F/A', '6-K', '6-K/A']);
const UNIT_RE = /^(?:[A-Z]{3}|[A-Z]{3}\/shares|shares)$/;

/**
 * companyfacts/CIK##########.json trimmed to FACT_CONCEPTS, units USD-like, share or per-share, facts from periodic
 * reports with valid dates and numbers, the last 6 years, at most SEC_MAX_FACTS facts. The 6 years count back from the
 * newest period end of the revenue and net income concepts (any concept when there are none), ignoring period ends
 * after `today` (a typo in a filing must not empty the window). A fact with a bad field is dropped alone; a body of
 * another company or without `facts` is refused (null).
 */
export function trimCompanyFacts(body: unknown, cik10: string, today: string = new Date().toISOString().slice(0, 10)): CompanyFacts | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { cik?: unknown; entityName?: unknown; facts?: Record<string, Record<string, { units?: Record<string, unknown> }>> };
  if (padCik(b.cik) !== cik10) return null;
  if (!b.facts || typeof b.facts !== 'object') return null;
  const all: Array<{ key: string; unit: string; f: SecFact }> = [];
  for (const key of FACT_CONCEPTS) {
    const [tax, name] = key.split(':') as [string, string];
    const units = b.facts[tax]?.[name]?.units;
    if (!units || typeof units !== 'object') continue;
    for (const [unit, arr] of Object.entries(units)) {
      if (!UNIT_RE.test(unit) || !Array.isArray(arr)) continue;
      for (const x of arr.slice(0, 20_000)) {
        const f = cleanFact(x);
        if (f) all.push({ key, unit, f });
      }
    }
  }
  const anchor = (a: { key: string }) => /Revenue|NetIncomeLoss|ProfitLoss/.test(a.key);
  let newest = '';
  for (const a of all) if (anchor(a) && a.f.end <= today && a.f.end > newest) newest = a.f.end;
  if (!newest) for (const a of all) if (a.f.end <= today && a.f.end > newest) newest = a.f.end;
  const from = newest ? `${Number(newest.slice(0, 4)) - KEEP_YEARS}${newest.slice(4)}` : '';
  const kept = all.filter((a) => a.f.end >= from).sort((x, y) => (x.f.end < y.f.end ? 1 : x.f.end > y.f.end ? -1 : 0)).slice(0, SEC_MAX_FACTS);
  const concepts: CompanyFacts['concepts'] = {};
  for (const a of kept) ((concepts[a.key] ??= {})[a.unit] ??= []).push(a.f);
  return { cik: cik10, entityName: (str(b.entityName) ?? '').trim(), concepts };
}

function cleanFact(x: unknown): SecFact | null {
  if (!x || typeof x !== 'object') return null;
  const f = x as Record<string, unknown>;
  const end = f.end, start = f.start, val = f.val, form = f.form, filed = f.filed, accn = f.accn;
  if (typeof end !== 'string' || !DATE_RE.test(end) || !Number.isFinite(Date.parse(end))) return null;
  if (start !== undefined && (typeof start !== 'string' || !DATE_RE.test(start) || !(start <= end))) return null;
  if (typeof val !== 'number' || !Number.isFinite(val)) return null;
  if (typeof form !== 'string' || !FACT_FORMS.has(form)) return null;
  if (typeof filed !== 'string' || !DATE_RE.test(filed)) return null;
  if (typeof accn !== 'string' || !ACCN_RE.test(accn)) return null;
  return { ...(typeof start === 'string' ? { start } : {}), end, val, form, filed, accn };
}
