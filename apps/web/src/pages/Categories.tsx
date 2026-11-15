import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api, qs } from '../api';
import { MonthNav, useMonth } from '../components/MonthNav';
import { Amount, Bar, Card, ErrorBox, Spinner } from '../components/ui';
import { money } from '../format';
import { type Key, useI18n } from '../i18n';
import type { CategoriesOverview, CategoryView } from '../types';

const todayMonth = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);
const ORDER = ['lifestyle', 'daily', 'car', 'fixed', 'installments', 'savings', 'fees', 'other', 'uncategorised', 'income', 'transfers'];
/** One restrained colour per group: a dot on the header, the bars, the current month in the sparkline. */
export const GROUP_COLOR: Record<string, string> = {
  lifestyle: '#2dd4bf',
  daily: '#60a5fa',
  car: '#fbbf24',
  fixed: '#a78bfa',
  installments: '#c4b5fd',
  savings: '#34d399',
  fees: '#94a3b8',
  other: '#94a3b8',
  uncategorised: '#f87171',
  income: '#34d399',
  transfers: '#64748b',
};
const colorOf = (g: string) => GROUP_COLOR[g] ?? '#8b93a7';

export function Categories() {
  const { t, lang } = useI18n();
  const [month, setMonth] = useMonth(todayMonth());
  const q = useQuery({ queryKey: ['categories', month], queryFn: () => api.get<CategoriesOverview>(`/api/categories${qs({ month })}`) });
  if (q.isPending) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const groups = [...q.data.groups].sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key));
  return (
    <div className="flex flex-col gap-3">
      <header className="flex items-center justify-between flex-wrap gap-2">
        <MonthNav month={month} onChange={setMonth} />
        <span className="text-xs text-muted">{t('pace')}: {Math.round(q.data.elapsedShare * 100)}%</span>
      </header>
      {groups
        .filter((g) => g.categories.some((c) => c.spent !== 0 || c.monthlyTarget !== null || c.sparkline.some((s) => s.sum !== 0)))
        .map((g) => (
          <Card
            key={g.key}
            title={
              <span className="flex items-center gap-2">
                <span className="inline-block h-2.5 w-2.5 rounded-full shrink-0" style={{ background: colorOf(g.key) }} />
                <span className="text-text">{t(`group_${g.key}` as Key) === `group_${g.key}` ? g.key : t(`group_${g.key}` as Key)}</span>
                <Amount value={g.spent} tone={g.section === 'income' ? 'pos' : 'neutral'} decimals={0} className="text-text" />
                {g.target !== null && <span className="text-muted font-normal">/ {money(g.target, { decimals: 0 })}</span>}
              </span>
            }
            action={g.section === 'variable' ? <GroupTarget groupKey={g.key} current={g.groupTarget} /> : undefined}
          >
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3">
              {g.categories
                .filter((c) => c.spent !== 0 || c.monthlyTarget !== null)
                .map((c) => (
                  <CategoryLine key={c.id} c={c} month={month} elapsed={q.data.elapsedShare} lang={lang} color={colorOf(g.key)} />
                ))}
            </div>
          </Card>
        ))}
    </div>
  );
}

/** One number for a whole group (the research's "one broad discretionary target"); it overrides the sum of category targets. */
function GroupTarget({ groupKey, current }: { groupKey: string; current: number | null }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(current !== null ? String(Math.round(current / 100)) : '');
  const save = useMutation({
    mutationFn: (amount: number | null) => api.patch(`/api/categories/groups/${groupKey}`, { monthlyTarget: amount }),
    onSuccess: () => {
      setEditing(false);
      void qc.invalidateQueries({ queryKey: ['categories'] });
      void qc.invalidateQueries({ queryKey: ['hub'] });
    },
  });
  if (!editing)
    return (
      <button className="btn btn-sm" onClick={() => setEditing(true)} title={t('group_target')}>
        {current !== null ? `${t('target_short')} ${money(current, { decimals: 0 })}` : t('group_target')}
      </button>
    );
  return (
    <form
      className="flex gap-1 items-center"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(v ? Math.round(Number(v) * 100) : null);
      }}
    >
      <input className="input w-24 num" inputMode="numeric" placeholder="₪" value={v} onChange={(e) => setV(e.target.value.replace(/[^\d]/g, ''))} autoFocus />
      <button className="btn btn-sm btn-primary">{t('save')}</button>
      <button type="button" className="btn btn-sm" onClick={() => save.mutate(null)}>
        {t('no_target')}
      </button>
    </form>
  );
}

