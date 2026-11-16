import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { api, qs } from '../api';
import { MonthNav } from '../components/MonthNav';
import { PaidBackQuestion, useUndoPaidBack } from '../components/PaidBack';
import { SplitSection } from '../components/SplitSection';
import { CategoryChip, TxnByDate, TxnList, TxnSections, buildSections, sectionLabel, todayLocal } from '../components/TxnList';
import { Amount, Card, Chip, Empty, ErrorBox, Row, Sheet, Spinner } from '../components/ui';
import { dayLabel, money, monthLabel } from '../format';
import { type Key, useI18n } from '../i18n';
import { paidBackState } from '../paidBack';
import { settlementNote } from '../settlement';
import type { CategoriesOverview, EventView, ReviewInbox, TxnDetail, TxnPage } from '../types';

const todayMonth = () => todayLocal().slice(0, 7);
const BUCKETS = ['all', 'income', 'fixed', 'variable', 'installments', 'savings', 'transfers', 'cancelled', 'uncategorised', 'pending'] as const;
type Mode = 'kind' | 'date';

/**
 * Transactions: a month either by kind of money (sections with sums, the committed ones collapsed)
 * or by date (day headers with day totals). A scoped list (search, merchant, stream, plan, category,
 * account, bucket or group from Now) is always by date with its scope as the title and its total.
 */
