import { useEffect, useState } from 'react';
import { ApiError, pairDevice } from '../api';
import { useI18n } from '../i18n';
import { storeFailureMessage } from '../lockflow';
import { checkHubUrl, type HubCheck } from '../hubhost';
import { deviceModel, hubPolicy, keepPairing, onAppUrl, parsePairingText, scanQr, type PairedServer } from '../native';

/** The Android app's first screen: scan the QR from Settings → Pair a phone, or type the address and code. */
export function Pair({ onPaired, message, lastUrl }: { onPaired: (s: PairedServer) => void; message?: string | null; lastUrl?: string | null }) {
  const { t, lang, setLang } = useI18n();
  const [manual, setManual] = useState(false);
  const [url, setUrl] = useState(lastUrl ?? '');
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(message ?? null);
  const [busy, setBusy] = useState(false);
  // Redeemed at the hub but not yet in the vault (the prompt was cancelled). The pairing code is single-use,
  // so a retry stores this same pairing again instead of pairing anew; its token waits in native memory (P2-01).
  // It never counts as paired until stored.
  const [unsaved, setUnsaved] = useState<PairedServer | null>(null);

  /** Into the vault (fingerprint / screen-lock prompt) and only then paired (security research P1-11). */
  async function keep(server: PairedServer) {
    const saved = await keepPairing({ title: t('vault_store_title'), subtitle: t('vault_store_subtitle') });
    if (!saved.ok) {
      setUnsaved(server);
      setErr(t(storeFailureMessage(saved.reason)));
      return;
    }
    setUnsaved(null);
    onPaired(server);
  }

  async function retryKeep() {
    if (!unsaved) return;
    setBusy(true);
    setErr(null);
    try {
      await keep(unsaved);
    } finally {
      setBusy(false);
    }
  }

  /** Why a hub URL is refused, in the user's language; null when it is acceptable. */
  function refusal(c: HubCheck, host: string | null): string | null {
    if (c.ok) return null;
    if (c.reason === 'https') return t('pair_https_only');
    if (c.reason === 'host') return host ? t('pair_wrong_host', { host }) : t('pair_wrong_host_any');
    return t('pair_failed');
  }

  async function redeem(target: { url: string; code: string }) {
    setBusy(true);
    setErr(null);
    setUnsaved(null);
    try {
      // Security research P1-10: the app pins the public key of its own hub only. The code is never sent to any
      // other host (a release build refuses it here, and the vault refuses to store it as well).
      const policy = await hubPolicy();
      const checked = checkHubUrl(target.url, policy);
      if (!checked.ok) {
        setErr(refusal(checked, policy.host));
        return;
      }
      // redeemed natively (P2-01): the token stays in native memory; the hub's own address is taken only if it
      // passes the same host check, natively (HubRequestRules.pairedOrigin, the mirror of hubhost pairedOrigin)
      const r = await pairDevice(checked.origin, target.code, deviceModel());
      await keep({ url: r.url, deviceName: r.device.name });
    } catch (e) {
      setErr(`${t('pair_failed')}: ${e instanceof ApiError ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  useEffect(
    () =>
      onAppUrl((u) => {
        // finc://pair?code=…&url=… from a camera app, or the https link itself. Any page or message can open
        // such a link, so the hub must be https and the user confirms the host before anything is sent (audit M3).
        // A release app also refuses, before asking, any host other than the one it pins (P1-10).
        void (async () => {
          try {
            const parsed = new URL(u);
            const code = parsed.searchParams.get('code');
            const hub = parsed.searchParams.get('url') ?? (parsed.protocol.startsWith('http') ? parsed.origin : null);
            if (!code || !hub) return;
            const policy = await hubPolicy();
            const checked = checkHubUrl(hub, policy);
            if (!checked.ok) return setErr(refusal(checked, policy.host));
            if (!window.confirm(t('pair_confirm_host', { host: new URL(checked.origin).host }))) return;
            void redeem({ url: checked.origin, code });
          } catch {
            setErr(t('pair_failed'));
          }
        })();
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  async function scan() {
    setErr(null);
    try {
      const text = await scanQr();
      if (!text) return;
      const parsed = parsePairingText(text, url || undefined);
      if (!parsed) return setErr(t('scan_failed'));
      await redeem(parsed);
    } catch (e) {
      setErr(`${t('scan_failed')}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <div className="min-h-full flex items-center justify-center p-6">
      <div className="card p-6 w-full max-w-sm flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <img src="/icon.svg" alt="" className="h-10 w-10 rounded-xl" />
          <div>
            <h1 className="font-bold text-lg leading-tight">{t('pair_title')}</h1>
            <p className="text-muted text-sm">{t('pair_app_help')}</p>
          </div>
        </div>
        {err && <div className="text-neg text-sm">{err}</div>}
        {unsaved && (
          <button className="btn btn-primary" disabled={busy} onClick={() => void retryKeep()}>
            {t('pair_store_retry')}
          </button>
        )}
        <button className="btn btn-primary" disabled={busy} onClick={() => void scan()}>
          {t('scan_qr')}
        </button>
        {!manual ? (
          <button type="button" className="text-xs text-muted hover:text-text" onClick={() => setManual(true)}>
            {t('manual_entry')}
          </button>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              // a pairing code is a random 22-character string; only digits is almost surely the PIN: never send it
              if (/^\d+$/.test(code)) return setErr(t('pair_code_not_pin'));
              const parsed = parsePairingText(code, url);
              if (!parsed) return setErr(t('pair_failed'));
              void redeem(parsed);
            }}
          >
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted">{t('server_url')}</span>
              <input className="input" dir="ltr" type="url" inputMode="url" placeholder="https://your-name.duckdns.org" value={url} onChange={(e) => setUrl(e.target.value)} autoCapitalize="off" autoCorrect="off" />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted">{t('pairing_code')}</span>
              <input className="input num" dir="ltr" value={code} onChange={(e) => setCode(e.target.value.trim())} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
              <span className="text-xs text-muted">{t('pair_code_where')}</span>
            </label>
            <button className="btn btn-primary" disabled={busy || code.length < 8 || (!url && !code.startsWith('http'))}>
              {t('pair_now')}
            </button>
          </form>
        )}
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
