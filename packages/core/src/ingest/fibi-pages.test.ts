import { describe, expect, it } from 'vitest';
import { parseFibiFxText, parseFibiPortfolioText } from './fibi-pages.js';

// shaped like the recorded page of 2026-11-10, with made-up papers and amounts
const PORTFOLIO = `תיק ני"ע
נכון ל:
10.11.2026 08:46
סה״כ
12,345.67₪
שינוי מצטבר מקניה
₪ 1,234.56
11.111%
נייר
\t
כמות
\t
שווי החזקה
מניות

ABCD
ALPHA BETA CORP - C...
\t
10
\t
$100.50
\t
+0.73%
\t12.34\t$80.00\t
+25.63%
\t
₪3,150.00
$1,005.00

XY
XYLO INC
\t
3
\t
$2.00
\t
-1.50%
\t0.10\t$5.00\t
-60.00%
\t
₪18.81
$6.00
 הכנסה לקבל:
$1.15 | 11/12/2026

TASE1
חברה ישראלית בע"מ
\t
7
\t
₪1,310.95
\t
+0.00%
\t0.00\t₪1,000.00\t
+31.10%
\t
₪9,176.65

סה״כ\t3\t₪12.44\t₪1,234.56\t₪12,345.67\t
סה״כ לנסחרים ב-$: $1,011.00
פעילים ביותר בתיק
בעליה
XYLO INC
XY
$ 2.00
-1.50%
התפלגות התיק שלי
מניות
₪12,345.67
100%
`;

const FX = `תיק מט"ח
סניף: 12
מספר חשבון:12345
פרוט למטבע דולר ארה"ב
פעולה\tסוג חשבון\tשער\tיתרה עדכנית\tשווי בש"ח\tיתרת מזומן\tשווי בש"ח
ק מ \t  155פמח עוש יחידים\t  3.1425\t  41.76\t  131.23\t  41.76\t  131.23
סה"כ עו"ש :בש"ח\t131.23
פרוט למטבע אירו
ק מ \t  155פמח עוש יחידים\t  3.6000\t  10.00\t  36.00\t  10.00\t  36.00
סה"כ תיק לקוח :בש"ח\t167.23
`;

describe('FIBI pages', () => {
  it('reads the securities portfolio: symbol, name, quantity, prices, changes and values', () => {
    const r = parseFibiPortfolioText(PORTFOLIO);
    expect(r.totalIls).toBe(1_234_567);
    expect(r.positions.map((p) => p.symbol)).toEqual(['ABCD', 'XY', 'TASE1']);
    expect(r.positions[0]).toMatchObject({ kind: 'security', name: 'ALPHA BETA CORP - C', quantity: 10, price: 100.5, currency: 'USD', valueIls: 315_000, valueOrig: 1005, costPrice: 80, dailyChangePct: 0.73, fromCostPct: 25.63 });
    // a note between positions ("הכנסה לקבל") does not break the next one
    expect(r.positions[1]).toMatchObject({ symbol: 'XY', quantity: 3, price: 2, valueIls: 1_881, fromCostPct: -60 });
    // a paper traded in shekels: ILS currency, value in both fields
    expect(r.positions[2]).toMatchObject({ symbol: 'TASE1', currency: 'ILS', quantity: 7, price: 1310.95, costPrice: 1000, valueIls: 917_665, valueOrig: 9176.65 });
    // the page footer (totals, most active, distribution) never leaks into the last position
    expect(r.positions).toHaveLength(3);
  });

  it('reads the foreign-currency portfolio: one row per currency with rate, balance and shekel value', () => {
    const r = parseFibiFxText(FX);
    expect(r.totalIls).toBe(16_723);
    expect(r.positions).toHaveLength(2);
    expect(r.positions[0]).toMatchObject({ kind: 'currency', symbol: 'USD', currency: 'USD', quantity: 41.76, price: 3.1425, valueIls: 13_123, valueOrig: 41.76 });
    expect(r.positions[1]).toMatchObject({ symbol: 'EUR', quantity: 10, price: 3.6, valueIls: 3_600 });
  });

  it('is quiet on unrelated text', () => {
    expect(parseFibiPortfolioText('דלג לתפריט הנגישות\n012-345')).toEqual({ positions: [], totalIls: null });
    expect(parseFibiFxText('nothing here')).toEqual({ positions: [], totalIls: null });
  });
});
