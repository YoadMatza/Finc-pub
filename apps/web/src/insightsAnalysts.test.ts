import { describe, expect, it } from 'vitest';
import { en, he, type Key } from './i18n';
import { RATING_KEYS, analystView, analystsParts, analystsIssue, analystsUnavailableReason, changeText, daysUntil, finnhubSource, lastEarningsText, monthYear, nextEarningsText, ratingColor, sharePct } from './insightsAnalysts';
import { insightsReady } from './insights';
import type { HoldingInsights, InsightAnalystCounts, InsightAnalysts, InsightEarnings } from './types';

/** the real English strings, so the lines are checked as the owner reads them */
const t = (k: Key, vars?: Record<string, string | number>) => {
  let s: string = en[k];
  for (const [a, b] of Object.entries(vars ?? {})) s = s.replaceAll(`{${a}}`, String(b));
  return s;
};
/** without the bidi isolates, for readable expectations */
const plain = (s: string | null) => (s === null ? null : s.replace(/[⁦-⁩]/g, ''));

const month = (over: Partial<InsightAnalystCounts> = {}): InsightAnalystCounts => ({ period: '2026-11', strongBuy: 10, buy: 12, hold: 8, sell: 1, strongSell: 1, total: 32, buyShare: 68.75, sellShare: 6.25, ...over });
const an = (over: Partial<InsightAnalysts> = {}): InsightAnalysts => ({
  ...month(),
  prev3m: month({ period: '2026-08', strongBuy: 8, buy: 10, hold: 10, sell: 2, strongSell: 0, total: 30, buyShare: 60, sellShare: 6.67 }),
  buyShareChange3mPts: 8.8,
  fetchedAt: '2026-11-11T07:00:00Z',
  source: 'finnhub',
  ...over,
});

describe('analystView', () => {
  it('segments in order strong buy → strong sell, shares from the counts', () => {
    const v = analystView(an())!;
    expect(v.segments.map((s) => s.key)).toEqual([...RATING_KEYS]);
    expect(v.segments.map((s) => s.count)).toEqual([10, 12, 8, 1, 1]);
    expect(v.segments.reduce((a, s) => a + s.frac, 0)).toBeCloseTo(1);
    expect(v.total).toBe(32);
    expect(v.buyPct).toBeCloseTo(68.75);
    expect(v.sellPct).toBeCloseTo(6.25);
    expect(v.period).toBe('2026-11');
  });
  it("the change is the hub's number (the one the rules check), else computed", () => {
    expect(analystView(an())!.changePts).toBe(8.8);
    expect(analystView(an({ buyShareChange3mPts: null }))!.changePts).toBe(r1(r1(68.75) - r1((18 / 30) * 100)));
    // the shares as shown subtract to the change shown: 68.8 − 60.0 = 8.8
    expect(plain(changeText(t, analystView(an({ buyShareChange3mPts: null }))!))).toBe('Buy share 3 months ago: 60.0% → now 68.8% (+8.8 points)');
    expect(analystView(an({ prev3m: null }))!.changePts).toBeNull();
    expect(analystView(an({ prev3m: null }))!.prev).toBeNull();
  });
  it('a previous month that is not earlier, or empty, is not compared', () => {
    expect(analystView(an({ prev3m: month({ period: '2026-11' }) }))!.prev).toBeNull();
    expect(analystView(an({ prev3m: month({ period: '2026-08', strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0 }) }))!.changePts).toBeNull();
  });
  it('fewer than 3 analysts: not drawn, reported as too few', () => {
    const few = an({ strongBuy: 1, buy: 1, hold: 0, sell: 0, strongSell: 0 });
    expect(analystView(few)).toBeNull();
    expect(analystsIssue(few)).toBe('too_few');
  });
  it('unreadable counts or period: not drawn, reported as invalid', () => {
    for (const bad of [an({ buy: -1 }), an({ hold: 2.5 }), an({ sell: Number.NaN }), an({ period: '2026-13' }), an({ period: 'Nov 2026' }), an({ strongBuy: '3' as never })]) {
      expect(analystView(bad)).toBeNull();
      expect(analystsIssue(bad)).toBe('invalid');
    }
  });
  it('nothing sent: null, no issue', () => {
    expect(analystView(null)).toBeNull();
    expect(analystView(undefined)).toBeNull();
    expect(analystsIssue(null)).toBeNull();
    expect(analystsIssue(an())).toBeNull();
  });
});

const r1 = (v: number) => Math.round(v * 10) / 10;

