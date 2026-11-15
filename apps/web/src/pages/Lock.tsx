import { useEffect, useRef, useState } from 'react';
import { type Key, useI18n } from '../i18n';
import { unlockOutcome, type UnlockOutcome } from '../lockflow';
import { unlockServer } from '../native';
import { nextFailureCount, offerForget } from '../relock';

/**
 * The fingerprint / screen-lock gate on open and after 30 seconds in the background. Unlocking is what decrypts
 * the device token (FincVault, security research P1-11): before this screen succeeds the token is not in memory.
 * A cancelled or failed prompt stays here with a retry button; everything else goes to the caller.
 * After three failures in a row it offers a way out: forget the pairing (confirmed in the page) and pair again.
 */
export function Lock({ onOutcome, onForget }: { onOutcome: (o: Exclude<UnlockOutcome, { kind: 'retry' }>) => void; onForget: () => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Key | null>(null);
  const [failures, setFailures] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const inFlight = useRef(false);

  async function unlock() {
    if (inFlight.current) return; // StrictMode mounts twice; never show two prompts
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const o = unlockOutcome(await unlockServer({ title: t('lock_title'), subtitle: t('vault_unlock_subtitle'), migrateSubtitle: t('vault_migrate_subtitle') }));
      setFailures((n) => nextFailureCount(n, o));
      if (o.kind === 'retry') setMessage(o.message);
      else onOutcome(o);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  useEffect(() => {
    void unlock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-full flex items-center justify-center p-6">
      <div className="card p-6 w-full max-w-sm flex flex-col items-center gap-4 text-center">
        <img src="/icon.svg" alt="" className="h-14 w-14 rounded-2xl" />
        <h1 className="font-bold text-lg">{t('lock_title')}</h1>
        {message && <div className="text-neg text-sm">{t(message)}</div>}
        <button className="btn btn-primary w-full" disabled={busy} onClick={() => void unlock()}>
          {t('unlock_app')}
        </button>
        {(offerForget(failures) || message === 'lock_wrong_host') &&
          (confirming ? (
            <div className="flex flex-col gap-3 w-full">
              <p className="text-sm">{t('lock_forget_confirm')}</p>
              <div className="flex gap-2">
                <button className="btn flex-1" disabled={busy} onClick={() => setConfirming(false)}>
                  {t('cancel')}
                </button>
                <button className="btn btn-primary flex-1" disabled={busy} onClick={onForget}>
                  {t('lock_forget_yes')}
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="text-xs text-muted hover:text-text" disabled={busy} onClick={() => setConfirming(true)}>
              {t('lock_forget')}
            </button>
          ))}
      </div>
    </div>
  );
}
