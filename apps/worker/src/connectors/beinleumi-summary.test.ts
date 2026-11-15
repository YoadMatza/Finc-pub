import { describe, expect, it } from 'vitest';
import { parseBeinleumiSummary } from './scrape.js';

// The shape of FIBI's post-login summary page (innerText), with made-up numbers.
const SAMPLE = `החשבון שלי
יתרת עו״ש עדכנית
12,345.67
₪
שערוך עו״ש מט״ח
1,111.11
₪
תנועות אחרונות
כרטיסי אשראי
סך החיובים הבאים:
בש"ח
2,222.22
₪
ניירות ערך ופיקדונות
סה״כ השקעות
20,000.50
₪
שערוך ני"ע סחיר
20,000.50
₪
משהו חדש`;

describe('FIBI summary page', () => {
  it('reads the foreign-currency valuation and the investments total in agorot', () => {
    expect(parseBeinleumiSummary(SAMPLE)).toEqual({ fxIls: 111111, investmentsIls: 2000050, securitiesIls: 2000050, checkingIls: 1234567 });
  });
  it('tolerates missing blocks and odd quotes', () => {
    expect(parseBeinleumiSummary('שערוך עו"ש מט"ח\n-12.50\n₪')).toEqual({ fxIls: -1250 });
    expect(parseBeinleumiSummary('nothing here')).toEqual({});
  });
});
