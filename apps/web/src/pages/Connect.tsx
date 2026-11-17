import { startAuthentication } from '@simplewebauthn/browser';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import { ApiError } from '../api';
import { Spinner } from '../components/ui';
import { connectErrorKey, requestOptionsFrom, safeConnectRedirect, validRequestId } from '../connect';
import { useI18n } from '../i18n';
import { passkeyFailure, passkeysSupported } from '../passkey';
import type { OAuthRequestInfo } from '../types';

/**
 * The consent page for a remote AI app (remote-mcp.md §3, §4.3), at /connect?req=<id>. It works without a hub
 * session: ChatGPT or Claude sends the owner's browser here (often a phone), and approval needs a fresh passkey
 * signature over this request, never an existing session. The app's name comes from finc's allow-list.
 *
 * Calls go same-origin with plain fetch (not api.ts): no device token, and a 401 here must not sign the hub out.
 */
async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(typeof data['error'] === 'string' ? data['error'] : `HTTP ${res.status}`, res.status, undefined, data);
  return data as T;
}

/** A known reason is kept as its key (so it follows a language switch); anything else as the server's text. */
type Load = { kind: 'loading' } | { kind: 'error'; key: ReturnType<typeof connectErrorKey>; text: string } | { kind: 'ready'; info: OAuthRequestInfo };

export function Connect() {
  const { t, lang, setLang } = useI18n();
  const req = new URLSearchParams(useLocation().search).get('req');
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const [err, setErr] = useState<{ text: string; calm?: boolean } | null>(null);
  const [leaving, setLeaving] = useState<'approved' | 'denied' | null>(null);
  const supported = passkeysSupported();
  const base = validRequestId(req) ? `/api/oauth/requests/${encodeURIComponent(req)}` : null;

  useEffect(() => {
    if (!base) {
      setLoad({ kind: 'error', key: 'connect_err_not_found', text: '' });
      return;
    }
    let live = true;
    call<OAuthRequestInfo>('GET', base).then(
      (info) => live && setLoad({ kind: 'ready', info }),
      (e: unknown) => {
        if (!live) return;
        const key = e instanceof ApiError ? connectErrorKey(e.data['code']) : null;
        setLoad({ kind: 'error', key, text: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      live = false;
    };
  }, [base]);

  /** Follow the worker's redirect only if it is ChatGPT's or Claude's (checked again here, connect.ts). */
  const go = (redirect: unknown, kind: 'approved' | 'denied') => {
    const safe = safeConnectRedirect(redirect);
    if (!safe) {
      setErr({ text: t('connect_bad_redirect') });
      return;
    }
    setLeaving(kind);
    window.location.assign(safe);
  };

  const approve = async () => {
    if (!base) return;
    setBusy('approve');
    setErr(null);
    try {
      const optionsJSON = requestOptionsFrom<PublicKeyCredentialRequestOptionsJSON>(await call<unknown>('POST', `${base}/options`, {}));
      if (!optionsJSON) throw new Error('no passkey options');
      const response = await startAuthentication({ optionsJSON });
      const r = await call<{ redirect: string }>('POST', `${base}/approve`, { response });
      go(r.redirect, 'approved');
    } catch (e) {
      if (!(e instanceof ApiError) && passkeyFailure(e) === 'cancelled') setErr({ text: t('connect_cancelled'), calm: true });
      else setErr({ text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const deny = async () => {
    if (!base) return;
    setBusy('deny');
    setErr(null);
    try {
      const r = await call<{ redirect: string }>('POST', `${base}/deny`, {});
      go(r.redirect, 'denied');
    } catch (e) {
      setErr({ text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="min-h-full flex items-center justify-center p-6">
      <div className="card p-6 w-full max-w-sm flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <img src="/icon.svg" alt="" className="h-10 w-10 rounded-xl" />
          <div className="flex flex-col">
            <span className="font-bold text-lg leading-tight">finc</span>
            <span className="text-sm text-muted">{t('connect_title')}</span>
          </div>
        </div>
        {load.kind === 'loading' ? (
          <Spinner />
        ) : load.kind === 'error' ? (
          <p className="text-sm text-warn text-start">{load.key ? t(load.key) : `${t('error')}: ${load.text}`}</p>
        ) : leaving ? (
          <p className="text-sm text-pos">{t(leaving === 'approved' ? 'connect_approved' : 'connect_denied', { app: load.info.app })}</p>
        ) : (
          <>
            <h1 className="font-semibold text-base text-start">{t('connect_wants', { app: load.info.app })}</h1>
            <div className="text-sm flex flex-col gap-1">
              <span className="text-muted">{t('connect_returns')}</span>
              <span className="num break-all text-start" dir="ltr">
                {load.info.redirectHost}
              </span>
            </div>
            <p className="text-sm text-muted text-start">{t('mcp_setting_help')}</p>
            <p className="text-sm text-muted text-start">{t('connect_lasts')}</p>
            {!supported && <p className="text-sm text-warn">{t('pk_unsupported')}</p>}
            <div className="flex gap-2">
              <button className="btn btn-primary flex-1" disabled={!supported || busy !== null} onClick={() => void approve()}>
                {t('connect_approve')}
              </button>
              <button className="btn flex-1" disabled={busy !== null} onClick={() => void deny()}>
                {t('connect_deny')}
              </button>
            </div>
          </>
        )}
        {err && <div className={`text-sm text-start ${err.calm ? 'text-muted' : 'text-neg'}`}>{err.text}</div>}
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
