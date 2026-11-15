import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api, qs } from '../api';
import { money, shortDate } from '../format';
import { type Key, useI18n } from '../i18n';
import { compactMoney, explainCheck, extraTotal, incomeTotals, splitParts, typicalExpense, withoutExtraText } from '../nowCard';
import { explainItemIsPaidBack, paidBackLine, paidBackState } from '../paidBack';
import type { ExplainTerm, HubOverview } from '../types';
import { PaidBackLine, PaidBackQuestion } from './PaidBack';
import { Amount, Sheet } from './ui';

const whole = (v: number) => money(v, { decimals: 0 });

/**
 * Under the "left to spend" headline (now-screen-and-limit.md §2): what the number rests on — the regular | extra
 * split, received vs still expected, the month without the extra income, a typical month, and "how is this
 * calculated?". Every part shows only when the hub sends it (older hubs send none of it).
 */
export function NowSplit({ h, headline }: { h: HubOverview; headline: number }) {
  const { t, locale } = useI18n();
  const nav = useNavigate();
  const [explainOpen, setExplainOpen] = useState(false);
  const s = h.incomeSplit;
  const w = h.withoutExtra;
  const typ = h.typical;
  const extra = s ? extraTotal(s) : 0;
  const totals = s ? incomeTotals(s) : null;
  const openTxn = (id: number) => nav(`/transactions${qs({ month: h.month, open: id })}`);
  if (!s && !w && !typ && !h.explain && !paidBackLine(h.paidBack)) return null;
  const parts = w && s && extra !== 0 ? splitParts(w.left, extra) : null;
  const wx = w && extra !== 0 ? withoutExtraText(w) : null;
  return (
    <div className="mt-3 flex flex-col gap-1.5 text-sm">
      {parts && (
        <div>
          <div className="bar flex overflow-hidden gap-px" role="img" aria-label={`${t('split_regular')} ${money(parts.regular.amount, { sign: 'auto', decimals: 0 })} · ${t('split_extra')} ${money(parts.extra.amount, { sign: 'auto', decimals: 0 })}`}>
            <div className={parts.regular.negative ? 'bg-neg' : 'bg-accent'} style={{ width: `${parts.regular.pct}%` }} />
            <div className={parts.extra.negative ? 'bg-neg' : 'bg-pos/70'} style={{ width: `${parts.extra.pct}%` }} />
          </div>
          <div className="flex justify-between gap-3 text-[11px] mt-1">
            <span className="flex flex-col">
              <span className="text-muted">{t('split_regular')}</span>
              <span className={`num ${parts.regular.negative ? 'text-neg' : ''}`}>{money(parts.regular.amount, { sign: 'auto', decimals: 0 })}</span>
            </span>
            <span className="flex flex-col items-end text-end">
              <span className="text-muted">{t('split_extra')}</span>
              <span className={`num ${parts.extra.negative ? 'text-neg' : 'text-pos'}`}>{money(parts.extra.amount, { sign: 'always', decimals: 0 })}</span>
            </span>
          </div>
          {s && s.extra.items.length > 0 && (
            <div className="flex flex-col mt-1">
              {s.extra.items.map((it, i) => {
                const body = (
                  <>
                    <span className="flex-1 truncate" dir="auto">
                      {it.name}
                    </span>
                    {it.status === 'expected' && <span className="chip !py-0 !text-[10px] shrink-0">{t('explain_expected')}</span>}
                    <span className="num shrink-0">{shortDate(it.date)}</span>
                    <Amount value={it.amount} tone="muted" decimals={0} className="shrink-0" />
                  </>
                );
                // an expected item has no transaction yet (id null): shown, not tappable, never asked about
                return it.id !== null ? (
                  <div key={i} className="flex flex-col">
                    <button className="flex items-center gap-2 text-xs text-muted hover:text-text text-start py-0.5" onClick={() => openTxn(it.id!)}>
                      {body}
                    </button>
                    {paidBackState(it) === 'ask' && <PaidBackQuestion id={it.id} name={it.name} canRemember={it.canRemember} compact />}
                  </div>
                ) : (
                  <div key={i} className="flex items-center gap-2 text-xs text-muted py-0.5">
                    {body}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      {totals && <div className="text-muted">{t('income_received_expected', { r: whole(totals.received), e: whole(totals.expected) })}</div>}
      {wx && w && <div className={w.tone === 'positive' ? 'text-pos' : w.tone === 'short' ? 'text-warn' : 'text-text'}>{t(wx.key, { x: money(wx.amount, { sign: wx.signed ? 'auto' : 'never', decimals: 0 }) })}</div>}
      <PaidBackLine pb={h.paidBack} onOpenTxn={openTxn} locale={locale} />
      {typ && typ.months > 0 && <div className="text-xs text-muted">{t('typical_month_line', { n: typ.months, i: compactMoney(typ.income), o: compactMoney(typicalExpense(typ)) })}</div>}
      {h.explain && h.explain.length > 0 && (
        <>
          <button className="text-xs text-accent hover:underline self-start" onClick={() => setExplainOpen(true)}>
            {t('how_calculated')}
          </button>
          <ExplainSheet open={explainOpen} onClose={() => setExplainOpen(false)} terms={h.explain} headline={headline} onOpenTxn={openTxn} locale={locale} />
        </>
      )}
    </div>
  );
}

/**
 * Under the weekly and projection lines: when a large extra income is kept out of them, say so, with a toggle
 * that spreads it for this month (and back).
 */
export function SpreadNote({ h }: { h: HubOverview }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const sp = h.spread;
  const save = useMutation({
    mutationFn: (value: boolean) => api.patch('/api/settings', { spreadExtra: { month: h.month, value } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hub'] }),
  });
  if (!sp || !h.incomeSplit) return null;
  const extra = extraTotal(h.incomeSplit);
  // shown when the extra is kept out, and (to undo it) when the owner spread a large extra in; a hub without
  // `extraIncluded` predates it, read from `reason` as before
  const included = !sp.extraExcluded && (sp.extraIncluded ?? sp.reason === 'large_extra');
  if (!sp.extraExcluded && !included) return null;
  // the weekly line already gives the figure with the extra when regular income leaves no weekly room
  const withAll = sp.extraExcluded && sp.weeklyAll !== null && sp.weeklyRegular !== null;
  return (
    <span className="text-xs text-muted flex flex-wrap items-center gap-x-2">
      <span>
        {t(sp.extraExcluded ? 'spread_excluded' : 'spread_included', { x: whole(extra) })}
        {withAll ? ` · ${t('spread_with_all', { w: whole(sp.weeklyAll!) })}` : ''}
      </span>
      <button className="btn btn-sm !py-0 !px-2 !text-xs" disabled={save.isPending} onClick={() => save.mutate(sp.extraExcluded)}>
        {sp.extraExcluded ? t('spread_include') : t('spread_exclude')}
      </button>
    </span>
  );
}

function ExplainSheet({ open, onClose, terms, headline, onOpenTxn, locale }: { open: boolean; onClose: () => void; terms: ExplainTerm[]; headline: number; onOpenTxn: (id: number) => void; locale: string }) {
  const { t } = useI18n();
  const check = explainCheck(terms, headline);
  const label = (k: string) => (t(`explain_${k}` as Key) === `explain_${k}` ? k : t(`explain_${k}` as Key));
  return (
    <Sheet open={open} onClose={onClose} title={t('explain_title')}>
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-xs text-muted">{t('explain_intro')}</p>
        <div className="flex flex-col divide-y divide-border">
          {terms.map((x) => (
            <ExplainRow key={x.key} term={x} label={label(x.key)} onOpenTxn={onOpenTxn} locale={locale} />
          ))}
        </div>
        <div className="flex items-center justify-between font-semibold border-t border-border pt-2">
          <span>{t('explain_total')}</span>
          <span className={`num ${check.ok ? 'text-pos' : 'text-warn'}`}>
            = {money(check.total, { sign: 'auto', decimals: 0 })} {check.ok ? '✓' : '≠'}
          </span>
        </div>
        {!check.ok && <div className="text-xs text-warn">{t('explain_mismatch', { x: money(headline, { sign: 'auto', decimals: 0 }), d: money(check.diff, { sign: 'always', decimals: 0 }) })}</div>}
      </div>
    </Sheet>
  );
}

function ExplainRow({ term: x, label, onOpenTxn, locale }: { term: ExplainTerm; label: string; onOpenTxn: (id: number) => void; locale: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const expandable = x.items.length > 0 || (x.more ?? 0) > 0;
  return (
    <div className="py-2">
      <button className="w-full flex items-center gap-2 text-start" onClick={() => expandable && setOpen((o) => !o)} aria-expanded={expandable ? open : undefined}>
        <span className="text-muted w-3 shrink-0">{expandable ? (open ? '▾' : locale.startsWith('he') ? '◂' : '▸') : ''}</span>
        <span className="flex-1">{label}</span>
        <Amount value={x.amount} tone={x.amount > 0 ? 'pos' : x.amount < 0 ? 'neutral' : 'muted'} sign="auto" decimals={0} />
      </button>
      {open && (
        <div className="flex flex-col mt-1 ps-5">
          {x.items.length === 0 && <span className="text-xs text-muted">{t('explain_none')}</span>}
          {x.items.map((it, i) => {
            const row = (
              <>
                <span className="flex-1 truncate" dir="auto">
                  {it.name}
                </span>
                {it.status === 'expected' && <span className="chip !py-0 !text-[10px] shrink-0">{t('explain_expected')}</span>}
                {explainItemIsPaidBack(x.key, it.amount) && <span className="chip !py-0 !text-[10px] shrink-0 text-pos">{t('explain_paid_back')}</span>}
                <span className="num shrink-0 text-muted">{it.date ? shortDate(it.date) : ''}</span>
                <Amount value={it.amount} tone={it.status === 'expected' ? 'muted' : it.amount > 0 ? 'pos' : 'neutral'} sign="auto" decimals={0} className="shrink-0" />
              </>
            );
            return it.id !== null ? (
              <button key={`${it.id}-${i}`} className="flex items-center gap-2 text-xs py-1 text-start hover:bg-surface-2 rounded" onClick={() => onOpenTxn(it.id!)}>
                {row}
              </button>
            ) : (
              <div key={`n-${i}`} className="flex items-center gap-2 text-xs py-1">
                {row}
              </div>
            );
          })}
          {(x.more ?? 0) > 0 && <span className="text-xs text-muted py-1">{t('explain_more', { n: x.more! })}</span>}
        </div>
      )}
    </div>
  );
}
