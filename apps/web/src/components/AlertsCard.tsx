import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type KeyboardEvent, useState } from 'react';
import { ApiError, api } from '../api';
import { relTime } from '../format';
import { type Key, useI18n } from '../i18n';
import { errorText } from '../limits';
import type { AlertType, AlertsPayload } from '../types';
import { Card, Empty, Spinner } from './ui';

const TYPES: AlertType[] = ['missing_fixed', 'big_purchase', 'card_testing', 'unusual_charge', 'instalment_purchase', 'card_bill_gap', 'refund_matched', 'over_target', 'spend_limit', 'price_change', 'sync_error', 'stale_sync', 'otp_needed', 'candidate', 'uncategorised', 'weekly_summary', 'image_old'];

/** The two money-out thresholds (whole shekels), edited as a draft and saved on blur, Enter or the save button. */
function AmountsEditor({ amounts, saving, onSave }: { amounts: { big: number; urgent: number }; saving: boolean; onSave: (next: { big: number; urgent: number }) => void }) {
  const { t } = useI18n();
  const [big, setBig] = useState(String(amounts.big));
  const [urgent, setUrgent] = useState(String(amounts.urgent));
  const next = { big: Number(big), urgent: Number(urgent) };
  const dirty = next.big !== amounts.big || next.urgent !== amounts.urgent;
  const save = () => {
    if (dirty && !saving) onSave(next);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') save();
  };
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
      <label className="flex items-center gap-2">
        <span className="text-muted">{t('alert_amount_big')}</span>
        <input type="number" inputMode="numeric" min={1} step={1} className="input w-28 num" value={big} onChange={(e) => setBig(e.target.value)} onBlur={save} onKeyDown={onKey} />
      </label>
      <label className="flex items-center gap-2">
        <span className="text-muted">{t('alert_amount_urgent')}</span>
        <input type="number" inputMode="numeric" min={1} step={1} className="input w-28 num" value={urgent} onChange={(e) => setUrgent(e.target.value)} onBlur={save} onKeyDown={onKey} />
      </label>
      {dirty && (
        <button type="button" className="btn btn-sm" disabled={saving} onClick={save}>
          {t('save')}
        </button>
      )}
    </div>
  );
}

