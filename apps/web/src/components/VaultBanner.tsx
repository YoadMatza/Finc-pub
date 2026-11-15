import { useQuery } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router';
import { api } from '../api';
import { useI18n } from '../i18n';
import type { Health } from '../types';

/**
 * A banner on every page while the vault is locked (security research P1-05): the syncs wait, and without the alarm
 * bot no security alert can reach Telegram, so the state must be impossible to miss. At home it links to the unlock
 * form; elsewhere it says where to unlock (only on the PC, P1-01).
 */
export function VaultBanner() {
  const { t } = useI18n();
  const loc = useLocation();
  const health = useQuery({ queryKey: ['health'], queryFn: () => api.get<Health>('/api/health'), refetchInterval: 15_000 });
  const auth = useQuery({ queryKey: ['auth'], queryFn: () => api.get<{ trusted: boolean }>('/api/auth/status'), staleTime: 60_000 });
  if (health.data?.vault !== 'locked' || !auth.isSuccess) return null;
  return (
    <div role="alert" className="mb-3 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn flex items-center justify-between gap-2">
      <span>{auth.data.trusted ? t('vault_locked_banner') : t('vault_unlock_home_only')}</span>
      {auth.data.trusted && loc.pathname !== '/accounts' && (
        <Link to="/accounts" className="btn btn-sm shrink-0">
          {t('vault_unlock')}
        </Link>
      )}
    </div>
  );
}
