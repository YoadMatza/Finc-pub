import { money } from '../format';
import { useI18n } from '../i18n';
import type { Settings } from '../types';
import { LimitAmountForm, useSaveSpendLimit } from './LimitCard';
import { Card, ErrorBox } from './ui';

/**
 * Settings → Monthly spending limit (now-screen step 2): an amount in shekels for day-to-day spending, or off.
 * It is saved for the current month and carries forward; earlier months keep theirs. Hidden on an older hub.
 */
export function SpendLimitCard({ limit }: { limit: Settings['spendLimit'] }) {
  const { t } = useI18n();
  const off = useSaveSpendLimit();
  if (!limit) return null;
  return (
    <Card title={t('spend_limit')}>
      <p className="text-xs text-muted mb-2">{t('spend_limit_help')}</p>
      <div className="flex items-center gap-2 text-sm mb-2 flex-wrap">
        <span className="flex-1">{limit.amount !== null ? t('spend_limit_current', { x: money(limit.amount, { decimals: 0 }) }) : t('spend_limit_none')}</span>
        {limit.amount !== null && (
          <button className="btn btn-sm" disabled={off.isPending} onClick={() => off.mutate({ month: limit.month, amount: null })}>
            {t('spend_limit_off')}
          </button>
        )}
      </div>
      <LimitAmountForm key={`${limit.month}-${limit.amount ?? 'off'}`} id="settings-limit-amount" month={limit.month} initial={limit.amount} />
      {off.error && <ErrorBox error={off.error} />}
    </Card>
  );
}
