import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, qs } from '../api';
import { LimitCard, LimitSetLink } from '../components/LimitCard';
import { MonthNav, useMonth } from '../components/MonthNav';
import { NowSplit, SpreadNote } from '../components/NowSplit';
import { Icon } from '../components/Shell';
import { TxnList } from '../components/TxnList';
import { Amount, Bar, Card, Chip, Empty, ErrorBox, Row, Spinner } from '../components/ui';
import { dayLabel, money, relTime, shortDate } from '../format';
import { type Key, useI18n } from '../i18n';
import { errorText } from '../limits';
import { type WeeklyLine, weeklyLine } from '../nowCard';
import type { Health, HubOverview, Insight } from '../types';

const todayMonth = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);

/**
 * Now: one hero number (variable left this month) with one comparison (same day last month),
 * then the month as a waterfall: income, committed (fixed + installments), savings, the variable
 * groups, what is not counted, and the projected end. Every line opens the transactions behind it.
 * Attention, the spend line, upcoming and recent sit below (behind "more" on the phone).
 */
export function Hub() {
  const { t, locale } = useI18n();
  const [month, setMonth] = useMonth(todayMonth());
  const [sp, setSp] = useSearchParams();
  const view = (sp.get('view') as 'purchase' | 'billing' | null) ?? 'purchase';
  const nav = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['hub', month, view], queryFn: () => api.get<HubOverview>(`/api/hub${qs({ month, view })}`) });
  const health = useQuery({ queryKey: ['health'], queryFn: () => api.get<Health>('/api/health'), refetchInterval: 30_000 });
  const dismiss = useMutation({ mutationFn: (key: string) => api.post('/api/insights/dismiss', { key, month, view }), onSuccess: () => qc.invalidateQueries({ queryKey: ['hub'] }) });
  // P2-02: a manual sync away from home can be capped; the refusal says when it works again
  const [syncErr, setSyncErr] = useState<string | null>(null);
  const sync = useMutation({ mutationFn: () => api.post('/api/sync', {}), onMutate: () => setSyncErr(null), onError: (e) => setSyncErr(errorText(e, 'sync', t, locale)), onSettled: () => qc.invalidateQueries({ queryKey: ['health'] }) });
  const [more, setMore] = useState(() => {
    try {
      return localStorage.getItem('finc.hubMore') === '1';
    } catch {
      return false;
    }
  });
  const toggleMore = () => {
    setMore((m) => {
      try {
        localStorage.setItem('finc.hubMore', m ? '0' : '1');
      } catch {
        /* ignore */
      }
      return !m;
    });
  };

  if (q.isPending) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const h = q.data;
  const s = h.summary;
  const f = h.forecast;
  const signed = (v: number) => money(v, { sign: 'auto', decimals: 0 });
  // chart: cumulative outflow to today (solid), then the usual-pace projection to the end of the month (dashed)
  const chart = (() => {
    const actual = h.daily.filter((d) => d.date <= h.today).map((d) => ({ date: d.date, actual: d.cumulative, projected: null as number | null }));
    if (!f.isCurrentMonth || actual.length === 0) return actual;
    const last = actual[actual.length - 1]!;
    const remainingOut = f.variable.remaining + f.committed.fixedExpected + f.committed.installmentsExpected + f.savings.planned;
    const endDate = `${h.month}-${String(f.dim).padStart(2, '0')}`;
    last.projected = last.actual;
    if (f.daysLeft > 1) actual.push({ date: endDate, actual: null as unknown as number, projected: last.actual + remainingOut });
    return actual;
  })();
  const weeklyText = (l: WeeklyLine): string => {
    const m = (v: number) => money(v, { decimals: 0 });
    switch (l.key) {
      case 'hero_formula':
        return t(l.key, { i: m(l.i), c: m(l.c), v: m(l.v) });
      case 'tight_line':
        return t(l.key, { r: m(l.r), b: m(l.b) });
      case 'this_week_of':
        return t(l.key, { a: m(l.a), b: m(l.b), n: l.n });
      case 'weekly_no_room_regular':
        return t(l.key, { w: m(l.w) });
      default:
        return t(l.key);
    }
  };
  const goTx = (params: Record<string, string | number | undefined>) => nav(`/transactions${qs({ month, view, ...params })}`);
  const incomeExpected = s.income.sum + s.expectedIncomeRemaining;
  const lastOk = health.data?.connections.filter((c) => c.lastOkAt).map((c) => c.lastOkAt!).sort().at(-1) ?? null;
  const groupLabel = (g: string) => (t(`group_${g}` as Key) === `group_${g}` ? g : t(`group_${g}` as Key));
  const fixedLine = h.breakdown.find((g) => g.group === 'fixed');
  const instLine = h.breakdown.find((g) => g.group === 'installments');
  const savingsLine = h.breakdown.find((g) => g.group === 'savings');
  const variableLines = h.breakdown.filter((g) => !['fixed', 'installments', 'savings'].includes(g.group) && (g.spent !== 0 || g.basis === 'targets'));
  const notCounted = s.excluded.settlements.count + s.excluded.transfers.count + s.excluded.refunds.count + s.excluded.other.count;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-3 justify-between">
        <MonthNav month={month} onChange={setMonth} min={h.months.first} max={h.months.last} />
        <div className="flex items-center gap-2 flex-wrap">
          <Chip on={view === 'purchase'} onClick={() => setSp((x) => ((x.set('view', 'purchase'), x)), { replace: true })}>
            {t('view_purchase')}
          </Chip>
          <Chip on={view === 'billing'} onClick={() => setSp((x) => ((x.set('view', 'billing'), x)), { replace: true })}>
            {t('view_billing')}
          </Chip>
          <span className="text-xs text-muted hidden md:inline">
            {t('last_sync')}: {lastOk ? relTime(lastOk, locale) : t('never')}
          </span>
          {health.data?.connections
            .filter((c) => c.enabled || c.lastOkAt)
            .map((c) => {
              const err = c.lastError && (!c.lastOkAt || (c.lastErrorAt ?? '') > c.lastOkAt);
              if (!err) return null;
              return (
                <Chip key={c.institutionId} tone="warn" onClick={() => nav('/accounts')}>
                  {c.displayName.replace(/\s*\(.*\)/, '')} ⚠
                </Chip>
              );
            })}
          <button className="btn btn-sm" onClick={() => nav('/chat')} title={t('nav_chat')} aria-label={t('nav_chat')}>
            <Icon name="chat" className="h-4 w-4" />
          </button>
          {health.data?.vault === 'unlocked' && (
            <button className="btn btn-sm hidden md:inline-flex" disabled={health.data.syncRunning || sync.isPending} onClick={() => sync.mutate()}>
              {health.data.syncRunning ? t('sync_running') : t('sync_now')}
            </button>
          )}
        </div>
        {syncErr && <div className="w-full text-xs text-neg md:text-end">{syncErr}</div>}
      </header>

      {/* --- the one number: cash in minus committed, savings and what is already spent */}
      <Card>
        <button className="text-start w-full" onClick={() => goTx({ bucket: 'variable' })}>
          <div className="text-xs text-muted uppercase tracking-wide">{!f.isCurrentMonth ? t('net') : h.limit ? t('hero_left_after_bills') : t('hero_left')}</div>
          <div className="mt-1 flex items-baseline gap-3 flex-wrap">
            {!f.isCurrentMonth ? (
              <Amount value={s.net} tone={s.net >= 0 ? 'pos' : 'neg'} sign="auto" className="text-4xl font-bold" decimals={0} />
            ) : f.state === 'short' ? (
              <span className="text-4xl font-bold text-neg num">−{money(-f.left, { decimals: 0 })}</span>
            ) : (
              <Amount value={f.left} tone={f.state === 'comfortable' ? 'pos' : 'neutral'} className="text-4xl font-bold" decimals={0} />
            )}
          </div>
        </button>
        {/* what the headline rests on: regular | extra, received vs expected, without the extra, a typical month */}
        {f.isCurrentMonth && <NowSplit h={h} headline={f.left} />}
        <button className="text-start w-full" onClick={() => goTx({ bucket: 'variable' })}>
          {f.isCurrentMonth && <IncomeBar f={f} />}
          <div className="text-sm text-muted mt-2">
            {!f.isCurrentMonth
              ? t('in_out', { i: money(s.income.sum, { decimals: 0 }), o: money(-(s.expense.sum + s.installments.sum + s.savings.sum), { decimals: 0 }) })
              : weeklyText(weeklyLine(f, h.spread))}
          </div>
        </button>
        {f.isCurrentMonth && (
          <div className="mt-3 pt-3 border-t border-border text-sm text-muted flex flex-col gap-1">
            <span>{f.early ? t('too_early') : t('projection_band', { p: signed(f.projected.end), lo: signed(f.projected.lo), hi: signed(f.projected.hi) })}</span>
            <SpreadNote h={h} />
            {h.change && <ChangeLine c={h.change} />}
            {h.accuracy.monthsEvaluated > 0 && <span className="text-xs">{t('forecast_accuracy', { n: h.accuracy.insideBand, of: h.accuracy.monthsEvaluated })}</span>}
            {!f.early && f.variable.typicalByToday !== null && f.variable.typicalByToday > 0 && (
              <span className={f.variableSpent <= f.variable.typicalByToday ? 'text-pos' : 'text-warn'}>
                {f.day >= 10
                  ? f.variableSpent <= f.variable.typicalByToday
                    ? t('below_usual', { pct: Math.round((1 - f.variableSpent / f.variable.typicalByToday) * 100) })
                    : t('above_usual', { pct: Math.round((f.variableSpent / f.variable.typicalByToday - 1) * 100) })
                  : t('typical_by_today', { x: money(f.variable.typicalByToday, { decimals: 0 }) })}
              </span>
            )}
          </div>
        )}
      </Card>

      {/* --- step 2: the monthly spending limit (a separate question from the cash left after bills) */}
      {h.limit ? <LimitCard limit={h.limit} month={h.month} editable={h.isCurrentMonth} /> : h.limit === null && h.isCurrentMonth ? <LimitSetLink /> : null}

      {/* --- the month as a waterfall */}
      <Card title={t('this_month')}>
        <div className="flex flex-col divide-y divide-border">
          <Line label={t('income')} amount={s.income.sum} expected={incomeExpected} tone="pos" onClick={() => goTx({ bucket: 'income' })} />
          <Line label={t('fixed')} amount={fixedLine?.spent ?? s.fixed.sum} expected={fixedLine?.expected ?? s.fixed.sum} onClick={() => goTx({ bucket: 'fixed' })} />
          {instLine && (instLine.spent !== 0 || instLine.expected !== 0) && <Line label={t('installments')} amount={instLine.spent} expected={instLine.expected} indent onClick={() => goTx({ bucket: 'installments' })} />}
          {savingsLine && savingsLine.spent !== 0 && <Line label={t('savings')} amount={savingsLine.spent} expected={savingsLine.expected} onClick={() => goTx({ bucket: 'savings' })} />}
          {variableLines.map((g) => {
            const over = Math.abs(g.spent) > Math.abs(g.expected) + 50;
            const params = g.group === 'uncategorised' ? { bucket: 'uncategorised' } : { group: g.group, bucket: 'variable' };
            const targeted = g.basis === 'targets';
            return <Line key={g.group} label={groupLabel(g.group)} amount={g.spent} {...(targeted ? { expected: g.expected } : {})} indent bar={targeted} tone={targeted && over ? 'neg' : 'accent'} onClick={() => goTx(params)} />;
          })}
          {notCounted > 0 && <Line label={`${t('not_counted')} (${notCounted})`} amount={s.excluded.settlements.sum + s.excluded.transfers.sum} muted onClick={() => goTx({ bucket: 'transfers' })} />}
          <div className="flex items-center justify-between py-2 font-semibold">
            <span>{h.isCurrentMonth ? `${t('net')} ${t('so_far')}` : t('net')}</span>
            <Amount value={s.net} tone={s.net >= 0 ? 'pos' : 'neg'} sign="auto" decimals={0} />
          </div>
          {h.isCurrentMonth && (
            <div className="flex items-center justify-between py-2 text-sm text-muted">
              <span>{t('projection')}</span>
              <span className="num">{signed(f.projected.end)}</span>
            </div>
          )}
        </div>
      </Card>

      <button className="btn w-full md:hidden" onClick={toggleMore}>
        {more ? t('show_less') : t('show_more')}
        {!more && h.attention.length > 0 && <span className="chip chip-on num ms-2">{h.attention.length}</span>}
      </button>

      <div className={`${more ? 'flex' : 'hidden md:flex'} flex-col gap-4`}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Card title={t('attention')}>
            {h.attention.length === 0 ? (
              <Empty>{t('nothing_to_see')}</Empty>
            ) : (
              <div className="flex flex-col gap-1">
                {h.attention.slice(0, 8).map((i) => (
                  <InsightRow key={i.key} insight={i} onDismiss={() => dismiss.mutate(i.key)} onOpen={() => openInsight(i)} />
                ))}
              </div>
            )}
          </Card>
          <Card title={t('expenses')} action={<span className="text-xs text-muted"><span className="text-accent">■</span> {t('so_far')} · <span className="text-muted">■</span> {t('projection')}</span>}>
            {chart.length > 1 ? (
              <div className="h-28 -mx-2">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chart} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
                    <defs>
                      <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#2dd4bf" stopOpacity={0.5} />
                        <stop offset="100%" stopColor="#2dd4bf" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <XAxis dataKey="date" hide />
                    <YAxis hide domain={[0, 'dataMax']} />
                    <Tooltip contentStyle={{ background: '#171a21', border: '1px solid #262b36', borderRadius: 8, fontSize: 12 }} labelFormatter={(l) => dayLabel(String(l), locale)} formatter={(v, name) => [money(Number(v)), name === 'actual' ? t('so_far') : t('projection')]} />
                    <Area type="monotone" dataKey="actual" stroke="#2dd4bf" fill="url(#g)" strokeWidth={2} isAnimationActive={false} connectNulls={false} />
                    <Area type="monotone" dataKey="projected" stroke="#8b93a7" strokeDasharray="4 4" fill="none" strokeWidth={1.5} isAnimationActive={false} connectNulls={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <Empty>{t('no_data')}</Empty>
            )}
          </Card>
        </div>

        <Card title={t('upcoming')}>
          {h.upcoming.length === 0 ? (
            <Empty>{t('no_data')}</Empty>
          ) : (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {h.upcoming.map((u, i) => (
                <div key={i} className={`shrink-0 rounded-xl border px-3 py-2 min-w-[9rem] ${u.status === 'missing' ? 'border-warn/50' : 'border-border'}`}>
                  <div className="text-xs text-muted">{shortDate(u.date)}</div>
                  <div className="truncate max-w-[10rem]" title={u.name}>
                    {u.name}
                  </div>
                  <Amount value={u.amount} tone={u.kind === 'income' ? 'pos' : u.status === 'missing' ? 'neg' : 'neutral'} className="text-sm" />
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card
          title={t('recent')}
          action={
            <button className="btn btn-sm" onClick={() => goTx({})}>
              {t('all_transactions')}
            </button>
          }
        >
          <TxnList items={h.recent} />
        </Card>
      </div>
    </div>
  );

  function openInsight(i: Insight) {
    if (i.txnId) return nav(`/transactions${qs({ month, open: i.txnId })}`);
    if (i.kind === 'uncategorised') return goTx({ bucket: 'uncategorised' });
    if (i.kind === 'suggested_links') return nav('/transactions?tab=review');
    if (i.kind === 'candidate' || i.kind === 'missing_fixed' || i.kind === 'price_change') return nav('/recurring');
    if (i.kind === 'sync_error' || i.kind === 'stale_sync') return nav('/accounts');
    if (i.kind === 'over_target') return goTx({ group: i.name, bucket: 'variable' });
    if (i.kind === 'integrity') return nav('/accounts');
  }
}

/** The month's income as one bar: committed | savings | variable spent | left (or the overrun beyond the end). */
/** "Since yesterday −₪240 · 2 new: Bookstore ₪180, Wolt ₪60": what moved the big number. */
function ChangeLine({ c }: { c: NonNullable<HubOverview['change']> }) {
  const { t } = useI18n();
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const moved = Math.abs(c.delta) >= 100;
  const head = !moved ? t(c.since === yesterday ? 'since_yesterday_same' : 'since_day_same', { d: shortDate(c.since) }) : t(c.since === yesterday ? 'since_yesterday' : 'since_day', { d: shortDate(c.since), x: money(c.delta, { sign: 'auto', decimals: 0 }) });
  const list = c.arrived.map((a) => `${a.name} ${money(Math.abs(a.amount), { decimals: 0 })}`).join(', ');
  const tail = c.arrivedCount === 0 ? null : t(c.arrivedCount === 1 ? 'arrived_one' : 'arrived_n', { n: c.arrivedCount, list: c.arrivedCount > 3 ? `${list}…` : list });
  return (
    <span className={`text-xs ${moved && c.delta < 0 ? 'text-warn' : ''}`}>
      {head}
      {tail ? ` · ${tail}` : ''}
    </span>
  );
}

function IncomeBar({ f }: { f: HubOverview['forecast'] }) {
  const { t } = useI18n();
  const total = Math.max(f.income.total, f.committed.total + f.savings.total + f.variableSpent, 1);
  const pct = (v: number) => `${Math.max(0, Math.min(100, (v / total) * 100))}%`;
  const over = f.left < 0 ? -f.left : 0;
  return (
    <div className="mt-3">
      <div className="bar flex overflow-hidden">
        <div className="bg-muted/70" style={{ width: pct(f.committed.total) }} title={t('legend_committed')} />
        <div className="bg-accent/60" style={{ width: pct(f.savings.total) }} title={t('savings')} />
        <div className={over ? 'bg-neg' : 'bg-accent'} style={{ width: pct(f.variableSpent) }} title={t('variable')} />
      </div>
      <div className="flex flex-wrap gap-x-3 text-[11px] text-muted mt-1">
        <span>■ {t('legend_committed')} {money(f.committed.total, { decimals: 0 })}</span>
        {f.savings.total > 0 && <span>■ {t('savings')} {money(f.savings.total, { decimals: 0 })}</span>}
        <span>■ {t('variable')} {money(f.variableSpent, { decimals: 0 })}</span>
        <span className={over ? 'text-neg' : 'text-pos'}>■ {over ? t('legend_over') : t('legend_left')} {money(over || f.left, { decimals: 0 })}</span>
      </div>
    </div>
  );
}

/** One waterfall line: label, optional pace bar, amount with the expected figure in small print. */
function Line({ label, amount, expected, indent = false, bar = false, muted = false, tone = 'accent', onClick }: { label: string; amount: number; expected?: number; indent?: boolean; bar?: boolean; muted?: boolean; tone?: 'accent' | 'pos' | 'neg'; onClick: () => void }) {
  const showExpected = expected !== undefined && Math.round(expected) !== Math.round(amount);
  return (
    <Row onClick={onClick} className={indent ? 'ps-4' : ''}>
      <span className={`shrink-0 ${indent ? 'w-28' : 'w-32'} truncate ${muted ? 'text-muted' : ''}`}>{label}</span>
      {bar && expected !== undefined ? <Bar value={amount} max={expected} tone={tone} className="flex-1" /> : <span className="flex-1" />}
      <span className="num text-sm text-end shrink-0">
        <Amount value={amount} tone={muted ? 'muted' : tone === 'pos' ? 'pos' : tone === 'neg' ? 'neg' : 'neutral'} decimals={0} />
        {showExpected && <span className="text-muted text-xs"> / {money(expected!, { decimals: 0 })}</span>}
      </span>
    </Row>
  );
}

function InsightRow({ insight: i, onDismiss, onOpen }: { insight: Insight; onDismiss: () => void; onOpen: () => void }) {
  const { t, locale } = useI18n();
  const icon = i.severity === 'warn' ? '⚠' : i.severity === 'ok' ? '✓' : '•';
  const color = i.severity === 'warn' ? 'text-warn' : i.severity === 'ok' ? 'text-pos' : 'text-muted';
  const vars = {
    name:
      i.kind === 'over_target'
        ? t(`group_${i.name}` as Key) === `group_${i.name}` ? (i.name ?? '') : t(`group_${i.name}` as Key)
        : i.kind === 'sync_error' // the hub sends only an error kind (P2-09); unknown kinds read as 'other'
          ? t(`err_${i.name}` as Key) === `err_${i.name}` ? t('err_other') : t(`err_${i.name}` as Key)
          : (i.name ?? ''),
    amount: i.amount !== undefined ? money(i.amount) : '',
    ref: i.reference !== undefined ? money(i.reference) : '',
    date: i.date ? dayLabel(i.date, locale) : '',
    n: i.count ?? 0,
    inst: i.institutionId ?? '',
  };
  return (
    <Row onClick={onOpen}>
      <span className={`${color} w-4 shrink-0`}>{icon}</span>
      <span className="flex-1 text-sm">{t((i.kind === 'stale_sync' && !i.date ? 'insight_stale_sync_never' : i.count === 1 && t(`insight_${i.kind}_one` as Key) !== `insight_${i.kind}_one` ? `insight_${i.kind}_one` : `insight_${i.kind}`) as Key, vars)}</span>
      <button
        className="text-muted hover:text-text text-xs px-1"
        title={t('dismiss')}
        onClick={(e) => {
          e.stopPropagation();
          onDismiss();
        }}
      >
        ✕
      </button>
    </Row>
  );
}
