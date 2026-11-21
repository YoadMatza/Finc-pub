/**
 * Readers for two FIBI portal pages the scraping library does not cover, fed with the visible text of the
 * page's content frame (recorded 2026-11-10 with `finc spike beinleumi --explore`):
 *  - "שוק ההון → התיק שלי" (apps.fibi.co.il/cpm3/#/portfolio): the securities portfolio
 *  - "מטבע חוץ → תיק מט"ח": the foreign-currency balances
 * Pure text in, structured positions out; nothing here touches the browser or the database.
 */

export interface HoldingRow {
  kind: 'security' | 'currency';
  symbol: string;
  name: string;
  quantity: number;
  price: number | null;
  currency: string;
  /** agorot */
  valueIls: number;
  valueOrig: number | null;
  costPrice: number | null;
  dailyChangePct: number | null;
  fromCostPct: number | null;
}

const CURRENCY_SYMBOL: Record<string, string> = { $: 'USD', '₪': 'ILS', '€': 'EUR', '£': 'GBP', '¥': 'JPY' };
const num = (s: string): number => Number(s.replace(/[^\d.-]/g, ''));
const toMinor = (n: number): number => Math.round(n * 100);

/**
 * The portfolio page lists each position as a run of lines: SYMBOL, name, quantity, last price, daily %, daily
 * change, adjusted cost price, % from cost, value in ILS, value in the paper's currency. Lines are read in order
 * and matched by shape, so a missing column or an extra note ("הכנסה לקבל") does not derail the next position.
 */
export function parseFibiPortfolioText(text: string): { positions: HoldingRow[]; totalIls: number | null } {
  // cells: every tab-separated cell of every line, in reading order; the totals row is taken out first
  const cells: string[] = [];
  let totalIls: number | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (/^סה[״"]כ(\s|$)/.test(line) && !/לנסחרים/.test(line)) {
      const m = line.match(/₪\s?[\d,]+(\.\d+)?/g);
      if (m && m.length) totalIls = toMinor(num(m[m.length - 1]!));
      continue;
    }
    for (const cell of raw.split('\t')) {
      const c = cell.replace(/\s+/g, ' ').trim();
      if (c) cells.push(c);
    }
  }
  const isSymbol = (c: string) => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(c);
  const isInt = (c: string) => /^\d[\d,]*$/.test(c);
  const isMoney = (c: string) => /^[$₪€£¥]\s?[\d,]+(\.\d+)?$/.test(c);
  const isPct = (c: string) => /^[+-]?[\d,]+(\.\d+)?\s?%$/.test(c);
  const isNameAfter = (i: number) => {
    const n = cells[i + 1];
    return n !== undefined && !isSymbol(n) && !isMoney(n) && !isInt(n) && !isPct(n);
  };
  const positions: HoldingRow[] = [];
  for (let i = 0; i < cells.length; i++) {
    if (!isSymbol(cells[i]!) || !isNameAfter(i)) continue;
    const symbol = cells[i]!;
    const name = cells[i + 1]!;
    // the block ends at the next position, or at any Hebrew text other than the dividend note ("הכנסה לקבל"):
    // after the last position the page goes on with totals, "most active", market views and footnotes
    let j = i + 2;
    const block: string[] = [];
    while (j < cells.length && !(isSymbol(cells[j]!) && isNameAfter(j)) && !(/[\u0590-\u05FF]/.test(cells[j]!) && !/^הכנסה/.test(cells[j]!))) block.push(cells[j]!), j++;
    const qtyTok = block.find(isInt);
    const money = block.filter(isMoney);
    if (!qtyTok || money.length < 2) {
      i = j - 1;
      continue;
    }
    const cur = money[0]![0]!;
    const currency = CURRENCY_SYMBOL[cur] ?? 'ILS';
    const same = money.filter((m) => m[0] === cur); // price, cost, value in the paper's currency
    // a foreign paper has exactly one shekel figure, its value; a shekel paper lists price, cost, then value
    const ilsTokens = money.filter((m) => m.startsWith('₪'));
    const valueIlsTok = currency === 'ILS' ? ilsTokens[2] : ilsTokens[0];
    if (!valueIlsTok) {
      i = j - 1;
      continue;
    }
    const pcts = block.filter(isPct);
    positions.push({
      kind: 'security',
      symbol,
      name: name.replace(/\.\.\.$/, '').trim(),
      quantity: num(qtyTok),
      price: num(same[0]!),
      currency,
      valueIls: toMinor(num(valueIlsTok)),
      valueOrig: same[2] !== undefined ? num(same[2]) : currency === 'ILS' ? num(valueIlsTok) : null,
      costPrice: same[1] !== undefined && same[1] !== valueIlsTok ? num(same[1]) : null,
      dailyChangePct: pcts[0] ? num(pcts[0]) : null,
      fromCostPct: pcts[1] ? num(pcts[1]) : null,
    });
    i = j - 1;
  }
  return { positions, totalIls };
}

