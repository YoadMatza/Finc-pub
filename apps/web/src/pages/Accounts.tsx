import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Area, AreaChart, ResponsiveContainer, Tooltip, YAxis } from 'recharts';
import { ApiError, api, qs } from '../api';
import { HoldingsSheet } from '../components/HoldingsSheet';
import { Amount, Card, Chip, Empty, ErrorBox, LiveTag, Row, Spinner } from '../components/ui';
import { dayLabel, money, relTime } from '../format';
import { useI18n } from '../i18n';
import { errorText } from '../limits';
import { liveTag } from '../live';
import type { AccountsOverview, Health } from '../types';

export function Accounts() {
  const { t, locale } = useI18n();
  const nav = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['accounts'], queryFn: () => api.get<AccountsOverview>('/api/accounts') });
  const health = useQuery({ queryKey: ['health'], queryFn: () => api.get<Health>('/api/health'), refetchInterval: 15_000 });
  // the master password is typed only at home (P1-01, QUESTIONS 12): the phone and other browsers see a hint instead
  const auth = useQuery({ queryKey: ['auth'], queryFn: () => api.get<{ trusted: boolean }>('/api/auth/status'), staleTime: 60_000 });
  const canUnlock = auth.data?.trusted === true;
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const unlock = useMutation({
    mutationFn: () => api.post('/api/vault/unlock', { password: pw }),
    onSuccess: () => {
      setPw('');
      setErr(null);
      void qc.invalidateQueries({ queryKey: ['health'] });
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : String(e)),
  });
  const sync = useMutation({
    mutationFn: (institutions: string[] | 'all') => api.post('/api/sync', { institutions }),
    onMutate: () => setErr(null),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['health'] });
      setTimeout(() => void qc.invalidateQueries({ queryKey: ['accounts'] }), 5000);
    },
    // P2-02: a manual sync away from home can be capped (429 with the time it works again)
    onError: (e) => setErr(errorText(e, 'sync', t, locale)),
  });
  const [holdingsOf, setHoldingsOf] = useState<{ id: number; title: string } | null>(null);
  if (q.isPending) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const vault = health.data?.vault;
  const hasHoldings = (type: string) => type === 'securities' || type === 'foreign_currency';
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {d.accounts.map((a) => (
          <Card key={a.id}>
            <button className="text-start w-full" onClick={() => (hasHoldings(a.type) ? setHoldingsOf({ id: a.id, title: a.displayName ?? a.institutionId }) : nav(`/transactions${qs({ accountId: a.id })}`))}>
              <div className="text-xs text-muted">{a.displayName ?? a.institutionId}</div>
              <div className="mt-1">
                {a.card ? (
                  <Amount value={Math.abs(a.card.nextBillingAmount)} tone="neutral" className="text-2xl font-bold" decimals={0} />
                ) : typeof a.liveValueIls === 'number' ? (
                  <Amount value={a.liveValueIls} tone={a.liveValueIls >= 0 ? 'pos' : 'neg'} className="text-2xl font-bold" decimals={0} />
                ) : (
                  <Amount value={a.balance?.amount ?? 0} tone={(a.balance?.amount ?? 0) >= 0 ? 'pos' : 'neg'} className="text-2xl font-bold" decimals={0} />
                )}
              </div>
              <div className="text-xs text-muted">
                {!a.card && typeof a.liveValueIls === 'number' ? (
                  <LiveTag {...liveTag(a.liveState, a.liveAsOf, t)} className="align-middle" />
                ) : a.card ? (
                  a.card.nextBillingDate ? `${t('next_billing')} ${dayLabel(a.card.nextBillingDate, locale)}` : t('no_data')
                ) : a.balance ? (
                  `${t('as_of')} ${relTime(a.balance.takenAt, locale)}`
                ) : (
                  t('no_data')
                )}
                {a.pending > 0 ? ` · ${a.pending} ${t('pending')}` : ''}
                {hasHoldings(a.type) ? ` · ${t('holdings_title')} ›` : ''}
              </div>
            </button>
            {!a.card && a.balanceHistory.length > 2 && (
              <div className="h-12 mt-2 -mx-2">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={a.balanceHistory} margin={{ top: 2, right: 2, bottom: 0, left: 2 }}>
                    <YAxis hide domain={['dataMin', 'dataMax']} />
                    <Tooltip contentStyle={{ background: '#171a21', border: '1px solid #262b36', borderRadius: 8, fontSize: 12 }} formatter={(v) => [money(Number(v)), t('balance')]} labelFormatter={(l, p) => dayLabel(String(p?.[0]?.payload?.date ?? l), locale)} />
                    <Area type="monotone" dataKey="balance" stroke="#2dd4bf" fill="#2dd4bf22" strokeWidth={1.5} isAnimationActive={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
            {a.card && a.card.lastBillingDate && (
              <div className="mt-2 text-sm flex justify-between">
                <span className="text-muted">{t('last_billing')}</span>
                <span>
                  {dayLabel(a.card.lastBillingDate, locale)} <Amount value={Math.abs(a.card.lastBillingAmount)} tone="muted" />
                </span>
              </div>
            )}
          </Card>
        ))}
      </div>

      <Card
        title={t('connection')}
        action={
          <div className="flex items-center gap-2">
            {vault === 'locked' && auth.isSuccess && !canUnlock && <span className="text-xs text-muted">{t('vault_unlock_home_only')}</span>}
            {vault === 'locked' && canUnlock && (
              <form
                className="flex gap-2 items-center"
                onSubmit={(e) => {
                  e.preventDefault();
                  unlock.mutate();
                }}
              >
                <input className="input w-44" type="password" placeholder={t('master_password')} value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" />
                <button className="btn btn-sm btn-primary" disabled={!pw || unlock.isPending}>
                  {t('vault_unlock')}
                </button>
              </form>
            )}
            {vault === 'unlocked' && (
              <button className="btn btn-sm" disabled={health.data?.syncRunning || sync.isPending} onClick={() => sync.mutate('all')}>
                {health.data?.syncRunning ? t('sync_running') : t('sync_now')}
              </button>
            )}
          </div>
        }
      >
        {err && <div className="text-neg text-sm mb-2">{err}</div>}
        <div className="flex flex-col divide-y divide-border">
          {(health.data?.connections ?? d.connections)
            .filter((c) => c.kind !== 'manual')
            .map((c) => {
              const bad = c.lastError && (!c.lastOkAt || (c.lastErrorAt ?? '') > c.lastOkAt);
              return (
                <Row key={c.institutionId}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span>{c.displayName}</span>
                      <Chip tone={!c.enabled && !c.lastOkAt ? 'pending' : bad ? 'warn' : 'pos'}>{!c.enabled && !c.lastOkAt ? t('disabled') : bad ? t('error_state') : t('ok')}</Chip>
                    </div>
                    <div className="text-xs text-muted">
                      {t('last_ok')}: {c.lastOkAt ? relTime(c.lastOkAt, locale) : t('never')}
                      {bad && c.lastError ? ` · ${t('last_error')}: ${c.lastError.slice(0, 90)}` : ''}
                    </div>
                  </div>
                  {vault === 'unlocked' && c.kind !== 'aggregator' && (
                    <button className="btn btn-sm" disabled={health.data?.syncRunning} onClick={() => sync.mutate([c.institutionId])}>
                      {t('sync_now')}
                    </button>
                  )}
                </Row>
              );
            })}
        </div>
      </Card>

      <Card title={t('runs')}>
        {d.runs.length ? (
          <div className="flex flex-col divide-y divide-border text-sm">
            {d.runs.slice(0, 15).map((r) => (
              <div key={r.id} className="py-1.5 flex items-center gap-3">
                <span className="num text-xs text-muted w-28">{r.startedAt.slice(5, 16).replace('T', ' ')}</span>
                <span className="w-24">{r.institutionId}</span>
                <Chip tone={r.status === 'ok' ? 'pos' : r.status === 'running' ? 'pending' : 'warn'}>{r.status}</Chip>
                <span className="text-muted text-xs flex-1 truncate">
                  {r.status === 'ok' ? `${r.rowsSeen} rows, ${r.rowsNew} new` : (r.error ?? r.errorType ?? '')}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <Empty>{t('no_data')}</Empty>
        )}
      </Card>
      <HoldingsSheet accountId={holdingsOf?.id ?? null} title={holdingsOf?.title ?? ''} onClose={() => setHoldingsOf(null)} />
    </div>
  );
}
