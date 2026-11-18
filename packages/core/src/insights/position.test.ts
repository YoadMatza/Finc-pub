import { describe, expect, it } from 'vitest';
import type { CostLotRow } from '../ingest/fibi-pages.js';
import { computePosition, matchLots, type PositionInput, xirr } from './position.js';

// made-up papers, prices and amounts; every expected number below is worked out by hand in the comment next to it
const lot = (o: Partial<CostLotRow> = {}): CostLotRow => ({ paperId: '11111', name: 'ACME', action: 'buy', actionText: 'קניה בבורסה', quantity: 10, costPrice: 100, costPriceIls: 350, currency: 'USD', tradeDate: '2024-11-18', avgPrice: null, lastPrice: 150, changePct: 50, ...o });

const base = (o: Partial<PositionInput> = {}): PositionInput => ({
  // 10 units at $150, $1 = ₪3.7: 10 × 150 × 3.7 = ₪5,550
  holding: { quantity: 10, price: 150, currency: 'USD', valueIls: 555_000, rate: 3.7, priceSource: 'bank', asOf: '2026-11-18T10:00:00Z' },
  lots: [lot()],
  // the trade date (Mon 2024-11-18) has no bar: the Friday before (500) is used
  spy: [{ d: '2024-11-15', adj: 500 }, { d: '2024-11-19', adj: 510 }, { d: '2026-11-17', adj: 650 }],
  today: '2026-11-18',
  portfolioIls: 1_110_000,
  netWorthIls: 5_550_000,
  ...o,
});

function view(o: Partial<PositionInput> = {}) {
  const r = computePosition(base(o));
  if (!r.ok) throw new Error(r.code);
  return r.view;
}

describe('xirr', () => {
  it('finds the yearly rate', () => {
    expect(xirr([{ d: '2025-01-01', amount: -1000 }, { d: '2026-01-01', amount: 1100 }])).toBeCloseTo(0.1, 6);
    expect(xirr([{ d: '2025-01-01', amount: -1000 }])).toBeNull();
  });
});

