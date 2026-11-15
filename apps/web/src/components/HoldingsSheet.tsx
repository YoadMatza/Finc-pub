import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Area, AreaChart, ResponsiveContainer, Tooltip, YAxis } from 'recharts';
import { api } from '../api';
import { currencySymbol as sym, dayLabel, foreignMoney, money, relTime } from '../format';
import { badgeCount } from '../holdingRules';
import { useI18n } from '../i18n';
import { freshness, gainTone, matchLiveRows, pctText, refetchMs, toneClass } from '../live';
import type { HoldingView, HoldingsOverview, LiveHoldingRow, LiveHoldings } from '../types';
import { InsightsView } from './InsightsView';
import { Amount, Bar, Empty, LiveTag, Sheet, Spinner } from './ui';

const fmt = (n: number, digits = 2) => n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: n % 1 === 0 ? 0 : Math.min(2, digits) });

/**
 * What is inside a securities or foreign-currency account (design §6): each position with quantity, price,
 * value in shekels and in its currency, change against cost and today, its share of the account, and the
 * account's value over the recorded days. Filled by the FIBI pages read on every sync; on a newer hub the
 * prices are live (`live`), refreshed every minute while the sheet is open and the market trades.
 */
export function HoldingsSheet({ accountId, title, onClose }: { accountId: number | null; title: string; onClose: () => void }) {
  const { t, locale } = useI18n();
  // the security whose insights are open (by row id), inside this same sheet; back returns to the list
  const [open, setOpen] = useState<{ accountId: number; id: number } | null>(null);
  const q = useQuery({
    queryKey: ['holdings', accountId],
    queryFn: () => api.get<HoldingsOverview>(`/api/accounts/${accountId}/holdings`),
    enabled: accountId !== null,
    // only while the sheet is open (enabled), never in the background
    refetchInterval: (query) => (accountId === null ? false : refetchMs(query.state.data?.live)),
    refetchIntervalInBackground: false,
  });
  const d = q.data;
  const live = d?.live;
  const matched = d && live ? matchLiveRows(d.positions, live.rows) : [];
  const total = live ? live.totalIls : (d?.totalIls ?? 0);
  const close = () => {
    setOpen(null);
    onClose();
  };
  // a selection from another account (or a row that is gone after a refetch) shows the list
  const selIdx = open && d && open.accountId === accountId ? d.positions.findIndex((p) => p.id === open.id && p.kind === 'security') : -1;
  if (d && selIdx >= 0) {
    const p = d.positions[selIdx]!;
    const r = matched[selIdx];
    return (
      <Sheet open={accountId !== null} onClose={close} title={`${p.symbol} · ${t('ins_open')}`}>
        <InsightsView p={p} r={r} share={r && total ? r.valueIls / total : p.share} onBack={() => setOpen(null)} />
      </Sheet>
    );
  }
  const select = (p: HoldingView) => (accountId !== null && p.kind === 'security' && p.id !== undefined ? () => setOpen({ accountId, id: p.id! }) : undefined);
  return (
    <Sheet open={accountId !== null} onClose={close} title={title}>
      {q.isPending || !d ? (
        <Spinner />
      ) : d.positions.length === 0 ? (
        <Empty>{t('holdings_none')}</Empty>
      ) : (
        <div className="flex flex-col gap-4 text-sm">
          {live ? (
            <LiveHeader live={live} bankTakenAt={d.takenAt} />
          ) : (
            <div className="flex items-baseline justify-between gap-3">
              <Amount value={d.totalIls} tone="neutral" className="text-2xl font-bold" decimals={0} />
              <span className="text-xs text-muted">{d.takenAt ? t('holdings_as_of', { d: relTime(d.takenAt, locale) }) : ''}</span>
            </div>
          )}
          {d.history.length > 1 && (
            <div className="h-20 -mx-2" dir="ltr">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={d.history} margin={{ top: 2, right: 2, bottom: 0, left: 2 }}>
                  <YAxis hide domain={['dataMin', 'dataMax']} />
                  <Tooltip contentStyle={{ background: '#171a21', border: '1px solid #262b36', borderRadius: 8, fontSize: 12 }} formatter={(v) => [money(Number(v), { decimals: 0 }), t('holdings_value')]} labelFormatter={(l, p) => dayLabel(String(p?.[0]?.payload?.date ?? l), locale)} />
                  <Area type="monotone" dataKey="totalIls" stroke="#2dd4bf" fill="#2dd4bf22" strokeWidth={1.5} isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
          <div className="flex flex-col divide-y divide-border">
            {d.positions.map((p, i) => {
              const r = matched[i];
              const key = p.id ?? `${p.symbol}-${i}`;
              return r ? <LivePosition key={key} p={p} r={r} share={total ? r.valueIls / total : p.share} onOpen={select(p)} /> : <Position key={key} p={p} onOpen={select(p)} />;
            })}
          </div>
          {d.positions.some((p) => select(p)) && <p className="text-[11px] text-muted -mt-2">{t('ins_tap_hint')}</p>}
        </div>
      )}
    </Sheet>
  );
}

/** The live total, its gain since purchase and today, the dollar rate used and how fresh the prices are. */
function LiveHeader({ live, bankTakenAt }: { live: LiveHoldings; bankTakenAt: string | null }) {
  const { t } = useI18n();
  const f = freshness(live, bankTakenAt, t);
  // the server's percentages: the gain is in dollars at today's rate, so it cannot be derived from the ₪ totals here
  const gainPct = live.gainPct ?? null;
  const dayPct = live.dayChangePct ?? null;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <Amount value={live.totalIls} tone="neutral" className="text-2xl font-bold" decimals={0} />
        <LiveTag text={f.text} kind={f.kind} />
      </div>
      <div className="flex items-start gap-x-4 gap-y-1 flex-wrap text-xs">
        {live.gainIls !== null && (
          <span className="flex flex-col">
            <span className="flex items-baseline gap-1.5">
              <span className="text-muted">{t('live_gain')}</span>
              <span className={`num ${toneClass(gainTone(live.gainIls))}`} dir="ltr">
                {money(live.gainIls, { sign: 'always', decimals: 0 })}
                {gainPct !== null ? ` (${pctText(gainPct)})` : ''}
              </span>
            </span>
            {live.gainBasis === 'usd_at_today_rate' && <span className="text-[11px] text-muted">{t('live_gain_basis')}</span>}
          </span>
        )}
        {live.dayChangeIls !== null && (
          <span className="flex items-baseline gap-1.5 self-start">
            <span className="text-muted">{t('live_day')}</span>
            <span className={`num ${toneClass(gainTone(live.dayChangeIls))}`} dir="ltr">
              {money(live.dayChangeIls, { sign: 'always', decimals: 0 })}
              {dayPct !== null ? ` (${pctText(dayPct)})` : ''}
            </span>
          </span>
        )}
        {live.fx && (
          <span className="text-muted num ms-auto" dir="ltr">
            {t('live_fx', { r: live.fx.rate.toFixed(3) })}
          </span>
        )}
      </div>
    </div>
  );
}

/** A position priced live: price, value in its currency and in shekels, gain since purchase and today's move. */
function LivePosition({ p, r, share, onOpen }: { p: HoldingView; r: LiveHoldingRow; share: number; onOpen: (() => void) | undefined }) {
  const { t } = useI18n();
  const cur = r.currency || p.currency;
  const bank = r.source === 'bank';
  const priceDigits = p.kind === 'currency' ? 4 : 2;
  return (
    <PositionRow onOpen={onOpen}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 flex items-baseline gap-2">
          <span className="font-semibold num shrink-0" dir="ltr">
            {p.symbol}
          </span>
          <RulesBadge n={p.rulesApplying} />
          <span className="text-muted truncate" dir="auto">
            {p.name}
          </span>
        </span>
        <span className="text-end shrink-0">
          <Amount value={r.valueIls} tone="neutral" decimals={0} className="block" />
          {r.valueOrig !== null && cur !== 'ILS' && (
            <span className="block text-xs text-muted num" dir="ltr">
              {foreignMoney(r.valueOrig, cur)}
            </span>
          )}
        </span>
      </div>
      <div className="flex items-center gap-3 text-xs text-muted flex-wrap">
        <span className="num" dir="ltr">
          {p.kind === 'currency' ? `${fmt(p.quantity)} ${p.currency} × ${r.price !== null ? fmt(r.price, priceDigits) : '?'}` : `${fmt(p.quantity, 4)} × ${r.price !== null ? foreignMoney(r.price, cur, { decimals: priceDigits }) : '?'}`}
        </span>
        {bank && <span className="text-[11px] italic opacity-80">{t('live_bank_row')}</span>}
        <span className="flex-1" />
        {(r.dayChangeOrig !== null || r.dayChangePct !== null) && (
          <span className={`num ${toneClass(gainTone(r.dayChangePct ?? r.dayChangeOrig))}`} dir="ltr" title={t('live_day')}>
            {r.dayChangeOrig !== null ? `${foreignMoney(r.dayChangeOrig, cur, { sign: 'always' })} ` : ''}
            {pctText(r.dayChangePct)}
          </span>
        )}
        {(r.gainOrig !== null || r.gainPct !== null) && (
          <span className={`num font-semibold ${toneClass(gainTone(r.gainPct ?? r.gainOrig))}`} dir="ltr" title={t('live_gain')}>
            {r.gainOrig !== null ? `${foreignMoney(r.gainOrig, cur, { sign: 'always' })} ` : ''}
            {pctText(r.gainPct)}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Bar value={share} max={1} className="flex-1" />
        <span className="text-[11px] text-muted num w-10 text-end">{Math.round(share * 100)}%</span>
      </div>
    </PositionRow>
  );
}

/** A position row; a security with insights opens them on tap (or Enter), currency rows stay plain. */
function PositionRow({ onOpen, children }: { onOpen: (() => void) | undefined; children: ReactNode }) {
  const { t } = useI18n();
  if (!onOpen) return <div className="py-3 flex flex-col gap-1.5">{children}</div>;
  return (
    <div
      className="py-3 px-2 -mx-2 rounded-lg flex flex-col gap-1.5 row-link cursor-pointer"
      role="button"
      tabIndex={0}
      title={t('ins_open')}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      {children}
    </div>
  );
}

function Position({ p, onOpen }: { p: HoldingView; onOpen: (() => void) | undefined }) {
  const { t } = useI18n();
  return (
    <PositionRow onOpen={onOpen}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 flex items-baseline gap-2">
          <span className="font-semibold num shrink-0" dir="ltr">
            {p.symbol}
          </span>
          <RulesBadge n={p.rulesApplying} />
          <span className="text-muted truncate" dir="auto">
            {p.name}
          </span>
        </span>
        <span className="text-end shrink-0">
          <Amount value={p.valueIls} tone="neutral" decimals={0} className="block" />
          {p.valueOrig !== null && p.currency !== 'ILS' && (
            <span className="block text-xs text-muted num" dir="ltr">
              {sym(p.currency)}
              {fmt(p.valueOrig)}
            </span>
          )}
        </span>
      </div>
      <div className="flex items-center gap-3 text-xs text-muted">
        <span className="num" dir="ltr">
          {p.kind === 'currency' ? `${fmt(p.quantity)} ${p.currency} × ${p.price !== null ? fmt(p.price, 4) : '?'}` : `${fmt(p.quantity, 4)} × ${p.price !== null ? `${sym(p.currency)}${fmt(p.price)}` : '?'}`}
        </span>
        {p.kind === 'security' && p.costPrice !== null && (
          <span className="num" dir="ltr">
            {t('holdings_cost')} {sym(p.currency)}
            {fmt(p.costPrice)}
          </span>
        )}
        <span className="flex-1" />
        {p.kind === 'security' && (
          <>
            <span className={`num ${toneClass(gainTone(p.dailyChangePct))}`} dir="ltr" title={t('holdings_daily')}>
              {pctText(p.dailyChangePct)}
            </span>
            <span className={`num font-semibold ${toneClass(gainTone(p.fromCostPct))}`} dir="ltr" title={t('holdings_from_cost')}>
              {pctText(p.fromCostPct)}
            </span>
          </>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Bar value={p.share} max={1} className="flex-1" />
        <span className="text-[11px] text-muted num w-10 text-end">{Math.round(p.share * 100)}%</span>
      </div>
    </PositionRow>
  );
}

/** How many of the owner's own rules apply to this holding (neutral accent outline; nothing when none). */
function RulesBadge({ n }: { n: number | undefined }) {
  const { t } = useI18n();
  const c = badgeCount(n);
  if (c === null) return null;
  const label = t('hr_badge', { n: c });
  return (
    <span className="shrink-0 self-center inline-flex items-center gap-1 rounded-full border border-accent/70 text-accent bg-accent/10 px-1.5 text-[10px] leading-4 num" title={label} aria-label={label}>
      <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M4 6l2 2 3-3M4 13l2 2 3-3M12 7h8M12 14h8M12 20h8" />
      </svg>
      {c}
    </span>
  );
}
