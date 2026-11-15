import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { api, qs } from '../api';
import { CategoryChip, TxnList, todayLocal } from '../components/TxnList';
import { Amount, Bar, Card, Empty, ErrorBox, Row, Sheet, Spinner } from '../components/ui';
import { dayLabel, money } from '../format';
import { type Key, useI18n } from '../i18n';
import type { EventView, Txn, TxnPage } from '../types';
import { GROUP_COLOR } from './Categories';
import { TxnSheet } from './Transactions';

/**
 * Events (design §7): "how much did it cost me?" A list of events with their cost and a breakdown,
 * and one event opened: its transactions, a picker to add more, edit, archive, delete.
 */
const colorOf = (g: string) => GROUP_COLOR[g] ?? '#8b93a7';

export function Events() {
  const { t } = useI18n();
  const [sp, setSp] = useSearchParams();
  const openId = sp.get('id') ? Number(sp.get('id')) : null;
  const [archived, setArchived] = useState(false);
  const q = useQuery({ queryKey: ['events', archived], queryFn: () => api.get<EventView[]>(`/api/events${qs({ archived: archived ? 1 : undefined })}`) });
  const open = (id: number | null) => {
    const n = new URLSearchParams(sp);
    if (id === null) n.delete('id');
    else n.set('id', String(id));
    setSp(n, { replace: true });
  };
  if (openId !== null) return <EventPage id={openId} onBack={() => open(null)} />;
  if (q.isPending) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  return (
    <div className="flex flex-col gap-3 max-w-3xl">
      <header className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-lg font-semibold">{t('events_title')}</h1>
        <label className="flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> {t('event_show_archived')}
        </label>
      </header>
      <p className="text-sm text-muted">{t('events_help')}</p>
      <NewEvent onCreated={(e) => open(e.id)} />
      {q.data.length === 0 ? (
        <Empty>{t('event_none')}</Empty>
      ) : (
        q.data.map((e) => <EventCard key={e.id} e={e} onOpen={() => open(e.id)} />)
      )}
    </div>
  );
}

function groupLabel(t: (k: Key, v?: Record<string, string | number>) => string, key: string): string {
  const k = `group_${key}` as Key;
  return t(k) === k ? key : t(k);
}

/** One event in the list: name, span, cost, a stacked bar by group and the top categories. */
function EventCard({ e, onOpen }: { e: EventView; onOpen: () => void }) {
  const { t, locale, lang } = useI18n();
  const total = e.byGroup.reduce((a, g) => a + g.sum, 0);
  return (
    <button className="card p-4 text-start flex flex-col gap-2 w-full" onClick={onOpen}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-semibold truncate">
          {e.name}
          {e.archived && <span className="chip ms-2 text-[10px]">{t('event_archive')}</span>}
        </span>
        <Amount value={-e.spent + e.income} tone={e.net < 0 ? 'neutral' : 'pos'} className="text-xl font-bold shrink-0" decimals={0} />
      </div>
      <div className="text-xs text-muted flex gap-2 flex-wrap">
        <span>{t('event_txns_n', { n: e.count })}</span>
        {e.firstDate && e.lastDate && (
          <span>
            · {dayLabel(e.firstDate, locale, { year: true })}
            {e.lastDate !== e.firstDate ? ` – ${dayLabel(e.lastDate, locale, { year: true })}` : ''}
          </span>
        )}
        {e.income > 0 && <span>· {t('event_refunds_in', { x: money(e.income, { decimals: 0 }) })}</span>}
      </div>
      {total > 0 && (
        <>
          <div className="flex h-2 rounded-full overflow-hidden bg-surface-2">
            {e.byGroup.map((g) => (
              <span key={g.group} style={{ width: `${(g.sum / total) * 100}%`, background: colorOf(g.group) }} title={`${groupLabel(t, g.group)} ${money(g.sum, { decimals: 0 })}`} />
            ))}
          </div>
          <div className="flex gap-x-3 gap-y-1 flex-wrap text-xs text-muted">
            {e.byCategory.slice(0, 4).map((c) => (
              <span key={c.key ?? 'none'}>
                {c.key === null ? t('uncategorised') : lang === 'he' ? c.nameHe : c.nameEn} {money(c.sum, { decimals: 0 })}
              </span>
            ))}
          </div>
        </>
      )}
    </button>
  );
}

function NewEvent({ onCreated }: { onCreated: (e: EventView) => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [openForm, setOpenForm] = useState(false);
  const [name, setName] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const create = useMutation({
    mutationFn: () => api.post<EventView>('/api/events', { name, fromDate: from || null, toDate: to || null }),
    onSuccess: (e) => {
      void qc.invalidateQueries({ queryKey: ['events'] });
      setName('');
      setFrom('');
      setTo('');
      setOpenForm(false);
      onCreated(e);
    },
  });
  if (!openForm)
    return (
      <button className="btn btn-primary self-start" onClick={() => setOpenForm(true)}>
        + {t('events_new')}
      </button>
    );
  return (
    <form
      className="card p-4 flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) create.mutate();
      }}
    >
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted">{t('event_name')}</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={80} />
      </label>
      <div className="flex gap-3 flex-wrap">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">{t('event_from')}</span>
          <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">{t('event_to')}</span>
          <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      <div className="flex gap-2">
        <button className="btn btn-primary" disabled={!name.trim() || create.isPending}>
          {t('event_create')}
        </button>
        <button type="button" className="btn" onClick={() => setOpenForm(false)}>
          {t('cancel')}
        </button>
      </div>
    </form>
  );
}

