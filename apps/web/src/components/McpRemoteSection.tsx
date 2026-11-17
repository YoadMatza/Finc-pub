import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../api';
import { relTime } from '../format';
import { useI18n } from '../i18n';
import { lastUsedLabel } from '../mcpSettings';
import { formatCountdown, grantPath, remoteRefetchMs, sortGrants, windowLeftMs } from '../mcpRemote';
import type { McpRemoteGrant, McpRemotePayload, Settings } from '../types';
import { CopyLine } from './CopyLine';
import { Empty, ErrorBox, Row, Spinner } from './ui';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : String(e));

/**
 * Settings → AI → Remote AI apps (remote-mcp.md §4.1, §4.4): ChatGPT and Claude reach finc from anywhere with a token
 * the owner approves with a passkey. Turning it on and opening the "Connect an app" window need the PC at home;
 * turning it off, closing the window and revoking only take access away, so they are offered from anywhere.
 */
export function McpRemoteSection({ settings }: { settings: Settings }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const on = settings.ai.mcpRemote ?? false;
  const [err, setErr] = useState<string | null>(null);
  const toggle = useMutation({
    mutationFn: (mcpRemote: boolean) => api.patch('/api/settings', { ai: { mcpRemote } }),
    onMutate: () => setErr(null),
    onError: (e) => setErr(errText(e)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings'] });
      void qc.invalidateQueries({ queryKey: ['mcpRemote'] });
    },
  });
  return (
    <div className="mt-3 flex flex-col gap-2">
      <div className="text-sm font-semibold">{t('mcpr_title')}</div>
      <div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" role="switch" checked={on} disabled={toggle.isPending || (!on && !settings.trusted)} onChange={(e) => toggle.mutate(e.target.checked)} />
          {t('mcpr_setting')}
        </label>
        <p className="text-xs text-muted mt-1">{t('mcp_setting_help')}</p>
        <p className="text-xs text-muted mt-1">{t('mcpr_setting_help')}</p>
        {err && <p className="text-neg text-sm mt-1">{err}</p>}
      </div>
      {on && <McpRemoteBody trusted={settings.trusted} />}
    </div>
  );
}

/** Mounted only while the switch is on (and Settings is open): the address, the window and the grants. */
function McpRemoteBody({ trusted }: { trusted: boolean }) {
  const { t } = useI18n();
  const q = useQuery({
    queryKey: ['mcpRemote'],
    queryFn: () => api.get<McpRemotePayload>('/api/mcp/remote'),
    refetchInterval: (query) => remoteRefetchMs(query.state.data?.windowUntil, Date.now()),
  });
  if (q.isPending) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  return (
    <>
      {d.endpoint ? (
        <div className="flex flex-col gap-2 text-sm">
          <span className="text-muted">{t('mcpr_address')}</span>
          <CopyLine text={d.endpoint} />
          <ConnectWindow windowUntil={d.windowUntil} trusted={trusted} />
        </div>
      ) : (
        <p className="text-sm text-warn">{t('mcpr_no_endpoint')}</p>
      )}
      <span className="text-xs text-muted">{t('mcpr_off_note')}</span>
      <Grants grants={d.grants} />
    </>
  );
}