export function Transactions() {
  const { t, locale } = useI18n();
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') === 'review' ? 'review' : 'all';
  const set = (k: string, v: string | null) => {
    const n = new URLSearchParams(sp);
    if (v === null || v === '' || v === 'all') n.delete(k);
    else n.set(k, v);
    if (k !== 'open') n.delete('open');
    setSp(n, { replace: true });
  };
  const month = sp.get('month') ?? (sp.get('q') || sp.get('merchantId') || sp.get('streamId') || sp.get('planId') ? null : todayMonth());
  const bucket = sp.get('bucket') ?? 'all';
  const q = sp.get('q') ?? '';
  const today = todayLocal();
  const [search, setSearch] = useState(q);
  const [showSearch, setShowSearch] = useState(Boolean(q));
  const [showFilters, setShowFilters] = useState(false);
  const [mode, setModeState] = useState<Mode>(() => {
    try {
      return localStorage.getItem('finc.txnMode') === 'date' ? 'date' : 'kind';
    } catch {
      return 'kind';
    }
  });
  const setMode = (m: Mode) => {
    setModeState(m);
    try {
      localStorage.setItem('finc.txnMode', m);
    } catch {
      /* ignore */
    }
  };
  useEffect(() => {
    const h = setTimeout(() => {
      if (search !== q) {
        const n = new URLSearchParams(sp);
        if (search) {
          n.set('q', search);
          n.delete('month');
        } else n.delete('q');
        setSp(n, { replace: true });
      }
    }, 300);
    return () => clearTimeout(h);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  const scoped = Boolean(sp.get('group') || sp.get('categoryId') || sp.get('merchantId') || sp.get('streamId') || sp.get('planId') || sp.get('accountId') || bucket !== 'all' || q);
  const scopeLabel = bucket !== 'all' ? t(`filter_${bucket}` as Key) : sp.get('group') ? t(`group_${sp.get('group')}` as Key) : sp.get('categoryId') ? t('category') : sp.get('accountId') ? t('account') : q ? `"${q}"` : '⌕';
  const byKind = !scoped && mode === 'kind';
  const params = {
    month: month ?? undefined,
    view: sp.get('view') ?? undefined,
    bucket: bucket === 'all' ? undefined : bucket === 'transfers' ? undefined : bucket,
    includeExcluded: bucket === 'transfers' || byKind ? true : undefined,
    group: sp.get('group') ?? undefined,
    categoryId: sp.get('categoryId') ?? undefined,
    accountId: sp.get('accountId') ?? undefined,
    merchantId: sp.get('merchantId') ?? undefined,
    streamId: sp.get('streamId') ?? undefined,
    planId: sp.get('planId') ?? undefined,
    q: q || undefined,
    limit: 1000,
  };
  const list = useQuery({ queryKey: ['transactions', params], queryFn: () => api.get<TxnPage>(`/api/transactions${qs(params)}`), enabled: tab === 'all' });
  const review = useQuery({ queryKey: ['review'], queryFn: () => api.get<ReviewInbox>('/api/review') });
  const openId = sp.get('open');
  const reviewCount = review.data ? review.data.counts.suggestedLinks + review.data.counts.uncategorised + review.data.counts.candidates + review.data.counts.overdue : 0;
  const clearScope = () => {
    const n = new URLSearchParams(sp);
    for (const k of ['group', 'categoryId', 'merchantId', 'streamId', 'planId', 'accountId', 'bucket', 'q', 'open']) n.delete(k);
    if (!n.get('month')) n.set('month', todayMonth());
    setSearch('');
    setShowSearch(false);
    setSp(n, { replace: true });
  };

  // totals: "out so far" counts completed outflows dated up to today; "in" counts income
  const items = list.data?.items ?? [];
  const isCurrent = month === todayMonth();
  const outSoFar = -items.filter((x) => x.status === 'completed' && !x.excluded && ['fixed', 'variable', 'installments', 'savings'].includes(x.bucket) && x.date <= today).reduce((a, x) => a + x.netAmount, 0);
  const inSoFar = items.filter((x) => x.status === 'completed' && x.bucket === 'income').reduce((a, x) => a + x.netAmount, 0);
  const sectionsForFilter = buildSections(items);

  return (
    <div className="flex flex-col gap-3">
      {tab === 'review' ? (
        <header className="flex items-center gap-3">
          <button className="btn btn-sm" onClick={() => set('tab', null)}>
            ‹ {t('nav_transactions')}
          </button>
          <span className="font-semibold">
            {t('review_inbox')} <span className="num text-muted">{reviewCount}</span>
          </span>
        </header>
      ) : (
        <header className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            {month ? <MonthNav month={month} onChange={(m) => set('month', m)} /> : <span className="font-semibold">{scopeLabel}</span>}
            <button className={`btn btn-sm ${showSearch ? 'btn-primary' : ''}`} onClick={() => { setShowSearch((v) => !v); if (showSearch) setSearch(''); }} title={t('search')} aria-label={t('search')}>
              ⌕
            </button>
          </div>
          {showSearch ? (
            <input className="input w-full" placeholder={t('search')} value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
          ) : (
            <div className="flex items-center justify-between gap-2 text-sm">
              {scoped ? (
                <Chip on onClick={clearScope}>
                  {scopeLabel} ✕
                </Chip>
              ) : (
                <div className="flex gap-4">
                  {(['kind', 'date'] as Mode[]).map((m) => (
                    <button key={m} className={`pb-0.5 border-b-2 ${mode === m ? 'border-accent text-text' : 'border-transparent text-muted'}`} onClick={() => setMode(m)}>
                      {m === 'kind' ? t('by_kind') : t('by_date')}
                    </button>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-2">
                {!byKind && !scoped && (
                  <button className="btn btn-sm" onClick={() => setShowFilters(true)}>
                    {t('filter')}
                  </button>
                )}
                <button className="text-muted hover:text-text" onClick={() => set('tab', 'review')}>
                  {t('review_inbox')} {reviewCount > 0 && <span className="chip chip-on num text-[10px]">{reviewCount}</span>} ›
                </button>
              </div>
            </div>
          )}
          {list.data && !scoped && (
            <div className="text-sm text-muted">
              {isCurrent ? t('out_so_far', { x: money(outSoFar, { decimals: 0 }) }) : t('out_total', { x: money(outSoFar, { decimals: 0 }) })} · {t('in_so_far', { x: money(inSoFar, { decimals: 0 }) })}
            </div>
          )}
        </header>
      )}
      {tab === 'all' ? (
        <>
          <Sheet open={showFilters} onClose={() => setShowFilters(false)} title={t('filter')}>
            <div className="flex flex-col divide-y divide-border">
              {BUCKETS.map((b) => {
                const sec = b === 'all' ? null : sectionsForFilter.filter((x) => (b === 'transfers' ? x.key === 'not_counted' : b === 'variable' ? ['lifestyle', 'daily', 'car', 'bills', 'other', 'uncategorised'].includes(x.key) : x.key === b));
                const count = sec ? sec.reduce((a, x) => a + x.count, 0) : items.length;
                const sum = sec ? sec.reduce((a, x) => a + x.sum, 0) : null;
                return (
                  <button key={b} className={`py-3 text-start flex items-center justify-between gap-2 ${bucket === b ? 'text-accent' : ''}`} onClick={() => { set('bucket', b); setShowFilters(false); }}>
                    <span>{t(`filter_${b}` as Key)}</span>
                    <span className="num text-xs text-muted">
                      {count}
                      {sum !== null && sum !== 0 ? ` · ${money(sum, { decimals: 0 })}` : ''}
                    </span>
                  </button>
                );
              })}
            </div>
          </Sheet>
          {list.isPending ? (
            <Spinner />
          ) : list.error ? (
            <ErrorBox error={list.error} onRetry={() => list.refetch()} />
          ) : list.data.items.length === 0 ? (
            <Empty>{q ? t('search_empty', { q }) : month ? t('no_txns_month', { m: monthLabel(month, locale) }) : t('no_data')}</Empty>
          ) : byKind ? (
            <TxnSections items={list.data.items} today={today} onOpen={(x) => set('open', String(x.id))} />
          ) : (
            <Card {...(scoped ? { title: `${scopeLabel} · ${t('rows', { n: list.data.total })}`, action: <Amount value={list.data.netSum} sign="auto" className="text-base font-semibold" /> } : {})}>
              <TxnByDate items={list.data.items} today={today} locale={locale} onOpen={(x) => set('open', String(x.id))} />
              {list.data.total > list.data.items.length && <Empty>{t('rows', { n: list.data.items.length })} / {list.data.total}</Empty>}
            </Card>
          )}
        </>
      ) : (
        <ReviewPane data={review.data} onOpen={(id) => set('open', String(id))} />
      )}
      <TxnSheet id={openId ? Number(openId) : null} onClose={() => set('open', null)} />
    </div>
  );
}

function ReviewPane({ data, onOpen }: { data: ReviewInbox | undefined; onOpen: (id: number) => void }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['review'] });
    void qc.invalidateQueries({ queryKey: ['transactions'] });
    void qc.invalidateQueries({ queryKey: ['hub'] });
    void qc.invalidateQueries({ queryKey: ['recurring'] });
  };
  const decide = useMutation({ mutationFn: (p: { id: number; verdict: 'confirm' | 'reject' }) => api.post(`/api/links/${p.id}/decide`, { verdict: p.verdict }), onSuccess: invalidate });
  const stream = useMutation({ mutationFn: (p: { id: number; state: string }) => api.post(`/api/recurring/${p.id}/state`, { state: p.state }), onSuccess: invalidate });
  const exclude = useMutation({ mutationFn: (id: number) => api.patch(`/api/transactions/${id}`, { excluded: true }), onSuccess: invalidate });
  const cats = useQuery({ queryKey: ['categories-flat'], queryFn: () => api.get<CategoriesOverview>('/api/categories'), staleTime: 300_000 });
  const setMerchantCat = useMutation({ mutationFn: (p: { merchantId: number; category: number }) => api.post(`/api/merchants/${p.merchantId}/category`, { category: p.category }), onSuccess: invalidate });
  if (!data) return <Spinner />;
  const total = Object.values(data.counts).reduce((a, b) => a + b, 0);
  if (!total) return <Empty>{t('review_empty')}</Empty>;
  const catOptions = cats.data?.groups.flatMap((g) => g.categories.filter((c) => c.id > 0)) ?? [];
  return (
    <div className="flex flex-col gap-3">
      {data.suggestedLinks.length > 0 && (
        <Card title={`${t('review_links')} (${data.suggestedLinks.length})`}>
          <div className="flex flex-col divide-y divide-border">
            {data.suggestedLinks.map((l) => (
              <div key={l.linkId} className="py-2 flex flex-col gap-1">
                <div className="flex items-center gap-2 flex-wrap text-sm">
                  <button className="underline-offset-2 hover:underline" onClick={() => onOpen(l.from.id)}>
                    {dayLabel(l.from.date, locale)} <Amount value={l.from.amount} tone="pos" /> {l.from.name}
                  </button>
                  <span className="text-muted">↔</span>
                  <button className="underline-offset-2 hover:underline" onClick={() => onOpen(l.to.id)}>
                    {dayLabel(l.to.date, locale)} <Amount value={l.to.amount} /> {l.to.name}
                  </button>
                  <span className="chip num">{Math.round(l.confidence * 100)}%</span>
                </div>
                <div className="text-xs text-muted">{l.explanation.map((e) => `${e.signal} ${e.score.toFixed(2)} ${e.note}`).join(' · ')}</div>
                <div className="flex gap-2">
                  <button className="btn btn-sm btn-primary" onClick={() => decide.mutate({ id: l.linkId, verdict: 'confirm' })}>
                    {t('link_confirm')}
                  </button>
                  <button className="btn btn-sm" onClick={() => decide.mutate({ id: l.linkId, verdict: 'reject' })}>
                    {t('link_reject')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
      {data.uncategorised.length > 0 && (
        <Card title={`${t('review_uncategorised')} (${data.uncategorised.length})`}>
          <div className="flex flex-col divide-y divide-border">
            {data.uncategorised.map((u) => (
              <div key={`${u.merchantId}-${u.name}`} className="py-2 flex items-center gap-2 flex-wrap">
                <button className="flex-1 min-w-[10rem] text-start hover:underline" onClick={() => onOpen(u.sampleTxnId)}>
                  {u.name} <span className="text-muted text-xs">· {t('rows', { n: u.rows })} · {money(u.spend)}</span>
                  {u.ai?.reason && <div className="text-xs text-muted">{t('cat_source_ai')}: {u.ai.reason}</div>}
                </button>
                {u.merchantId !== null && (
                  <select className="input w-auto text-sm" defaultValue="" onChange={(e) => e.target.value && setMerchantCat.mutate({ merchantId: u.merchantId!, category: Number(e.target.value) })}>
                    <option value="">{t('category')}…</option>
                    {catOptions.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.icon ?? ''} {locale.startsWith('he') ? c.nameHe : c.nameEn}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}
      {data.lowConfidence.length > 0 && (
        <Card title={`${t('review_low_confidence')} (${data.lowConfidence.length})`}>
          <div className="flex flex-col divide-y divide-border">
            {data.lowConfidence.map((u) => (
              <div key={u.merchantId} className="py-2 flex items-center gap-2 flex-wrap">
                <button className="flex-1 min-w-[10rem] text-start hover:underline" onClick={() => onOpen(u.sampleTxnId)}>
                  {u.name} <CategoryChip categoryKey={u.categoryKey} source="ai" /> <span className="chip num">{Math.round(u.confidence * 100)}%</span>
                  {u.reason && <div className="text-xs text-muted">{u.reason}</div>}
                </button>
                <select className="input w-auto text-sm" defaultValue="" onChange={(e) => e.target.value && setMerchantCat.mutate({ merchantId: u.merchantId, category: Number(e.target.value) })}>
                  <option value="">{t('category')}…</option>
                  {catOptions.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.icon ?? ''} {locale.startsWith('he') ? c.nameHe : c.nameEn}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </Card>
      )}
      {data.candidates.length > 0 && (
        <Card title={`${t('review_candidates')} (${data.candidates.length})`}>
          {data.candidates.map((c) => (
            <Row key={c.streamId}>
              <span className="flex-1">
                {c.name} <span className="text-muted text-xs">· {t(`freq_${c.frequency}` as Key)} · ×{c.occurrences}</span>
              </span>
              <Amount value={c.expectedAmount} />
              <button className="btn btn-sm btn-primary" onClick={() => stream.mutate({ id: c.streamId, state: 'confirmed' })}>
                {t('confirm_stream')}
              </button>
              <button className="btn btn-sm" onClick={() => stream.mutate({ id: c.streamId, state: 'rejected' })}>
                {t('reject_stream')}
              </button>
            </Row>
          ))}
        </Card>
      )}
      {data.overdue.length > 0 && (
        <Card title={`${t('review_overdue')} (${data.overdue.length})`}>
          {data.overdue.map((o) => (
            <Row key={o.streamId}>
              <span className="flex-1">
                {o.name} <span className="text-muted text-xs">· {dayLabel(o.expectedDate, locale)}</span>
              </span>
              <Amount value={o.amount} />
              <button className="btn btn-sm" onClick={() => stream.mutate({ id: o.streamId, state: 'ended' })}>
                {t('end_stream')}
              </button>
            </Row>
          ))}
        </Card>
      )}
      {data.exclusions.length > 0 && (
        <Card title={`${t('review_exclusions')} (${data.exclusions.length})`}>
          {data.exclusions.map((x) => (
            <Row key={x.txnId} onClick={() => onOpen(x.txnId)}>
              <span className="flex-1">
                {x.name} <span className="text-muted text-xs">· {dayLabel(x.date, locale)} {x.comment ? `· ${x.comment}` : ''}</span>
              </span>
              <Amount value={x.amount} />
              <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); exclude.mutate(x.txnId); }}>
                {t('exclude')}
              </button>
            </Row>
          ))}
        </Card>
      )}
    </div>
  );
}

export function TxnSheet({ id, onClose }: { id: number | null; onClose: () => void }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['txn', id], queryFn: () => api.get<TxnDetail>(`/api/transactions/${id}`), enabled: id !== null });
  const cats = useQuery({ queryKey: ['categories-flat'], queryFn: () => api.get<CategoriesOverview>('/api/categories'), staleTime: 300_000 });
  const [cat, setCat] = useState<number | ''>('');
  const [applyAll, setApplyAll] = useState(true);
  const [rule, setRule] = useState(false);
  const [note, setNote] = useState('');
  useEffect(() => {
    if (q.data) {
      setCat(q.data.categoryId ?? '');
      setNote(q.data.note ?? '');
      setRule(false);
    }
  }, [q.data]);
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['txn', id] });
    void qc.invalidateQueries({ queryKey: ['transactions'] });
    void qc.invalidateQueries({ queryKey: ['hub'] });
    void qc.invalidateQueries({ queryKey: ['review'] });
    void qc.invalidateQueries({ queryKey: ['categories'] });
  };
  const patch = useMutation({ mutationFn: (body: Record<string, unknown>) => api.patch(`/api/transactions/${id}`, body), onSuccess: invalidate });
  const decide = useMutation({ mutationFn: (p: { linkId: number; verdict: 'confirm' | 'reject' }) => api.post(`/api/links/${p.linkId}/decide`, { verdict: p.verdict }), onSuccess: invalidate });
  const undoPaidBack = useUndoPaidBack();
  const x = q.data;
  const pbState = x ? paidBackState(x) : 'none';
  const settle = x ? settlementNote(x, t) : null;
  const catOptions = cats.data?.groups.flatMap((g) => g.categories.filter((c) => c.id > 0)) ?? [];
  const dirty = x ? cat !== (x.categoryId ?? '') || note !== (x.note ?? '') : false;
  return (
    <Sheet open={id !== null} onClose={onClose} title={x?.name ?? ''}>
      {!x ? (
        <Spinner />
      ) : (
        <div className="flex flex-col gap-4 text-sm">
          <div className="flex items-baseline justify-between">
            <Amount value={x.amount} tone={x.amount > 0 ? 'pos' : 'neutral'} className="text-2xl font-bold" currency={x.originalCurrency !== 'ILS' ? undefined : undefined} />
            <span className="text-muted">
              {dayLabel(x.date, locale, { year: true })}
              {x.chargeDate && x.chargeDate !== x.date ? ` · ${t('view_billing')} ${dayLabel(x.chargeDate, locale)}` : ''}
            </span>
          </div>
          {x.originalCurrency !== 'ILS' && x.originalAmount !== null && (
            <div className="text-muted">
              {x.originalCurrency} {(Math.abs(x.originalAmount) / 100).toFixed(2)}
            </div>
          )}
          <div className="flex flex-wrap gap-1">
            <Chip>{x.accountName ?? x.institutionId}</Chip>
            <Chip>{t(`filter_${x.bucket === 'settlements' || x.bucket === 'transfers' || x.bucket === 'refunds' || x.bucket === 'excluded' ? 'transfers' : x.bucket}` as Key)}</Chip>
            {x.status !== 'completed' && <Chip tone="pending">{x.status === 'pending' ? t('pending') : t('voided')}</Chip>}
            {x.installment && <Chip>{t('installment_n', { n: x.installment.n, total: x.installment.total })}</Chip>}
            {x.excluded && <Chip tone="pending">{t('exclude')}</Chip>}
            {pbState === 'paid_back' && <Chip tone="pos">{t('paid_back_badge')}</Chip>}
          </div>
          {pbState === 'ask' && <PaidBackQuestion id={x.id} name={x.name} canRemember={x.canRemember} />}
          {pbState === 'paid_back' && (
            <div className="flex flex-col gap-1">
              <button className="btn btn-sm self-start" disabled={undoPaidBack.pending} onClick={() => undoPaidBack.undo({ id: x.id, name: x.name, amount: x.amount, byRule: x.paidBackByRule })}>
                {t('paid_back_count_income')}
              </button>
              {undoPaidBack.error && <ErrorBox error={undoPaidBack.error} />}
            </div>
          )}
          {settle && (
            <div className="text-muted" dir="auto">
              {settle.text}
            </div>
          )}
          <div className="text-xs text-muted">
            {t('raw_description')}: <span dir="auto">{x.descriptionRaw}</span>
            {x.memo ? ` · ${x.memo}` : ''}
            {x.merchantAliases.length > 1 ? ` · ${x.merchantAliases.slice(0, 4).join(' / ')}` : ''}
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-muted">
              {t('category')}
              {x.categorySource && (
                <>
                  {' '}
                  · {t(`cat_source_${x.categorySource}` as Key)}
                  {x.categoryConfidence !== null && x.categorySource !== 'user' ? ` ${Math.round(x.categoryConfidence * 100)}%` : ''}
                </>
              )}
            </span>
            <select className="input" value={cat} onChange={(e) => setCat(e.target.value ? Number(e.target.value) : '')}>
              <option value="">{t('uncategorised')}</option>
              {catOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.icon ?? ''} {locale.startsWith('he') ? c.nameHe : c.nameEn}
                </option>
              ))}
            </select>
            {x.aiSuggestion?.reason && cat === '' && <span className="text-xs text-muted">{t('cat_source_ai')}: {x.aiSuggestion.reason}</span>}
          </label>
          {x.merchantId !== null && cat !== '' && cat !== x.categoryId && (
            <div className="flex flex-col gap-1 text-xs">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={applyAll} onChange={(e) => setApplyAll(e.target.checked)} /> {t('apply_to_merchant', { name: x.name })}
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={rule} onChange={(e) => setRule(e.target.checked)} /> {t('create_rule')}
              </label>
            </div>
          )}
          <SplitSection key={x.id} x={x} categories={catOptions} onChanged={invalidate} />
          {x.amount > 0 && x.bucket === 'income' && x.incomeKind !== undefined && (
            <div className="flex flex-col gap-1">
              <span className="text-muted">{t('income_kind_label')}</span>
              <div className="flex gap-1 flex-wrap">
                {([null, 'regular', 'extra'] as const).map((k) => (
                  <Chip key={k ?? 'follow'} on={(x.incomeKind ?? null) === k} onClick={() => (x.incomeKind ?? null) !== k && !patch.isPending && patch.mutate({ incomeKind: k })}>
                    {t(k === null ? 'income_kind_follow' : k === 'regular' ? 'income_kind_regular' : 'income_kind_extra')}
                  </Chip>
                ))}
              </div>
            </div>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-muted">{t('note')}</span>
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <EventTags x={x} onChange={invalidate} />
          <div className="flex gap-2 flex-wrap">
            <button
              className="btn btn-primary"
              disabled={!dirty || patch.isPending}
              onClick={() => patch.mutate({ ...(cat !== (x.categoryId ?? '') && cat !== '' ? { category: cat, applyToMerchant: applyAll, createRule: rule } : {}), ...(note !== (x.note ?? '') ? { note: note || null } : {}) })}
            >
              {t('save')}
            </button>
            <button className="btn" onClick={() => patch.mutate({ excluded: !x.excluded })}>
              {x.excluded ? t('include') : t('exclude')}
            </button>
            {x.amount < 0 && (
              <button className="btn" onClick={() => patch.mutate({ transfer: x.kind !== 'transfer' })}>
                {x.kind === 'transfer' ? t('unmark_transfer') : t('mark_transfer')}
              </button>
            )}
          </div>

          {x.links.length > 0 && (
            <div>
              <div className="text-muted mb-1">{t('links')}</div>
              <div className="flex flex-col gap-2">
                {x.links.map((l) => (
                  <div key={l.id} className="card p-2 flex flex-col gap-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Chip>{l.type}</Chip>
                      <span>
                        {dayLabel(l.otherDate, locale)} <Amount value={l.otherAmount} tone={l.otherAmount > 0 ? 'pos' : 'neutral'} /> <span dir="auto">{l.otherDescription}</span>
                      </span>
                      <span className="chip num">{Math.round(l.confidence * 100)}%</span>
                      {l.decision && <Chip tone={l.decision === 'confirmed' ? 'pos' : 'pending'}>{l.decision}</Chip>}
                    </div>
                    <div className="text-xs text-muted">{l.explanation.map((e) => `${e.signal} ${e.score.toFixed(2)} ${e.note}`).join(' · ')}</div>
                    {l.zone === 'suggest' && !l.decision && (
                      <div className="flex gap-2">
                        <button className="btn btn-sm btn-primary" onClick={() => decide.mutate({ linkId: l.id, verdict: 'confirm' })}>
                          {t('link_confirm')}
                        </button>
                        <button className="btn btn-sm" onClick={() => decide.mutate({ linkId: l.id, verdict: 'reject' })}>
                          {t('link_reject')}
                        </button>
                      </div>
                    )}
                    {l.zone === 'auto' && !l.decision && (
                      <button className="btn btn-sm self-start" onClick={() => decide.mutate({ linkId: l.id, verdict: 'reject' })}>
                        {t('link_reject')}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="text-[11px] text-muted">
            #{x.id} · {t('source')}: {x.source}
            {x.identifier ? ` · ${x.identifier}` : ''}
          </div>
        </div>
      )}
    </Sheet>
  );
}

/** The events a transaction belongs to, with remove, and a select to tag it into another (design §7). */
function EventTags({ x, onChange }: { x: TxnDetail; onChange: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const events = useQuery({ queryKey: ['events', false], queryFn: () => api.get<EventView[]>('/api/events'), staleTime: 60_000 });
  const change = useMutation({
    mutationFn: (p: { eventId: number; add?: number[]; remove?: number[] }) => api.post(`/api/events/${p.eventId}/txns`, { add: p.add, remove: p.remove }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['events'] });
      void qc.invalidateQueries({ queryKey: ['event'] });
      onChange();
    },
  });
  const mine = new Set(x.events.map((e) => e.id));
  const options = (events.data ?? []).filter((e) => !mine.has(e.id));
  if (!x.events.length && !options.length) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted">{t('txn_events')}</span>
      <div className="flex gap-2 flex-wrap items-center">
        {x.events.map((e) => (
          <span key={e.id} className="chip chip-on flex items-center gap-1">
            {e.name}
            <button type="button" className="opacity-70 hover:opacity-100" title={t('event_remove_txn')} onClick={() => change.mutate({ eventId: e.id, remove: [x.id] })}>
              ×
            </button>
          </span>
        ))}
        {options.length > 0 && (
          <select className="input w-auto" value="" onChange={(e) => e.target.value && change.mutate({ eventId: Number(e.target.value), add: [x.id] })}>
            <option value="">{t('txn_add_to_event')}</option>
            {options.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}
