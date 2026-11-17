import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { ApiError, api } from '../api';
import { revokeSession } from '../logout';
import { AlertsCard } from '../components/AlertsCard';
import { HoldingRulesCard } from '../components/HoldingRulesCard';
import { IncomeKindsCard } from '../components/IncomeKindsCard';
import { LimitsCard } from '../components/LimitsCard';
import { LockdownCard } from '../components/LockdownCard';
import { McpRemoteSection } from '../components/McpRemoteSection';
import { McpSection } from '../components/McpSection';
import { PasskeysCard } from '../components/PasskeysCard';
import { SecurityLogCard } from '../components/SecurityLogCard';
import { SpendLimitCard } from '../components/SpendLimitCard';
import { TotpCard } from '../components/TotpCard';
import { Card, Chip, Empty, ErrorBox, Row, Spinner } from '../components/ui';
import { IDLE_DAYS_MAX, parseIdleDays, revokedLabel } from '../devicePolicy';
import { relTime } from '../format';
import { useI18n } from '../i18n';
import { isNative } from '../native';
import type { DevicesPayload, Pairing, Rule, Settings as SettingsT } from '../types';

export function Settings({ onSignOut, thisDevice }: { onSignOut: () => void; thisDevice?: { id: number; name: string } | null }) {
  const { t, lang, setLang } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api.get<SettingsT>('/api/settings') });
  const rules = useQuery({ queryKey: ['rules'], queryFn: () => api.get<Rule[]>('/api/rules') });
  // the phone app's own version (versionName from the APK); the line below also shows the hub's
  const appInfo = useQuery({ queryKey: ['appInfo'], enabled: isNative, staleTime: Infinity, queryFn: async () => (await import('@capacitor/app')).App.getInfo() });
  const patch = useMutation({ mutationFn: (body: unknown) => api.patch('/api/settings', body), onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }) });
  const rulePatch = useMutation({ mutationFn: (p: { id: number; enabled: boolean }) => api.patch(`/api/rules/${p.id}`, { enabled: p.enabled }), onSuccess: () => qc.invalidateQueries({ queryKey: ['rules'] }) });
  const ruleDel = useMutation({ mutationFn: (id: number) => api.del(`/api/rules/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['rules'] }) });
  const engine = useMutation({ mutationFn: () => api.post('/api/engine/run'), onSuccess: () => qc.invalidateQueries() });
  // revoke on the hub first; if it cannot be reached, stay signed in and say so (P3-02)
  const logout = useMutation({ mutationFn: () => revokeSession(() => api.post('/api/auth/logout')), onSuccess: (r) => r === 'revoked' && onSignOut() });
  if (q.isPending) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const s = q.data;
  return (
    <div className="flex flex-col gap-3 max-w-2xl">
      <Card title={t('language')}>
        <div className="flex gap-2">
          <Chip on={lang === 'he'} onClick={() => { setLang('he'); patch.mutate({ language: 'he' }); }}>
            {t('hebrew')}
          </Chip>
          <Chip on={lang === 'en'} onClick={() => { setLang('en'); patch.mutate({ language: 'en' }); }}>
            {t('english')}
          </Chip>
        </div>
      </Card>
      <AlertsCard />
      <HoldingRulesCard />
      <PhoneAccess settings={s} thisDevice={thisDevice ?? null} onUnpair={() => logout.mutate()} />
      <PasskeysCard trusted={s.trusted} />
      <TotpCard />
      <LockdownCard settings={s} />
      <LimitsCard settings={s} />
      <SecurityLogCard trusted={s.trusted} />
      <Card title={t('model_provider')}>
        <div className="flex gap-2 flex-wrap items-center">
          {(['openai', 'anthropic', 'local'] as const).map((p) => (
            <Chip key={p} on={s.ai.provider === p} onClick={() => patch.mutate({ ai: { provider: p } })}>
              {p}
            </Chip>
          ))}
          <span className="text-xs text-muted">
            {s.ai.model ?? ''} {s.ai.provider === 'local' ? `· ${s.ai.baseUrl}` : ''}
          </span>
        </div>
        {s.ai.chatModels && (
          // chat v2 step 4: the chat's own model, two tiers of the provider (hidden for local / none)
          <div className="mt-3">
            <div className="text-sm mb-1">{t('chat_model')}</div>
            <div className="flex gap-2 flex-wrap items-center">
              {(['fast', 'better'] as const).map((tier) => {
                const id = s.ai.chatModels![tier];
                return (
                  // no choice made = the fast tier (chatModelOf); from outside the change is refused, so not clickable
                  <Chip key={tier} on={(s.ai.chatModel ?? s.ai.chatModels!.fast) === id} {...(s.trusted ? { onClick: () => patch.mutate({ ai: { chatModel: id } }) } : {})}>
                    {t(tier === 'fast' ? 'chat_model_fast' : 'chat_model_better')} <span dir="ltr" className="text-muted">{id}</span>
                  </Chip>
                );
              })}
            </div>
            <p className="text-xs text-muted mt-1">{t('chat_model_note')}</p>
          </div>
        )}
        {/* decision aids C: the AI summary of stock news has its own switch; headlines show either way. Absent = on. */}
        <div className="mt-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              role="switch"
              checked={s.ai.newsSummary ?? true}
              disabled={!s.trusted || patch.isPending}
              onChange={(e) => patch.mutate({ ai: { newsSummary: e.target.checked } })}
            />
            {t('news_setting')}
          </label>
          <p className="text-xs text-muted mt-1">{t('news_setting_help')}</p>
        </div>
        <McpSection settings={s} />
        <McpRemoteSection settings={s} />
        <p className="text-xs text-muted mt-2">finc vault set ai_{s.ai.provider ?? 'openai'} · finc ai dry-run · finc ai run</p>
      </Card>
      <Card title={t('conventions')}>
        <ul className="text-sm list-disc ps-5 text-muted">
          <li>{t('conv_month')}</li>
          <li>{t('conv_cards')}</li>
        </ul>
      </Card>
      <SpendLimitCard limit={s.spendLimit} />
      <IncomeKindsCard kinds={s.incomeKinds} />
      <Card title={t('schedule')}>
        <div className="text-sm text-muted">
          {s.schedule.times.join(', ')} ({s.schedule.timezone}) ± {s.schedule.jitterMinutes} min · {s.schedule.monthsBack} months back · vault: {s.vault}
        </div>
        <button className="btn btn-sm mt-2" disabled={engine.isPending} onClick={() => engine.mutate()}>
          {t('run_engine')}
        </button>
      </Card>
      <Card title={t('rules')}>
        {rules.data?.length ? (
          <div className="flex flex-col divide-y divide-border text-sm">
            {rules.data.map((r) => (
              <Row key={r.id}>
                <span className="flex-1">
                  {r.merchantName ?? JSON.stringify(r.conditions)} → {r.categoryKey ?? JSON.stringify(r.actions)}
                  {r.note ? <span className="text-muted"> · {r.note}</span> : null}
                </span>
                <label className="flex items-center gap-1 text-xs text-muted">
                  <input type="checkbox" checked={r.enabled} onChange={(e) => rulePatch.mutate({ id: r.id, enabled: e.target.checked })} /> {t('enabled')}
                </label>
                <button className="btn btn-sm" onClick={() => ruleDel.mutate(r.id)}>
                  {t('delete')}
                </button>
              </Row>
            ))}
          </div>
        ) : (
          <Empty>{t('no_rules')}</Empty>
        )}
      </Card>
      {logout.data === 'failed' && <p className="text-xs text-neg" role="alert">{t('sign_out_failed')}</p>}
      <div className="flex justify-between items-center text-xs text-muted">
        <span>
          {isNative && appInfo.data ? `${t('app_version')} ${appInfo.data.version} (${appInfo.data.build}) · ` : ''}
          {t('hub_version')} {s.version}
        </span>
        {!isNative && (
          <button className="btn btn-sm" disabled={logout.isPending} onClick={() => logout.mutate()}>
            {t('sign_out')}
          </button>
        )}
      </div>
    </div>
  );
}

/** Public address, pairing QR, and the list of paired phones with revoke. */
function PhoneAccess({ settings, thisDevice, onUnpair }: { settings: SettingsT; thisDevice: { id: number; name: string } | null; onUnpair: () => void }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  // removed devices (and why: by hand, unused too long, lock everything) only on request (P1-09)
  const [showRemoved, setShowRemoved] = useState(false);
  const devices = useQuery({ queryKey: ['devices', showRemoved], queryFn: () => api.get<DevicesPayload>(`/api/devices${showRemoved ? '?all=true' : ''}`), refetchInterval: 15_000 });
  const [url, setUrl] = useState(settings.publicUrl ?? '');
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  // every action says when it fails (before 2026-11-10 a refusal from outside the home network was silent)
  const [err, setErr] = useState<string | null>(null);
  const fail = (e: unknown) => setErr(e === null ? null : e instanceof ApiError ? e.message : String(e));
  const saveUrl = useMutation({ mutationFn: (v: string) => api.patch('/api/settings', { publicUrl: v || null }), onMutate: () => setErr(null), onError: fail, onSuccess: () => { void qc.invalidateQueries({ queryKey: ['settings'] }); void qc.invalidateQueries({ queryKey: ['devices'] }); } });
  const newCode = useMutation({ mutationFn: () => api.post<Pairing>('/api/devices/pairings', { name: 'phone' }), onMutate: () => setErr(null), onError: fail, onSuccess: (p) => { setPairing(p); void qc.invalidateQueries({ queryKey: ['devices'] }); } });
  // removing works from anywhere (it only takes access away); pairing and the public address need the PC at home
  const revoke = useMutation({ mutationFn: (id: number) => api.del(`/api/devices/${id}`), onMutate: () => setErr(null), onError: fail, onSuccess: () => qc.invalidateQueries({ queryKey: ['devices'] }) });

  const pairUrl = pairing ? `${pairing.url}/pair?code=${encodeURIComponent(pairing.code)}` : null;
  useEffect(() => {
    if (!pairUrl) return setQr(null);
    void QRCode.toDataURL(pairUrl, { margin: 1, width: 260, color: { dark: '#0f1115', light: '#ffffff' } }).then(setQr);
  }, [pairUrl]);
  useEffect(() => {
    if (!pairing) return;
    const id = setTimeout(() => setPairing(null), Math.max(0, new Date(pairing.expiresAt).getTime() - Date.now()));
    return () => clearTimeout(id);
  }, [pairing]);

  const trusted = devices.data?.trusted ?? settings.trusted;
  return (
    <Card title={t('phone_access')}>
      <div className="flex flex-col gap-4">
        {thisDevice && (
          <Row>
            <span className="flex-1 text-sm">
              {t('this_phone')}: <b>{thisDevice.name}</b>
            </span>
            <button className="btn btn-sm" onClick={onUnpair}>
              {t('unpair')}
            </button>
          </Row>
        )}
        {!isNative && !trusted && settings.publicUrl && (
          <div className="flex flex-col gap-1 text-sm">
            <span className="text-muted">{t('public_url')}</span>
            <span className="num" dir="ltr">
              {settings.publicUrl}
            </span>
          </div>
        )}
        {!isNative && trusted && (
          <form
            className="flex flex-col gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              saveUrl.mutate(url.trim().replace(/\/+$/, ''));
            }}
          >
            <span className="text-sm text-muted">{t('public_url')}</span>
            <div className="flex gap-2">
              <input className="input flex-1" dir="ltr" type="url" placeholder="https://your-name.duckdns.org" value={url} onChange={(e) => setUrl(e.target.value)} />
              <button className="btn btn-sm" disabled={saveUrl.isPending || url.trim().replace(/\/+$/, '') === (settings.publicUrl ?? '')}>
                {t('save')}
              </button>
            </div>
            <span className="text-xs text-muted">{t('public_url_help')}</span>
          </form>
        )}
        {!isNative && (
          <div className="flex flex-col gap-2">
            {trusted ? (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <button className="btn btn-sm btn-primary" disabled={newCode.isPending} onClick={() => newCode.mutate()}>
                    {pairing ? t('new_code') : t('pair_phone')}
                  </button>
                  <span className="text-xs text-muted">{t('pair_phone_help')}</span>
                </div>
                {pairing && (
                  <div className="flex flex-col sm:flex-row gap-4 items-center card p-3">
                    {qr && <img src={qr} alt="QR" className="rounded-lg bg-white p-1 w-[200px] h-[200px]" />}
                    <div className="flex flex-col gap-1 text-sm min-w-0">
                      <span className="text-muted text-xs">{t('server_url')}</span>
                      <span className="num break-all" dir="ltr">
                        {pairing.url}
                      </span>
                      <span className="text-muted text-xs mt-1">{t('pairing_code')}</span>
                      <span className="num break-all select-all" dir="ltr">
                        {pairing.code}
                      </span>
                      <span className="text-xs text-muted mt-1">{t('expires_at', { t: new Date(pairing.expiresAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) })}</span>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <span className="text-xs text-muted">{t('pair_from_pc')}</span>
            )}
          </div>
        )}
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-sm text-muted">{t('devices')}</span>
            <Chip on={showRemoved} onClick={() => setShowRemoved((v) => !v)}>
              {t('dev_show_removed')}
            </Chip>
          </div>
          {devices.data?.devices.length ? (
            <div className="flex flex-col divide-y divide-border text-sm">
              {devices.data.devices.map((d) => {
                const why = revokedLabel(d);
                return (
                  <Row key={d.id}>
                    <span className={`flex-1 min-w-0 ${why ? 'text-muted' : ''}`}>
                      {d.name}
                      {thisDevice?.id === d.id && <span className="chip chip-on ms-2 text-[10px]">{t('this_phone')}</span>}
                      {why && (
                        <span className="chip ms-2 text-[10px] text-neg border-neg/40">
                          {why.key === 'dev_reason_expired' ? t(why.key, { n: why.days }) : t(why.key)}
                          {d.revokedAt ? ` · ${relTime(d.revokedAt, locale)}` : ''}
                        </span>
                      )}
                      <div className="text-xs text-muted truncate" dir="ltr">
                        {t('last_seen')}: {relTime(d.lastSeenAt, locale)}
                        {d.lastAddress ? ` · ${d.lastAddress}` : ''}
                      </div>
                    </span>
                    {!why && thisDevice?.id !== d.id && (
                      <button
                        className="btn btn-sm"
                        disabled={revoke.isPending}
                        onClick={() => {
                          if (window.confirm(t('revoke_confirm', { name: d.name }))) revoke.mutate(d.id);
                        }}
                      >
                        {t('revoke')}
                      </button>
                    )}
                  </Row>
                );
              })}
            </div>
          ) : (
            <Empty>{t('no_devices')}</Empty>
          )}
        </div>
        {settings.deviceIdleDays !== undefined && <IdleExpiry days={settings.deviceIdleDays} trusted={trusted} onError={fail} />}
        {err && <div className="text-neg text-sm">{err}</div>}
      </div>
    </Card>
  );
}

/**
 * P1-09: paired devices unused this many days are removed by the worker (0 = never). Changed only from home (the worker
 * answers 403 otherwise; that refusal shows in the card's error line). onError(null) clears that line.
 */
function IdleExpiry({ days, trusted, onError }: { days: number; trusted: boolean; onError: (e: unknown) => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [value, setValue] = useState(String(days));
  useEffect(() => setValue(String(days)), [days]);
  const save = useMutation({ mutationFn: (n: number) => api.patch('/api/settings', { deviceIdleDays: n }), onMutate: () => onError(null), onError, onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }) });
  const parsed = parseIdleDays(value);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted">{days > 0 ? t('dev_idle_policy', { n: days }) : t('dev_idle_never')}</span>
      <span className="text-xs text-muted">{t('dev_idle_passkeys')}</span>
      {trusted ? (
        <form
          className="flex flex-col gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (parsed !== null) save.mutate(parsed);
          }}
        >
          <label className="text-sm text-muted" htmlFor="device-idle-days">
            {t('dev_idle_label')}
          </label>
          <div className="flex gap-2 items-center">
            <input id="device-idle-days" className="input" style={{ width: '6rem' }} dir="ltr" type="number" inputMode="numeric" min={0} max={IDLE_DAYS_MAX} step={1} value={value} onChange={(e) => setValue(e.target.value)} />
            <button className="btn btn-sm" disabled={save.isPending || parsed === null || parsed === days}>
              {t('save')}
            </button>
            {parsed === null && <span className="text-xs text-neg">{t('dev_idle_invalid')}</span>}
          </div>
        </form>
      ) : (
        <span className="text-xs text-muted">{t('dev_idle_home_only')}</span>
      )}
    </div>
  );
}
