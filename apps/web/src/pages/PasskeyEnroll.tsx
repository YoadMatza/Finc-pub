import { useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import { ApiError, browserLabel } from '../api';
import { useI18n } from '../i18n';
import { onRpHost, passkeyFailure, passkeysSupported, registerPasskey } from '../passkey';
import type { PasskeysInfo } from '../types';

/**
 * What the phone camera lands on when it scans the "Add a passkey" QR made at home. Works before any
 * sign-in: the one-time code is the permission, and a successful registration signs this browser in.
 */
export function PasskeyEnroll() {
  const { t, lang, setLang } = useI18n();
  const code = new URLSearchParams(useLocation().search).get('code') ?? '';
  const [name, setName] = useState(() => browserLabel());
  const [rpId, setRpId] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ text: string; calm?: boolean } | null>(null);
  const [done, setDone] = useState(false);
  const supported = passkeysSupported();

  // the passkey is bound to the public host: learn it so a page opened elsewhere can say where to go
  useEffect(() => {
    void fetch('/api/auth/status', { credentials: 'same-origin' })
      .then((r) => r.json() as Promise<{ passkeys?: PasskeysInfo }>)
      .then((s) => setRpId(s.passkeys?.rpId ?? null))
      .catch(() => setRpId(null));
  }, []);

  const wrongHost = !!rpId && !onRpHost(rpId);

  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      await registerPasskey(code, name.trim() || undefined);
      setDone(true);
    } catch (e) {
      const f = passkeyFailure(e);
      if (f === 'cancelled') setErr({ text: t('pk_enroll_cancelled'), calm: true });
      else if (f === 'already') setErr({ text: t('pk_enroll_already'), calm: true });
      else if (e instanceof ApiError && e.status === 401) setErr({ text: t('pk_enroll_expired') });
      else if (e instanceof ApiError && e.status === 409) setErr({ text: t('pk_no_public_url') });
      else setErr({ text: `${t('pk_enroll_failed')}: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-full flex items-center justify-center p-6">
      <div className="card p-6 w-full max-w-sm flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <img src="/icon.svg" alt="" className="h-10 w-10 rounded-xl" />
          <h1 className="font-bold text-lg leading-tight">{t('pk_enroll_title')}</h1>
        </div>
        {done ? (
          <>
            <p className="text-sm text-pos">{t('pk_enroll_done')}</p>
            <button className="btn btn-primary" onClick={() => window.location.replace('/')}>
              {t('pk_open_finc')}
            </button>
          </>
        ) : !code ? (
          <p className="text-sm text-muted">{t('pk_no_code')}</p>
        ) : !supported ? (
          <p className="text-sm text-warn">{t('pk_unsupported')}</p>
        ) : wrongHost ? (
          <div className="text-sm flex flex-col gap-1">
            <span className="text-warn">{t('pk_wrong_host')}</span>
            <span className="num break-all" dir="ltr">
              {rpId}
            </span>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted">{t('pk_enroll_help')}</p>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted">{t('pk_name')}</span>
              <input className="input" dir="auto" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <button className="btn btn-primary" disabled={busy || rpId === undefined} onClick={() => void create()}>
              {t('pk_create')}
            </button>
          </>
        )}
        {err && <div className={`text-sm ${err.calm ? 'text-muted' : 'text-neg'}`}>{err.text}</div>}
        <div className="flex justify-center gap-3 text-xs text-muted">
          <button type="button" className={lang === 'he' ? 'text-accent' : ''} onClick={() => setLang('he')}>
            עברית
          </button>
          <button type="button" className={lang === 'en' ? 'text-accent' : ''} onClick={() => setLang('en')}>
            English
          </button>
        </div>
      </div>
    </div>
  );
}
