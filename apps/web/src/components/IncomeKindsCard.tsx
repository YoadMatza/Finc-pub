import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useI18n } from '../i18n';
import type { CategoriesOverview, IncomeKind, Settings } from '../types';
import { Card, Chip, ErrorBox } from './ui';

/**
 * Settings → Income types (now-screen step 1): each income category is regular (salary, recurring) or extra
 * (freelance, gifts, one-offs). The Now screen's "without the extra income" follows this. A category the hub
 * has no kind for counts as extra (§1). Hidden on an older hub that does not send `incomeKinds`.
 */
export function IncomeKindsCard({ kinds }: { kinds: Settings['incomeKinds'] }) {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const cats = useQuery({ queryKey: ['categories-flat'], queryFn: () => api.get<CategoriesOverview>('/api/categories'), staleTime: 300_000 });
  const save = useMutation({
    mutationFn: (p: { key: string; kind: IncomeKind }) => api.patch('/api/settings', { incomeKinds: { [p.key]: p.kind } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings'] });
      void qc.invalidateQueries({ queryKey: ['hub'] });
    },
  });
  if (!kinds) return null;
  const income = cats.data?.groups.filter((g) => g.section === 'income' || g.key === 'income').flatMap((g) => g.categories.filter((c) => c.id > 0)) ?? [];
  return (
    <Card title={t('income_kinds')}>
      <p className="text-xs text-muted mb-2">{t('income_kinds_help')}</p>
      {cats.error && <ErrorBox error={cats.error} onRetry={() => cats.refetch()} />}
      {cats.data && income.length === 0 && <div className="text-sm text-muted">{t('income_kinds_none')}</div>}
      <div className="flex flex-col gap-1">
        {income.map((c) => {
          const kind: IncomeKind = kinds[c.key] ?? 'extra';
          return (
            <div key={c.id} className="flex items-center gap-2 text-sm py-1">
              <span className="flex-1 truncate">
                {c.icon ?? ''} {lang === 'he' ? c.nameHe : c.nameEn}
              </span>
              {(['regular', 'extra'] as const).map((k) => (
                <Chip key={k} on={kind === k} onClick={() => kind !== k && !save.isPending && save.mutate({ key: c.key, kind: k })}>
                  {t(k === 'regular' ? 'income_kind_regular' : 'income_kind_extra')}
                </Chip>
              ))}
            </div>
          );
        })}
      </div>
      {save.error && <ErrorBox error={save.error} />}
    </Card>
  );
}
