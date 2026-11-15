import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import { money, shortDate } from '../format';
import { useI18n } from '../i18n';
import { isGenericPayerError, paidBackButtons, paidBackLine, undoConfirmKey } from '../paidBack';
import type { PaidBack, PaidBackAnswer } from '../types';
import { Amount, ErrorBox } from './ui';

const whole = (v: number) => money(v, { decimals: 0 });

/**
 * POST the owner's answer about a payment (now-screen-and-limit.md §1, step 3), then refresh everything that shows
 * it: the Now screen, the transaction lists, every open transaction (an "Always" changes the payer's other rows),
 * the trends and the review inbox.
 */
export function usePaidBackAnswer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: { id: number; answer: PaidBackAnswer }) => api.post<{ changed: number }>(`/api/transactions/${p.id}/paid-back`, { answer: p.answer }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['hub'] });
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      void qc.invalidateQueries({ queryKey: ['txn'] });
      void qc.invalidateQueries({ queryKey: ['trends'] });
      void qc.invalidateQueries({ queryKey: ['review'] });
    },
  });
}

/** A failed answer: the hub's "several payers share this text" refusal in plain words, anything else as usual. */
function AnswerError({ error }: { error: unknown }) {
  const { t } = useI18n();
  if (isGenericPayerError(error)) return <div className="w-full text-xs text-warn">{t('paid_back_generic_payer')}</div>;
  return (
    <div className="w-full">
      <ErrorBox error={error} />
    </div>
  );
}

/**
 * "Is X paying you back?" with Always / Just this one / No, it's income; when the payer cannot be remembered
 * (`canRemember` false) only Just this one / No, and No covers this payment only.
 */
export function PaidBackQuestion({ id, name, canRemember, compact = false }: { id: number; name: string; canRemember?: boolean | undefined; compact?: boolean }) {
  const { t } = useI18n();
  const answer = usePaidBackAnswer();
  return (
    <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 ${compact ? 'text-[11px] ps-1 pb-1' : 'text-sm'}`}>
      <span className="text-muted" dir="auto">
        {t('paid_back_ask', { name })}
      </span>
      <span className="flex gap-1 flex-wrap">
        {paidBackButtons(canRemember).map((a) => (
          <button key={a.answer} className={`btn btn-sm ${compact ? '!py-0 !px-2 !text-[11px]' : ''}`} disabled={answer.isPending} onClick={() => answer.mutate({ id, answer: a.answer })}>
            {t(a.key)}
          </button>
        ))}
      </span>
      {answer.error && <AnswerError error={answer.error} />}
    </div>
  );
}

/**
 * Asks before "count as income again"; when the payer is (or may be) remembered as always paying back, the text
 * says that stops too.
 */
export function useUndoPaidBack() {
  const { t } = useI18n();
  const answer = usePaidBackAnswer();
  const undo = (x: { id: number; name: string; amount: number; byRule?: boolean | undefined }) => {
    if (window.confirm(t(undoConfirmKey(x.byRule), { name: x.name, x: whole(Math.abs(x.amount)) }))) answer.mutate({ id: x.id, answer: 'undo' });
  };
  return { undo, pending: answer.isPending, error: answer.error };
}

/** The Now-card line "Paid back to you: ₪X — counted against day-to-day spending", opening to its payments. */
export function PaidBackLine({ pb, onOpenTxn, locale }: { pb: PaidBack | undefined; onOpenTxn: (id: number) => void; locale: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const { undo, pending, error } = useUndoPaidBack();
  const line = paidBackLine(pb);
  if (!line || !pb) return null;
  return (
    <div>
      <button className="flex items-center gap-1 text-start text-muted hover:text-text" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="w-3 shrink-0 text-xs">{open ? '▾' : locale.startsWith('he') ? '◂' : '▸'}</span>
        <span>{t('paid_back_line', { x: whole(line.total) })}</span>
      </button>
      {open && (
        <div className="flex flex-col mt-1 ps-4">
          {pb.items.map((it) => (
            <div key={it.id} className="flex items-center gap-2 text-xs text-muted py-0.5">
              <button className="flex-1 flex items-center gap-2 min-w-0 text-start hover:text-text" onClick={() => onOpenTxn(it.id)}>
                <span className="flex-1 truncate" dir="auto">
                  {it.name}
                </span>
                {it.byRule && <span className="chip !py-0 !text-[10px] shrink-0">{t('paid_back_rule')}</span>}
                <span className="num shrink-0">{shortDate(it.date)}</span>
                <Amount value={it.amount} tone="muted" decimals={0} className="shrink-0" />
              </button>
              <button className="text-accent hover:underline shrink-0" disabled={pending} onClick={() => undo(it)}>
                {t('paid_back_undo')}
              </button>
            </div>
          ))}
          {error && <AnswerError error={error} />}
        </div>
      )}
    </div>
  );
}
