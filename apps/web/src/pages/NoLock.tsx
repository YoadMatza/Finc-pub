import { useState } from 'react';
import { useI18n } from '../i18n';

/**
 * The phone has no screen lock (or this APK has no vault): finc refuses to run, since there is nothing to bind
 * the device token's key to (security research P1-11). "Check again" re-reads the vault status.
 */
export function NoLock({ variant, onRetry }: { variant: 'nolock' | 'novault'; onRetry: () => Promise<void> }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  return (
    <div className="min-h-full flex items-center justify-center p-6">
      <div className="card p-6 w-full max-w-sm flex flex-col items-center gap-4 text-center">
        <img src="/icon.svg" alt="" className="h-14 w-14 rounded-2xl" />
        <h1 className="font-bold text-lg">{t(variant === 'nolock' ? 'nolock_title' : 'novault_title')}</h1>
        <p className="text-muted text-sm">{t(variant === 'nolock' ? 'nolock_help' : 'novault_help')}</p>
        <button
          className="btn btn-primary w-full"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onRetry().finally(() => setBusy(false));
          }}
        >
          {t('nolock_retry')}
        </button>
      </div>
    </div>
  );
}
