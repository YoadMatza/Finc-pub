import { describe, expect, it } from 'vitest';
import golden from './__fixtures__/orchard-companyfacts.json' with { type: 'json' };
import googl from './__fixtures__/sec-googl-2025-08-01.json' with { type: 'json' };
import nvda from './__fixtures__/sec-nvda-2024-09-01.json' with { type: 'json' };
import { type CompanyFacts, type SecFact, trimCompanyFacts } from './sec.js';
import { buildCompany, chooseConcept, dedupe, flowNear, flowSeries, instantSeries, latestFlow, moneyUnit, totalDebtAt, ttmAt } from './company.js';

// Fictional companies and numbers throughout. The golden fixture (Orchard Devices Inc., CIK 9999001) mirrors the
// structure of a large US filer's companyfacts: 52/53-week fiscal years ending in late September, 10-Qs with
// prior-year comparatives and year-to-date facts, 10-Ks with three years and no Q4, a 10-Q/A, dei share counts.

const CIK = '0009999001';
const INFO = { cik: CIK, name: 'Orchard Devices Inc.', sic: '3571', sicDescription: 'Electronic Computers' };
const M = 1_000_000;
let n = 0;
const accn = () => `0009999001-26-${String(++n).padStart(6, '0')}`;
const f = (start: string | null, end: string, val: number, o: Partial<SecFact> = {}): SecFact => ({ ...(start ? { start } : {}), end, val, form: '10-Q', filed: '2026-01-01', accn: accn(), ...o });
const cf = (concepts: CompanyFacts['concepts']): CompanyFacts => ({ cik: CIK, entityName: 'Test Co', concepts });

/** calendar quarters: [start, end] for a year */
const Q = (y: number): Array<[string, string]> => [
  [`${y}-01-01`, `${y}-03-31`],
  [`${y}-04-01`, `${y}-06-30`],
  [`${y}-07-01`, `${y}-09-30`],
  [`${y}-10-01`, `${y}-12-31`],
];
const quarterFacts = (y: number, vals: number[], o: Partial<SecFact> = {}): SecFact[] => vals.map((v, i) => f(Q(y)[i]![0], Q(y)[i]![1], v, { filed: `${y + (i === 3 ? 1 : 0)}-${['05', '08', '11', '02'][i]}-01`, ...o }));
const fy = (y: number, v: number, o: Partial<SecFact> = {}): SecFact => f(`${y}-01-01`, `${y}-12-31`, v, { form: '10-K', filed: `${y + 1}-02-15`, ...o });

describe('golden: a fictional large filer (52/53-week years, comparatives, YTD facts, an amendment)', () => {
  const trimmed = trimCompanyFacts(golden, CIK)!;
  const out = buildCompany(INFO, trimmed, { price: 71, currency: 'USD' });
  const F = out.figures;

  it('TTM revenue, net income and growth, with the 10-K that completes the year', () => {
    expect(out.currency).toBe('USD');
    expect(F.revenueTtm).toEqual({ value: 4400 * M, unit: 'USD', periodEnd: '2026-09-26', basis: 'ttm', form: '10-K', filed: '2026-10-31', accn: '0009999001-26-000024' });
    expect(F.revenueYoYPct).toMatchObject({ value: 10, unit: '%', periodEnd: '2026-09-26', basis: 'ttm' });
    expect(F.netIncomeTtm).toMatchObject({ value: 880 * M, unit: 'USD', basis: 'ttm' });
    expect(F.netIncomeYoYPct?.value).toBe(15.8); // 880 vs 760
  });

  it('net margin now, a year and 3 years earlier (a 53-week year with a 14-week Q1 included)', () => {
    expect(F.netMarginPct).toMatchObject({ value: 20, unit: '%', periodEnd: '2026-09-26' });
    expect(F.netMarginPct1yAgo).toMatchObject({ value: 19, periodEnd: '2025-09-27' });
    expect(F.netMarginPct3yAgo).toMatchObject({ value: 20, periodEnd: '2023-09-30' });
  });

  it('EPS TTM and P/E against the given close', () => {
    expect(F.epsTtm).toMatchObject({ value: 3.55, unit: 'USD/shares', basis: 'ttm', form: '10-K' });
    expect(F.pe).toMatchObject({ value: 20, unit: 'x', basis: 'derived', periodEnd: '2026-09-26' });
  });

  it('balance sheet: cash, total debt (rule b: noncurrent + current + commercial paper), debt/equity', () => {
    expect(F.cash).toEqual({ value: 1500 * M, unit: 'USD', periodEnd: '2026-09-26', basis: 'instant', form: '10-K', filed: '2026-10-31', accn: '0009999001-26-000024' });
    expect(F.totalDebt).toMatchObject({ value: 2500 * M, periodEnd: '2026-09-26', basis: 'instant' });
    expect(F.debtToEquity).toMatchObject({ value: 0.5, unit: 'ratio' });
  });

  it('shares outstanding from the cover page and the change over a year', () => {
    expect(F.sharesOutstanding).toMatchObject({ value: 247 * M, unit: 'shares', periodEnd: '2026-10-17', form: '10-K' });
    expect(F.sharesChange1yPct?.value).toBe(-1.2); // 247 vs 250 million
  });

  it('notes the derived Q4; trims to the concepts used and to 6 years; ignores 8-K facts', () => {
    expect(out.notes).toContainEqual(expect.objectContaining({ code: 'q4_derived', figure: 'revenueTtm' }));
    expect(out.notes).toContainEqual(expect.objectContaining({ code: 'excludes_leases', figure: 'totalDebt' }));
    expect(Object.keys(trimmed.concepts)).not.toContain('us-gaap:AccountsPayableCurrent');
    const all = Object.values(trimmed.concepts).flatMap((u) => Object.values(u).flat());
    expect(all.every((x) => x.end >= '2020-09-26')).toBe(true); // 6 years before the newest revenue period
    expect(all.some((x) => x.form === '8-K')).toBe(false);
    expect(Object.entries(F).every(([k, x]) => k === 'financeLeases' || x !== null)).toBe(true);
  });
});