function CategoryLine({ c, month, elapsed, lang, color }: { c: CategoryView; month: string; elapsed: number; lang: string; color: string }) {
  const { t } = useI18n();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [target, setTarget] = useState(c.monthlyTarget !== null ? String(Math.round(c.monthlyTarget / 100)) : '');
  const save = useMutation({
    mutationFn: (v: number | null) => api.patch(`/api/categories/${c.id}`, { monthlyTarget: v }),
    onSuccess: () => {
      setEditing(false);
      void qc.invalidateQueries({ queryKey: ['categories'] });
      void qc.invalidateQueries({ queryKey: ['hub'] });
    },
  });
  const name = lang === 'he' ? c.nameHe : c.nameEn;
  const spentAbs = Math.abs(c.spent);
  const max = c.monthlyTarget ?? Math.max(spentAbs, ...c.sparkline.map((s) => Math.abs(s.sum)));
  const over = c.monthlyTarget !== null && spentAbs > c.monthlyTarget;
  const ahead = c.monthlyTarget !== null && c.paceTarget !== null && spentAbs > c.paceTarget && !over;
  const sparkMax = Math.max(1, ...c.sparkline.map((s) => Math.abs(s.sum)));
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <button className="flex-1 text-start truncate hover:underline" onClick={() => nav(`/transactions${qs(c.id > 0 ? { month, categoryId: c.id } : { month, bucket: 'uncategorised' })}`)}>
          {name} <span className="text-muted text-xs">({c.count})</span>
        </button>
        <div className="flex items-end gap-px h-5" title={c.sparkline.map((s) => `${s.month}: ${money(s.sum, { decimals: 0 })}`).join('\n')}>
          {c.sparkline.map((s) => (
            <div key={s.month} className={`w-1.5 rounded-sm ${s.month === month ? '' : 'bg-muted/30'}`} style={{ height: `${Math.max(8, Math.round((Math.abs(s.sum) / sparkMax) * 100))}%`, ...(s.month === month ? { background: color } : {}) }} />
          ))}
        </div>
        <span className="num text-sm w-28 text-end">
          <Amount value={c.spent} tone={c.section === 'income' ? 'pos' : over ? 'neg' : 'neutral'} decimals={0} />
          {c.monthlyTarget !== null && <span className="text-muted"> / {money(c.monthlyTarget, { decimals: 0 })}</span>}
        </span>
        {c.id > 0 && c.section !== 'income' && (
          <button className={`text-xs text-muted hover:text-text ${c.monthlyTarget !== null ? '' : 'hidden md:inline'}`} onClick={() => setEditing((e) => !e)} title={t('set_target')}>
            {t('target_short')}
          </button>
        )}
      </div>
      <div className="relative">
        <Bar value={spentAbs} max={max} tone={over ? 'neg' : 'accent'} {...(over ? {} : { color })} />
        {c.monthlyTarget !== null && <div className="absolute top-[-2px] h-[10px] w-px bg-text/60" style={{ insetInlineStart: `${Math.round(elapsed * 100)}%` }} title={t('pace')} />}
      </div>
      {editing && (
        <form
          className="flex gap-2 items-center"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(target ? Math.round(Number(target) * 100) : null);
          }}
        >
          <input className="input w-28 num" inputMode="numeric" placeholder="₪" value={target} onChange={(e) => setTarget(e.target.value.replace(/[^\d]/g, ''))} autoFocus />
          <button className="btn btn-sm btn-primary">{t('save')}</button>
          <button type="button" className="btn btn-sm" onClick={() => save.mutate(null)}>
            {t('no_target')}
          </button>
        </form>
      )}
      {c.topMerchants.length > 0 && (
        <div className="text-xs text-muted truncate hidden md:block">
          {c.topMerchants
            .slice(0, 3)
            .map((m) => `${m.name} ${money(m.sum, { decimals: 0 })}`)
            .join(' · ')}
        </div>
      )}
    </div>
  );
}
