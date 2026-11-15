import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { ApiError, api } from '../api';
import { relTime } from '../format';
import { useI18n } from '../i18n';
import { isNative } from '../native';
import type { PasskeyEnrollCode, PasskeysPayload } from '../types';
import { Card, Empty, Row, Spinner } from './ui';

/** The enroll link the phone camera opens: the worker may answer with the full link or only the public base. */
function enrollLink(r: PasskeyEnrollCode): string {
  if (/\/passkey\?/.test(r.url)) return r.url;
  return `${r.url.replace(/\/+$/, '')}/passkey?code=${encodeURIComponent(r.code)}`;
}

/** Settings → Passkeys: the list with remove, and (at home, in the browser) a QR that adds one on the phone. */
export function PasskeysCard({ trusted }: { trusted: boolean }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['passkeys'], queryFn: () => api.get<PasskeysPayload>('/api/passkeys'), refetchInterval: 15_000 });
  const [msg, setMsg] = useState<string | null>(null);
  const [enroll, setEnroll] = useState<{ link: string; minutes: number } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const fail = (e: unknown) => setMsg(e instanceof ApiError ? e.message : String(e));

  const newCode = useMutation({
    mutationFn: () => api.post<PasskeyEnrollCode>('/api/auth/passkey/enroll-code', {}),
    onSuccess: (r) => {
      setMsg(null);
      setEnroll({ link: enrollLink(r), minutes: r.expiresInMin });
    },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: number | string) => api.del(`/api/passkeys/${encodeURIComponent(String(id))}`),
    onSuccess: () => {
      setMsg(null);
      void qc.invalidateQueries({ queryKey: ['passkeys'] });
      void qc.invalidateQueries({ queryKey: ['auth'] });
    },
    onError: fail,
  });

  useEffect(() => {
    if (!enroll) return setQr(null);
    void QRCode.toDataURL(enroll.link, { margin: 1, width: 260, color: { dark: '#0f1115', light: '#ffffff' } }).then(setQr);
    // the code dies after its lifetime; drop the QR then (the list refreshes on its own interval)
    const id = setTimeout(() => setEnroll(null), enroll.minutes * 60_000);
    return () => clearTimeout(id);
  }, [enroll]);

  if (q.isPending) return <Spinner />;
  if (q.error || !q.data) return null;
  const d = q.data;
  const list = d.passkeys.filter((p) => !p.revokedAt);
  const noPublicUrl = !d.rpId;

  return (
    <Card title={t('pk_title')}>
      <div className="flex flex-col gap-4">
        <p className="text-xs text-muted">{t('pk_help')}</p>
        {noPublicUrl && <p className="text-sm text-warn">{t('pk_no_public_url')}</p>}
        {!isNative && !noPublicUrl && (
          <div className="flex flex-col gap-2">
            {trusted ? (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <button className="btn btn-sm btn-primary" disabled={newCode.isPending} onClick={() => newCode.mutate()}>
                    {enroll ? t('new_code') : t('pk_add')}
                  </button>
                  <span className="text-xs text-muted">{t('pk_add_help')}</span>
                </div>
                {enroll && (
                  <div className="flex flex-col sm:flex-row gap-4 items-center card p-3">
                    {qr && <img src={qr} alt="QR" className="rounded-lg bg-white p-1 w-[200px] h-[200px]" />}
                    <div className="flex flex-col gap-1 text-sm min-w-0">
                      <span className="num break-all select-all" dir="ltr">
                        {enroll.link}
                      </span>
                      <span className="text-xs text-muted mt-1">{t('pk_code_expires', { n: enroll.minutes })}</span>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <span className="text-xs text-muted">{t('pk_add_home_only')}</span>
            )}
          </div>
        )}
        {msg && <div className="text-neg text-sm">{msg}</div>}
        {list.length ? (
          <div className="flex flex-col divide-y divide-border text-sm">
            {list.map((p) => (
              <Row key={p.id}>
                <span className="flex-1 min-w-0">
                  <span dir="auto">{p.name}</span>
                  {p.backedUp && <span className="chip ms-2 text-[10px]">{t('pk_synced')}</span>}
                  <div className="text-xs text-muted truncate">
                    {t('pk_created')}: {relTime(p.createdAt, locale)} · {t('pk_last_used')}: {p.lastUsedAt ? relTime(p.lastUsedAt, locale) : t('never')}
                  </div>
                </span>
                <button className="btn btn-sm" disabled={remove.isPending} onClick={() => window.confirm(t('pk_remove_confirm', { name: p.name })) && remove.mutate(p.id)}>
                  {t('pk_remove')}
                </button>
              </Row>
            ))}
          </div>
        ) : (
          <Empty>{t('pk_none')}</Empty>
        )}
      </div>
    </Card>
  );
}
