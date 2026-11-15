import { useState } from 'react';
import { useLocation } from 'react-router';
import { ApiError, pairThisBrowser } from '../api';
import { useI18n } from '../i18n';

/** What a phone camera lands on when it scans the pairing QR with a normal camera app. */
export function PairInfo() {
  const { t } = useI18n();
  const code = new URLSearchParams(useLocation().search).get('code') ?? '';
  const hub = window.location.origin;
  const intent = `intent://pair?code=${encodeURIComponent(code)}&url=${encodeURIComponent(hub)}#Intent;scheme=finc;package=il.finc.app;end`;
  const android = /Android/i.test(navigator.userAgent);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pairHere = async () => {
    setBusy(true);
    setErr(null);
    try {
      await pairThisBrowser(code);
      window.location.replace('/');
    } catch (e) {
      setErr(`${t('pair_failed')}: ${e instanceof ApiError ? e.message : String(e)}`);
      setBusy(false);
    }
  };
  return (
    <div className="min-h-full flex items-center justify-center p-6">
      <div className="card p-6 w-full max-w-sm flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <img src="/icon.svg" alt="" className="h-10 w-10 rounded-xl" />
          <h1 className="font-bold text-lg leading-tight">{t('pair_title')}</h1>
        </div>
        <p className="text-sm text-muted">{code ? t('pair_page_help') : t('pair_from_outside')}</p>
        {code && (
          <div className="card p-3 text-center">
            <div className="text-xs text-muted">{t('pairing_code')}</div>
            <div className="num text-lg break-all select-all" dir="ltr">
              {code}
            </div>
            <div className="text-xs text-muted mt-1" dir="ltr">
              {hub}
            </div>
          </div>
        )}
        {/* On an Android phone the camera usually lands here: the app is what is wanted, pairing Chrome itself is the
            exception. Elsewhere (a computer) pairing this browser is the point of the page. */}
        {code && android && (
          <a className="btn btn-primary text-center" href={intent}>
            {t('open_in_app')}
          </a>
        )}
        {code && (
          <button className={`btn ${android ? '' : 'btn-primary'}`} disabled={busy} onClick={() => void pairHere()}>
            {t('pair_browser_btn')}
          </button>
        )}
        {code && android && <p className="text-xs text-muted">{t('pair_open_app_tip')}</p>}
        {code && !android && (
          <a className="btn text-center" href={intent}>
            {t('open_in_app')}
          </a>
        )}
        {err && <div className="text-neg text-sm">{err}</div>}
      </div>
    </div>
  );
}
