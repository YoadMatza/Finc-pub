import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '../api';
import { dayLabel } from '../format';
import { useI18n } from '../i18n';
import { groupSecret, isAppCode, qrPath, totpConfirmError } from '../totp';
import type { TotpConfirmed, TotpInfo, TotpSetup } from '../types';
import { Card } from './ui';

/** The otpauth:// URI as an SVG QR code, black on white whatever the theme (authenticator cameras want contrast). */
function TotpQr({ uri }: { uri: string }) {
  const qr = useMemo(() => qrPath(uri), [uri]);
  return (
    <svg viewBox={`0 0 ${qr.size} ${qr.size}`} className="rounded-lg w-[200px] h-[200px] shrink-0" shapeRendering="crispEdges" role="img" aria-label="QR">
      <rect width={qr.size} height={qr.size} fill="#ffffff" />
      <path d={qr.d} fill="#0f1115" />
    </svg>
  );
}

/** The recovery codes, shown once right after setup, with Copy all and Done (which hides them for good). */
function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);
  // the clipboard API needs a secure context; over plain http the codes stay selectable
  const canCopy = typeof navigator !== 'undefined' && !!navigator.clipboard;
  return (
    <div className="card p-3 flex flex-col gap-3">
      <div className="font-medium text-sm">{t('totp_codes_title')}</div>
      <p className="text-sm text-warn">{t('totp_codes_save')}</p>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-1 num text-sm select-all" dir="ltr">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <p className="text-xs text-muted">{t('totp_codes_use')}</p>
      <div className="flex gap-2 flex-wrap">
        {canCopy && (
          <button
            className="btn btn-sm"
            onClick={() => {
              navigator.clipboard.writeText(codes.join('\n')).then(
                () => setCopied(true),
                () => setCopied(false),
              );
            }}
          >
            {copied ? t('totp_copied') : t('totp_copy_all')}
          </button>
        )}
        <button className="btn btn-sm btn-primary" onClick={onDone}>
          {t('totp_done')}
        </button>
      </div>
    </div>
  );
}

/** Settings → Backup login: PIN + a code from an authenticator app, for a browser away from home without a passkey. */
export function TotpCard() {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['totp'], queryFn: () => api.get<TotpInfo>('/api/auth/totp') });
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [asking, setAsking] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const fail = (e: unknown) => setMsg(e instanceof ApiError ? e.message : String(e));
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['totp'] });
    void qc.invalidateQueries({ queryKey: ['auth'] });
  };

  const start = useMutation({
    mutationFn: () => api.post<TotpSetup>('/api/auth/totp/setup', {}),
    onSuccess: (r) => {
      setMsg(null);
      setCode('');
      setSetup(r);
    },
    onError: fail,
  });
  const confirm = useMutation({
    mutationFn: (c: string) => api.post<TotpConfirmed>('/api/auth/totp/confirm', { code: c }),
    onSuccess: (r) => {
      setMsg(null);
      setSetup(null);
      setCode('');
      setCodes(r.recoveryCodes);
      refresh();
    },
    onError: (e) => {
      setMsg(totpConfirmError(e, t));
      // an expired setup cannot be confirmed any more: back to Set up
      if (e instanceof ApiError && e.status === 410) setSetup(null);
    },
  });
  const turnOff = useMutation({
    mutationFn: () => api.del<{ ok: boolean }>('/api/auth/totp'),
    onSuccess: () => {
      setMsg(null);
      setAsking(false);
      refresh();
    },
    onError: fail,
  });

  // the setup secret dies on the worker after 10 minutes; drop it here too
  useEffect(() => {
    if (!setup) return;
    const id = setTimeout(() => setSetup(null), 10 * 60_000);
    return () => clearTimeout(id);
  }, [setup]);

  if (q.isPending || q.error || !q.data) return null;
  const d = q.data;
  const left = d.recoveryLeft ?? 0;

  return (
    <Card title={t('totp_title')}>
      <div className="flex flex-col gap-3">
        <p className="text-xs text-muted">{t('totp_help')}</p>
        {codes && <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />}
        {d.enabled ? (
          <div className="flex flex-col gap-2 text-sm">
            <span className="text-pos">{d.enabledAt ? t('totp_on_since', { date: dayLabel(d.enabledAt.slice(0, 10), locale, { year: true }) }) : t('totp_on')}</span>
            {d.recoveryLeft !== null && <span className={left === 0 ? 'text-warn' : 'text-muted'}>{left === 0 ? t('totp_codes_none') : left === 1 ? t('totp_codes_left_one') : t('totp_codes_left', { n: left })}</span>}
            {d.canEdit &&
              (asking ? (
                <div className="flex items-center gap-2 flex-wrap">
                  <span>{t('totp_turn_off_q')}</span>
                  <button className="btn btn-sm" disabled={turnOff.isPending} onClick={() => turnOff.mutate()}>
                    {t('totp_yes')}
                  </button>
                  <button className="btn btn-sm" disabled={turnOff.isPending} onClick={() => setAsking(false)}>
                    {t('cancel')}
                  </button>
                </div>
              ) : (
                <div>
                  <button className="btn btn-sm" onClick={() => setAsking(true)}>
                    {t('totp_turn_off')}
                  </button>
                </div>
              ))}
          </div>
        ) : setup ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (isAppCode(code)) confirm.mutate(code.replace(/\s+/g, ''));
            }}
          >
            <div className="flex flex-col sm:flex-row gap-4 items-center card p-3">
              <TotpQr uri={setup.uri} />
              <div className="flex flex-col gap-1 text-sm min-w-0">
                <span>{t('totp_scan')}</span>
                <span className="text-xs text-muted mt-1">{t('totp_manual')}</span>
                <code className="num break-all select-all text-start" dir="ltr">
                  {groupSecret(setup.secret)}
                </code>
              </div>
            </div>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted">{t('totp_confirm_label')}</span>
              <input className="input num text-lg tracking-widest max-w-[12rem] text-start" type="text" inputMode="numeric" autoComplete="one-time-code" dir="ltr" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} />
            </label>
            <div className="flex gap-2">
              <button className="btn btn-sm btn-primary" disabled={confirm.isPending || !isAppCode(code)}>
                {t('totp_confirm')}
              </button>
              <button type="button" className="btn btn-sm" disabled={confirm.isPending} onClick={() => { setSetup(null); setCode(''); setMsg(null); }}>
                {t('cancel')}
              </button>
            </div>
          </form>
        ) : (
          !codes && (
            <div className="flex items-center gap-2 flex-wrap">
              <button className="btn btn-sm btn-primary" disabled={!d.canEdit || start.isPending} onClick={() => start.mutate()}>
                {t('totp_setup')}
              </button>
              {!d.canEdit && <span className="text-xs text-muted">{t('totp_home_only')}</span>}
            </div>
          )
        )}
        {d.enabled && !d.canEdit && <span className="text-xs text-muted">{t('totp_home_only')}</span>}
        {msg && <div className="text-neg text-sm">{msg}</div>}
      </div>
    </Card>
  );
}
