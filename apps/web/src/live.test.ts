import { describe, expect, it } from 'vitest';
import { currencySymbol, foreignMoney } from './format';
import type { Key } from './i18n';
import { freshness, gainTone, liveTag, liveTotals, matchLiveRows, pctText, refetchMs, shownValue, stamp, toneClass } from './live';
import type { LiveHoldingRow, LiveHoldings, NetWorthLine } from './types';

const t = (k: Key, vars?: Record<string, string | number>) => (vars ? `${k}(${Object.entries(vars).map(([a, b]) => `${a}=${b}`).join(',')})` : k);

// local-time instants so the tests pass in any time zone
const now = new Date(2026, 10, 11, 14, 40);
const at = (h: number, m: number, day = 11) => new Date(2026, 10, day, h, m).toISOString();

const row = (over: Partial<LiveHoldingRow> = {}): LiveHoldingRow => ({ symbol: 'VOO', source: 'live', price: 500, prevClose: 495, currency: 'USD', valueOrig: 5000, valueIls: 1_850_000, gainOrig: 500, gainPct: 11.1, dayChangeOrig: 50, dayChangePct: 1.01, ...over });
const live = (over: Partial<LiveHoldings> = {}): LiveHoldings => ({ asOf: at(14, 32), marketState: 'open', fx: { pair: 'USD/ILS', rate: 3.7, at: at(14, 30) }, rows: [row()], totalIls: 1_850_000, gainIls: 185_000, dayChangeIls: 18_500, ...over });

describe('stamp', () => {
  it('today: hours and minutes', () => expect(stamp(at(14, 32), now)).toBe('14:32'));
  it('another day: day.month and time', () => expect(stamp(at(6, 1, 10), now)).toBe('10.11 06:01'));
  it('garbage: empty', () => expect(stamp('nope', now)).toBe(''));
});

describe('freshness label', () => {
  it('market open and recent: live with the time', () => expect(freshness(live(), null, t, now)).toEqual({ kind: 'live', text: 'live_at(t=14:32)' }));
  it('market open but the last price is old: last price with its time', () => expect(freshness(live({ asOf: at(13, 0) }), null, t, now)).toEqual({ kind: 'stale', text: 'live_stale_at(t=13:00)' }));
  it('market closed', () => expect(freshness(live({ marketState: 'closed' }), null, t, now)).toEqual({ kind: 'closed', text: 'live_closed' }));
  it('feed unavailable: bank prices at the snapshot time', () => expect(freshness(live({ marketState: 'unavailable' }), at(6, 1), t, now)).toEqual({ kind: 'bank', text: 'live_bank_at(t=06:01)' }));
  it('every row from the bank: bank prices even with the market open', () => expect(freshness(live({ rows: [row({ source: 'bank' })] }), at(6, 1), t, now).kind).toBe('bank'));
  it('some rows from the bank: still live (those rows are marked one by one)', () => expect(freshness(live({ rows: [row(), row({ symbol: 'X', source: 'bank' })] }), at(6, 1), t, now).kind).toBe('live'));
  it('no time anywhere: plain bank label', () => expect(freshness(live({ marketState: 'unavailable', asOf: null }), null, t, now)).toEqual({ kind: 'bank', text: 'live_bank' }));
});

describe('refetch interval', () => {
  it('a minute while the market is open', () => expect(refetchMs(live())).toBe(60_000));
  it('ten minutes when closed, unavailable, or an older hub', () => {
    expect(refetchMs(live({ marketState: 'closed' }))).toBe(600_000);
    expect(refetchMs(live({ marketState: 'unavailable' }))).toBe(600_000);
    expect(refetchMs(undefined)).toBe(600_000);
  });
});

describe('tone and percent', () => {
  it('green up, red down, muted flat or unknown', () => {
    expect(gainTone(1.2)).toBe('pos');
    expect(gainTone(-0.1)).toBe('neg');
    expect(gainTone(0)).toBe('muted');
    expect(gainTone(null)).toBe('muted');
    expect(toneClass('pos')).toBe('text-pos');
    expect(toneClass('neg')).toBe('text-neg');
  });
  it('percent text keeps a sign and two digits', () => {
    expect(pctText(1.234)).toBe('+1.23%');
    expect(pctText(-0.4)).toBe('−0.40%');
    expect(pctText(0.001)).toBe('0.00%');
    expect(pctText(null)).toBe('–');
  });
});