describe('wording', () => {
  it('month and year in the language', () => {
    expect(monthYear('2026-11', 'en-GB')).toBe('November 2026');
    expect(monthYear('2026-01', 'he-IL')).toContain('2026');
    expect(monthYear('2026-01', 'he-IL')).toContain('ינואר');
    expect(monthYear('soon', 'en-GB')).toBe('soon');
  });
  it('whole-percent shares', () => {
    expect(sharePct(68.75)).toBe('69%');
    expect(sharePct(0)).toBe('0%');
  });
  it('the 3-month line', () => {
    expect(plain(changeText(t, analystView(an())!))).toBe('Buy share 3 months ago: 60.0% → now 68.8% (+8.8 points)');
    expect(plain(changeText(t, analystView(an({ buyShareChange3mPts: -4 }))!))).toContain('(−4.0 points)');
    expect(changeText(t, analystView(an({ prev3m: null }))!)).toBeNull();
  });
  it('one hue in five strengths, strongest first', () => {
    const pcts = RATING_KEYS.map((k) => Number(/(\d+)%/.exec(ratingColor(k))![1]));
    expect(pcts).toEqual([...pcts].sort((a, b) => b - a));
    for (const k of RATING_KEYS) expect(ratingColor(k)).toContain('var(--color-accent)');
  });
  it('a reason for every code, in both languages; unknown codes say nothing', () => {
    for (const c of ['off', 'no_key', 'vault_locked', 'not_covered', 'busy', 'unreachable', 'invalid', 'too_few']) {
      expect(analystsUnavailableReason(t, c)).toBeTruthy();
      expect(he[`ins_an_unav_${c}` as Key]).toBeTruthy();
    }
    expect(analystsUnavailableReason(t, 'no_key')).toContain('.\\finc vault set finnhub');
    expect(analystsUnavailableReason(t, 'something_new')).toBeNull();
    expect(analystsUnavailableReason(t, undefined)).toBeNull();
    expect(analystsUnavailableReason(t, 'toString')).toBeNull();
  });
  it("finc's own words never advise (the rating names are labels of what analysts published)", () => {
    const labels = new Set(['ins_an_strong_buy', 'ins_an_buy', 'ins_an_hold', 'ins_an_sell', 'ins_an_strong_sell']);
    const words = /\b(buy|sell|hold|should|recommend\w*)\b/i;
    for (const k of Object.keys(en).filter((k) => (k.startsWith('ins_an') || k.startsWith('ins_earn')) && !labels.has(k))) {
      // the category names used as labels: "Buy and strong buy:", "Buy share", "sell ratings"
      const s = en[k as Key].replace(/\b(buy|sell) and strong (buy|sell):/gi, '').replace(/\bbuy share\b/gi, '').replace(/\bsell ratings\b/gi, '');
      expect(s, k).not.toMatch(words);
      expect(he[k as Key], k).not.toMatch(/כדאי|מומלץ|לקנות|למכור|להחזיק/);
    }
  });
});