describe('concept choice', () => {
  it('the concept filed most recently wins over an earlier candidate; ties go to the candidate order', () => {
    const c = cf({
      'us-gaap:Revenues': { USD: [fy(2022, 100, { filed: '2023-02-01' })] },
      'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax': { USD: [fy(2024, 300, { filed: '2025-02-01' })] },
      'us-gaap:SalesRevenueNet': { USD: [fy(2024, 999, { filed: '2025-02-01' })] },
    });
    const unit = (u: Record<string, SecFact[]>) => moneyUnit(u, 'USD', 'flow');
    expect(chooseConcept(c, ['us-gaap:Revenues', 'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax', 'us-gaap:SalesRevenueNet'], unit, 'flow')?.concept).toBe('us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax');
    expect(chooseConcept(c, ['us-gaap:SalesRevenueNet', 'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax'], unit, 'flow')?.concept).toBe('us-gaap:SalesRevenueNet');
  });

  it('only quarter or year durations count (a newer 9-month fact does not make a concept current)', () => {
    const c = cf({
      'us-gaap:Revenues': { USD: [f('2025-01-01', '2025-09-30', 5, { filed: '2025-11-01' })] },
      'us-gaap:SalesRevenueNet': { USD: [fy(2024, 7, { filed: '2025-02-01' })] },
    });
    expect(chooseConcept(c, ['us-gaap:Revenues', 'us-gaap:SalesRevenueNet'], (u) => moneyUnit(u, 'USD', 'flow'), 'flow')?.concept).toBe('us-gaap:SalesRevenueNet');
  });

  it('IFRS fallbacks when no us-gaap concept exists', () => {
    const c = cf({ 'ifrs-full:Revenue': { USD: [...quarterFacts(2025, [10, 10, 10, 10])] }, 'ifrs-full:ProfitLossAttributableToOwnersOfParent': { USD: quarterFacts(2025, [1, 1, 1, 1]) } });
    const out = buildCompany(INFO, c, { price: null, currency: 'USD' });
    expect(out.figures.revenueTtm?.value).toBe(40);
    expect(out.figures.netMarginPct?.value).toBe(10);
  });
});