/** Settings → Alerts: Telegram status and setup, the type matrix, quiet hours, the weekly slot, recent sends. */
export function AlertsCard() {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['alerts'], queryFn: () => api.get<AlertsPayload>('/api/alerts'), refetchInterval: 30_000 });
  const [msg, setMsg] = useState<string | null>(null);
  const done = (text: string) => {
    setMsg(text);
    void qc.invalidateQueries({ queryKey: ['alerts'] });
  };
  const fail = (e: unknown) => setMsg(e instanceof ApiError ? e.message : String(e));
  const patch = useMutation({ mutationFn: (body: unknown) => api.patch('/api/alerts', body), onSuccess: () => qc.invalidateQueries({ queryKey: ['alerts'] }), onError: fail });
  // Binding the chat (P0-02): a one-time code made here at home, sent to the bot by pressing Start through the link.
  const [binding, setBinding] = useState<{ code: string; link: string | null } | null>(null);
  const makeCode = useMutation({
    mutationFn: () => api.post<{ code: string; link: string | null }>('/api/alerts/telegram/code'),
    onSuccess: (r) => {
      setMsg(null);
      setBinding(r);
    },
    onError: fail,
  });
  const discover = useMutation({
    mutationFn: () => api.post<{ from: string }>('/api/alerts/telegram/discover'),
    onSuccess: (r) => {
      setBinding(null);
      done(`✓ ${r.from}`);
    },
    onError: fail,
  });
  const saveAmounts = useMutation({ mutationFn: (amounts: { big: number; urgent: number }) => api.patch('/api/alerts', { amounts }), onSuccess: () => done('✓'), onError: fail });
  // P2-02: test sends are capped per hour; a 429 says when the next one is allowed
  const test = useMutation({ mutationFn: (weekly: boolean) => api.post('/api/alerts/test', { weekly }), onMutate: () => setMsg(null), onSuccess: () => done('✓'), onError: (e) => setMsg(errorText(e, 'alerts', t, locale)) });
  if (q.isPending) return <Spinner />;
  if (q.error || !q.data) return null;
  const d = q.data;
  const tg = d.telegram;
  const ready = tg.tokenInVault && tg.tokenValid && !!tg.chatId;
  const canEdit = d.canEdit !== false;
  return (
    <Card title={t('alerts')}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2 text-sm">
          <p className="text-xs text-muted">{t('alerts_help')}</p>
          <div className="flex items-center gap-2 flex-wrap">
            {tg.vaultLocked ? (
              <span className="chip text-warn border-warn/40">{t('telegram_status_locked')}</span>
            ) : !tg.tokenInVault ? (
              <span className="chip text-warn border-warn/40">{t('telegram_status_none')}</span>
            ) : (
              <span className={`chip ${tg.tokenValid ? 'text-pos border-pos/40' : 'text-neg border-neg/40'}`}>
                {t('telegram_status_bot')} {tg.bot ? `@${tg.bot}` : '?'}
              </span>
            )}
            {tg.tokenInVault && tg.tokenValid && !tg.chatId && <span className="text-muted">{t('telegram_status_nochat')}</span>}
            {canEdit && tg.tokenInVault && tg.tokenValid && !binding && (
              <button className={`btn btn-sm ${tg.chatId ? '' : 'btn-primary'}`} disabled={makeCode.isPending} onClick={() => makeCode.mutate()}>
                {tg.chatId ? t('tg_move_chat') : t('find_chat')}
              </button>
            )}
            {ready && (
              <>
                <button className="btn btn-sm" disabled={test.isPending} onClick={() => test.mutate(false)}>
                  {t('send_test')}
                </button>
                <button className="btn btn-sm" disabled={test.isPending} onClick={() => test.mutate(true)}>
                  {t('send_weekly_now')}
                </button>
              </>
            )}
            {msg && <span className="text-xs text-muted">{msg}</span>}
          </div>
          {binding && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-2">
              {binding.link && (
                <a className="btn btn-sm btn-primary" href={binding.link} target="_blank" rel="noreferrer">
                  {t('tg_open_link')}
                </a>
              )}
              <span className="text-xs text-muted">
                {t('tg_code_hint')} <span className="num select-all">/start {binding.code}</span>
              </span>
              <button className="btn btn-sm" disabled={discover.isPending} onClick={() => discover.mutate()}>
                {t('tg_check')}
              </button>
            </div>
          )}
          {!canEdit && <p className="text-xs text-muted">{t('alerts_home_only')}</p>}
        </div>

        <fieldset disabled={!canEdit} className="contents">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-sm">
          {TYPES.map((ty) => (
            <label key={ty} className="flex items-center justify-between gap-2 py-1">
              <span>{t(`alert_${ty}` as Key)}</span>
              <input type="checkbox" checked={d.config.matrix[ty]?.telegram ?? false} onChange={(e) => patch.mutate({ matrix: { [ty]: { telegram: e.target.checked } } })} />
            </label>
          ))}
        </div>

        {/* keyed on the saved values, so the draft resets to what the server holds after each save */}
        <AmountsEditor key={`${d.config.amounts.big}-${d.config.amounts.urgent}`} amounts={d.config.amounts} saving={saveAmounts.isPending} onSave={(a) => saveAmounts.mutate(a)} />

        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted">{t('alert_unusual_factor')}</span>
          <select className="input w-20" value={d.config.unusualFactor} onChange={(e) => patch.mutate({ unusualFactor: Number(e.target.value) })}>
            {[2, 3, 4, 5, 6, 8, 10].map((n) => (
              <option key={n} value={n}>
                ×{n}
              </option>
            ))}
          </select>
        </label>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <label className="flex items-center gap-2">
            <span className="text-muted">{t('quiet_hours')}</span>
            <input type="time" className="input w-24" value={d.config.quiet?.from ?? ''} disabled={!d.config.quiet} onChange={(e) => patch.mutate({ quiet: { from: e.target.value, to: d.config.quiet?.to ?? '07:00' } })} />
            <span className="text-muted">–</span>
            <input type="time" className="input w-24" value={d.config.quiet?.to ?? ''} disabled={!d.config.quiet} onChange={(e) => patch.mutate({ quiet: { from: d.config.quiet?.from ?? '23:00', to: e.target.value } })} />
            <input type="checkbox" checked={!d.config.quiet} onChange={(e) => patch.mutate({ quiet: e.target.checked ? 'off' : { from: '23:00', to: '07:00' } })} /> <span className="text-muted">{t('quiet_off')}</span>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-muted">{t('weekly_summary_at')}</span>
            <select className="input w-auto" value={d.config.weekly.day} onChange={(e) => patch.mutate({ weekly: { day: Number(e.target.value) } })}>
              {[0, 1, 2, 3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>
                  {t(`day_${n}` as Key)}
                </option>
              ))}
            </select>
            <select className="input w-auto num" value={d.config.weekly.hour} onChange={(e) => patch.mutate({ weekly: { hour: Number(e.target.value) } })}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, '0')}:00
                </option>
              ))}
            </select>
          </label>
        </div>
        </fieldset>

        <div className="flex flex-col gap-1">
          <span className="text-sm text-muted">{t('recent_alerts')}</span>
          {d.recent.length ? (
            <div className="flex flex-col divide-y divide-border text-sm">
              {d.recent.slice(0, 10).map((a) => (
                <div key={a.id} className="py-1.5 flex items-start gap-2">
                  <span className={`shrink-0 ${a.ok ? 'text-pos' : 'text-neg'}`}>{a.ok ? '✓' : '✗'}</span>
                  <span className="flex-1 min-w-0 truncate" dir="auto" title={a.text.replace(/<[^>]+>/g, '')}>
                    {a.text.replace(/<[^>]+>/g, '')}
                  </span>
                  <span className="text-xs text-muted shrink-0">{relTime(a.sentAt, locale)}</span>
                </div>
              ))}
            </div>
          ) : (
            <Empty>{t('no_alerts_yet')}</Empty>
          )}
        </div>
      </div>
    </Card>
  );
}