describe('earnings', () => {
  const e = (over: Partial<InsightEarnings> = {}): InsightEarnings => ({
    next: { date: '2027-01-29', hour: 'bmo', epsEstimate: 1.7 },
    last: { date: '2026-10-30', epsActual: 1.64, epsEstimate: 1.6, surprisePct: 2.5 },
    fetchedAt: '2026-11-11T07:00:00Z',
    ...over,
  });
  it('the next report with the time of day and a countdown', () => {
    expect(nextEarningsText(t, e(), '2026-11-11')).toBe('Next earnings report: 29.1.2027, before the market opens · in 79 days');
    expect(nextEarningsText(t, e({ next: { date: '2026-11-12', hour: 'amc', epsEstimate: null } }), '2026-11-11')).toBe('Next earnings report: 12.11.2026, after the market closes · tomorrow');
    expect(nextEarningsText(t, e({ next: { date: '2026-11-11', hour: 'dmh', epsEstimate: null } }), '2026-11-11')).toBe('Next earnings report: 11.11.2026, during market hours · today');
  });
  it('no time of day, no countdown for a past date or without today', () => {
    expect(nextEarningsText(t, e({ next: { date: '2027-01-29', hour: null, epsEstimate: null } }), null)).toBe('Next earnings report: 29.1.2027');
    expect(nextEarningsText(t, e({ next: { date: '2026-11-01', hour: null, epsEstimate: null } }), '2026-11-11')).toBe('Next earnings report: 1.11.2026');
    expect(nextEarningsText(t, e({ next: null }), '2026-11-11')).toBeNull();
    expect(nextEarningsText(t, null, '2026-11-11')).toBeNull();
    expect(nextEarningsText(t, e({ next: { date: 'soon', hour: null, epsEstimate: null } }), '2026-11-11')).toBeNull();
  });
  it('the last report: actual vs expected and the surprise', () => {
    expect(plain(lastEarningsText(t, e()))).toBe('Last report (30.10.2026): EPS 1.64 vs 1.60 expected (+2.5%)');
    expect(plain(lastEarningsText(t, e({ last: { date: '2026-10-30', epsActual: -0.12, epsEstimate: -0.05, surprisePct: -140 } })))).toBe('Last report (30.10.2026): EPS −0.12 vs −0.05 expected (−140.0%)');
    expect(plain(lastEarningsText(t, e({ last: { date: '2026-10-30', epsActual: 1.64, epsEstimate: 1.6, surprisePct: null } })))).toBe('Last report (30.10.2026): EPS 1.64 vs 1.60 expected');
    expect(plain(lastEarningsText(t, e({ last: { date: '2026-10-30', epsActual: 1.64, epsEstimate: null, surprisePct: 3 } })))).toBe('Last report (30.10.2026): EPS 1.64');
    expect(lastEarningsText(t, e({ last: null }))).toBeNull();
    expect(lastEarningsText(t, e({ last: { date: '2026-10-30', epsActual: null as never, epsEstimate: 1, surprisePct: null } }))).toBeNull();
  });
  it('daysUntil', () => {
    expect(daysUntil('2027-01-29', '2026-11-11')).toBe(79);
    expect(daysUntil('2026-11-11', '2026-11-11')).toBe(0);
    expect(daysUntil('2026-11-10', '2026-11-11')).toBe(-1);
    // across the clock change: still whole days
    expect(daysUntil('2026-04-01', '2026-03-20')).toBe(12);
    expect(daysUntil('x', '2026-11-11')).toBeNull();
  });
  it("each part's own date, and a note when the hub could not refresh it", () => {
    expect(finnhubSource(t, 'ins_an_source_analysts', an({ fetchedAt: '2026-11-10T07:00:00Z' }))).toBe('Analysts: Finnhub, 10.11');
    expect(finnhubSource(t, 'ins_an_source_earnings', e())).toBe('Earnings: Finnhub, 11.11');
    expect(finnhubSource(t, 'ins_an_source_analysts', an({ fetchedAt: '2026-11-08T07:00:00Z', stale: true }))).toBe('Analysts: Finnhub, 8.11 · not refreshed since 8.11');
    expect(finnhubSource(t, 'ins_an_source_earnings', e({ stale: false }))).toBe('Earnings: Finnhub, 11.11');
    expect(finnhubSource(t, 'ins_an_source_earnings', e({ fetchedAt: 'later' }))).toBeNull();
    expect(finnhubSource(t, 'ins_an_source_analysts', null)).toBeNull();
  });
});

describe('analystsParts', () => {
  const earnings: InsightEarnings = { next: { date: '2027-01-29', hour: 'amc', epsEstimate: null }, last: null, fetchedAt: '2026-11-10T07:00:00Z' };
  /** the price part failed (Yahoo unavailable), but the hub still sent the analysts and the earnings */
  const noPrice = { id: 7, symbol: 'ABC', unavailable: 'Yahoo unreachable', unavailableCode: 'unreachable', asOf: null, analysts: an(), earnings } as unknown as HoldingInsights;
  it('is built for a payload whose price data is unavailable', () => {
    expect(insightsReady(noPrice)).toBe(false);
    const p = analystsParts(t, noPrice, '2026-11-11')!;
    expect(p.view?.total).toBe(32);
    expect(p.why).toBeNull();
    expect(p.next).toBe('Next earnings report: 29.1.2027, after the market closes · in 79 days');
    expect(p.last).toBeNull();
    // each part keeps its own date, never the newer of both
    expect(p.analystsSource).toBe('Analysts: Finnhub, 11.11');
    expect(p.earningsSource).toBe('Earnings: Finnhub, 10.11');
  });
  it('a reason instead of ratings; nothing at all from an older hub', () => {
    const p = analystsParts(t, { analysts: null, analystsUnavailableCode: 'no_key', earnings: null }, null)!;
    expect(p.view).toBeNull();
    expect(p.why).toContain('finc vault set finnhub');
    expect(p.analystsSource).toBeNull();
    expect(p.earningsSource).toBeNull();
    expect(analystsParts(t, { analysts: an({ strongBuy: 1, buy: 0, hold: 0, sell: 0, strongSell: 0 }) }, null)!.why).toBe(en.ins_an_unav_too_few);
    expect(analystsParts(t, {}, null)).toBeNull();
    expect(analystsParts(t, undefined, null)).toBeNull();
  });
});
