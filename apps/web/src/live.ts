/**
 * Live holding values (prices from the market on top of the bank's morning snapshot): the pure parts —
 * which freshness label to show, the green/red tone of a change, percent text, how often to refetch,
 * and net worth totals with live values swapped in. No React here so it is easy to test.
 */
import type { Key } from './i18n';
import type { HoldingView, LiveHoldingRow, LiveHoldings, LiveState, NetWorthLine, NetWorthOverview } from './types';

type T = (key: Key, vars?: Record<string, string | number>) => string;

/** A live price older than this while the market is open is no longer called "live". */
export const LIVE_FRESH_MS = 15 * 60_000;
export const REFETCH_OPEN_MS = 60_000;
export const REFETCH_CLOSED_MS = 10 * 60_000;

/** 14:32 for today, 10.11 14:32 for another day (local time, 24h). */
export function stamp(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? hm : `${d.getDate()}.${d.getMonth() + 1} ${hm}`;
}

export type FreshnessKind = 'live' | 'stale' | 'closed' | 'bank';
export interface Freshness {
  kind: FreshnessKind;
  text: string;
}

/**
 * The label in the holdings header.
 * - bank: the market feed is unavailable, or no row has a live price — the bank's prices are shown (time of the bank snapshot).
 * - live: the market is open and the prices are recent.
 * - stale: the market is open but the last price is older than LIVE_FRESH_MS.
 * - closed: the market is closed; the prices are the last trade.
 */
export function freshness(live: LiveHoldings, bankTakenAt: string | null, t: T, now: Date = new Date()): Freshness {
  const allBank = live.rows.length > 0 && live.rows.every((r) => r.source === 'bank');
  if (live.marketState === 'unavailable' || allBank || !live.asOf) {
    const at = bankTakenAt ?? live.asOf;
    return { kind: 'bank', text: at ? t('live_bank_at', { t: stamp(at, now) }) : t('live_bank') };
  }
  if (live.marketState === 'closed') return { kind: 'closed', text: t('live_closed') };
  const age = now.getTime() - Date.parse(live.asOf);
  if (age <= LIVE_FRESH_MS) return { kind: 'live', text: t('live_at', { t: stamp(live.asOf, now) }) };
  return { kind: 'stale', text: t('live_stale_at', { t: stamp(live.asOf, now) }) };
}

/** How often the open holdings sheet asks again: every minute while the market trades, else every 10 minutes. */
export function refetchMs(live: LiveHoldings | undefined): number {
  return live?.marketState === 'open' ? REFETCH_OPEN_MS : REFETCH_CLOSED_MS;
}

export type Tone = 'pos' | 'neg' | 'muted';
/** Green for up, red for down, muted for flat or unknown. */
export function gainTone(v: number | null | undefined): Tone {
  if (v === null || v === undefined || Number.isNaN(v) || v === 0) return 'muted';
  return v > 0 ? 'pos' : 'neg';
}
export const toneClass = (tone: Tone): string => (tone === 'pos' ? 'text-pos' : tone === 'neg' ? 'text-neg' : 'text-muted');

/** +1.23% / −0.40% / – (null). */
export function pctText(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '–';
  const abs = Math.abs(v).toFixed(digits);
  if (Number(abs) === 0) return `${(0).toFixed(digits)}%`;
  return `${v > 0 ? '+' : '−'}${abs}%`;
}

/** The value shown for an account or a net worth line: the live one when the hub sent it. */
export function shownValue(v: { value: number; liveValueIls?: number | undefined }): number {
  return typeof v.liveValueIls === 'number' ? v.liveValueIls : v.value;
}

/**
 * Net worth totals with live values in place of the snapshot for the lines that have one
 * (assets only — securities and FX accounts are assets). The history line is left as recorded.
 */
export function liveTotals(d: Pick<NetWorthOverview, 'total' | 'assets' | 'liabilities'> & { lines: NetWorthLine[] }): { total: number; assets: number; liabilities: number; live: boolean } {
  let delta = 0;
  let live = false;
  for (const l of d.lines) {
    if (typeof l.liveValueIls !== 'number' || l.side !== 'asset') continue;
    delta += l.liveValueIls - l.value;
    live = true;
  }
  return { total: d.total + delta, assets: d.assets + delta, liabilities: d.liabilities, live };
}

/**
 * The tag on an account card or a net worth line priced live: green "Live · 14:32" only when the hub says
 * 'live' and the price is at most LIVE_FRESH_MS old; otherwise grey "Last price · 14:32".
 * A hub that sends no liveState is treated as 'live' (still subject to the age check).
 */
export function liveTag(liveState: LiveState | undefined, liveAsOf: string | undefined, t: T, now: Date = new Date()): { kind: 'live' | 'closed'; text: string } {
  const fresh = liveAsOf !== undefined && now.getTime() - Date.parse(liveAsOf) <= LIVE_FRESH_MS;
  if ((liveState ?? 'live') === 'live' && fresh && liveAsOf) return { kind: 'live', text: t('live_at', { t: stamp(liveAsOf, now) }) };
  return { kind: 'closed', text: liveAsOf ? t('live_stale_at', { t: stamp(liveAsOf, now) }) : t('live_closed') };
}

/**
 * The live row for each position, in the positions' order. By id (holding_snapshot row id) when the live
 * rows and the positions carry one — two USD rows can share a symbol. Without ids, by index order (only if the symbol agrees
 * at that index), then by the first unused row with the same symbol.
 */
export function matchLiveRows(positions: Pick<HoldingView, 'id' | 'symbol'>[], rows: LiveHoldingRow[]): Array<LiveHoldingRow | undefined> {
  if (rows.length && rows.every((r) => typeof r.id === 'number') && positions.some((p) => typeof p.id === 'number')) {
    const byId = new Map(rows.map((r) => [r.id, r]));
    return positions.map((p) => (typeof p.id === 'number' ? byId.get(p.id) : undefined));
  }
  const used = new Set<number>();
  return positions.map((p, i) => {
    let j = rows[i] && rows[i].symbol === p.symbol && !used.has(i) ? i : -1;
    if (j < 0) j = rows.findIndex((r, k) => !used.has(k) && r.symbol === p.symbol);
    if (j < 0) return undefined;
    used.add(j);
    return rows[j];
  });
}