describe('foreign money', () => {
  it('dollars with cents', () => expect(foreignMoney(1234.5, 'USD')).toBe('$1,234.50'));
  it('signed', () => {
    expect(foreignMoney(12.3, 'USD', { sign: 'always' })).toBe('+$12.30');
    expect(foreignMoney(-5, 'EUR', { sign: 'always' })).toBe('−€5.00');
    expect(foreignMoney(-0.001, 'USD', { sign: 'always' })).toBe('$0.00');
  });
  it('more digits for a rate, unknown code spelled out', () => {
    expect(foreignMoney(3.71234, 'ILS', { decimals: 4 })).toBe('₪3.7123');
    expect(foreignMoney(10, 'CHF')).toBe('CHF 10.00');
    expect(currencySymbol('GBP')).toBe('£');
  });
});

describe('net worth with live values', () => {
  const line = (over: Partial<NetWorthLine>): NetWorthLine => ({ key: 'k', name: 'n', kind: 'investment', side: 'asset', value: 100_000, asOf: null, source: 'snapshot', currency: 'ILS', ...over });
  it('swaps the live value into the totals', () => {
    const lines = [line({ liveValueIls: 120_000 }), line({ value: 50_000 }), line({ side: 'liability', value: 30_000 })];
    expect(liveTotals({ total: 120_000, assets: 150_000, liabilities: 30_000, lines })).toEqual({ total: 140_000, assets: 170_000, liabilities: 30_000, live: true });
  });
  it('no live values: unchanged', () => {
    expect(liveTotals({ total: 70_000, assets: 100_000, liabilities: 30_000, lines: [line({})] })).toEqual({ total: 70_000, assets: 100_000, liabilities: 30_000, live: false });
  });
  it('shown value prefers live', () => {
    expect(shownValue({ value: 1, liveValueIls: 2 })).toBe(2);
    expect(shownValue({ value: 1 })).toBe(1);
  });
});

describe('account and net worth tag', () => {
  it('live and fresh: green Live with the time', () => expect(liveTag('live', at(14, 32), t, now)).toEqual({ kind: 'live', text: 'live_at(t=14:32)' }));
  it('closed: grey last price', () => expect(liveTag('closed', at(14, 32), t, now)).toEqual({ kind: 'closed', text: 'live_stale_at(t=14:32)' }));
  it('live but older than 15 minutes: grey', () => expect(liveTag('live', at(14, 0), t, now).kind).toBe('closed'));
  it('no state from an older hub: by age', () => expect(liveTag(undefined, at(14, 30), t, now).kind).toBe('live'));
  it('no time: grey, market closed text', () => expect(liveTag('live', undefined, t, now)).toEqual({ kind: 'closed', text: 'live_closed' }));
});

describe('matching live rows to positions', () => {
  it('by id: two USD rows with the same symbol stay apart', () => {
    const rows = [row({ id: 8, symbol: 'USD', valueIls: 2 }), row({ id: 7, symbol: 'USD', valueIls: 1 })];
    const m = matchLiveRows([{ id: 7, symbol: 'USD' }, { id: 8, symbol: 'USD' }], rows);
    expect(m.map((r) => r?.valueIls)).toEqual([1, 2]);
  });
  it('by id: a position without a live row gets none', () => {
    expect(matchLiveRows([{ id: 1, symbol: 'A' }, { id: 2, symbol: 'B' }], [row({ id: 2, symbol: 'B' })]).map((r) => r?.symbol)).toEqual([undefined, 'B']);
  });
  it('no ids: index order when the symbol agrees, else by symbol', () => {
    const rows = [row({ symbol: 'USD', valueIls: 1 }), row({ symbol: 'USD', valueIls: 2 }), row({ symbol: 'VOO', valueIls: 3 })];
    expect(matchLiveRows([{ symbol: 'USD' }, { symbol: 'USD' }, { symbol: 'VOO' }], rows).map((r) => r?.valueIls)).toEqual([1, 2, 3]);
    expect(matchLiveRows([{ symbol: 'VOO' }, { symbol: 'USD' }], rows).map((r) => r?.valueIls)).toEqual([3, 2]);
  });
  it('rows have ids but an older hub sends positions without: falls back', () => {
    expect(matchLiveRows([{ symbol: 'VOO' }], [row({ id: 5 })]).map((r) => r?.symbol)).toEqual(['VOO']);
  });
});
