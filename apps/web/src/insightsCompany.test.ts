import { describe, expect, it, vi } from 'vitest';
import type { Key } from './i18n';
import { basisCaption, companyUnavailableReason, compactNumber, figureCurrency, filingText, noteText, periodLabel, placeNotes, itemTitle, latestSecDate, marginTrend, numericDate, openSecLink, ratioText, secLink } from './insightsCompany';
import type { InsightFigure } from './types';

const t = (k: Key, vars?: Record<string, string | number>) => (vars ? `${k}(${Object.entries(vars).map(([a, b]) => `${a}=${b}`).join(',')})` : k);
/** a t that knows the unit words, like the real dictionaries */
const units: Partial<Record<Key, string>> = { ins_k: 'K', ins_m: 'M', ins_b: 'B', ins_t: 'T' };
const unitsHe: Partial<Record<Key, string>> = { ins_k: 'אלף', ins_m: 'מיליון', ins_b: 'מיליארד', ins_t: 'טריליון' };
const tEn = (k: Key) => units[k] ?? k;
const tHe = (k: Key) => unitsHe[k] ?? k;
const iso = (s: string) => `⁦${s}⁩`;

const fig = (over: Partial<InsightFigure> = {}): InsightFigure => ({ value: 1, unit: 'USD', periodEnd: '2026-09-30', basis: 'ttm', form: '10-Q', filed: '2026-10-31', accn: '0000320193-26-000100', ...over });

describe('compactNumber', () => {
  it('English: one decimal and a unit letter', () => {
    expect(compactNumber(tEn, 'en', 394_328_000_000, 'USD')).toBe('$394.3B');
    expect(compactNumber(tEn, 'en', 1_234_567, 'USD')).toBe('$1.2M');
    expect(compactNumber(tEn, 'en', 850_000, 'USD')).toBe('$850.0K');
    expect(compactNumber(tEn, 'en', 2.5e12, 'USD')).toBe('$2.5T');
    expect(compactNumber(tEn, 'en', 15_204_000_000)).toBe('15.2B');
  });
  it('a real minus for losses', () => {
    expect(compactNumber(tEn, 'en', -1_200_000_000, 'USD')).toBe('−$1.2B');
  });
  it('rounding up to 1000 moves to the next unit', () => {
    expect(compactNumber(tEn, 'en', 999_960_000, 'USD')).toBe('$1.0B');
    expect(compactNumber(tEn, 'en', 999_940_000, 'USD')).toBe('$999.9M');
  });
  it('small numbers as they are', () => {
    expect(compactNumber(tEn, 'en', 512.5, 'USD')).toBe('$512.5');
    expect(compactNumber(tEn, 'en', 0)).toBe('0');
  });
  it('Hebrew: the number isolated left-to-right, the unit as a word', () => {
    expect(compactNumber(tHe, 'he', 394_328_000_000, 'USD')).toBe(`${iso('$394.3')} מיליארד`);
    expect(compactNumber(tHe, 'he', -1_200_000, 'USD')).toBe(`${iso('−$1.2')} מיליון`);
    expect(compactNumber(tHe, 'he', 12, 'USD')).toBe(iso('$12'));
  });
  it('unknown currency uses the code; null is a dash', () => {
    expect(compactNumber(tEn, 'en', 3e9, 'CHF')).toBe('CHF 3.0B');
    expect(compactNumber(tEn, 'en', null, 'USD')).toBe('–');
    expect(compactNumber(tEn, 'en', Number.NaN)).toBe('–');
  });
});

describe('basisCaption', () => {
  it('12 months with the filing', () => {
    expect(basisCaption(t, fig())).toBe('ins_basis_ttm(d=30.9.2026) · ins_basis_filed(f=10-Q,d=31.10.2026)');
  });
  it('annual, instant and derived', () => {
    expect(basisCaption(t, fig({ basis: 'annual', periodEnd: '2025-12-31', form: '10-K', filed: '2026-02-20' }))).toBe('ins_basis_annual(d=31.12.2025) · ins_basis_filed(f=10-K,d=20.2.2026)');
    expect(basisCaption(t, fig({ basis: 'instant' }))).toBe('ins_basis_instant(d=30.9.2026) · ins_basis_filed(f=10-Q,d=31.10.2026)');
    expect(basisCaption(t, fig({ basis: 'derived', form: null, filed: null }))).toBe('ins_basis_derived(d=30.9.2026)');
    expect(basisCaption(t, fig({ basis: 'derived', periodEnd: null, form: null, filed: null }))).toBe('ins_basis_derived_nodate');
  });
  it('missing parts are left out; null figure → null', () => {
    expect(basisCaption(t, fig({ periodEnd: null, filed: null }))).toBe('10-Q');
    expect(basisCaption(t, fig({ periodEnd: null, form: null, filed: null }))).toBeNull();
    expect(basisCaption(t, null)).toBeNull();
  });
  it('numericDate', () => {
    expect(numericDate('2026-01-05')).toBe('5.1.2026');
    expect(numericDate('2026-10-31T00:00:00Z')).toBe('31.10.2026');
    expect(numericDate('soon')).toBe('soon');
    expect(numericDate(null)).toBe('');
  });
});

