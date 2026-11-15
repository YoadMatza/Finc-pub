import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../api';
import { dayLabel, money, shortDate } from '../format';
import { type Key, useI18n } from '../i18n';
import { liveTag, liveTotals, shownValue } from '../live';
import type { ManualHolding, NetWorthLine, NetWorthOverview } from '../types';
import { Amount, Card, Empty, LiveTag, Row, Spinner } from './ui';

const KINDS = ['pension', 'savings', 'investment', 'property', 'cash', 'loan', 'other'] as const;
const TOOLTIP_STYLE = { background: '#171a21', border: '1px solid #262b36', borderRadius: 8, fontSize: 12 };

/**
 * Net worth (design §6): the total, its line over time, what it is made of, and the holdings
 * entered by hand (pension, a loan…) with a value to update.
 */
export function NetWorthCard() {
  const { t, locale } = useI18n();
  const q = useQuery({ queryKey: ['networth'], queryFn: () => api.get<NetWorthOverview>('/api/networth') });
  if (q.isPending) return <Spinner />;
  if (q.error || !q.data) return null;
  const d = q.data;
  // securities / FX lines priced live replace their snapshot value in the totals
  const totals = liveTotals(d);
  // the headline includes live prices: label it green only if every live line is live and fresh, else grey
  const liveLines = d.lines.filter((l) => typeof l.liveValueIls === 'number');
  const headTag = liveLines.length
    ? liveLines.map((l) => liveTag(l.liveState, l.liveAsOf, t)).sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'closed' ? -1 : 1))[0]
    : undefined;
  const first = d.history[0];
  // the history holds recorded (bank) values only, so the change is measured bank to bank — never live minus bank
  const change = first && d.history.length > 1 ? d.total - first.total : null;
  const kindName = (k: string) => {
    const key = `nw_kind_${k}` as Key;
    return t(key) === key ? k : t(key);
  };
  return (
    <Card title={t('nw_title')}>
      <div className="flex flex-col gap-4">
        <div>
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <span className="flex items-baseline gap-2">
              <Amount value={totals.total} tone={totals.total >= 0 ? 'pos' : 'neg'} sign="auto" className="text-3xl font-bold" decimals={0} />
              {headTag && <LiveTag {...headTag} />}
            </span>
            <span className="text-xs text-muted">
              {t('nw_assets')} {money(totals.assets, { decimals: 0 })} · {t('nw_liabilities')} {money(totals.liabilities, { decimals: 0 })}
              {change !== null && first ? ` · ${t('nw_change_since', { d: shortDate(first.date), x: money(change, { sign: 'auto', decimals: 0 }) })}${totals.live ? ` (${t('nw_change_bank')})` : ''}` : ''}
            </span>
          </div>
          <p className="text-xs text-muted mt-1">{t('nw_help')}</p>
        </div>

        {d.history.length > 1 && (
          <div className="h-36" dir="ltr">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={d.history} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
                <defs>
                  <linearGradient id="nw" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#34d399" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#34d399" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#8b93a7' }} tickFormatter={(v) => shortDate(String(v))} axisLine={false} tickLine={false} minTickGap={40} />
                <YAxis hide domain={['auto', 'auto']} />
                <Tooltip contentStyle={TOOLTIP_STYLE} labelFormatter={(l) => dayLabel(String(l), locale, { year: true })} formatter={(v) => [money(Number(v), { sign: 'auto', decimals: 0 }), t('nw_title')]} />
                <Area type="monotone" dataKey="total" stroke="#34d399" fill="url(#nw)" strokeWidth={2} isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1">
          <Lines title={t('nw_assets')} lines={d.lines.filter((l) => l.side === 'asset')} kindName={kindName} />
          <Lines title={t('nw_liabilities')} lines={d.lines.filter((l) => l.side === 'liability')} kindName={kindName} negative />
        </div>

        <ManualSection manual={d.manual} kindName={kindName} />
      </div>
    </Card>
  );
}

function Lines({ title, lines, kindName, negative = false }: { title: string; lines: NetWorthLine[]; kindName: (k: string) => string; negative?: boolean }) {
  const { t, locale } = useI18n();
  return (
    <div className="flex flex-col">
      <span className="text-xs text-muted uppercase tracking-wide py-1">{title}</span>
      {lines.length === 0 ? (
        <Empty>–</Empty>
      ) : (
        lines.map((l) => (
          <Row key={l.key}>
            <span className="flex-1 min-w-0">
              <span className="block truncate text-sm">{l.name}</span>
              <span className="block text-xs text-muted truncate">
                {kindName(l.kind)}
                {typeof l.liveValueIls === 'number' ? '' : l.source === 'cards' ? ` · ${t('nw_cards_owed')}` : l.asOf ? ` · ${t('nw_as_of', { d: dayLabel(l.asOf, locale) })}` : ''}
                {typeof l.liveValueIls === 'number' && <LiveTag {...liveTag(l.liveState, l.liveAsOf, t)} className="ms-1.5 align-middle" />}
              </span>
            </span>
            <Amount value={negative ? -shownValue(l) : shownValue(l)} tone="neutral" sign={negative ? 'auto' : 'never'} decimals={0} className="text-sm" />
          </Row>
        ))
      )}
    </div>
  );
}

function ManualSection({ manual, kindName }: { manual: ManualHolding[]; kindName: (k: string) => string }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<(typeof KINDS)[number]>('pension');
  const [value, setValue] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['networth'] });
  const create = useMutation({
    mutationFn: () => api.post('/api/networth/manual', { name, kind, value: Math.round(Number(value) * 100), date }),
    onSuccess: () => {
      invalidate();
      setAdding(false);
      setName('');
      setValue('');
    },
  });
  const setVal = useMutation({ mutationFn: (p: { id: number; value: number; date: string }) => api.post(`/api/networth/manual/${p.id}/values`, { value: p.value, date: p.date }), onSuccess: invalidate });
  const del = useMutation({ mutationFn: (id: number) => api.del(`/api/networth/manual/${id}`), onSuccess: invalidate });
  const active = manual.filter((m) => !m.archived);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted uppercase tracking-wide">{t('nw_manual')}</span>
        {!adding && (
          <button className="btn btn-sm" onClick={() => setAdding(true)}>
            + {t('nw_add')}
          </button>
        )}
      </div>
      {adding && (
        <form
          className="card p-3 flex flex-col gap-2 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && value !== '') create.mutate();
          }}
        >
          <div className="flex gap-2 flex-wrap">
            <label className="flex flex-col gap-1 flex-1 min-w-[10rem]">
              <span className="text-muted text-xs">{t('nw_name')}</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-muted text-xs">{t('nw_kind')}</span>
              <select className="input" value={kind} onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])}>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {kindName(k)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex gap-2 flex-wrap items-end">
            <label className="flex flex-col gap-1">
              <span className="text-muted text-xs">{t('nw_value')} (₪)</span>
              <input className="input w-36 num" type="number" min={0} step="0.01" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-muted text-xs">{t('nw_date')}</span>
              <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
            <button className="btn btn-primary btn-sm" disabled={!name.trim() || value === '' || create.isPending}>
              {t('save')}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setAdding(false)}>
              {t('cancel')}
            </button>
          </div>
        </form>
      )}
      {active.map((m) => (
        <ManualRow key={m.id} m={m} kindName={kindName} onValue={(v, d) => setVal.mutate({ id: m.id, value: v, date: d })} onRemove={() => window.confirm(t('nw_remove_confirm')) && del.mutate(m.id)} locale={locale} />
      ))}
    </div>
  );
}