describe('periods', () => {
  it('dedupe: the latest filing of a (start, end) wins (amendments, later comparatives)', () => {
    const a = f('2025-01-01', '2025-03-31', 100, { filed: '2025-05-01' });
    const b = f('2025-01-01', '2025-03-31', 105, { filed: '2025-06-10', form: '10-Q/A' });
    const c = f('2025-01-01', '2025-03-31', 100, { filed: '2025-04-30' });
    expect(dedupe([a, b, c]).map((x) => x.val)).toEqual([105]);
    const s = flowSeries([a, b, c, ...quarterFacts(2025, [0, 10, 10, 10]).slice(1)]);
    expect(ttmAt(s.quarters, 3)?.value).toBe(135);
  });

  it('derives Q4 = FY − (Q1+Q2+Q3) only when all three quarters chain from the year start', () => {
    const s = flowSeries([...quarterFacts(2025, [10, 20, 30]), fy(2025, 100)]);
    expect(s.quarters.map((q) => [q.end, q.val, q.derived])).toEqual([
      ['2025-03-31', 10, false],
      ['2025-06-30', 20, false],
      ['2025-09-30', 30, false],
      ['2025-12-31', 40, true],
    ]);
    expect(flowSeries([...quarterFacts(2025, [10, 20, 30]).filter((_, i) => i !== 1), fy(2025, 100)]).quarters.some((q) => q.derived)).toBe(false);
    // a reported Q4 is not replaced
    const r = flowSeries([...quarterFacts(2025, [10, 20, 30, 45]), fy(2025, 100)]);
    expect(r.quarters.at(-1)).toMatchObject({ val: 45, derived: false });
  });

  it('ignores 6- and 9-month year-to-date facts', () => {
    const s = flowSeries([...quarterFacts(2025, [10, 20, 30]), f('2025-01-01', '2025-06-30', 30), f('2025-01-01', '2025-09-30', 60)]);
    expect(s.quarters).toHaveLength(3);
    expect(s.annuals).toHaveLength(0);
  });

  it('TTM needs 4 consecutive quarters; otherwise the latest fiscal year, labelled annual', () => {
    const full = flowSeries([...quarterFacts(2024, [1, 2, 3, 4]), ...quarterFacts(2025, [5, 6, 7])]);
    expect(latestFlow(full)).toMatchObject({ value: 4 + 5 + 6 + 7, end: '2025-09-30', basis: 'ttm' });
    const gap = flowSeries([...quarterFacts(2024, [1, 2, 3]), ...quarterFacts(2025, [5, 6, 7]).slice(1), fy(2024, 50)]);
    expect(ttmAt(gap.quarters, gap.quarters.length - 1)).toBeNull();
    expect(latestFlow(gap)).toMatchObject({ value: 50, end: '2024-12-31', basis: 'annual' });
    expect(latestFlow(flowSeries([fy(2023, 40), fy(2024, 50)]))).toMatchObject({ value: 50, basis: 'annual' });
    // a fiscal year newer than the last quarter wins
    expect(latestFlow(flowSeries([...quarterFacts(2023, [1, 1, 1, 1]), fy(2024, 50)]))).toMatchObject({ basis: 'annual', end: '2024-12-31' });
  });

  it('YoY compares with the TTM a year earlier (or the fiscal year ending then)', () => {
    const c = cf({ 'us-gaap:Revenues': { USD: [...quarterFacts(2024, [10, 10, 10, 10]), ...quarterFacts(2025, [12, 12, 12, 14])] }, 'us-gaap:NetIncomeLoss': { USD: [...quarterFacts(2024, [-2, -2, -2, -2]), ...quarterFacts(2025, [1, 1, 1, 1])] } });
    const out = buildCompany(INFO, c, { price: null, currency: 'USD' });
    expect(out.figures.revenueYoYPct?.value).toBe(25);
    expect(out.figures.netIncomeYoYPct?.value).toBe(150); // −8 to 4: measured against the size of −8
    const s = flowSeries([fy(2024, 40), ...quarterFacts(2025, [12, 12, 12, 14])]);
    expect(flowNear(s, 'ttm', '2024-12-31')).toMatchObject({ value: 40, basis: 'annual' });
  });

  it('YoY null (with a note) without a period a year earlier or when it was 0', () => {
    const c = cf({ 'us-gaap:Revenues': { USD: quarterFacts(2025, [1, 1, 1, 1]) }, 'us-gaap:NetIncomeLoss': { USD: [...quarterFacts(2024, [0, 0, 0, 0]), ...quarterFacts(2025, [1, 1, 1, 1])] } });
    const out = buildCompany(INFO, c, { price: null, currency: 'USD' });
    expect(out.figures.revenueYoYPct).toBeNull();
    expect(out.figures.netIncomeYoYPct).toBeNull();
    expect(out.notes).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'no_prior_period', figure: 'revenueYoYPct' }), expect.objectContaining({ code: 'prior_zero', figure: 'netIncomeYoYPct' })]));
  });
});

