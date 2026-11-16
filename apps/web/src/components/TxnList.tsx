import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { shortDate } from '../format';
import { type Key, useI18n } from '../i18n';
import { paidBackState } from '../paidBack';
import { settlementNote } from '../settlement';
import type { Txn } from '../types';
import { Amount, Chip } from './ui';

export function CategoryChip({ categoryKey, source }: { categoryKey: string | null; source: string | null }) {
  const { t } = useI18n();
  if (!categoryKey) return <Chip tone="warn">{t('uncategorised')}</Chip>;
  const label = categoryKey.split('.').pop()!.replace(/_/g, ' ');
  return (
    <Chip>
      {label}
      {source === 'ai' && <span className="opacity-60">·{t('cat_source_ai')}</span>}
    </Chip>
  );
}

export const todayLocal = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

function useOpen(onOpen?: (t: Txn) => void) {
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const openId = (id: number) => {
    const n = new URLSearchParams(sp);
    n.set('open', String(id));
    nav(`/transactions?${n.toString()}`);
  };
  return {
    open: (x: Txn) => (onOpen ? onOpen(x) : openId(x.id)),
    /** opens another row's detail (the card row a payment paid, or the payment); not where a page handles opening itself */
    openId: onOpen ? null : openId,
  };
}

/**
 * One calm line per transaction: day, name, amount. Everything else lives in the detail sheet. The
 * only marks on the line change what the amount means: pending, cancelled, refunded, installment
 * n/total, "charged on" for rows dated after today (card installments post their future slices), and split.
 */
