import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router';
import { BillCalendarView } from '../components/BillCalendar';
import { api, qs } from '../api';
import { MonthNav, useMonth } from '../components/MonthNav';
import { Amount, Card, Chip, Empty, ErrorBox, Row, Spinner } from '../components/ui';
import { money, shortDate } from '../format';
import { type Key, useI18n } from '../i18n';
import type { RecurringOverview, StreamView } from '../types';

const todayMonth = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);

/**
 * Recurring: one calm line per stream (name, amount, this month's status as plain text), the
 * month's committed total in the header. Candidates first, because they need a decision.
 */
export function Recurring() {
  const { t } = useI18n();
  const [month, setMonth] = useMonth(todayMonth());
  const q = useQuery({ queryKey: ['recurring', month], queryFn: () => api.get<RecurringOverview>(`/api/recurring${qs({ month })}`) });
  const qc = useQueryClient();
  const nav = useNavigate();
  // List / Calendar (bill calendar, wave 5); kept in the URL so the back button and a shared link keep it
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'calendar' ? 'calendar' : 'list';
  const tabs = (
    <div className="flex gap-2">
      <Chip on={view === 'list'} onClick={() => setParams((p) => (p.delete('view'), p), { replace: true })}>
        {t('rec_tab_list')}
      </Chip>
      <Chip on={view === 'calendar'} onClick={() => setParams((p) => (p.set('view', 'calendar'), p), { replace: true })}>
        {t('rec_tab_calendar')}
      </Chip>
    </div>
  );
  const setState = useMutation({
    mutationFn: (p: { id: number; state: string }) => api.post(`/api/recurring/${p.id}/state`, { state: p.state }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['recurring'] });
      void qc.invalidateQueries({ queryKey: ['hub'] });
      void qc.invalidateQueries({ queryKey: ['review'] });
    },
  });
  if (view === 'calendar')
    return (
      <div className="flex flex-col gap-3">
        <header className="flex flex-wrap items-center gap-3 justify-between">
          <MonthNav month={month} onChange={setMonth} />
          {tabs}
        </header>
        <BillCalendarView month={month} />
      </div>
    );
  if (q.isPending) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const confirmed = d.streams.filter((s) => s.state === 'confirmed');
  const expenses = confirmed.filter((s) => s.direction === 'expense');
  const income = confirmed.filter((s) => s.direction === 'income');
  const candidates = d.streams.filter((s) => s.state === 'candidate');
  const paused = d.streams.filter((s) => s.state === 'paused');
  const activePlans = d.plans.filter((p) => p.status === 'active');

  const status = (s: StreamView): { text: string; cls: string } => {
    const st = s.thisMonth.status;
    if (st === 'matched') return { text: `✓ ${s.thisMonth.expectedDate ? shortDate(s.thisMonth.expectedDate) : t('matched')}`, cls: 'text-pos' };
    if (st === 'missing') return { text: t('missing'), cls: 'text-warn' };
    if (st === 'upcoming') return { text: `${t('upcoming_one')} ${s.thisMonth.expectedDate ? shortDate(s.thisMonth.expectedDate) : ''}`, cls: 'text-muted' };
    return { text: s.nextExpectedDate ? `${t('next')} ${shortDate(s.nextExpectedDate)}` : t('not_this_month'), cls: 'text-muted' };
  };

  const StreamRow = ({ s }: { s: StreamView }) => {
    const st = status(s);
    return (
      <Row onClick={() => nav(`/transactions${qs({ streamId: s.id })}`)}>
        <div className="flex-1 min-w-0">
          <div className="truncate" dir="auto">
            {s.label ?? s.merchantName}
          </div>
          <div className="text-xs text-muted">
            {t(`freq_${s.frequency}` as Key)}
            {s.expectedDay ? ` · ${s.expectedDay}` : ''}
            {s.priceChange ? <span className="text-warn"> · {t('price_change', { from: money(s.priceChange.from), to: money(s.priceChange.to) })}</span> : null}
          </div>
        </div>
        <div className="text-end shrink-0">
          <Amount value={s.thisMonth.status === 'matched' && s.thisMonth.actualAmount !== null ? s.thisMonth.actualAmount : s.expectedAmount} tone={s.direction === 'income' ? 'pos' : 'neutral'} decimals={0} />
          <div className={`text-xs ${st.cls}`}>{st.text}</div>
        </div>
      </Row>
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-wrap items-center gap-3 justify-between">
        <MonthNav month={month} onChange={setMonth} />
        {tabs}
        <span className="text-sm text-muted">
          {t('fixed_expenses')} <Amount value={d.audit.monthlyFixed} decimals={0} tone="muted" /> {t('monthly')}
        </span>
      </header>
      {candidates.length > 0 && (
        <Card title={`${t('candidates')} (${candidates.length})`}>
          <div className="flex flex-col divide-y divide-border">
            {candidates.map((s) => (
              <Row key={s.id}>
                <span className="flex-1 min-w-0 truncate" dir="auto">
                  {s.merchantName} <span className="text-muted text-xs">· {t(`freq_${s.frequency}` as Key)} · ×{s.occurrences}</span>
                </span>
                <Amount value={s.expectedAmount} decimals={0} />
                <button className="btn btn-sm btn-primary" onClick={() => setState.mutate({ id: s.id, state: 'confirmed' })}>
                  {t('confirm_stream')}
                </button>
                <button className="btn btn-sm" onClick={() => setState.mutate({ id: s.id, state: 'rejected' })}>
                  {t('reject_stream')}
                </button>
              </Row>
            ))}
          </div>
        </Card>
      )}
      <Card title={`${t('fixed_expenses')} (${expenses.length})`}>
        {expenses.length ? <div className="flex flex-col divide-y divide-border">{expenses.map((s) => <StreamRow key={s.id} s={s} />)}</div> : <Empty>{t('no_data')}</Empty>}
      </Card>
      <Card title={`${t('installments')} (${activePlans.length})`}>
        {d.plans.length ? (
          <div className="flex flex-col divide-y divide-border">
            {d.plans.map((p) => {
              const st = p.thisMonth.status;
              const text = st === 'matched' ? `✓ ${p.thisMonth.n}/${p.totalN}` : st === 'upcoming' ? `${t('upcoming_one')} ${p.thisMonth.n}/${p.totalN}` : st === 'missing' ? `${t('missing')} ${p.thisMonth.n}/${p.totalN}` : p.nextDate ? `${t('next')} ${shortDate(p.nextDate)}` : '—';
              const cls = st === 'matched' ? 'text-pos' : st === 'missing' ? 'text-warn' : 'text-muted';
              return (
                <Row key={p.id} onClick={() => nav(`/transactions${qs({ planId: p.id })}`)}>
                  <div className="flex-1 min-w-0">
                    <div className="truncate" dir="auto">
                      {p.merchantName}
                    </div>
                    <div className="text-xs text-muted">
                      {p.seenN}/{p.totalN}
                      {p.endsMonth ? ` · ${t('ends')} ${p.endsMonth}` : ''} · {t('remaining')} {money(p.remainingAmount, { decimals: 0 })}
                    </div>
                  </div>
                  <div className="text-end shrink-0">
                    <Amount value={p.sliceAmount} decimals={0} />
                    <div className={`text-xs ${cls}`}>{text}</div>
                  </div>
                </Row>
              );
            })}
          </div>
        ) : (
          <Empty>{t('no_data')}</Empty>
        )}
      </Card>
      <Card title={`${t('fixed_income')} (${income.length})`}>
        {income.length ? <div className="flex flex-col divide-y divide-border">{income.map((s) => <StreamRow key={s.id} s={s} />)}</div> : <Empty>{t('no_data')}</Empty>}
      </Card>
      {paused.length > 0 && (
        <Card title={t('pause_stream')}>
          {paused.map((s) => (
            <Row key={s.id}>
              <span className="flex-1" dir="auto">
                {s.merchantName}
              </span>
              <Amount value={s.expectedAmount} decimals={0} />
              <button className="btn btn-sm" onClick={() => setState.mutate({ id: s.id, state: 'confirmed' })}>
                {t('confirm_stream')}
              </button>
            </Row>
          ))}
        </Card>
      )}
      <p className="text-xs text-muted">{t('subscriptions_audit')}: {money(d.audit.yearlySubscriptions, { decimals: 0 })} {t('yearly')}</p>
    </div>
  );
}