describe('margins, P/E, debt, shares, bounds', () => {
  const flows = (rev: number[], ni: number[], eps?: number[]) =>
    cf({
      'us-gaap:Revenues': { USD: [...quarterFacts(2022, rev), ...quarterFacts(2023, rev), ...quarterFacts(2024, rev), ...quarterFacts(2025, rev)] },
      'us-gaap:NetIncomeLoss': { USD: [...quarterFacts(2022, ni.map((x) => x / 2)), ...quarterFacts(2024, ni), ...quarterFacts(2025, ni)] },
      ...(eps ? { 'us-gaap:EarningsPerShareDiluted': { 'USD/shares': quarterFacts(2025, eps) } } : {}),
    });

  it('margin history: now, a year and 3 years earlier, each from the same 12 months', () => {
    const out = buildCompany(INFO, flows([100, 100, 100, 100], [10, 10, 10, 10]), { price: null, currency: 'USD' });
    expect(out.figures.netMarginPct?.value).toBe(10);
    expect(out.figures.netMarginPct1yAgo).toMatchObject({ value: 10, periodEnd: '2024-12-31' });
    expect(out.figures.netMarginPct3yAgo).toMatchObject({ value: 5, periodEnd: '2022-12-31' });
  });

  it('margin bounds: |margin| ≤ 500%, revenue must be positive', () => {
    const out = buildCompany(INFO, flows([1, 1, 1, 1], [-10, -10, -10, -10]), { price: null, currency: 'USD' });
    expect(out.figures.netMarginPct).toBeNull();
    expect(out.notes).toContainEqual(expect.objectContaining({ code: 'out_of_bounds', figure: 'netMarginPct' }));
    const zero = buildCompany(INFO, flows([0, 0, 0, 0], [1, 1, 1, 1]), { price: null, currency: 'USD' });
    expect(zero.figures.revenueTtm?.value).toBe(0);
    expect(zero.figures.netMarginPct).toBeNull();
  });

  it('negative revenue is outside the bounds: no revenue figures', () => {
    const out = buildCompany(INFO, flows([-1, -1, -1, -1], [1, 1, 1, 1]), { price: null, currency: 'USD' });
    expect(out.figures.revenueTtm).toBeNull();
    expect(out.figures.revenueYoYPct).toBeNull();
    expect(out.figures.netMarginPct).toBeNull();
  });

  it('P/E only with EPS > 0, in the price currency, and ≤ 1000', () => {
    const pe = (eps: number[], price: number | null, currency = 'USD') => buildCompany(INFO, flows([1, 1, 1, 1], [1, 1, 1, 1], eps), { price, currency });
    expect(pe([0.5, 0.5, 0.5, 0.5], 30).figures.pe).toMatchObject({ value: 15, unit: 'x', basis: 'derived' });
    expect(pe([-0.5, 0.2, 0.1, 0.1], 30).figures.pe).toBeNull();
    expect(pe([0, 0, 0, 0], 30).figures.pe).toBeNull();
    expect(pe([0.001, 0.001, 0.001, 0.001], 30).figures.pe).toBeNull(); // 7500
    expect(pe([0.5, 0.5, 0.5, 0.5], null).figures.pe).toBeNull();
    const eur = pe([0.5, 0.5, 0.5, 0.5], 30, 'EUR');
    expect(eur.figures.pe).toBeNull();
    expect(eur.notes).toContainEqual({ code: 'eps_currency', figure: 'pe', text: 'pe: EPS is reported in USD, the price is in EUR.' });
  });

  it('total debt rules (a), (b), (c) at the balance-sheet date, never double-counting current maturities', () => {
    const d = '2025-12-31';
    const inst = (v: number, end = d) => [f(null, end, v)];
    const debt = (c: Record<string, number>) => totalDebtAt(cf(Object.fromEntries(Object.entries(c).map(([k, v]) => [`us-gaap:${k}`, { USD: inst(v) }]))), 'USD', d);
    expect(debt({ LongTermDebtNoncurrent: 100, DebtCurrent: 30, LongTermDebtCurrent: 20, LongTermDebt: 120 })).toMatchObject({ value: 130, rule: 'a' });
    expect(debt({ LongTermDebtNoncurrent: 100, LongTermDebtCurrent: 20, ShortTermBorrowings: 5, CommercialPaper: 9 })).toMatchObject({ value: 125, rule: 'b' });
    expect(debt({ LongTermDebtNoncurrent: 100, LongTermDebtCurrent: 20, CommercialPaper: 9 })).toMatchObject({ value: 129, rule: 'b' });
    expect(debt({ LongTermDebt: 120, ShortTermBorrowings: 5 })).toMatchObject({ value: 125, rule: 'c' });
    expect(debt({ LongTermDebt: 120 })).toMatchObject({ value: 120, rule: 'c' });
    expect(debt({ LongTermDebtNoncurrent: 100 })).toBeNull();
    expect(debt({ ShortTermBorrowings: 5 })).toBeNull();
    // components at another date do not count
    expect(totalDebtAt(cf({ 'us-gaap:LongTermDebt': { USD: inst(120, '2025-09-30') } }), 'USD', d)).toBeNull();
  });

  it('debt/equity only with positive equity at the same date; total debt null when not determinable', () => {
    const base = { 'us-gaap:Revenues': { USD: quarterFacts(2025, [1, 1, 1, 1]) }, 'us-gaap:LongTermDebt': { USD: [f(null, '2025-12-31', 50)] } };
    expect(buildCompany(INFO, cf({ ...base, 'us-gaap:StockholdersEquity': { USD: [f(null, '2025-12-31', 200)] } }), { price: null, currency: 'USD' }).figures.debtToEquity?.value).toBe(0.25);
    const neg = buildCompany(INFO, cf({ ...base, 'us-gaap:StockholdersEquity': { USD: [f(null, '2025-12-31', -20)] } }), { price: null, currency: 'USD' });
    expect(neg.figures.totalDebt?.value).toBe(50);
    expect(neg.figures.debtToEquity).toBeNull();
    const none = buildCompany(INFO, cf({ 'us-gaap:Revenues': base['us-gaap:Revenues'], 'us-gaap:StockholdersEquity': { USD: [f(null, '2025-12-31', 200)] } }), { price: null, currency: 'USD' });
    expect(none.figures.totalDebt).toBeNull();
    expect(none.notes).toContainEqual(expect.objectContaining({ code: 'not_determinable', figure: 'totalDebt' }));
  });

  it('shares: latest vs about a year earlier; share classes in one filing are summed; must be positive', () => {
    const sh = (facts: SecFact[]) => buildCompany(INFO, cf({ 'dei:EntityCommonStockSharesOutstanding': { shares: facts } }), { price: null, currency: 'USD' });
    const a = sh([f(null, '2024-10-20', 1000, { accn: '0000000001-24-000001' }), f(null, '2025-10-18', 1050, { accn: '0000000001-25-000001' })]);
    expect(a.figures.sharesOutstanding).toMatchObject({ value: 1050, unit: 'shares', periodEnd: '2025-10-18', basis: 'instant' });
    expect(a.figures.sharesChange1yPct?.value).toBe(5);
    const classes = instantSeries([f(null, '2025-10-18', 600, { accn: '0000000001-25-000002' }), f(null, '2025-10-18', 400, { accn: '0000000001-25-000002' })], true);
    expect(classes).toMatchObject([{ val: 1000, parts: 2 }]);
    const far = sh([f(null, '2024-06-01', 1000), f(null, '2025-10-18', 1050)]);
    expect(far.figures.sharesChange1yPct).toBeNull();
    expect(sh([f(null, '2025-10-18', 0)]).figures.sharesOutstanding).toBeNull();
    // the cover-page concept wins over the balance-sheet one when filed later; the balance sheet is the fallback
    const fb = buildCompany(INFO, cf({ 'us-gaap:CommonStockSharesOutstanding': { shares: [f(null, '2025-09-30', 900)] } }), { price: null, currency: 'USD' });
    expect(fb.figures.sharesOutstanding?.value).toBe(900);
  });
});

