/**
 * Bill calendar (wave 5, research_notes/proposals/bill-calendar.md): the month's fixed money by day. A week grid on
 * wide screens, a list of days on the phone. Card items show on the day they hit the card; the money leaves the bank
 * in the card bill, so only the bill counts in the day's totals and in the balance line.
 */
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { api, qs } from '../api';
import { money } from '../format';
import { useI18n } from '../i18n';
import type { BillCalendar, CalendarDay, CalendarItem } from '../types';
import { Amount, Card, Empty, ErrorBox, Spinner } from './ui';

const STATUS_CLASS: Record<CalendarItem['status'], string> = { paid: 'text-muted', upcoming: '', missing: 'text-warn' };

export function BillCalendarView({ month }: { month: string }) {
  const { t, locale } = useI18n();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['calendar', month], queryFn: () => api.get<BillCalendar>(`/api/calendar${qs({ month })}`) });
  if (q.isPending) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const cal = q.data;
  const any = cal.days.some((d) => d.items.length);
  const open = (it: CalendarItem) => {
    if (it.txnId) return nav(`/transactions${qs({ month, open: it.txnId })}`);
    if (it.streamId) return nav(`/transactions${qs({ streamId: it.streamId })}`);
    if (it.planId) return nav('/recurring');
  };
  const weekday = (date: string, style: 'short' | 'narrow' = 'short') => new Intl.DateTimeFormat(locale, { weekday: style, timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
  const dayNum = (date: string) => Number(date.slice(8, 10));

  const ItemLine = ({ it, compact = false }: { it: CalendarItem; compact?: boolean }) => (
    <button type="button" onClick={() => open(it)} className={`w-full flex items-baseline gap-1 text-start ${compact ? 'text-[11px] leading-tight' : 'text-sm'} ${STATUS_CLASS[it.status]}`}>
      <span className="shrink-0">{it.status === 'paid' ? '✓' : it.status === 'missing' ? '!' : it.kind === 'income' ? '↓' : '•'}</span>
      <span className="flex-1 min-w-0 truncate" dir="auto">
        {it.kind === 'card_bill' ? `${t('cal_card_bill')} ${it.name}` : it.name}
        {it.via === 'card' && it.kind !== 'card_bill' ? ' 💳' : ''}
      </span>
      <Amount value={it.amount} decimals={0} tone={it.amount > 0 ? 'pos' : it.status === 'missing' ? 'neg' : 'neutral'} className="shrink-0" />
    </button>
  );

  // the grid starts on Sunday, as the week does in Israel
  const leading = new Date(`${cal.days[0]!.date}T00:00:00Z`).getUTCDay();
  const cells: Array<CalendarDay | null> = [...Array.from({ length: leading }, () => null), ...cal.days];

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <span>
            <span className="text-muted">{t('cal_out')} </span>
            <Amount value={-cal.totals.out} decimals={0} tone="neutral" />
          </span>
          <span>
            <span className="text-muted">{t('cal_in')} </span>
            <Amount value={cal.totals.in} decimals={0} tone="pos" />
          </span>
          {cal.isCurrentMonth && (
            <span>
              <span className="text-muted">{t('cal_to_come')} </span>
              <Amount value={-cal.totals.toComeOut} decimals={0} tone="neutral" />
              {cal.totals.toComeIn > 0 && (
                <>
                  {' · '}
                  <Amount value={cal.totals.toComeIn} decimals={0} tone="pos" />
                </>
              )}
            </span>
          )}
        </div>
        {cal.balance && <BalanceLine balance={cal.balance} />}
      </Card>

      {!any ? (
        <Empty>{t('cal_empty')}</Empty>
      ) : (
        <>
          {/* wide screens: the month as weeks */}
          <div className="hidden md:grid grid-cols-7 gap-1">
            {/* Sunday to Saturday: 2026-11-15 was a Sunday */}
            {Array.from({ length: 7 }, (_, i) => (
              <div key={`h${i}`} className="text-xs text-muted text-center pb-1">
                {weekday(`2026-11-${15 + i}`)}
              </div>
            ))}
            {cells.map((d, i) =>
              d ? (
                <div key={d.date} className={`rounded-md border border-border p-1.5 min-h-[5.5rem] flex flex-col gap-0.5 ${d.date === cal.today ? 'ring-1 ring-accent' : ''}`}>
                  <div className="flex justify-between text-xs">
                    <span className={d.date === cal.today ? 'font-semibold' : 'text-muted'}>{dayNum(d.date)}</span>
                    {d.out > 0 && <span className="text-muted num">{money(-d.out, { decimals: 0 })}</span>}
                  </div>
                  {d.items.map((it, j) => (
                    <ItemLine key={j} it={it} compact />
                  ))}
                </div>
              ) : (
                <div key={`e${i}`} />
              ),
            )}
          </div>

          {/* phone: only the days that have something */}
          <div className="md:hidden flex flex-col gap-2">
            {cal.days
              .filter((d) => d.items.length)
              .map((d) => (
                <Card key={d.date}>
                  <div className="flex justify-between text-sm mb-1">
                    <span className={d.date === cal.today ? 'font-semibold' : 'text-muted'}>
                      {weekday(d.date)} {dayNum(d.date)}
                    </span>
                    <span className="num text-muted">
                      {d.out > 0 ? money(-d.out, { decimals: 0 }) : ''}
                      {d.in > 0 ? ` +${money(d.in, { decimals: 0 })}` : ''}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1">
                    {d.items.map((it, j) => (
                      <ItemLine key={j} it={it} />
                    ))}
                  </div>
                </Card>
              ))}
          </div>
          <p className="text-xs text-muted">{t('cal_note')}</p>
        </>
      )}
    </div>
  );
}

/** The bank balance from today to the month's end, with its lowest point. */
function BalanceLine({ balance }: { balance: NonNullable<BillCalendar['balance']> }) {
  const { t, locale } = useI18n();
  const pts = balance.points;
  const W = 300;
  const H = 48;
  const lo = Math.min(0, ...pts.map((p) => p.balance));
  const hi = Math.max(0, ...pts.map((p) => p.balance));
  const span = hi - lo || 1;
  const x = (i: number) => (pts.length < 2 ? W / 2 : (i / (pts.length - 1)) * W);
  const y = (v: number) => H - ((v - lo) / span) * H;
  const lowIdx = pts.findIndex((p) => p.date === balance.lowest.date);
  const day = (date: string) => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-48 h-12 shrink-0" aria-hidden="true">
        {lo < 0 && <line x1={0} x2={W} y1={y(0)} y2={y(0)} stroke="currentColor" strokeOpacity={0.25} strokeDasharray="3 3" />}
        <polyline fill="none" stroke="currentColor" strokeWidth={2} points={pts.map((p, i) => `${x(i)},${y(p.balance)}`).join(' ')} />
        {lowIdx >= 0 && <circle cx={x(lowIdx)} cy={y(balance.lowest.balance)} r={3.5} className={balance.lowest.balance < 0 ? 'fill-[var(--neg,#f87171)]' : 'fill-current'} />}
      </svg>
      <div className="text-sm">
        <div>
          <span className="text-muted">{t('cal_balance_now')} </span>
          <Amount value={pts[0]?.balance ?? balance.start} decimals={0} tone="auto" />
        </div>
        <div>
          <span className="text-muted">{t('cal_lowest', { date: day(balance.lowest.date) })} </span>
          <Amount value={balance.lowest.balance} decimals={0} tone={balance.lowest.balance < 0 ? 'neg' : 'auto'} />
        </div>
      </div>
    </div>
  );
}