function ManualRow({ m, kindName, onValue, onRemove, locale }: { m: ManualHolding; kindName: (k: string) => string; onValue: (value: number, date: string) => void; onRemove: () => void; locale: string }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(m.value !== null ? String(m.value / 100) : '');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  return (
    <div className="flex flex-col gap-1 border-b border-border last:border-0 py-1.5 text-sm">
      <div className="flex items-center gap-3">
        <span className="flex-1 min-w-0">
          <span className="block truncate">{m.name}</span>
          <span className="block text-xs text-muted">
            {kindName(m.kind)}
            {m.asOf ? ` · ${t('nw_as_of', { d: dayLabel(m.asOf, locale) })}` : ''}
            {m.history.length > 1 ? ` · ${m.history.length}` : ''}
          </span>
        </span>
        {m.value !== null && <Amount value={m.side === 'liability' ? -m.value : m.value} tone="neutral" sign={m.side === 'liability' ? 'auto' : 'never'} decimals={0} />}
        <button className="btn btn-sm" onClick={() => setEditing((v) => !v)}>
          {t('nw_update_value')}
        </button>
      </div>
      {editing && (
        <form
          className="flex gap-2 flex-wrap items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (value !== '') {
              onValue(Math.round(Number(value) * 100), date);
              setEditing(false);
            }
          }}
        >
          <input className="input w-36 num" type="number" min={0} step="0.01" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
          <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <button className="btn btn-primary btn-sm">{t('save')}</button>
          <button type="button" className="btn btn-sm text-neg ms-auto" onClick={onRemove}>
            {t('nw_remove')}
          </button>
        </form>
      )}
    </div>
  );
}