describe('currencies', () => {
  it('a foreign filer in EUR: figures keep EUR and say so; no P/E against a USD price; no mixing', () => {
    const c = cf({
      'ifrs-full:Revenue': { EUR: [...quarterFacts(2024, [100, 100, 100, 100]), ...quarterFacts(2025, [110, 110, 110, 110])] },
      'ifrs-full:ProfitLossAttributableToOwnersOfParent': { EUR: quarterFacts(2025, [11, 11, 11, 11]), USD: quarterFacts(2025, [99, 99, 99, 99]) },
      'ifrs-full:DilutedEarningsLossPerShare': { 'EUR/shares': quarterFacts(2025, [0.2, 0.2, 0.2, 0.2]) },
      'ifrs-full:CashAndCashEquivalents': { USD: [f(null, '2025-12-31', 5)] },
    });
    const out = buildCompany(INFO, c, { price: 12, currency: 'USD' });
    expect(out.currency).toBe('EUR');
    expect(out.figures.revenueTtm).toMatchObject({ value: 440, unit: 'EUR' });
    expect(out.figures.netIncomeTtm).toMatchObject({ value: 44, unit: 'EUR' });
    expect(out.figures.netMarginPct?.value).toBe(10);
    expect(out.figures.epsTtm).toMatchObject({ value: 0.8, unit: 'EUR/shares' });
    expect(out.figures.pe).toBeNull();
    expect(out.figures.cash).toBeNull(); // only in USD: not mixed in
    expect(out.notes).toContainEqual(expect.objectContaining({ code: 'foreign_currency', figure: null }));
    expect(out.notes).toContainEqual(expect.objectContaining({ code: 'foreign_ifrs', figure: null }));
  });

  it('USD is preferred when a concept has several currencies', () => {
    expect(moneyUnit({ EUR: [fy(2025, 1, { filed: '2026-03-01' })], USD: [fy(2024, 1)] }, null, 'flow')).toBe('USD');
    expect(moneyUnit({ EUR: [fy(2025, 1, { filed: '2026-03-01' })], JPY: [fy(2024, 1)] }, null, 'flow')).toBe('EUR');
  });

  it('no facts: every figure null with a note', () => {
    const out = buildCompany(INFO, null, { price: 1, currency: 'USD' });
    expect(Object.values(out.figures).every((x) => x === null)).toBe(true);
    expect(out).toMatchObject({ name: INFO.name, cik: CIK, sic: '3571', currency: null, notes: [{ code: 'no_xbrl', figure: null, text: 'The company has filed no XBRL financial data with SEC.' }] });
  });
});

