import { describe, expect, it } from 'vitest';
import { fibiEarliestTradeDate, fibiFormDate, fibiTradeRanges, parseFibiCostLotsText, parseFibiTaxYearText } from './fibi-pages.js';

// shaped like the pages recorded on 2026-11-18, with made-up papers, numbers and amounts
const LOTS = [
  'עלות נומינלית לחישוב רווח הון',
  'סניף: 00',
  'מספר חשבון:000000',
  'על כל לקוח לבדוק את הנתונים המלאים, כנדרש בהוראות המס.',
  'שם ני"ע\tסוג פעולה\tכמות\tשער',
  'עלות',
  'למס\tשער',
  'עלות',
  'למס',
  'בש"ח\tמטבע\tתאריך',
  'ביצוע',
  'הפעולה\tשער',
  'נייר',
  'ממוצע\tמחיר',
  '/שער\t% שינוי',
  'נומינלי',
  'משער',
  'עלות',
  'למס',
  'ACME',
  '(11111)\tקניה בבורסה\t10.00\t20.50\t75.10\tUSD\t03/02/2025\t\t.45\t-97.80',
  'WIDGET HOLDINGS',
  '(22222222)\tקניה בבורסה\t4.00\t150.00\t540.00\tUSD\t01/07/2024\t\t1,210.00\t706.67',
  'WIDGET HOLDINGS',
  '(22222222)\tאחוד/פצול הון מקבל\t2.00\t0.00\t0.00\tUSD\t15/09/2024\t\t1,210.00\t',
  'EXAMPLE FIN',
  '(33333333)\tדיבידנד ע,מתקבל\t1.00\t5.00\t18.00\tUSD\t20/10/2025\t\t4.00\t-20.00',
  "מט''ח",
  'תל אביב',
  'ת"א-35\t2,000.00\t-0.50 %',
].join('\n');

const TAX = [
  'פירוט אירועי מס - סיכום שנתי',
  'שנת - 2026',
  'שנת - 2025',
  'שנת - 2024',
  '\tפירוט לני"ע ונגזרים פיננסיים\tפירוט לעסקות נגזרים פיננסיים בלבד',
  'הפסדים\t-123.45',
  'רווחים % 25.00\t0.00',
  'רווחים % 15.00\t10.00',
  'רווחים אחוז אחר\t0.00',
  'מס שנוכה % 25.00\t0.00',
  'מס שנוכה % 15.00\t1.50',
  'מס שנוכה אחוז אחר\t0.00',
  'נתונים שטרם נכללו ביתרות הנ"ל',
  'הכנסות מריבית ודיבידנד\t2.00',
  'מס שנוכה מריבית ודיבידנד\t0.50',
].join('\n');

describe('FIBI cost lots page', () => {
  it('reads every lot with its date, cost and kind', () => {
    const r = parseFibiCostLotsText(LOTS);
    expect(r?.lots).toHaveLength(4);
    expect(r?.lots[0]).toEqual({ paperId: '11111', name: 'ACME', action: 'buy', actionText: 'קניה בבורסה', quantity: 10, costPrice: 20.5, costPriceIls: 75.1, currency: 'USD', tradeDate: '2025-02-03', avgPrice: null, lastPrice: 0.45, changePct: -97.8 });
    expect(r?.lots[1]).toMatchObject({ paperId: '22222222', name: 'WIDGET HOLDINGS', quantity: 4, lastPrice: 1210, tradeDate: '2024-07-01' });
    expect(r?.lots[2]).toMatchObject({ action: 'split', quantity: 2, changePct: null });
    expect(r?.lots[3]).toMatchObject({ action: 'dividend', name: 'EXAMPLE FIN' });
  });

  it('fails closed on a changed layout, and is empty for an empty table', () => {
    expect(parseFibiCostLotsText('nothing here')).toBeNull();
    expect(parseFibiCostLotsText(LOTS.replace('03/02/2025', '2025-02-03'))).toBeNull();
    expect(parseFibiCostLotsText(LOTS.replace('\t20.50\t', '\tabc\t'))).toBeNull();
    expect(parseFibiCostLotsText(LOTS.replace('\tUSD\t03', '\t$\t03'))).toBeNull();
    expect(parseFibiCostLotsText('שם ני"ע\tסוג פעולה\tכמות\nעלות')).toEqual({ lots: [] });
  });
});

describe('FIBI tax-year summary page', () => {
  it('reads the shown year: losses, gains and tax by rate, interest and dividends', () => {
    expect(parseFibiTaxYearText(TAX)).toEqual({
      year: 2026,
      lossesIls: -12345,
      gains: [
        { ratePct: 25, amountIls: 0 },
        { ratePct: 15, amountIls: 1000 },
        { ratePct: null, amountIls: 0 },
      ],
      taxWithheld: [
        { ratePct: 25, amountIls: 0 },
        { ratePct: 15, amountIls: 150 },
        { ratePct: null, amountIls: 0 },
      ],
      interestDividendIls: 200,
      interestDividendTaxIls: 50,
    });
  });

  it('fails closed without the year or the losses line', () => {
    expect(parseFibiTaxYearText(TAX.replace(/שנת - \d{4}/g, ''))).toBeNull();
    expect(parseFibiTaxYearText(TAX.replace('הפסדים\t-123.45', ''))).toBeNull();
  });
});

describe('trade history ranges (explore run)', () => {
  it('writes dates the way the bank form does and steps back 10 and 1 years', () => {
    expect(fibiFormDate('2026-11-21')).toBe('21/11/2026');
    expect(fibiTradeRanges('2026-11-21')).toEqual([
      { years: 10, from: '21/11/2016', till: '21/11/2026' },
      { years: 1, from: '21/11/2025', till: '21/11/2026' },
    ]);
  });

  it("reads the earliest date from the bank's refusal, in either order", () => {
    expect(fibiEarliestTradeDate('תנועות בני"ע\n01/01/2024   ניתן להציג תנועות רק מתאריך   ')).toBe('01/01/2024');
    expect(fibiEarliestTradeDate('ניתן להציג תנועות רק מתאריך 02/03/2024')).toBe('02/03/2024');
    expect(fibiEarliestTradeDate('פירוט תנועות לכל ניירות הערך 05/05/2026')).toBeNull();
  });

  it('a leap day falls back to the 28th in a year without one', () => {
    expect(fibiTradeRanges('2028-02-29').map((r) => r.from)).toEqual(['28/02/2018', '28/02/2027']);
  });
});
