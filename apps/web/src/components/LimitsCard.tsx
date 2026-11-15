import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, api } from '../api';
import { type Key, useI18n } from '../i18n';
import { LIMIT_KEYS, LIMIT_RANGES, type LimitKey, type Limits, parseLimit, readLimits } from '../limits';
import type { Settings } from '../types';
import { Card } from './ui';

/**
 * Settings → limits away from home (P2-02): manual sync, chat and alert caps. Read-only on the phone and from the
 * internet; editable from home through PATCH /api/settings {limits} (the worker answers 403 elsewhere). Hidden when the
 * hub does not report its limits (an older hub).
 */
export function LimitsCard({ settings }: { settings: Settings }) {
  const { t } = useI18n();
  const limits = readLimits(settings.limits);
  if (!limits) return null;
  return (
    <Card title={t('limits_title')}>
      <div className="flex flex-col gap-3">
        <ul className="text-sm flex flex-col gap-1">
          <li>{t('limits_sync', { m: limits.syncCooldownMin, n: limits.syncDailyCap, mo: limits.syncMaxMonthsOutside })}</li>
          <li>{t('limits_chat', { h: limits.chatPerHour, d: limits.chatPerDay })}</li>
          <li>{t('limits_alerts', { h: limits.alertsPerHour })}</li>
        </ul>
        <p className="text-xs text-muted">{t('limits_help')}</p>
        {settings.trusted ? (
          // keyed on the saved values, so the draft resets to what the hub holds after each save
          <LimitsEditor key={LIMIT_KEYS.map((k) => limits[k]).join('-')} limits={limits} />
        ) : (
          <span className="text-xs text-muted">{t('limits_home_only')}</span>
        )}
      </div>
    </Card>
  );
}

function LimitsEditor({ limits }: { limits: Limits }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Record<LimitKey, string>>(() => Object.fromEntries(LIMIT_KEYS.map((k) => [k, String(limits[k])])) as Record<LimitKey, string>);
  const [err, setErr] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (changed: Partial<Limits>) => api.patch('/api/settings', { limits: changed }),
    onMutate: () => setErr(null),
    onError: (e) => setErr(e instanceof ApiError ? e.message : String(e)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  });
  const parsed = Object.fromEntries(LIMIT_KEYS.map((k) => [k, parseLimit(k, draft[k])])) as Record<LimitKey, number | null>;
  const valid = LIMIT_KEYS.every((k) => parsed[k] !== null);
  const changed: Partial<Limits> = {};
  for (const k of LIMIT_KEYS) {
    const n = parsed[k];
    if (n !== null && n !== limits[k]) changed[k] = n;
  }
  const dirty = Object.keys(changed).length > 0;
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && dirty) save.mutate(changed);
      }}
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
        {LIMIT_KEYS.map((k) => {
          const r = LIMIT_RANGES[k];
          const bad = parsed[k] === null;
          return (
            <label key={k} className="flex items-center justify-between gap-2">
              <span className="text-muted">{t(`limit_f_${k}` as Key)}</span>
              <input
                className={`input num ${bad ? 'border-neg' : ''}`}
                style={{ width: '6rem' }}
                dir="ltr"
                type="number"
                inputMode="numeric"
                min={r.min}
                max={r.max}
                step={1}
                value={draft[k]}
                title={t('limits_invalid', { min: r.min, max: r.max })}
                aria-invalid={bad}
                onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
              />
            </label>
          );
        })}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <button className="btn btn-sm" disabled={save.isPending || !valid || !dirty}>
          {t('save')}
        </button>
        {!valid && (
          <span className="text-xs text-neg">
            {LIMIT_KEYS.filter((k) => parsed[k] === null)
              .map((k) => `${t(`limit_f_${k}` as Key)}: ${t('limits_invalid', { min: LIMIT_RANGES[k].min, max: LIMIT_RANGES[k].max })}`)
              .join(' · ')}
          </span>
        )}
        {err && <span className="text-xs text-neg">{err}</span>}
      </div>
    </form>
  );
}
