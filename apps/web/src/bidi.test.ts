import { describe, expect, it } from 'vitest';
import { bidiRuns, isHebrewText } from './bidi';

/** The LTR runs only. */
const ltr = (s: string) => bidiRuns(s).filter((r) => r.ltr).map((r) => r.text);

describe('bidiRuns', () => {
  it('joins back to exactly the same text (nothing inserted)', () => {
    for (const s of ['הוצאת ₪1,234 ב-ELECTRO DEMO ב-2026-09-22.', 'סה״כ 1,234 ש״ח', '', 'רק עברית', 'abc', '2026-01..2026-10 (12 חודשים)\nשורה שנייה']) {
      expect(bidiRuns(s).map((r) => r.text).join('')).toBe(s);
    }
    expect(bidiRuns('')).toEqual([]);
  });

  it('amounts, dates, ranges and percentages are single runs, without the sentence punctuation', () => {
    expect(ltr('הוצאת ₪1,234.50 החודש.')).toEqual(['₪1,234.50']);
    expect(ltr('סה״כ 1,234 ש״ח, כלומר 26.7%.')).toEqual(['1,234', '26.7%']);
    expect(ltr('התשלום הבא ב-2026-09-22, בסך 830 ₪.')).toEqual(['2026-09-22', '830 ₪']);
    expect(ltr('בין 2026-01..2026-10 הממוצע')).toEqual(['2026-01..2026-10']);
    expect(ltr('ב-15/11 וב-20.11')).toEqual(['15/11', '20.11']);
    // a minus is a sign only when it does not follow a letter
    expect(ltr('יתרה -500 ₪')).toEqual(['-500 ₪']);
    expect(ltr('ב-500')).toEqual(['500']);
  });

  it('Latin names stay one run across spaces; Hebrew ends the run', () => {
    expect(ltr('הקנייה ב-ELECTRO DEMO עלתה 1,200 ₪')).toEqual(['ELECTRO DEMO', '1,200 ₪']);
    expect(ltr('המודל gpt-5-mini ענה')).toEqual(['gpt-5-mini']);
    expect(ltr("McDonald's: 45 ₪")).toEqual(["McDonald's", '45 ₪']);
  });

  it('a name and its amount, or a date and an amount, stay separate runs (one run would swap them in RTL)', () => {
    expect(ltr('Wolt 120 ₪, Ten Bis 80 ₪')).toEqual(['Wolt', '120 ₪', 'Ten Bis', '80 ₪']);
    expect(ltr('ב-2026-09 1,200 ₪')).toEqual(['2026-09', '1,200 ₪']);
    expect(ltr('סה״כ ₪ 1,234')).toEqual(['₪ 1,234']);
  });

  it('a lone ₪ or % is not a run of its own', () => {
    expect(ltr('הסכום ב-₪ בלבד')).toEqual([]);
  });

  it('marks the runs in order with the text between them', () => {
    expect(bidiRuns('א 12 ב')).toEqual([
      { text: 'א ', ltr: false },
      { text: '12', ltr: true },
      { text: ' ב', ltr: false },
    ]);
  });
});

describe('isHebrewText', () => {
  it('follows the first strong character', () => {
    expect(isHebrewText('₪1,200 הוצאת על דלק')).toBe(true);
    expect(isHebrewText('Wolt היה הכי יקר')).toBe(false);
    expect(isHebrewText('1,200')).toBe(false);
    expect(isHebrewText('')).toBe(false);
  });
});