describe('regression on public filings (trimmed SEC companyfacts, as of a date)', () => {
  it('NVIDIA as of 2024-09-01: EPS and shares across the 10-for-1 split of 2024-06-10', () => {
    const t = trimCompanyFacts(nvda, '0001045810', '2024-09-01')!;
    const info = { cik: '0001045810', name: 'NVIDIA', sic: '3674', sicDescription: null };
    const out = buildCompany(info, t, { price: 119, currency: 'USD', splits: [{ d: '2021-07-20', ratio: '4:1' }, { d: '2024-06-10', ratio: '10:1' }] });
    expect(out.figures.revenueTtm).toMatchObject({ value: 96_307_000_000, periodEnd: '2024-07-28', basis: 'ttm' });
    expect(out.figures.epsTtm?.value).toBeCloseTo(2.13, 2);
    expect(out.figures.pe?.value).toBeCloseTo(55.9, 0);
    expect(out.figures.sharesChange1yPct?.value).toBe(-0.7);
    expect(out.notes).toContainEqual(expect.objectContaining({ code: 'split_adjusted', figure: 'epsTtm' }));
    // without the split events the filed EPS fails its check and the share count jump is not shown
    const blind = buildCompany(info, t, { price: 119, currency: 'USD', splits: null });
    expect(blind.figures.epsTtm).toBeNull();
    expect(blind.figures.pe).toBeNull();
    expect(blind.notes).toContainEqual(expect.objectContaining({ code: 'eps_inconsistent', figure: 'epsTtm' }));
    expect(blind.figures.sharesChange1yPct).toBeNull();
    expect(blind.notes).toContainEqual(expect.objectContaining({ code: 'split_suspected', figure: 'sharesChange1yPct' }));
  });

  it('Alphabet as of 2025-08-01: the new revenue concept is filled from the old one (no stale fiscal year)', () => {
    const t = trimCompanyFacts(googl, '0001652044', '2025-08-01')!;
    const out = buildCompany({ cik: '0001652044', name: 'Alphabet', sic: '7370', sicDescription: null }, t, { price: 190, currency: 'USD', splits: [{ d: '2022-07-18', ratio: '20:1' }] });
    expect(out.figures.revenueTtm).toMatchObject({ value: 371_399_000_000, periodEnd: '2025-06-30', basis: 'ttm' });
    expect(out.figures.revenueYoYPct?.value).toBe(13.1);
    expect(out.figures.netMarginPct?.value).toBe(31.1);
    expect(out.figures.netMarginPct1yAgo?.value).toBe(26.7);
    expect(out.figures.netMarginPct3yAgo?.value).toBe(25.9);
    expect(out.figures.pe?.value).toBeCloseTo(20.26, 1);
    expect(out.notes).toContainEqual(expect.objectContaining({ code: 'concept_filled', figure: 'revenueTtm' }));
  });
});

