import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api';
import { money } from '../format';
import { useI18n } from '../i18n';
import { limitLines, parseShekels } from '../limitCard';
import type { SpendLimit } from '../types';
import { Card, ErrorBox } from './ui';

const whole = (v: number) => money(v, { decimals: 0 });

/** PATCH the spending limit for `month` (agorot; null = off), then refresh the Now screen and Settings. */
export function useSaveSpendLimit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: { month: string; amount: number | null }) => api.patch('/api/settings', { spendLimit: p }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['hub'] });
      void qc.invalidateQueries({ queryKey: ['settings'] });
    },
  });
}

/**
 * The amount editor (shekels in, agorot out), shared by the Now card and Settings. Saves only a positive amount;
 * anything else shows why and does not send.
 */
export function LimitAmountForm({ month, initial, onDone, onCancel, id }: { month: string; initial: number | null; onDone?: () => void; onCancel?: () => void; id: string }) {
  const { t } = useI18n();
  const save = useSaveSpendLimit();
  const [value, setValue] = useState(initial ? String(Math.round(initial) / 100) : '');
  const [touched, setTouched] = useState(false);
  const parsed = parseShekels(value);
  const invalid = touched && value.trim() !== '' && parsed === null;
  return (
    <form
      className="flex flex-col gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (parsed === null) return;
        save.mutate({ month, amount: parsed }, { onSuccess: () => onDone?.() });
      }}
    >
      <label className="text-xs text-muted" htmlFor={id}>
        {t('spend_limit_amount')}
      </label>
      <div className="flex gap-2 items-center flex-wrap">
        <input id={id} className="input" style={{ width: '8rem' }} dir="ltr" inputMode="decimal" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} onBlur={() => setTouched(true)} />
        <button className="btn btn-sm btn-primary" disabled={save.isPending || parsed === null || parsed === initial}>
          {t('save')}
        </button>
        {onCancel && (
          <button type="button" className="btn btn-sm" onClick={onCancel}>
            {t('cancel')}
          </button>
        )}
      </div>
      {invalid && <span className="text-xs text-neg">{t('spend_limit_invalid')}</span>}
      {save.error && <ErrorBox error={save.error} />}
    </form>
  );
}

/**
 * Now screen, step 2 (now-screen-and-limit.md §3): "left within your limit" — day-to-day spending against the
 * owner's monthly limit, a bar with the even-pace marker, pace, what is left (or over), this week's share, and a
 * note when the category targets add up to more than the limit. The pencil edits the current month's limit.
 */
export function LimitCard({ limit, month, editable }: { limit: SpendLimit; month: string; editable: boolean }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const r = limitLines(limit);
  const warm = r.tone === 'warm';
  const paceText = r.pace.key === 'limit_pace_on' ? t(r.pace.key) : t(r.pace.key, { x: whole(r.pace.x) });
  return (
    <Card
      title={t('limit_title')}
      action={
        editable && !editing ? (
          <button className="btn btn-sm !py-0 !px-2" onClick={() => setEditing(true)} title={t('limit_edit')} aria-label={t('limit_edit')}>
            ✎
          </button>
        ) : undefined
      }
    >
      <div className={`text-3xl font-bold num ${r.over ? 'text-warn' : ''}`}>{r.over ? `−${whole(r.left.x)}` : whole(r.left.x)}</div>
      <div className="text-sm mt-1">{t('limit_headline', { a: whole(r.headline.spent), b: whole(r.headline.amount) })}</div>
      <div className="relative mt-2" role="img" aria-label={`${t('limit_headline', { a: whole(r.headline.spent), b: whole(r.headline.amount) })} · ${t('limit_marker', { x: whole(limit.pace.byToday) })}`}>
        <div className="bar">
          <div className={warm ? 'bg-warn' : 'bg-accent'} style={{ width: `${r.fillPct}%` }} />
        </div>
        <div className="absolute w-0.5 bg-text rounded" style={{ insetInlineStart: `calc(${r.markerPct}% - 1px)`, top: '-3px', height: '12px' }} title={t('limit_marker', { x: whole(limit.pace.byToday) })} />
      </div>
      <div className="text-sm mt-2 flex flex-wrap gap-x-2">
        <span className={warm && limit.pace.state === 'ahead' ? 'text-warn' : 'text-muted'}>{paceText}</span>
        <span className="text-muted">·</span>
        <span className={r.over ? 'text-warn' : 'text-muted'}>{t(r.left.key, { x: whole(r.left.x) })}</span>
        {r.week && (
          <>
            <span className="text-muted">·</span>
            <span className="text-muted">{t('limit_week', { a: whole(r.week.spent), b: whole(r.week.limit) })}</span>
          </>
        )}
      </div>
      {r.targetsOver !== null && <div className="text-xs text-warn mt-1">{t('limit_targets_over', { x: whole(r.targetsOver) })}</div>}
      {editing && (
        <div className="mt-3 pt-3 border-t border-border">
          <LimitAmountForm id="now-limit-amount" month={month} initial={limit.amount} onDone={() => setEditing(false)} onCancel={() => setEditing(false)} />
        </div>
      )}
    </Card>
  );
}

/** Now screen with no limit (current month only): one quiet line to Settings, not a card. */
export function LimitSetLink() {
  const { t } = useI18n();
  const nav = useNavigate();
  return (
    <button className="text-xs text-accent hover:underline self-start" onClick={() => nav('/settings')}>
      {t('limit_set_link')}
    </button>
  );
}