const HEBREW_CURRENCY: Array<[RegExp, string]> = [
  [/דולר ארה/, 'USD'],
  [/אירו|יורו/, 'EUR'],
  [/ליש|שטרלינג/, 'GBP'],
  [/פרנק שוו/, 'CHF'],
  [/ין יפני|יין/, 'JPY'],
  [/דולר קנד/, 'CAD'],
  [/דולר אוסטר/, 'AUD'],
];

/**
 * The foreign-currency page groups rows under "פרוט למטבע <name>"; a data row carries, tab separated, the action,
 * the account type, the exchange rate, the current balance, its ILS value, the cash balance and its ILS value.
 */
export function parseFibiFxText(text: string): { positions: HoldingRow[]; totalIls: number | null } {
  const positions: HoldingRow[] = [];
  let currency: string | null = null;
  let currencyName = '';
  let totalIls: number | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const head = line.match(/פרוט למטבע\s+(.+)$/);
    if (head) {
      currencyName = head[1]!.trim();
      currency = HEBREW_CURRENCY.find(([re]) => re.test(currencyName))?.[1] ?? currencyName;
      continue;
    }
    const tot = line.match(/סה"כ תיק לקוח\s*:?\s*בש"ח\s*([\d,]+(\.\d+)?)/);
    if (tot) {
      totalIls = toMinor(num(tot[1]!));
      continue;
    }
    if (!currency) continue;
    const cells = raw.split('\t').map((c) => c.trim()).filter(Boolean);
    if (cells.length < 5) continue;
    const nums = cells.slice(2).filter((c) => /^-?[\d,]+(\.\d+)?$/.test(c)).map(num);
    if (nums.length < 3) continue;
    const [rate, balance, valueIls] = nums as [number, number, number];
    positions.push({ kind: 'currency', symbol: currency, name: `${currencyName} · ${cells[1] ?? ''}`.trim(), quantity: balance, price: rate, currency, valueIls: toMinor(valueIls), valueOrig: balance, costPrice: null, dailyChangePct: null, fromCostPct: null });
  }
  return { positions, totalIls };
}

// --- Position view, step 1 (research_notes/proposals/position-view.md §4, recorded 2026-11-18) ---

/** One purchase lot from "מסים → עלות נומינלית לחישוב רווח הון". */
export interface CostLotRow {
  /** the bank's security number (public, not an account identifier) */
  paperId: string;
  /** the name as the page shows it (cut to ~15 characters by the bank) */
  name: string;
  action: 'buy' | 'split' | 'dividend' | 'other';
  /** the bank's wording, e.g. "קניה בבורסה" */
  actionText: string;
  quantity: number;
  /** nominal cost per unit in `currency`, purchase fee included */
  costPrice: number;
  /** the same cost per unit in shekels */
  costPriceIls: number;
  currency: string;
  /** YYYY-MM-DD */
  tradeDate: string;
  avgPrice: number | null;
  lastPrice: number | null;
  changePct: number | null;
}

const LOT_HEADER = /שם ני["״]ע\s*\tסוג פעולה/;
const LOT_ROW = /^\((\d{3,12})\)$/;
const decimal = (c: string | undefined): number | null => {
  const t = (c ?? '').replace(/,/g, '').trim();
  if (!t) return null;
  // the bank drops the leading zero: ".45"
  if (!/^-?(\d+(\.\d*)?|\.\d+)$/.test(t)) return Number.NaN;
  return Number(t);
};
const lotAction = (t: string): CostLotRow['action'] => (/קני/.test(t) ? 'buy' : /אחוד|פצול/.test(t) ? 'split' : /דיבידנד/.test(t) ? 'dividend' : 'other');

/**
 * The cost-lots page: after the header, each lot is a name line followed by a tab-separated row
 * "(paper id) · action · quantity · cost · cost in ₪ · currency · date · average · price · % change".
 * Fail-closed: `null` when the table header is missing or any row does not read cleanly, so a layout change never
 * stores half a portfolio. An empty table (no securities) is `{ lots: [] }`.
 */
export function parseFibiCostLotsText(text: string): { lots: CostLotRow[] } | null {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => LOT_HEADER.test(l));
  if (start < 0) return null;
  const lots: CostLotRow[] = [];
  let name = '';
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim();
    if (!line) continue;
    const cells = raw.split('\t').map((c) => c.trim());
    const id = cells[0]?.match(LOT_ROW);
    if (!id) {
      // a lone cell is the next lot's name; the header's own wrapped words come before the first lot and are dropped
      if (cells.length === 1) name = line;
      continue;
    }
    if (cells.length < 10 || !name) return null;
    const [, actionText, q, cost, costIls, currency, date, avg, price, pct] = cells as [string, string, string, string, string, string, string, string, string, string];
    const quantity = decimal(q);
    const costPrice = decimal(cost);
    const costPriceIls = decimal(costIls);
    const d = date.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    const rest = [decimal(avg), decimal(price), decimal(pct)];
    if (quantity === null || costPrice === null || costPriceIls === null || !d || !/^[A-Z]{3}$/.test(currency)) return null;
    if ([quantity, costPrice, costPriceIls, ...rest].some((n) => n !== null && Number.isNaN(n))) return null;
    lots.push({
      paperId: id[1]!,
      name,
      action: lotAction(actionText),
      actionText,
      quantity,
      costPrice,
      costPriceIls,
      currency,
      tradeDate: `${d[3]}-${d[2]}-${d[1]}`,
      avgPrice: rest[0] ?? null,
      lastPrice: rest[1] ?? null,
      changePct: rest[2] ?? null,
    });
    name = '';
  }
  return { lots };
}