/** One event: header with edit controls, cost and breakdown, its transactions, and the picker. */
function EventPage({ id, onBack }: { id: number; onBack: () => void }) {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['event', id], queryFn: () => api.get<EventView>(`/api/events/${id}`) });
  const txns = useQuery({ queryKey: ['transactions', { eventId: id }], queryFn: () => api.get<TxnPage>(`/api/transactions${qs({ eventId: id, includeExcluded: 1, limit: 500 })}`) });
  const [picking, setPicking] = useState(false);
  const [openTxn, setOpenTxn] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['event', id] });
    void qc.invalidateQueries({ queryKey: ['events'] });
    void qc.invalidateQueries({ queryKey: ['transactions'] });
  };
  const patch = useMutation({ mutationFn: (body: Record<string, unknown>) => api.patch<EventView>(`/api/events/${id}`, body), onSuccess: () => { invalidate(); setEditing(false); } });
  const change = useMutation({ mutationFn: (body: { add?: number[]; remove?: number[] }) => api.post<EventView>(`/api/events/${id}/txns`, body), onSuccess: invalidate });
  const del = useMutation({ mutationFn: () => api.del(`/api/events/${id}`), onSuccess: () => { invalidate(); onBack(); } });
  if (q.isPending) return <Spinner />;
  if (q.error || !q.data) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const e = q.data;
  const total = e.byGroup.reduce((a, g) => a + g.sum, 0);
  const back = lang === 'he' ? '›' : '‹';
  return (
    <div className="flex flex-col gap-3 max-w-3xl">
      <header className="flex items-center gap-2 flex-wrap">
        <button className="btn btn-sm" onClick={onBack} aria-label="back">
          {back}
        </button>
        <h1 className="text-lg font-semibold flex-1 truncate">{e.name}</h1>
        <button className="btn btn-sm" onClick={() => setEditing((v) => !v)}>
          {t('edit')}
        </button>
      </header>
      {editing && <EditEvent e={e} onSave={(body) => patch.mutate(body)} onDelete={() => { if (window.confirm(t('event_delete_confirm'))) del.mutate(); }} />}

      <Card>
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-xs text-muted uppercase tracking-wide">{t('event_cost')}</span>
          <Amount value={e.net} tone={e.net < 0 ? 'neutral' : 'pos'} sign="never" className="text-3xl font-bold" decimals={0} />
        </div>
        <div className="text-xs text-muted mt-1 flex gap-2 flex-wrap">
          <span>{t('event_txns_n', { n: e.count })}</span>
          {e.income > 0 && <span>· {t('event_refunds_in', { x: money(e.income, { decimals: 0 }) })}</span>}
          {e.note && <span>· {e.note}</span>}
        </div>
        {total > 0 && (
          <div className="mt-3 flex flex-col gap-2">
            {e.byGroup.map((g) => (
              <Row key={g.group}>
                <span className="inline-block h-2.5 w-2.5 rounded-full shrink-0" style={{ background: colorOf(g.group) }} />
                <span className="flex-1 text-sm">{groupLabel(t, g.group)}</span>
                <Bar value={g.sum} max={total} color={colorOf(g.group)} className="w-28" />
                <Amount value={-g.sum} tone="neutral" decimals={0} className="text-sm w-20 text-end" />
              </Row>
            ))}
          </div>
        )}
      </Card>

      <Card
        title={t('nav_transactions')}
        action={
          <button className="btn btn-sm btn-primary" onClick={() => setPicking(true)}>
            {t('event_add_txns')}
          </button>
        }
      >
        {txns.isPending ? (
          <Spinner />
        ) : txns.data?.items.length ? (
          <EventTxnList items={txns.data.items} onOpen={(x) => setOpenTxn(x.id)} onRemove={(x) => change.mutate({ remove: [x.id] })} />
        ) : (
          <Empty>{t('event_no_txns')}</Empty>
        )}
      </Card>

      <PickTxns open={picking} onClose={() => setPicking(false)} e={e} onAdd={(ids) => change.mutate({ add: ids })} />
      <TxnSheet id={openTxn} onClose={() => setOpenTxn(null)} />
    </div>
  );
}