describe('marginTrend', () => {
  it('up, down, flat within half a point', () => {
    expect(marginTrend(24.3, 21)).toBe('up');
    expect(marginTrend(18, 21)).toBe('down');
    expect(marginTrend(21.3, 21)).toBe('flat');
    expect(marginTrend(-5, -2)).toBe('down');
  });
  it('null when either side is missing', () => {
    expect(marginTrend(null, 21)).toBeNull();
    expect(marginTrend(21, undefined)).toBeNull();
  });
  it('ratioText', () => {
    expect(ratioText(28.444, 1)).toBe('28.4');
    expect(ratioText(1.5234)).toBe('1.52');
    expect(ratioText(-0.4)).toBe('−0.40');
    expect(ratioText(null)).toBe('–');
  });
});

describe('SEC link guard', () => {
  it('accepts SEC archive links', () => {
    const u = 'https://www.sec.gov/Archives/edgar/data/320193/000032019326000100/aapl-20260930.htm';
    expect(secLink(u)).toBe(u);
  });
  it('refuses everything else', () => {
    for (const bad of [
      'http://www.sec.gov/Archives/x.htm',
      'https://sec.gov/Archives/x.htm',
      'https://www.sec.gov.evil.com/x',
      'https://www.sec.gov@evil.com/x',
      'https://www.sec.gov:8443/x',
      'https://user:pw@www.sec.gov/x',
      'https://www.sec.gov',
      'javascript:alert(1)//https://www.sec.gov/',
      ' https://www.sec.gov/x',
      'https://www.sec.gov/\\@evil.com',
      'https://www.sec.gov/a b',
      'https://www.sec.gov/א',
      'https://www.sec.gov:443/x',
      'HTTPS://WWW.SEC.GOV/x',
      `https://www.sec.gov/${'a'.repeat(3000)}`,
      'https://data.sec.gov/x',
      42,
      null,
    ]) {
      expect(secLink(bad), String(bad)).toBeNull();
    }
  });
  it('openSecLink opens only safe links', () => {
    const open = vi.fn();
    expect(openSecLink('https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=320193', open)).toBe(true);
    expect(open).toHaveBeenCalledWith('https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=320193');
    expect(openSecLink('https://evil.example/', open)).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe('filings', () => {
  it('8-K items become titles; unknown numbers stay numbered', () => {
    expect(itemTitle(t, '2.02')).toBe('ins_8k_2_02');
    expect(itemTitle(t, 'Item 5.02')).toBe('ins_8k_5_02');
    expect(itemTitle(t, '6.03')).toBe('ins_8k_6_03');
    expect(itemTitle(t, '1.04')).toBe('ins_8k_1_04');
    expect(itemTitle(t, '6.10')).toBe('ins_8k_item(n=6.10)');
  });
  it('the hub form "<code> <English title>": known codes translated, unknown keep the title', () => {
    expect(itemTitle(t, '2.02 Results of operations')).toBe('ins_8k_2_02');
    expect(itemTitle(t, '5.02 Departure of Directors or Certain Officers')).toBe('ins_8k_5_02');
    expect(itemTitle(t, '6.10 Alternative Filings of Asset-Backed Issuers')).toBe('Alternative Filings of Asset-Backed Issuers');
    expect(itemTitle(t, '12.34')).toBe('ins_8k_item(n=12.34)');
    expect(itemTitle(t, 'Results only')).toBe('Results only');
    expect(filingText(t, { form: '8-K', title: null, items: ['2.02 Results of operations', '9.01 Financial Statements and Exhibits'] })).toBe('ins_8k_2_02');
  });
  it('figureCurrency: the unit first, then the company, then USD', () => {
    expect(figureCurrency({ unit: 'EUR' }, 'USD')).toBe('EUR');
    expect(figureCurrency({ unit: 'USD/shares' }, null)).toBe('USD');
    expect(figureCurrency({ unit: 'EUR/shares' }, null)).toBe('EUR');
    expect(figureCurrency({ unit: 'shares' }, 'JPY')).toBe('JPY');
    expect(figureCurrency({ unit: 'ratio' }, null)).toBe('USD');
    expect(figureCurrency(null, 'eur')).toBe('USD');
  });
  it('drops the exhibits item when others are present', () => {
    expect(filingText(t, { form: '8-K', title: null, items: ['2.02', '9.01'] })).toBe('ins_8k_2_02');
    expect(filingText(t, { form: '8-K', title: null, items: ['9.01'] })).toBe('ins_8k_9_01');
    expect(filingText(t, { form: '8-K', title: null, items: ['5.02', '7.01', '9.01'] })).toBe('ins_8k_5_02 · ins_8k_7_01');
  });
  it('title, then the form name, then nothing', () => {
    expect(filingText(t, { form: '10-Q', title: 'Quarterly report for Q3', items: [] })).toBe('Quarterly report for Q3');
    expect(filingText(t, { form: '10-Q', title: null, items: [] })).toBe('ins_form_10q');
    expect(filingText(t, { form: '10-K/A', title: ' ', items: [] })).toBe('ins_form_10k');
    expect(filingText(t, { form: 'SC 13G', title: null, items: [] })).toBeNull();
  });
  it('companyUnavailableReason', () => {
    expect(companyUnavailableReason(t, 'not_covered')).toBe('ins_co_unav_not_covered');
    expect(companyUnavailableReason(t, 'busy')).toBe('ins_co_unav_busy');
    expect(companyUnavailableReason(t, 'toString')).toBeNull();
    expect(companyUnavailableReason(t, undefined)).toBeNull();
  });
  it('latestSecDate: newest figure filing, else newest listed filing', () => {
    const figures = { revenueTtm: fig({ filed: '2026-10-31' }), cash: fig({ filed: '2026-08-01' }), pe: null } as never;
    expect(latestSecDate({ company: { figures } as never, filings: [{ form: '8-K', filed: '2026-11-05', reportDate: null, title: null, items: [], url: '' }] })).toBe('2026-10-31');
    expect(latestSecDate({ company: null, filings: [{ form: '8-K', filed: '2026-11-05', reportDate: null, title: null, items: [], url: '' }] })).toBe('2026-11-05');
    expect(latestSecDate({ company: null, filings: [] })).toBeNull();
    expect(latestSecDate(undefined)).toBeNull();
  });
});

describe('labels and notes', () => {
  it('periodLabel names the period by basis', () => {
    expect(periodLabel(t, 'Revenue', 'ttm')).toBe('Revenue ins_co_p_ttm');
    expect(periodLabel(t, 'Revenue', 'annual')).toBe('Revenue ins_co_p_annual');
    expect(periodLabel(t, 'Revenue', 'derived')).toBe('Revenue');
    expect(periodLabel(t, 'Revenue', null)).toBe('Revenue');
  });
  it('noteText translates known codes and falls back to the English text', () => {
    for (const c of ['no_xbrl', 'q4_derived', 'split_adjusted', 'eps_inconsistent', 'adr_no_pe', 'bank_debt_ratio', 'filings_unavailable']) {
      expect(noteText(t, { code: c, text: 'x' })).toEqual({ text: `ins_note_${c}`, raw: false });
    }
    expect(noteText(t, { code: 'new_code', text: 'Something new.' })).toEqual({ text: 'Something new.', raw: true });
    expect(noteText(t, { code: 'toString', text: '' })).toEqual({ text: 'toString', raw: true });
  });
  it('placeNotes: under the shown row, else the bottom; method codes behind the toggle', () => {
    const notes = [
      { code: 'split_adjusted', figure: null, text: '' },
      { code: 'eps_inconsistent', figure: 'epsTtm', text: '' },
      { code: 'prior_zero', figure: 'revenueYoYPct', text: '' },
      { code: 'prior_zero', figure: 'revenueYoYPct', text: '' },
      { code: 'no_prior_period', figure: 'netMarginPct3yAgo', text: '' },
      { code: 'q4_derived', figure: 'revenueTtm', text: '' },
      { code: 'excludes_leases', figure: 'totalDebt', text: '' },
      { code: '', figure: null, text: 'empty code' },
      'old string note',
      null,
    ];
    const p = placeNotes(notes, ['rev', 'margin', 'debt']);
    expect(p.byRow.rev?.map((n) => n.code)).toEqual(['prior_zero']);
    expect(p.byRow.margin?.map((n) => n.code)).toEqual(['no_prior_period']);
    expect(p.byRow.debt).toBeUndefined();
    expect(p.bottom.map((n) => `${n.code}:${n.figure}`)).toEqual(['split_adjusted:null', 'eps_inconsistent:epsTtm']);
    expect(p.method.map((n) => n.code)).toEqual(['q4_derived', 'excludes_leases']);
    expect(placeNotes(undefined, [])).toEqual({ byRow: {}, bottom: [], method: [] });
  });
});
