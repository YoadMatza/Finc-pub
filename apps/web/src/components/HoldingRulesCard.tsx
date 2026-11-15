import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api } from '../api';
import { useI18n } from '../i18n';
import { HOLDING_RULES_KEY } from '../holdingRules';
import type { HoldingRulesPayload } from '../types';
import { Card } from './ui';

/**
 * Settings → My stock rules: what the feature is, how many rules there are, and a link to the editor page.
 * Hidden when the hub does not know the endpoint (an older hub answers an error).
 */
export function HoldingRulesCard() {
  const { t } = useI18n();
  const q = useQuery({ queryKey: HOLDING_RULES_KEY, queryFn: () => api.get<HoldingRulesPayload>('/api/holding-rules'), retry: false });
  if (q.isError) return null;
  const rules = q.data?.rules;
  return (
    <Card title={t('hr_title')}>
      <div className="flex flex-col gap-2">
        <p className="text-xs text-muted leading-relaxed">{t('hr_intro')}</p>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm">{rules ? (rules.length ? t('hr_count', { n: rules.length, on: rules.filter((r) => r.enabled).length }) : t('hr_none')) : ''}</span>
          <Link to="/stock-rules" className="btn btn-sm">
            {t('hr_manage')}
          </Link>
        </div>
      </div>
    </Card>
  );
}
