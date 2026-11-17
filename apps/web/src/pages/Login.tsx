import { useState } from 'react';
import { ApiError, api } from '../api';
import { useI18n } from '../i18n';
import { onRpHost, passkeyFailure, passkeysSupported, signInWithPasskey } from '../passkey';
import { codeKind, signInWithTotp, totpLoginError } from '../totp';
import type { PasskeysInfo } from '../types';

export function Login({ pinSet, trusted = true, passkeys, totp = false, onDone }: { pinSet: boolean; trusted?: boolean; passkeys?: PasskeysInfo | null; totp?: boolean; onDone: () => void }) {
  const { t, lang, setLang, locale } = useI18n();
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pkMsg, setPkMsg] = useState<{ text: string; calm: boolean } | null>(null);
  const [pkBusy, setPkBusy] = useState(false);
  // the backup login (PIN + authenticator code): only away from home, where the plain PIN does not work
  const [totpOpen, setTotpOpen] = useState(false);
  const [totpPin, setTotpPin] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [totpErr, setTotpErr] = useState<string | null>(null);
  const [totpBusy, setTotpBusy] = useState(false);

  // a passkey only works on the public host it was made for, in a browser that speaks WebAuthn
  const canPasskey = pinSet && !!passkeys?.available && onRpHost(passkeys.rpId) && passkeysSupported();
  // on the public address with no passkey yet: say how to get one, so the missing button is not a mystery
  const canTotp = pinSet && !trusted && totp;
  const totpShown = canTotp && totpOpen;
  const noPasskeyYet = pinSet && !trusted && !!passkeys && !passkeys.available && onRpHost(passkeys.rpId) && passkeysSupported();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!pinSet && pin !== again) return setErr(t('pin_mismatch'));
    setBusy(true);
    try {
      await api.post(pinSet ? '/api/auth/login' : '/api/auth/setup', { pin });
      onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function totpSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTotpErr(null);
    if (!codeKind(totpCode)) return setTotpErr(t('totp_code_bad'));
    setTotpBusy(true);
    try {
      await signInWithTotp(totpPin, totpCode);
      onDone();
    } catch (e) {
      setTotpErr(totpLoginError(e, t, locale));
      setTotpCode('');
    } finally {
      setTotpBusy(false);
    }
  }

  async function passkey() {
    setPkMsg(null);
    setPkBusy(true);
    try {
      await signInWithPasskey();
      onDone();
    } catch (e) {
      if (passkeyFailure(e) === 'cancelled') setPkMsg({ text: t('pk_cancelled'), calm: true });
      else setPkMsg({ text: `${t('pk_failed')}: ${e instanceof Error ? e.message : String(e)}`, calm: false });
    } finally {
      setPkBusy(false);
    }
  }

  const passkeyBlock = canPasskey && (
    <div className="flex flex-col gap-2">
      <button type="button" className="btn btn-primary" disabled={pkBusy} onClick={() => void passkey()}>
        {t('pk_sign_in')}
      </button>
      {pkMsg && <div className={`text-sm ${pkMsg.calm ? 'text-muted' : 'text-neg'}`}>{pkMsg.text}</div>}
    </div>
  );

  // a second way in, below the passkey (still the first, recommended one)
  const totpBlock = canTotp && (
    totpShown ? (
      <div className="flex flex-col gap-3">
        <div className="font-medium text-sm">{t('totp_sign_in')}</div>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">{t('pin')}</span>
          <input className="input num text-lg tracking-widest" type="password" inputMode="numeric" autoComplete="current-password" autoFocus value={totpPin} onChange={(e) => setTotpPin(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">{t('totp_code')}</span>
          <input className="input num text-lg tracking-widest text-start" type="text" inputMode="text" autoComplete="one-time-code" dir="ltr" spellCheck={false} autoCapitalize="characters" maxLength={14} value={totpCode} onChange={(e) => setTotpCode(e.target.value)} />
          <span className="text-xs text-muted">{t('totp_code_hint')}</span>
        </label>
        {totpErr && <div className="text-neg text-sm">{totpErr}</div>}
        <div className="flex gap-2">
          <button className={`btn flex-1 ${canPasskey ? '' : 'btn-primary'}`} disabled={totpBusy || totpPin.length < 4 || !totpCode.trim()}>
            {t('sign_in')}
          </button>
          <button type="button" className="btn" onClick={() => { setTotpOpen(false); setTotpErr(null); setTotpPin(''); setTotpCode(''); }}>
            {t('totp_back')}
          </button>
        </div>
      </div>
    ) : (
      <div className="flex flex-col gap-1">
        {canPasskey && <div className="text-center text-xs text-muted">{t('totp_or')}</div>}
        <button type="button" className="btn" onClick={() => setTotpOpen(true)}>
          {t('totp_sign_in')}
        </button>
      </div>
    )
  );

  return (
    <div className="min-h-full flex items-center justify-center p-6">
      <form onSubmit={totpShown ? totpSubmit : submit} className="card p-6 w-full max-w-sm flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <img src="/icon.svg" alt="" className="h-10 w-10 rounded-xl" />
          <div>
            <h1 className="font-bold text-lg leading-tight">{pinSet ? t('pin_login_title') : t('pin_setup_title')}</h1>
            <p className="text-muted text-sm">{pinSet ? t('pin_login_help') : t('pin_setup_help')}</p>
          </div>
        </div>
        {!totpShown && passkeyBlock}
        {totpBlock}
        {(canPasskey && !trusted) || totpShown ? null : (
          <>
            {canPasskey && <div className="text-center text-xs text-muted">{t('pk_or_pin')}</div>}
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted">{t('pin')}</span>
              <input className="input num text-lg tracking-widest" type="password" inputMode="numeric" autoComplete={pinSet ? 'current-password' : 'new-password'} autoFocus={!canPasskey} value={pin} onChange={(e) => setPin(e.target.value)} />
            </label>
            {!pinSet && (
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted">{t('pin_repeat')}</span>
                <input className="input num text-lg tracking-widest" type="password" inputMode="numeric" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
              </label>
            )}
            {noPasskeyYet && <div className="text-sm text-muted">{t('pk_none_yet')}</div>}
            {!trusted && (
              <div className="text-sm flex flex-col gap-1">
                <span className="text-warn">{t('pair_only_home')}</span>
                <span className="text-muted">{t('pair_from_outside')}</span>
                <span className="num text-xs text-muted" dir="ltr">
                  {window.location.origin}/pair?code=…
                </span>
              </div>
            )}
            {err && <div className="text-neg text-sm">{err}</div>}
            <button className={`btn ${canPasskey ? '' : 'btn-primary'}`} disabled={busy || pin.length < 4 || !trusted}>
              {pinSet ? t('sign_in') : t('continue')}
            </button>
          </>
        )}
        <div className="flex justify-center gap-3 text-xs text-muted">
          <button type="button" className={lang === 'he' ? 'text-accent' : ''} onClick={() => setLang('he')}>
            עברית
          </button>
          <button type="button" className={lang === 'en' ? 'text-accent' : ''} onClick={() => setLang('en')}>
            English
          </button>
        </div>
      </form>
    </div>
  );
}
