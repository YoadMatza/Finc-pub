import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, api } from '../api';
import { relTime } from '../format';
import { useI18n } from '../i18n';
import { lastUsedLabel, mcpCommands, sortTokens, tokenPath } from '../mcpSettings';
import type { McpTokensPayload, Settings } from '../types';
import { CopyLine } from './CopyLine';
import { Empty, ErrorBox, Row, Spinner } from './ui';

/**
 * Settings → AI → AI apps (MCP) (mcp-server.md §5.4, §6): the switch (off by default), the PC setup steps, and the
 * connected apps with revoke. Turning it on needs the PC at home (like the other AI switches); turning it off and
 * revoking only take access away, so they are offered from anywhere (the worker has the last word).
 */
export function McpSection({ settings }: { settings: Settings }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const on = settings.ai.mcp ?? false;
  const [err, setErr] = useState<string | null>(null);
  const fail = (e: unknown) => setErr(e instanceof ApiError ? e.message : String(e));
  const toggle = useMutation({
    mutationFn: (mcp: boolean) => api.patch('/api/settings', { ai: { mcp } }),
    onMutate: () => setErr(null),
    onError: fail,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings'] });
      void qc.invalidateQueries({ queryKey: ['mcpTokens'] });
    },
  });
  const cmd = mcpCommands();
  return (
    <div className="mt-3 flex flex-col gap-2">
      <div className="text-sm font-semibold">{t('mcp_title')}</div>
      <div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" role="switch" checked={on} disabled={toggle.isPending || (!on && !settings.trusted)} onChange={(e) => toggle.mutate(e.target.checked)} />
          {t('mcp_setting')}
        </label>
        <p className="text-xs text-muted mt-1">{t('mcp_setting_help')}</p>
        {err && <p className="text-neg text-sm mt-1">{err}</p>}
      </div>
      {on && (
        <>
          <div className="flex flex-col gap-2 text-sm">
            <span className="text-muted">{t('mcp_steps')}</span>
            <span>{t('mcp_step_create')}</span>
            <CopyLine text={cmd.create} />
            <span>{t('mcp_step_add')}</span>
            <CopyLine text={cmd.claudeCode} />
            <span className="text-xs text-muted">{t('mcp_step_other')}</span>
            <span className="text-xs text-muted">
              {t('mcp_pc_only')} {t('mcp_off_note')}
            </span>
          </div>
          <McpTokens />
        </>
      )}
    </div>
  );
}

/** The connected apps (tokens): fetched only while the switch is on and Settings is open (this is mounted only then). */
function McpTokens() {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['mcpTokens'], queryFn: () => api.get<McpTokensPayload>('/api/mcp/tokens'), refetchInterval: 30_000 });
  const [confirming, setConfirming] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const revoke = useMutation({
    mutationFn: (name: string) => api.del<{ ok: true }>(tokenPath(name)),
    onMutate: () => setErr(null),
    onError: (e) => {
      // 404: already gone (revoked on the PC meanwhile); the refreshed list says so
      if (!(e instanceof ApiError && e.status === 404)) setErr(e instanceof ApiError ? e.message : String(e));
    },
    onSettled: () => {
      setConfirming(null);
      void qc.invalidateQueries({ queryKey: ['mcpTokens'] });
    },
  });
  if (q.isPending) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const tokens = sortTokens(q.data.tokens);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm text-muted">{t('mcp_apps')}</span>
      {err && <div className="text-neg text-sm">{err}</div>}
      {tokens.length ? (
        <div className="flex flex-col divide-y divide-border text-sm">
          {tokens.map((tok) => {
            const used = lastUsedLabel(tok.lastUsedAt);
            return (
              <Row key={tok.name}>
                <span className="flex-1 min-w-0">
                  <span dir="auto">{tok.name}</span>
                  <div className="text-xs text-muted">
                    {t('mcp_created')}: {relTime(tok.createdAt, locale)} · {t('mcp_last_used')}: {used.kind === 'never' ? t('never') : relTime(used.iso, locale)} · {t('mcp_calls_today', { n: tok.callsToday })}
                  </div>
                </span>
                {confirming === tok.name ? (
                  <span className="flex items-center gap-2 shrink-0">
                    <span className="text-xs">{t('mcp_revoke_q', { name: tok.name })}</span>
                    <button className="btn btn-sm" disabled={revoke.isPending} onClick={() => revoke.mutate(tok.name)}>
                      {t('mcp_revoke_yes')}
                    </button>
                    <button className="btn btn-sm" disabled={revoke.isPending} onClick={() => setConfirming(null)}>
                      {t('mcp_revoke_cancel')}
                    </button>
                  </span>
                ) : (
                  <button className="btn btn-sm shrink-0" disabled={revoke.isPending} onClick={() => setConfirming(tok.name)}>
                    {t('mcp_revoke')}
                  </button>
                )}
              </Row>
            );
          })}
        </div>
      ) : (
        <Empty>{t('mcp_none')}</Empty>
      )}
    </div>
  );
}