/** The event's rows with a remove control beside each; the row itself opens the transaction. */
function EventTxnList({ items, onOpen, onRemove }: { items: Txn[]; onOpen: (x: Txn) => void; onRemove: (x: Txn) => void }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col">
      {items.map((x) => (
        <div key={x.id} className="flex items-center gap-2 border-b border-border last:border-0">
          <div className="flex-1 min-w-0">
            <TxnList items={[x]} onOpen={onOpen} />
          </div>
          <button className="btn btn-sm shrink-0" onClick={() => onRemove(x)} title={t('event_remove_txn')}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

function EditEvent({ e, onSave, onDelete }: { e: EventView; onSave: (body: Record<string, unknown>) => void; onDelete: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState(e.name);
  const [from, setFrom] = useState(e.fromDate ?? '');
  const [to, setTo] = useState(e.toDate ?? '');
  const [note, setNote] = useState(e.note ?? '');
  return (
    <form
      className="card p-4 flex flex-col gap-3"
      onSubmit={(ev) => {
        ev.preventDefault();
        onSave({ name, fromDate: from || null, toDate: to || null, note: note || null });
      }}
    >
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted">{t('event_name')}</span>
        <input className="input" value={name} onChange={(ev) => setName(ev.target.value)} maxLength={80} />
      </label>
      <div className="flex gap-3 flex-wrap">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">{t('event_from')}</span>
          <input className="input" type="date" value={from} onChange={(ev) => setFrom(ev.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">{t('event_to')}</span>
          <input className="input" type="date" value={to} onChange={(ev) => setTo(ev.target.value)} />
        </label>
      </div>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted">{t('event_note')}</span>
        <input className="input" value={note} onChange={(ev) => setNote(ev.target.value)} maxLength={500} />
      </label>
      <div className="flex gap-2 flex-wrap">
        <button className="btn btn-primary" disabled={!name.trim()}>
          {t('save')}
        </button>
        <button type="button" className="btn" onClick={() => onSave({ archived: !e.archived })}>
          {e.archived ? t('event_unarchive') : t('event_archive')}
        </button>
        <button type="button" className="btn text-neg ms-auto" onClick={onDelete}>
          {t('event_delete')}
        </button>
      </div>
    </form>
  );
}

/** Candidates: transactions in a date range (the event's by default) not yet tagged, searchable, multi-select. */
function PickTxns({ open, onClose, e, onAdd }: { open: boolean; onClose: () => void; e: EventView; onAdd: (ids: number[]) => void }) {
  const { t } = useI18n();
  const today = todayLocal();
  const [from, setFrom] = useState(e.fromDate ?? e.firstDate ?? today.slice(0, 8) + '01');
  const [to, setTo] = useState(e.toDate ?? today);
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<Set<number>>(new Set());
  useEffect(() => {
    if (open) setPicked(new Set());
  }, [open]);
  const q = useQuery({
    queryKey: ['transactions', { pick: true, from, to, search }],
    queryFn: () => api.get<TxnPage>(`/api/transactions${qs({ from, to, q: search || undefined, limit: 300, sort: 'date' })}`),
    enabled: open,
  });
  const tagged = useQuery({ queryKey: ['transactions', { eventId: e.id }], queryFn: () => api.get<TxnPage>(`/api/transactions${qs({ eventId: e.id, includeExcluded: 1, limit: 500 })}`), enabled: open });
  const taggedIds = new Set(tagged.data?.items.map((x) => x.id) ?? []);
  const items = (q.data?.items ?? []).filter((x) => !taggedIds.has(x.id));
  const toggle = (id: number) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <Sheet open={open} onClose={onClose} title={t('event_pick_title')}>
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-xs text-muted">{t('event_pick_help')}</p>
        <div className="flex gap-2 flex-wrap items-end">
          <label className="flex flex-col gap-1">
            <span className="text-muted text-xs">{t('event_from')}</span>
            <input className="input" type="date" value={from} onChange={(ev) => setFrom(ev.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted text-xs">{t('event_to')}</span>
            <input className="input" type="date" value={to} onChange={(ev) => setTo(ev.target.value)} />
          </label>
          <input className="input flex-1 min-w-[8rem]" placeholder={t('search')} value={search} onChange={(ev) => setSearch(ev.target.value)} />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted">{t('event_txns_n', { n: items.length })}</span>
          <button className="btn btn-sm btn-primary" disabled={picked.size === 0} onClick={() => { onAdd([...picked]); onClose(); }}>
            {t('event_add_n', { n: picked.size })}
          </button>
        </div>
        {q.isPending ? (
          <Spinner />
        ) : (
          <div className="flex flex-col divide-y divide-border max-h-[60vh] overflow-y-auto">
            {items.map((x) => (
              <label key={x.id} className="flex items-center gap-3 py-2 cursor-pointer">
                <input type="checkbox" checked={picked.has(x.id)} onChange={() => toggle(x.id)} />
                <span className="flex-1 min-w-0">
                  <span className="block truncate">{x.name}</span>
                  <span className="flex items-center gap-2 text-xs text-muted">
                    {x.date} <CategoryChip categoryKey={x.categoryKey} source={x.categorySource} />
                  </span>
                </span>
                <Amount value={x.amount} tone={x.amount > 0 ? 'pos' : 'neutral'} className="shrink-0" />
              </label>
            ))}
            {items.length === 0 && <Empty>{t('no_data')}</Empty>}
          </div>
        )}
      </div>
    </Sheet>
  );
}

