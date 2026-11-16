import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import { money } from '../format';
import { useI18n } from '../i18n';
import { SPLIT_MAX_PARTS, SPLIT_MIN_PARTS, type SplitRow, addRow, planSplit, removeRow, splitChoices, startRows } from '../split';
import type { CategoryView, TxnDetail } from '../types';
import { Amount, ErrorBox, Row } from './ui';

/**
 * The transaction sheet's split (research_notes/proposals/split-transaction.md): spending only. Not split: a
 * "Split" button. Split: the parts, with "Edit split" and "Remove split". The editor's last row takes the
 * remainder, so the parts always add up to the charge.
 */
export function SplitSection({ x, categories, onChanged }: { x: TxnDetail; categories: CategoryView[]; onChanged: () => void }) {
  const { t, locale } = useI18n();
  const [rows, setRows] = useState<SplitRow[] | null>(null);
  const save = useMutation({
    mutationFn: (parts: Array<{ category: number; amount: number }>) => api.put<{ ok: true; transaction: TxnDetail }>(`/api/transactions/${x.id}/split`, { parts }),
    onSuccess: () => {
      setRows(null);
      onChanged();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.del<{ ok: true; transaction: TxnDetail }>(`/api/transactions/${x.id}/split`),
    onSuccess: () => {
      setRows(null);
      onChanged();
    },
  });
  // ordinary purchases only, the same rule as the hub (core hub/splits.ts): not a transfer, card bill, refund or saving
  if (x.amount >= 0 || x.excluded || (x.kind !== null && x.kind !== 'expense')) return null;
  const he = locale.startsWith('he');
  const choices = splitChoices(categories);
  const open = () => {
    save.reset();
    remove.reset();
    setRows(startRows(x.amount, x.categoryId, x.split));
  };

  if (rows === null) {
    if (!x.split) {
      return (
        <div className="flex flex-col gap-1">
          <button className="btn btn-sm self-start" onClick={open}>
            {t('split_action')}
          </button>
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-1">
        <span className="text-muted">{t('split_parts', { n: x.split.length })}</span>
        <div className="flex flex-col">
          {x.split.map((p, i) => (
            <Row key={`${p.categoryId}-${i}`}>
              <span className="flex-1 min-w-0 truncate" dir="auto">
                {he ? p.nameHe : p.nameEn}
              </span>
              <Amount value={p.amount} tone="neutral" />
            </Row>
          ))}
        </div>
        <div className="flex gap-2 flex-wrap">
          <button className="btn btn-sm" onClick={open}>
            {t('split_edit')}
          </button>
          <button className="btn btn-sm" disabled={remove.isPending} onClick={() => remove.mutate()}>
            {t('split_remove')}
          </button>
        </div>
        {remove.error && <ErrorBox error={remove.error} />}
      </div>
    );
  }

  const plan = planSplit(x.amount, rows);
  const setRow = (i: number, r: Partial<SplitRow>) => setRows(rows.map((old, j) => (j === i ? { ...old, ...r } : old)));
  const missingCategory = rows.some((r) => r.category === '');
  const badAmount = plan.amounts.slice(0, -1).some((v) => v === null || v <= 0);
  const last = rows.length - 1;
  return (
    <div className="card p-3 flex flex-col gap-2">
      <div className="font-semibold">{t('split_title')}</div>
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          <select className="input flex-1 min-w-0" aria-label={t('split_pick_category')} value={r.category} onChange={(e) => setRow(i, { category: e.target.value ? Number(e.target.value) : '' })}>
            <option value="">{t('split_pick_category')}</option>
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.icon ?? ''} {he ? c.nameHe : c.nameEn}
              </option>
            ))}
          </select>
          {i < last ? (
            <input className="input num" style={{ width: '7rem' }} dir="ltr" inputMode="decimal" autoComplete="off" aria-label={t('split_amount')} value={r.shekels} onChange={(e) => setRow(i, { shekels: e.target.value })} />
          ) : (
            <span className="num text-muted text-end" style={{ width: '7rem' }} title={t('split_rest')}>
              {money(plan.remainder > 0 ? plan.remainder : 0)}
            </span>
          )}
          <button type="button" className="btn btn-sm" title={t('split_remove_row')} aria-label={t('split_remove_row')} disabled={rows.length <= SPLIT_MIN_PARTS} onClick={() => setRows(removeRow(rows, i))}>
            ×
          </button>
        </div>
      ))}
      <div className="text-xs text-muted">
        {plan.remainder < 0 ? <span className="text-neg">{t('split_over', { amount: money(-plan.remainder) })}</span> : t('split_remainder', { amount: money(plan.remainder) })}
        {missingCategory ? ` · ${t('split_need_category')}` : ''}
        {badAmount || plan.remainder === 0 ? ` · ${t('split_need_amount')}` : ''}
      </div>
      <div className="text-xs text-muted">{t('split_main_note')}</div>
      <div className="flex gap-2 flex-wrap">
        <button className="btn btn-primary" disabled={!plan.valid || save.isPending} onClick={() => save.mutate(plan.parts)}>
          {t('split_save')}
        </button>
        <button className="btn" disabled={rows.length >= SPLIT_MAX_PARTS} onClick={() => setRows(addRow(x.amount, rows))}>
          {t('split_add_row')}
        </button>
        <button className="btn" onClick={() => setRows(null)}>
          {t('split_cancel')}
        </button>
      </div>
      {save.error && <ErrorBox error={save.error} />}
    </div>
  );
}