describe('computePosition', () => {
  it('your result, per year, the market, the dollar, if sold, what if, weight', () => {
    const v = view();
    // cost 10 × 350 = ₪3,500; gain 5,550 − 3,500 = ₪2,050 = 58.57%; in dollars 1,500 − 1,000 = $500 = 50%
    expect(v.result).toMatchObject({ costIls: 350_000, valueIls: 555_000, gainIls: 205_000, gainPct: 58.57, costOrig: 1000, valueOrig: 1500, gainOrig: 500, gainOrigPct: 50 });
    // two years exactly: √(5,550 / 3,500) − 1 = 25.93% a year
    expect(v.perYear).toEqual({ pct: 25.93, missing: null, since: '2024-11-18' });
    // $1,000 / 500 = 2 SPY units, × 650 = $1,300, × 3.7 = ₪4,810; gain ₪1,310 = 37.43%; ahead by ₪740 and 21.14 points
    expect(v.benchmark).toEqual({ symbol: 'SPY', asOf: '2026-11-17', valueIls: 481_000, gainIls: 131_000, gainPct: 37.43, diffIls: 74_000, diffPts: 21.14 });
    // the paper: $500 × 3.7 = ₪1,850; the dollar: $1,000 × (3.7 − 3.5) = ₪200
    expect(v.dollarPart).toEqual({ stockIls: 185_000, fxIls: 20_000, rateAtBuy: 3.5, rateNow: 3.7 });
    // no fee; tax 25% × 2,050 = ₪512.50; proceeds 5,550 − 512.50 = ₪5,037.50
    expect(v.ifSold).toEqual({ valueIls: 555_000, feeIls: 0, feeRate: 0, taxIls: 51_250, taxRate: 0.25, taxBasis: 'estimate_nominal_gain', proceedsIls: 503_750, netGainIls: 153_750, realisedLossIls: null });
    // 5,550 × 0.7 / 0.9 / 1.1 / 1.3; break-even 3,500 / 3.7 / 10 = $94.5946, 36.94% below $150
    expect(v.whatIf).toEqual({
      moves: [
        { movePct: -30, valueIls: 388_500, gainIls: 38_500 },
        { movePct: -10, valueIls: 499_500, gainIls: 149_500 },
        { movePct: 10, valueIls: 610_500, gainIls: 260_500 },
        { movePct: 30, valueIls: 721_500, gainIls: 371_500 },
      ],
      breakEvenPrice: 94.5946,
      breakEvenMovePct: -36.94,
    });
    expect(v.weight).toEqual({ ofPortfolioPct: 50, ofNetWorthPct: 10 });
    expect(v.lots).toEqual([{ tradeDate: '2024-11-18', action: 'buy', actionText: 'קניה בבורסה', quantity: 10, costPrice: 100, currency: 'USD', costIls: 350_000 }]);
  });

  it('at a loss with a fee: no tax, the loss that would be realised', () => {
    // value ₪3,000; fee 1% = ₪30; 3,000 − 30 − 3,500 = −₪530
    const v = view({ holding: { quantity: 10, price: 81.08, currency: 'USD', valueIls: 300_000, rate: 3.7, priceSource: 'live', asOf: null }, feeRate: 0.01 });
    expect(v.ifSold).toMatchObject({ feeIls: 3000, taxIls: 0, proceedsIls: 297_000, netGainIls: -53_000, realisedLossIls: -53_000 });
  });

  it('two lots: the money-weighted rate and the SPY units add up per date', () => {
    // 5 units on each of two dates, $500 and ₪1,750 each
    const v = view({ lots: [lot({ quantity: 5 }), lot({ quantity: 5, tradeDate: '2024-11-19' })] });
    // 1 unit (500) + $500 / 510 = 0.980392 → 1.980392 × 650 × 3.7 = ₪4,762.84
    expect(v.benchmark?.valueIls).toBe(476_284);
    expect(v.result.costIls).toBe(350_000);
  });

  it('shares received (split, dividend) have a result but no yearly rate or market comparison', () => {
    const v = view({ lots: [lot({ action: 'split', actionText: 'קבלה מאחוד/פצול' })] });
    expect(v.result.gainIls).toBe(205_000);
    expect(v.perYear.missing).toBe('received_shares');
    expect(v.benchmark).toBeNull();
    expect(v.benchmarkMissing).toBe('received_shares');
  });

  it('no yearly rate under a year; no market comparison without fresh SPY', () => {
    const v = view({ lots: [lot({ tradeDate: '2026-03-01' })], spy: [{ d: '2026-01-02', adj: 600 }, { d: '2026-11-02', adj: 650 }] });
    expect(v.perYear).toEqual({ pct: null, missing: 'under_a_year', since: '2026-03-01' });
    expect(v.benchmarkMissing).toBe('benchmark_stale');
    expect(view({ spy: null }).benchmarkMissing).toBe('no_benchmark');
    expect(view({ spy: [{ d: '2025-01-02', adj: 1 }, { d: '2026-11-17', adj: 2 }] }).benchmarkMissing).toBe('history_short');
  });

  it('refuses lots that do not add up to the holding', () => {
    expect(computePosition(base({ lots: [] }))).toEqual({ ok: false, code: 'no_lots' });
    expect(computePosition(base({ lots: [lot({ quantity: 9 })] }))).toEqual({ ok: false, code: 'not_matched' });
  });

  it('reads the rate from the value when none is given; a shekel paper has no dollar part', () => {
    expect(view({ holding: { ...base().holding, rate: null } }).rate).toBe(3.7);
    const ils = view({ holding: { quantity: 10, price: 500, currency: 'ILS', valueIls: 500_000, rate: null, priceSource: 'bank', asOf: null }, lots: [lot({ currency: 'ILS', costPrice: 350, costPriceIls: 350, lastPrice: 500 })] });
    expect(ils.dollarPart).toBeNull();
    expect(ils.dollarPartMissing).toBe('not_foreign');
    expect(ils.benchmarkMissing).toBe('not_foreign');
  });
});

describe('matchLots', () => {
  const H = (id: number, quantity: number, price: number | null, currency = 'USD') => ({ id, quantity, price, currency });

  it('joins a paper to the one holding with its quantity, currency and price', () => {
    const m = matchLots([H(1, 10, 20), H(2, 10, 151), H(3, 4, 150)], [lot({ quantity: 6 }), lot({ quantity: 4, tradeDate: '2025-01-01' }), lot({ paperId: '22222', quantity: 4, lastPrice: 155 })]);
    // paper 11111: 6 + 4 = 10 units at about $150 → holding 2 (holding 1 has 10 units at $20); 22222 → holding 3
    expect(m.get(2)?.map((l) => l.tradeDate)).toEqual(['2024-11-18', '2025-01-01']);
    expect(m.get(3)?.[0]?.paperId).toBe('22222');
    expect(m.has(1)).toBe(false);
  });

  it('leaves a paper unmatched when it fits two holdings, and a holding unclaimed when two papers fit it', () => {
    expect(matchLots([H(1, 10, 150), H(2, 10, 152)], [lot()]).size).toBe(0);
    expect(matchLots([H(1, 10, 150)], [lot(), lot({ paperId: '22222' })]).size).toBe(0);
    // no price on the lot: the quantity alone must point at one holding
    expect(matchLots([H(1, 10, 150), H(2, 3, 9)], [lot({ lastPrice: null })]).get(1)?.length).toBe(1);
    expect(matchLots([H(1, 10, 150)], [lot({ currency: 'EUR' })]).size).toBe(0);
  });
});
