import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, api } from '../api';
import { PANIC_WORD, panicOutcome, panicWordOk, telegramLockdownKey } from '../devicePolicy';
import { useI18n } from '../i18n';
import type { PanicResult, Settings } from '../types';
import { Card } from './ui';

/**
 * Settings → Lock everything (security research P1-09): removes every paired phone and browser session and locks
 * the vault, from anywhere. Afterwards this app's own access is gone too: re-checking /api/auth/status unpairs the
 * phone app (deviceStatus 'revoked') and brings a browser back to its sign-in screen; the PC's CLI token stays.
 */
export function LockdownCard({ settings }: { settings: Pick<Settings, 'lockdownTelegram'> }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [step, setStep] = useState<'idle' | 'confirm' | 'done' | 'ended'>('idle');
  const [word, setWord] = useState('');
  const [result, setResult] = useState<PanicResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // re-ask everything: the 401s (or auth/status itself) take the app to unpair / sign-in
  const recheck = () => void qc.invalidateQueries();
  const panic = useMutation({
    mutationFn: () => api.post<PanicResult>('/api/panic', { confirm: PANIC_WORD }),
    onMutate: () => setErr(null),
    onSuccess: (r) => {
      setResult(r);
      setStep('done');
      // not tied to this card: it must fire even if the screen changes in the meantime
      setTimeout(recheck, panicOutcome(r).showMs);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 401) {
        // this session had already ended (e.g. /lockdown from Telegram): nothing to wait for
        setStep('ended');
        recheck();
        return;
      }
      setErr(e instanceof ApiError ? e.message : String(e));
    },
  });

  const reset = () => {
    setStep('idle');
    setWord('');
    setErr(null);
  };

  return (
    <Card title={t('lockdown_title')}>
      <div className="flex flex-col gap-3">
        <p className="text-xs text-muted">{t('lockdown_help')}</p>
        <p className="text-xs text-muted">{t(telegramLockdownKey(settings))}</p>
        {step === 'idle' && (
          <div>
            <button className="btn btn-sm btn-danger" onClick={() => setStep('confirm')}>
              {t('lockdown_button')}
            </button>
          </div>
        )}
        {step === 'confirm' && (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (panicWordOk(word) && !panic.isPending) panic.mutate();
            }}
          >
            <label className="text-sm" htmlFor="lockdown-word">
              {t('lockdown_confirm_prompt')}{' '}
              <b className="num" dir="ltr">
                {PANIC_WORD}
              </b>
            </label>
            <div className="flex gap-2 items-center">
              <input
                id="lockdown-word"
                className="input flex-1 max-w-[12rem]"
                dir="ltr"
                autoFocus
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="characters"
                spellCheck={false}
                value={word}
                onChange={(e) => setWord(e.target.value)}
                placeholder={PANIC_WORD}
              />
              <button type="submit" className="btn btn-sm btn-danger" disabled={!panicWordOk(word) || panic.isPending}>
                {t('lockdown_confirm')}
              </button>
              <button type="button" className="btn btn-sm" disabled={panic.isPending} onClick={reset}>
                {t('cancel')}
              </button>
            </div>
          </form>
        )}
        {step === 'done' && result && <PanicDone result={result} />}
        {step === 'ended' && (
          <div className="text-sm text-warn" role="status">
            {t('lockdown_already_out')}
          </div>
        )}
        {err && <div className="text-neg text-sm">{err}</div>}
      </div>
    </Card>
  );
}

/** The outcome: counts, the vault, and on a partial failure (ok:false, still HTTP 200) what failed and what to do. */
function PanicDone({ result }: { result: PanicResult }) {
  const { t } = useI18n();
  const o = panicOutcome(result);
  return (
    <div className="flex flex-col gap-1 text-sm" role="status">
      <span className="text-neg font-semibold">{t(o.failed ? 'lockdown_partial' : 'lockdown_done', { devices: o.devices, sessions: o.sessions, passkeys: o.passkeys })}</span>
      <span className={o.vaultLocked ? 'text-muted' : 'text-warn'}>{o.vaultLocked ? t('lockdown_vault_locked') : t('lockdown_vault_open')}</span>
      {o.failed && (
        <div className="flex flex-col gap-1 rounded-lg border border-warn/40 p-2 text-warn" role="alert">
          <span className="font-semibold">{t('lockdown_failed_title')}</span>
          {o.errors.length > 0 && (
            <ul className="list-disc ps-5 text-xs" dir="auto">
              {o.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
          <span className="text-xs">
            {t('lockdown_failed_finish')}{' '}
            <code className="num" dir="ltr">
              .\finc panic
            </code>
          </span>
        </div>
      )}
      <span className="text-xs text-muted">{t('lockdown_ending')}</span>
    </div>
  );
}