describe('review fixes: splits, fill, subset guard, staleness, debt, ADRs', () => {
  it('splits: facts filed before a split are scaled, later (restated) ones are not; checked against NI / diluted shares', () => {
    // a 2-for-1 split on 2025-08-15: Q4 2024 to Q2 2025 EPS filed before it (1.0 pre-split), Q3 2025 after it (0.5)
    const q3 = Q(2025)[2]!;
    const c = cf({
      'us-gaap:NetIncomeLoss': { USD: [...quarterFacts(2024, [100, 100, 100, 100]), ...quarterFacts(2025, [100, 100, 100])] },
      'us-gaap:EarningsPerShareDiluted': { 'USD/shares': [...quarterFacts(2024, [1, 1, 1, 1]).slice(3), ...quarterFacts(2025, [1, 1]), f(q3[0], q3[1], 0.5, { filed: '2025-11-01' })] },
      'us-gaap:WeightedAverageNumberOfDilutedSharesOutstanding': { shares: [...quarterFacts(2024, [100, 100, 100, 100]).slice(3), ...quarterFacts(2025, [100, 100]), f(q3[0], q3[1], 200, { filed: '2025-11-01' })] },
    });
    const ok = buildCompany(INFO, c, { price: 20, currency: 'USD', splits: [{ d: '2025-08-15', ratio: '2:1' }] });
    expect(ok.figures.epsTtm?.value).toBe(2); // 0.5 x 4
    expect(ok.figures.pe?.value).toBe(10);
    expect(ok.notes).toContainEqual(expect.objectContaining({ code: 'split_adjusted', figure: 'epsTtm' }));
    const bad = buildCompany(INFO, c, { price: 20, currency: 'USD', splits: [] });
    expect(bad.figures.epsTtm).toBeNull();
    expect(bad.notes).toContainEqual(expect.objectContaining({ code: 'eps_inconsistent', figure: 'pe' }));
  });

  it('cover-page share counts dated before a split are scaled; unknown splits and a big jump: not shown', () => {
    const facts = { 'dei:EntityCommonStockSharesOutstanding': { shares: [f(null, '2024-10-20', 100, { filed: '2024-10-30' }), f(null, '2025-10-20', 410, { filed: '2025-10-30' })] } };
    expect(buildCompany(INFO, cf(facts), { price: null, currency: 'USD', splits: [{ d: '2025-06-01', ratio: '4:1' }] }).figures.sharesChange1yPct?.value).toBe(2.5);
    const unknown = buildCompany(INFO, cf(facts), { price: null, currency: 'USD', splits: null });
    expect(unknown.figures.sharesChange1yPct).toBeNull();
    expect(unknown.notes).toContainEqual(expect.objectContaining({ code: 'split_suspected' }));
  });

  it('fill: periods missing from the chosen concept come from another only when overlapping periods agree within 0.5%', () => {
    const newer = { 'us-gaap:Revenues': { USD: quarterFacts(2025, [10, 10, 10, 10], { filed: '2026-02-20' }).slice(2) } };
    const agree = cf({ ...newer, 'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax': { USD: [...quarterFacts(2024, [9, 9, 9, 9]), ...quarterFacts(2025, [10, 10, 10.02])] } });
    const a = buildCompany(INFO, agree, { price: null, currency: 'USD' });
    expect(a.figures.revenueTtm).toMatchObject({ value: 40, basis: 'ttm' });
    expect(a.figures.revenueYoYPct?.value).toBe(11.1);
    const differ = cf({ ...newer, 'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax': { USD: [...quarterFacts(2024, [9, 9, 9, 9]), ...quarterFacts(2025, [10, 10, 11])] } });
    expect(buildCompany(INFO, differ, { price: null, currency: 'USD' }).figures.revenueTtm).toBeNull();
  });

  it('subset guard: a newer concept under 70% of another fiscal-year figure (fee income only) gives way', () => {
    const c = cf({
      'us-gaap:Revenues': { USD: [fy(2024, 100, { filed: '2025-02-01' }), fy(2025, 110, { filed: '2026-02-01' })] },
      'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax': { USD: [fy(2025, 30, { filed: '2026-02-02' })] },
    });
    const out = buildCompany(INFO, c, { price: null, currency: 'USD' });
    expect(out.figures.revenueTtm?.value).toBe(110);
    expect(out.notes).toContainEqual(expect.objectContaining({ code: 'larger_revenue_concept', figure: 'revenueTtm' }));
  });

  it('stale: figures ending over 15 months before the newest period are dropped', () => {
    const c = cf({ 'us-gaap:Revenues': { USD: quarterFacts(2025, [1, 1, 1, 1]) }, 'us-gaap:CashAndCashEquivalentsAtCarryingValue': { USD: [f(null, '2023-12-31', 5, { filed: '2024-02-01' })] } });
    const out = buildCompany(INFO, c, { price: null, currency: 'USD' });
    expect(out.figures.revenueTtm).not.toBeNull();
    expect(out.figures.cash).toBeNull();
    expect(out.notes).toContainEqual(expect.objectContaining({ code: 'stale_dropped', figure: 'cash' }));
  });

  it('debt: other short-term borrowings count, finance leases are separate, banks get no debt/equity', () => {
    const d = '2025-12-31';
    const c = cf({
      'us-gaap:Revenues': { USD: quarterFacts(2025, [1, 1, 1, 1]) },
      'us-gaap:LongTermDebt': { USD: [f(null, d, 100)] },
      'us-gaap:CommercialPaper': { USD: [f(null, d, 10)] },
      'us-gaap:OtherShortTermBorrowings': { USD: [f(null, d, 5)] },
      'us-gaap:FinanceLeaseLiabilityCurrent': { USD: [f(null, d, 2)] },
      'us-gaap:FinanceLeaseLiabilityNoncurrent': { USD: [f(null, d, 8)] },
      'us-gaap:StockholdersEquity': { USD: [f(null, d, 230)] },
    });
    const out = buildCompany(INFO, c, { price: null, currency: 'USD' });
    expect(out.figures.totalDebt?.value).toBe(115);
    expect(out.figures.financeLeases).toMatchObject({ value: 10, unit: 'USD', basis: 'instant' });
    expect(out.figures.debtToEquity?.value).toBe(0.5);
    expect(out.notes).toContainEqual(expect.objectContaining({ code: 'excludes_leases', figure: 'totalDebt' }));
    const bank = buildCompany({ ...INFO, sic: '6021' }, c, { price: null, currency: 'USD' });
    expect(bank.figures.debtToEquity).toBeNull();
    expect(bank.notes).toContainEqual(expect.objectContaining({ code: 'bank_debt_ratio', figure: 'debtToEquity' }));
  });

  it('ADR: no P/E from a 20-F EPS', () => {
    const c = cf({ 'us-gaap:Revenues': { USD: [fy(2025, 100, { form: '20-F' })] }, 'us-gaap:EarningsPerShareDiluted': { 'USD/shares': [fy(2025, 2, { form: '20-F' })] } });
    const out = buildCompany(INFO, c, { price: 30, currency: 'USD' });
    expect(out.figures.epsTtm?.value).toBe(2);
    expect(out.figures.pe).toBeNull();
    expect(out.notes).toContainEqual(expect.objectContaining({ code: 'adr_no_pe', figure: 'pe' }));
  });

  it('trim window: from the newest revenue/net income period, ignoring dates in the future', () => {
    const fact = (end: string, start: string) => ({ start, end, val: 1, accn: '0009999001-25-000001', form: '10-Q', filed: '2025-05-01' });
    const body = { cik: 9999001, entityName: 'X', facts: { 'us-gaap': { Revenues: { units: { USD: [fact('2025-03-31', '2025-01-01'), fact('2018-06-30', '2018-04-01'), fact('2099-03-31', '2099-01-01')] } } } } };
    const t = trimCompanyFacts(body, CIK, '2026-11-11')!;
    expect(t.concepts['us-gaap:Revenues']!.USD!.map((x) => x.end)).toEqual(['2099-03-31', '2025-03-31']);
  });
});