export function TxnList({ items, onOpen, showDate = true, today }: { items: Txn[]; onOpen?: (t: Txn) => void; showDate?: boolean; today?: string }) {
  const { t } = useI18n();
  const { open, openId } = useOpen(onOpen);
  if (!items.length) return <div className="text-muted text-sm p-3 text-center">{t('no_data')}</div>;
  return (
    <div className="flex flex-col divide-y divide-border">
      {items.map((x) => {
        const cancelled = x.status === 'voided' || (x.refunds.length > 0 && Math.abs(x.netAmount) < 1);
        const pending = x.status === 'pending';
        const future = today !== undefined && x.date > today;
        const refunded = x.refunds.length > 0 && !cancelled;
        const note = pending
          ? t('pending')
          : x.status === 'voided'
            ? t('voided')
            : x.refundOf
              ? t('refund')
              : refunded
                ? t('refunded', { amount: `₪${(x.refunds.reduce((a, r) => a + r.amount, 0) / 100).toFixed(0)}` })
                : future
                  ? `${t('charge_on', { d: shortDate(x.chargeDate ?? x.date) })}${x.installment ? ` · ${t('installment_n', { n: x.installment.n, total: x.installment.total })}` : ''}`
                  : x.installment
                    ? t('installment_n', { n: x.installment.n, total: x.installment.total })
                    : null;
        const settle = settlementNote(x, t);
        // step 3: an incoming payment counted as paid back to the owner (not income)
        // a split charge says so next to its other marks (its parts live in the detail sheet)
        const line = [note, paidBackState(x) === 'paid_back' ? t('paid_back_marker') : null, x.split ? t('split_marker') : null].filter(Boolean).join(' · ');
        return (
          <div key={x.id} className={`flex items-center gap-3 py-2.5 px-1 row-link rounded-md ${pending || future ? 'opacity-60' : ''}`} onClick={() => open(x)}>
            {showDate && <span className="num text-xs text-muted w-10 shrink-0">{shortDate(x.date)}</span>}
            <div className="flex-1 min-w-0">
              <div className={`truncate ${cancelled ? 'struck' : ''}`} title={x.descriptionRaw} dir="auto">
                {!x.categoryKey && x.amount < 0 && !x.excluded && (
                  <span className="text-warn me-1" title={t('uncategorised')}>
                    •
                  </span>
                )}
                {x.name}
              </div>
              {line && <div className="text-[11px] text-muted truncate">{line}</div>}
              {settle && (
                <div
                  className={`text-[11px] text-muted truncate ${settle.targetId !== null && openId ? 'underline decoration-dotted' : ''}`}
                  dir="auto"
                  onClick={
                    settle.targetId !== null && openId
                      ? (e) => {
                          e.stopPropagation();
                          openId(settle.targetId!);
                        }
                      : undefined
                  }
                >
                  {settle.text}
                </div>
              )}
            </div>
            <div className="text-end shrink-0">
              <Amount value={x.netAmount !== x.amount ? x.netAmount : x.amount} tone={x.amount > 0 ? 'pos' : cancelled ? 'muted' : 'neutral'} sign={x.amount > 0 ? 'always' : 'never'} className={`text-base ${cancelled ? 'struck' : ''}`} />
              {x.netAmount !== x.amount && !cancelled && (
                <div className="num text-[11px] text-muted struck">
                  <Amount value={x.amount} tone="muted" />
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Sections by kind of money. Membership follows the bucket first, so every section sum equals the
// matching line on the Now screen; variable rows are then split by category group.

export type SectionKey = 'lifestyle' | 'daily' | 'car' | 'bills' | 'other' | 'uncategorised' | 'fixed' | 'installments' | 'savings' | 'income' | 'not_counted';
export const SECTION_ORDER: SectionKey[] = ['lifestyle', 'daily', 'car', 'bills', 'other', 'uncategorised', 'fixed', 'installments', 'savings', 'income', 'not_counted'];
const OPEN_BY_DEFAULT = new Set<SectionKey>(['lifestyle', 'daily', 'car', 'bills', 'other', 'uncategorised']);

export function sectionOf(x: Txn): SectionKey {
  switch (x.bucket) {
    case 'fixed':
      return 'fixed';
    case 'installments':
      return 'installments';
    case 'savings':
      return 'savings';
    case 'income':
      return 'income';
    case 'variable':
    case 'pending':
    case 'cancelled':
    case 'uncategorised': {
      const k = x.categoryKey;
      if (!k) return 'uncategorised';
      if (k.startsWith('lifestyle.')) return 'lifestyle';
      if (k.startsWith('daily.')) return 'daily';
      if (k.startsWith('car.')) return 'car';
      if (k.startsWith('fixed.')) return 'bills';
      if (k.startsWith('income.')) return 'income';
      return 'other';
    }
    default:
      return 'not_counted';
  }
}

export function sectionLabel(t: (k: Key, v?: Record<string, string | number>) => string, key: SectionKey): string {
  switch (key) {
    case 'lifestyle':
    case 'daily':
    case 'car':
      return t(`group_${key}` as Key);
    case 'bills':
      return t('sec_bills');
    case 'other':
      return t('sec_other');
    case 'uncategorised':
      return t('filter_uncategorised');
    case 'fixed':
      return t('filter_fixed');
    case 'installments':
      return t('filter_installments');
    case 'savings':
      return t('filter_savings');
    case 'income':
      return t('filter_income');
    default:
      return t('not_counted');
  }
}

export interface Section {
  key: SectionKey;
  items: Txn[];
  count: number;
  pending: number;
  sum: number;
}

export function buildSections(items: Txn[]): Section[] {
  const map = new Map<SectionKey, Section>();
  for (const x of items) {
    const key = sectionOf(x);
    const sec = map.get(key) ?? { key, items: [], count: 0, pending: 0, sum: 0 };
    sec.items.push(x);
    sec.count += 1;
    if (x.status === 'pending') sec.pending += 1;
    else if (x.status === 'completed') sec.sum += x.netAmount;
    map.set(key, sec);
  }
  return SECTION_ORDER.filter((k) => map.has(k)).map((k) => map.get(k)!);
}

function readOpen(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem('finc.txnSections') ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}

export function TxnSections({ items, today, onOpen }: { items: Txn[]; today: string; onOpen?: (t: Txn) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState<Record<string, boolean>>(readOpen);
  const sections = buildSections(items);
  if (!sections.length) return <div className="text-muted text-sm p-3 text-center">{t('no_data')}</div>;
  const isOpen = (k: SectionKey) => open[k] ?? OPEN_BY_DEFAULT.has(k);
  const toggle = (k: SectionKey) => {
    const next = { ...open, [k]: !isOpen(k) };
    setOpen(next);
    try {
      localStorage.setItem('finc.txnSections', JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="flex flex-col gap-2">
      {sections.map((sec) => (
        <div key={sec.key} className="card px-3 py-1">
          <button className="w-full flex items-center gap-2 py-2 text-sm font-semibold" onClick={() => toggle(sec.key)}>
            <span className="text-muted w-4 shrink-0">{isOpen(sec.key) ? '▾' : '‹'}</span>
            {sec.key === 'uncategorised' && <span className="text-warn">•</span>}
            <span className="flex-1 text-start truncate">{sectionLabel(t, sec.key)}</span>
            <span className="num text-xs text-muted font-normal">
              {sec.count}
              {sec.pending > 0 ? ` · ${t('pending_n', { n: sec.pending })}` : ''}
            </span>
            <Amount value={sec.sum} tone={sec.key === 'income' ? 'pos' : sec.key === 'not_counted' ? 'muted' : 'neutral'} sign={sec.key === 'income' ? 'always' : 'never'} decimals={0} className="text-sm w-20 text-end" />
          </button>
          {isOpen(sec.key) && (
            <div className="pb-1 border-t border-border">
              <TxnList items={sec.items} today={today} {...(onOpen ? { onOpen } : {})} />
              {sec.key === 'uncategorised' && sections.length === 1 && <div className="text-xs text-muted p-2">{t('hint_uncat')}</div>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// By date: day headers with the day's total; rows dated after today collect under one header on top.

export function TxnByDate({ items, today, locale, onOpen }: { items: Txn[]; today: string; locale: string; onOpen?: (t: Txn) => void }) {
  const { t } = useI18n();
  if (!items.length) return <div className="text-muted text-sm p-3 text-center">{t('no_data')}</div>;
  const future = items.filter((x) => x.date > today);
  const past = items.filter((x) => x.date <= today);
  const days = new Map<string, Txn[]>();
  for (const x of past) days.set(x.date, [...(days.get(x.date) ?? []), x]);
  const fmt = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' });
  const dayTotal = (xs: Txn[]) => xs.filter((x) => x.status === 'completed' && x.amount < 0 && !x.excluded).reduce((a, x) => a + x.netAmount, 0);
  const Header = ({ label, total }: { label: string; total: number }) => (
    <div className="flex items-center justify-between pt-3 pb-1 px-1 text-xs text-muted">
      <span>{label}</span>
      {total !== 0 && <Amount value={total} tone="muted" decimals={0} className="text-xs" />}
    </div>
  );
  return (
    <div className="flex flex-col">
      {future.length > 0 && (
        <div className="opacity-80">
          <Header label={t('later_this_month')} total={0} />
          <TxnList items={future} showDate today={today} {...(onOpen ? { onOpen } : {})} />
        </div>
      )}
      {[...days.entries()].map(([d, xs]) => (
        <div key={d}>
          <Header label={fmt.format(new Date(`${d}T00:00:00`))} total={dayTotal(xs)} />
          <TxnList items={xs} showDate={false} today={today} {...(onOpen ? { onOpen } : {})} />
        </div>
      ))}
    </div>
  );
}
