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