/** The 10-minute "Connect an app" window (§4.1): opened at home only, with a live countdown while it is open. */
function ConnectWindow({ windowUntil, trusted }: { windowUntil: string | null; trusted: boolean }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const left = windowLeftMs(windowUntil, now);
  const open = left > 0;
  // tick once a second while open; when it runs out, ask the worker again (it may have closed early, after an approval)
  const wasOpen = useRef(open);
  useEffect(() => {
    if (!windowUntil) return;
    setNow(Date.now());
    if (windowLeftMs(windowUntil, Date.now()) <= 0) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [windowUntil]);
  useEffect(() => {
    if (wasOpen.current && !open) void qc.invalidateQueries({ queryKey: ['mcpRemote'] });
    wasOpen.current = open;
  }, [open, qc]);
  const done = (data?: { windowUntil: string }) => {
    if (data) qc.setQueryData<McpRemotePayload>(['mcpRemote'], (p) => (p ? { ...p, windowUntil: data.windowUntil } : p));
    setNow(Date.now());
    void qc.invalidateQueries({ queryKey: ['mcpRemote'] });
  };
  const openWin = useMutation({
    mutationFn: () => api.post<{ windowUntil: string }>('/api/mcp/remote/window', {}),
    onMutate: () => setErr(null),
    onError: (e) => setErr(errText(e)),
    onSuccess: (data) => done(data),
  });
  const closeWin = useMutation({
    mutationFn: () => api.del<{ ok: true }>('/api/mcp/remote/window'),
    onMutate: () => setErr(null),
    onError: (e) => setErr(errText(e)),
    onSuccess: () => {
      qc.setQueryData<McpRemotePayload>(['mcpRemote'], (p) => (p ? { ...p, windowUntil: null } : p));
      done();
    },
  });
  return (
    <div className="flex flex-col gap-1">
      {open ? (
        <div className="flex items-center gap-2">
          <span className="flex-1 min-w-0 text-sm text-pos">{t('mcpr_window_open', { time: formatCountdown(left) })}</span>
          <button className="btn btn-sm shrink-0" disabled={closeWin.isPending} onClick={() => closeWin.mutate()}>
            {t('mcpr_close')}
          </button>
        </div>
      ) : (
        <div>
          <button className="btn btn-sm" disabled={!trusted || openWin.isPending} onClick={() => openWin.mutate()}>
            {t('mcpr_connect')}
          </button>
        </div>
      )}
      <span className="text-xs text-muted">
        {t('mcpr_connect_why')}
        {!trusted && !open && <> {t('mcpr_home_only')}</>}
      </span>
      {err && <span className="text-neg text-sm">{err}</span>}
    </div>
  );
}

/** The approved apps, with revoke (a 404 means it is already gone: refetch, no error). */
function Grants({ grants }: { grants: McpRemoteGrant[] }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const revoke = useMutation({
    mutationFn: (id: number) => api.del<{ ok: true }>(grantPath(id)),
    onMutate: () => setErr(null),
    onError: (e) => {
      if (!(e instanceof ApiError && e.status === 404)) setErr(errText(e));
    },
    onSettled: () => {
      setConfirming(null);
      void qc.invalidateQueries({ queryKey: ['mcpRemote'] });
    },
  });
  const sorted = sortGrants(grants);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm text-muted">{t('mcp_apps')}</span>
      {err && <div className="text-neg text-sm">{err}</div>}
      {sorted.length ? (
        <div className="flex flex-col divide-y divide-border text-sm">
          {sorted.map((g) => {
            const used = lastUsedLabel(g.lastUsedAt);
            return (
              <Row key={g.id}>
                <span className="flex-1 min-w-0">
                  <span dir="ltr">{g.app}</span>
                  <div className="text-xs text-muted">
                    {t('mcpr_connected')}: {relTime(g.createdAt, locale)} · {t('mcp_last_used')}: {used.kind === 'never' ? t('never') : relTime(used.iso, locale)} · {t('mcp_calls_today', { n: g.callsToday })} · {t('mcpr_access_until')}: {relTime(g.expiresAt, locale)}
                  </div>
                </span>
                {confirming === g.id ? (
                  <span className="flex items-center gap-2 shrink-0">
                    <span className="text-xs">{t('mcp_revoke_q', { name: g.app })}</span>
                    <button className="btn btn-sm" disabled={revoke.isPending} onClick={() => revoke.mutate(g.id)}>
                      {t('mcp_revoke_yes')}
                    </button>
                    <button className="btn btn-sm" disabled={revoke.isPending} onClick={() => setConfirming(null)}>
                      {t('mcp_revoke_cancel')}
                    </button>
                  </span>
                ) : (
                  <button className="btn btn-sm shrink-0" disabled={revoke.isPending} onClick={() => setConfirming(g.id)}>
                    {t('mcp_revoke')}
                  </button>
                )}
              </Row>
            );
          })}
        </div>
      ) : (
        <Empty>{t('mcpr_none')}</Empty>
      )}
    </div>
  );
}