/** The bank's tax-year summary ("מסים → פירוט אירועי מס"), realised results only; money in agorot. */
export interface TaxYearSummary {
  year: number;
  lossesIls: number;
  /** realised gains by tax rate (null = "אחוז אחר", another rate) */
  gains: Array<{ ratePct: number | null; amountIls: number }>;
  /** tax withheld by rate */
  taxWithheld: Array<{ ratePct: number | null; amountIls: number }>;
  /** not yet in the balances above */
  interestDividendIls: number | null;
  interestDividendTaxIls: number | null;
}

/**
 * The annual summary page shows one year at a time (the select's first option, the current year, by default):
 * label · securities column · (derivatives-only column). The securities column is read. Fail-closed like the lots.
 */
export function parseFibiTaxYearText(text: string): TaxYearSummary | null {
  const lines = text.split('\n').map((l) => l.trim());
  const year = lines.map((l) => l.match(/^שנת\s*-\s*(\d{4})$/)).find(Boolean);
  if (!year) return null;
  const first = (l: string): number | null => {
    const v = decimal(l.split('\t')[1]);
    return v === null || Number.isNaN(v) ? null : toMinor(v);
  };
  const rate = (l: string): number | null => {
    const m = l.match(/%\s*([\d.]+)/);
    return m ? Number(m[1]) : null;
  };
  let lossesIls: number | null = null;
  const gains: TaxYearSummary['gains'] = [];
  const taxWithheld: TaxYearSummary['taxWithheld'] = [];
  let interestDividendIls: number | null = null;
  let interestDividendTaxIls: number | null = null;
  for (const l of lines) {
    if (!l.includes('\t')) continue;
    const v = first(l);
    if (/^הפסדים\t/.test(l)) lossesIls = v;
    else if (/^רווחים /.test(l) && v !== null) gains.push({ ratePct: rate(l), amountIls: v });
    else if (/^מס שנוכה מריבית ודיבידנד\t/.test(l)) interestDividendTaxIls = v;
    else if (/^מס שנוכה /.test(l) && v !== null) taxWithheld.push({ ratePct: rate(l), amountIls: v });
    else if (/^הכנסות מריבית ודיבידנד\t/.test(l)) interestDividendIls = v;
  }
  if (lossesIls === null || !gains.length) return null;
  return { year: Number(year[1]), lossesIls, gains, taxWithheld, interestDividendIls, interestDividendTaxIls };
}

/**
 * The trade history page (תנועות בני"ע) shows nothing until it is given a range: its form takes dd/mm/yyyy dates
 * (#TrFrom / #TrTill, recorded 2026-11-18). How far back the bank allows is unknown, so the explore run asks for 10
 * years, then 3, then 1, and records what each answer looks like (position-view.md §7).
 */
export const FIBI_TRADE_RANGE_YEARS = [10, 3, 1] as const;

/** A date as the bank's form writes it: dd/mm/yyyy. `iso` is yyyy-mm-dd. */
export function fibiFormDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/** The ranges to try, newest last day first: each from the same day `years` back (Feb 29 falls to Feb 28) to `today`. */
export function fibiTradeRanges(today: string): Array<{ years: number; from: string; till: string }> {
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  return FIBI_TRADE_RANGE_YEARS.map((years) => {
    const last = new Date(Date.UTC(y - years, m, 0)).getUTCDate();
    const from = `${y - years}-${String(m).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
    return { years, from: fibiFormDate(from), till: fibiFormDate(today) };
  });
}
