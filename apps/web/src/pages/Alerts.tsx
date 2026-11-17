import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { cleanCode, countdown, mergeRecent, otpPollMs, validCode, type MergedAlert } from '../alertsPage';
import { ApiError, api } from '../api';
import { Card, Empty, ErrorBox, Spinner } from '../components/ui';
import { relTime } from '../format';
import { useI18n } from '../i18n';
import type { AlertsPayload, Health, OtpPending } from '../types';

type OtpRequest = OtpPending['requests'][number];

/** One bank sync waiting for a code: who asks, time left, the code field. */
function OtpRow({ req, name, now, focus, onDone }: { req: OtpRequest; name: string; now: number; focus: boolean; onDone: (id: string, outcome: 'sent' | 'gone') => void }) {
  const { t } = useI18n();
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focus) input.current?.focus();
  }, [focus]);
  const send = useMutation({
    mutationFn: (c: string) => api.post<{ ok: true }>(`/api/otp/${encodeURIComponent(req.id)}`, { code: c }),
    onMutate: () => setErr(null),
    onSuccess: () => onDone(req.id, 'sent'),
    onError: (e) => {
      if (e instanceof ApiError && e.status === 404) onDone(req.id, 'gone');
      else if (e instanceof ApiError && e.status === 400) setErr(t('otp_bad_code'));
      else setErr(e instanceof Error ? e.message : String(e));
    },
  });
  const left = countdown(req.expiresAt, now);
  const ok = validCode(code);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ok) {
      setErr(t('otp_bad_code'));
      return;
    }
    if (!send.isPending) send.mutate(cleanCode(code));
  };
  const inputId = `otp-${req.id}`;
  return (
    <form onSubmit={submit} className={`flex flex-col gap-2 rounded-lg border p-3 ${focus ? 'border-accent' : 'border-border'}`}>
      <div className="flex items-center gap-2">
        <label htmlFor={inputId} className="flex-1 min-w-0 truncate font-medium" dir="auto">
          {t('otp_code_label', { name })}
        </label>
        <span className={`text-xs shrink-0 ${left ? 'text-muted' : 'text-neg'}`}>{left ? t('otp_time_left', { t: left }) : t('otp_expired')}</span>
      </div>
      <div className="flex items-center gap-2">
        <input
          ref={input}
          id={inputId}
          className="input flex-1 num tracking-widest text-center"
          dir="ltr"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9 ]*"
          maxLength={12}
          value={code}
          disabled={!left || send.isPending}
          onChange={(e) => {
            setCode(e.target.value);
            setErr(null);
          }}
        />
        <button type="submit" className="btn btn-primary" disabled={!left || !ok || send.isPending}>
          {t('otp_send')}
        </button>
      </div>
      {err && <span className="text-xs text-neg">{err}</span>}
    </form>
  );
}

function ChannelMark({ c }: { c: MergedAlert['channels'][number] }) {
  const { t } = useI18n();
  const label = t(c.channel === 'push' ? 'alerts_page_ch_push' : 'alerts_page_ch_telegram');
  return (
    <span className={`chip text-[10px] px-1.5 leading-tight ${c.ok ? '' : 'text-neg border-neg/40'}`} title={c.error ?? undefined}>
      {label}
      {!c.ok && ' ✗'}
    </span>
  );
}

/**
 * Alerts (push-alerts.md step 5): bank syncs waiting for a one-time code on top, then the recent alerts with their
 * channels. The phone app opens /alerts?otp=<id> from a code notification; that request's field gets the focus.
 */
export function Alerts() {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const [sp] = useSearchParams();
  const focusId = sp.get('otp');
  const otp = useQuery({
    queryKey: ['otp-pending'],
    queryFn: () => api.get<OtpPending>('/api/otp/pending'),
    refetchInterval: (q) => otpPollMs(q.state.data?.requests.length ?? 0),
  });
  const alerts = useQuery({ queryKey: ['alerts'], queryFn: () => api.get<AlertsPayload>('/api/alerts'), refetchInterval: 30_000 });
  const health = useQuery({ queryKey: ['health'], queryFn: () => api.get<Health>('/api/health'), refetchInterval: 30_000 });
  const [notes, setNotes] = useState<Array<{ outcome: 'sent' | 'gone'; name: string }>>([]);
  const requests = otp.data?.requests ?? [];

  // one clock for every countdown, ticking only while a code is awaited
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!requests.length) return;
    setNow(Date.now());
    const h = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(h);
  }, [requests.length]);

  const nameOf = (institutionId: string) => health.data?.connections.find((c) => c.institutionId === institutionId)?.displayName ?? institutionId;
  const done = (id: string, outcome: 'sent' | 'gone') => {
    const req = requests.find((r) => r.id === id);
    setNotes((s) => [...s, { outcome, name: req ? nameOf(req.institutionId) : '' }]);
    qc.setQueryData<OtpPending>(['otp-pending'], (d) => (d ? { requests: d.requests.filter((r) => r.id !== id) } : d));
    void qc.invalidateQueries({ queryKey: ['otp-pending'] });
  };

  const merged = alerts.data ? mergeRecent(alerts.data.recent) : [];
  return (
    <div className="flex flex-col gap-3">
      <header className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">{t('alerts_page_title')}</h1>
      </header>

      {(requests.length > 0 || notes.length > 0) && (
        <Card title={t('otp_title')}>
          <div className="flex flex-col gap-3">
            {requests.length > 0 && <p className="text-xs text-muted">{t('otp_help')}</p>}
            {requests.map((r) => (
              <OtpRow key={r.id} req={r} name={nameOf(r.institutionId)} now={now} focus={r.id === focusId} onDone={done} />
            ))}
            {notes.map((n, i) => (
              <p key={i} className={`text-sm ${n.outcome === 'sent' ? 'text-pos' : 'text-warn'}`} dir="auto">
                {n.outcome === 'sent' ? t('otp_sent', { name: n.name }) : t('otp_gone')}
              </p>
            ))}
          </div>
        </Card>
      )}

      <Card title={t('alerts_page_recent')}>
        {alerts.isPending ? (
          <Spinner />
        ) : alerts.error ? (
          <ErrorBox error={alerts.error} onRetry={() => void alerts.refetch()} />
        ) : merged.length ? (
          <div className="flex flex-col divide-y divide-border text-sm">
            {merged.map((a) => (
              <div key={a.id} className="py-2 flex flex-col gap-1">
                <p className={`whitespace-pre-line break-words ${a.failed ? 'text-neg' : ''}`} dir="auto">
                  {a.text}
                </p>
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                  <span>{relTime(a.sentAt, locale)}</span>
                  {a.channels.map((c) => (
                    <ChannelMark key={c.channel} c={c} />
                  ))}
                  {a.failed && <span className="text-neg">{t('alerts_page_failed')}</span>}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Empty>{t('alerts_page_none')}</Empty>
        )}
      </Card>
    </div>
  );
}
