import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import { relTime } from '../format';
import { useI18n } from '../i18n';
import { SECURITY_FILTERS, type SecurityFilter, absTime, filterEvents, filterLabelKey, formatActor, formatDetail, isRoutine, kindLabel, kindTone, securityEventsPath, toneClass } from '../securityLog';
import type { SecurityEvent, SecurityEventsPage } from '../types';
import { Card, Chip, Empty, ErrorBox, Spinner } from './ui';

/**
 * Settings → Security log: the newest security events (sign-ins, devices, the vault, lockdowns), 30 at a time with
 * "load more". The address is shown only at home (trusted): on the phone or from the internet it stays hidden.
 */
export function SecurityLogCard({ trusted }: { trusted: boolean }) {
  const { t } = useI18n();
  const [filter, setFilter] = useState<SecurityFilter>('all');
  const q = useInfiniteQuery({
    queryKey: ['securityEvents'],
    queryFn: ({ pageParam }) => api.get<SecurityEventsPage>(securityEventsPath(pageParam)),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    refetchInterval: 60_000,
  });

  const all = q.data?.pages.flatMap((p) => p.events) ?? [];
  const shown = filterEvents(all, filter);

  return (
    <Card title={t('sec_title')}>
      <div className="flex flex-col gap-3">
        <p className="text-xs text-muted">{t('sec_help')}</p>
        <div className="flex gap-2 flex-wrap">
          {SECURITY_FILTERS.map((f) => (
            <Chip key={f} on={filter === f} onClick={() => setFilter(f)}>
              {t(filterLabelKey(f))}
            </Chip>
          ))}
        </div>
        {q.isPending ? (
          <Spinner />
        ) : q.error ? (
          <ErrorBox error={q.error} onRetry={() => q.refetch()} />
        ) : (
          <>
            {shown.length ? (
              <ul className="flex flex-col divide-y divide-border">
                {shown.map((e) => (
                  <EventRow key={e.id} e={e} showAddress={trusted} />
                ))}
              </ul>
            ) : (
              <Empty>{t(all.length ? 'sec_empty_filter' : 'sec_empty')}</Empty>
            )}
            {q.hasNextPage ? (
              <div>
                <button className="btn btn-sm" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
                  {q.isFetchingNextPage ? t('loading') : t('sec_load_more')}
                </button>
              </div>
            ) : (
              all.length > 0 && <span className="text-xs text-muted">{t('sec_end')}</span>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

function EventRow({ e, showAddress }: { e: SecurityEvent; showAddress: boolean }) {
  const { t, locale } = useI18n();
  const [abs, setAbs] = useState(false);
  const full = absTime(e.at, locale);
  const tone = kindTone(e.kind);
  const detail = formatDetail(e.detail, t);
  const routine = isRoutine(e.kind);
  return (
    <li className={`flex flex-col gap-0.5 ${routine ? 'py-1 text-xs text-muted' : 'py-2 text-sm'}`}>
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className={`${routine ? '' : 'font-medium'} ${toneClass(tone)}`} title={e.kind}>
          {kindLabel(e.kind, t)}
        </span>
        <span className="text-xs text-muted">· {formatActor(e.actor, e.actorName, t)}</span>
        <button type="button" className="ms-auto text-xs text-muted num" title={full} onClick={() => setAbs((v) => !v)}>
          {abs ? full : relTime(e.at, locale)}
        </button>
      </div>
      {(detail || (showAddress && e.address)) && (
        <div className="text-xs text-muted break-words" dir="auto">
          {detail}
          {showAddress && e.address && (
            <span className="num" dir="ltr">
              {detail ? ' · ' : ''}
              {e.address}
            </span>
          )}
        </div>
      )}
    </li>
  );
}
