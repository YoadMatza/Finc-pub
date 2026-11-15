import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { bidiRuns, isHebrewText } from '../bidi';
import { Card, Chip, Spinner } from '../components/ui';
import { type Key, useI18n } from '../i18n';
import { errorText } from '../limits';
import type { ChatResult, ChatStatus } from '../types';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  steps?: ChatResult['steps'];
  /** chat v2 step 4: questions offered as chips under the last answer */
  followUps?: string[];
  error?: boolean;
}

/**
 * Text of a bubble or a chip: in Hebrew text, each left-to-right run (amounts, dates, Latin names) is isolated with
 * <bdi dir="ltr"> so the RTL layout does not reorder it; the characters themselves are unchanged (bidi.ts).
 */
function BidiText({ text }: { text: string }) {
  if (!isHebrewText(text)) return <>{text}</>;
  return (
    <>
      {bidiRuns(text).map((r, i) =>
        r.ltr ? (
          <bdi key={i} dir="ltr">
            {r.text}
          </bdi>
        ) : (
          r.text
        ),
      )}
    </>
  );
}

/**
 * One id per conversation, so the worker can keep the conversation's earlier lookups (chat v2). randomUUID needs a
 * secure context; on plain http (the home network) getRandomValues still works.
 */
function newChatId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * "Ask my money" (design §8): a conversation with the model over fixed local aggregations. Every
 * answer shows what was looked up, so the number can be checked against the other screens.
 */
export function Chat() {
  const { t, locale } = useI18n();
  const status = useQuery({ queryKey: ['chat-status'], queryFn: () => api.get<ChatStatus>('/api/chat/status'), refetchInterval: 30_000 });
  const [turns, setTurns] = useState<Turn[]>([]);
  const [chatId, setChatId] = useState(newChatId);
  const [text, setText] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const ask = useMutation({
    mutationFn: (messages: Array<{ role: 'user' | 'assistant'; content: string }>) => api.post<ChatResult>('/api/chat', { messages, chatId }),
    onSuccess: (r) => setTurns((ts) => [...ts, { role: 'assistant', content: r.answer || '…', steps: r.steps, followUps: r.followUps ?? [] }]),
    // P2-02: a 429 says when the next question is allowed
    onError: (e) => setTurns((ts) => [...ts, { role: 'assistant', content: errorText(e, 'chat', t, locale), error: true }]),
  });
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns.length, ask.isPending]);
  const send = (q: string) => {
    const content = q.trim();
    if (!content || ask.isPending) return;
    const next: Turn[] = [...turns, { role: 'user', content }];
    setTurns(next);
    setText('');
    ask.mutate(next.filter((x) => !x.error).map((x) => ({ role: x.role, content: x.content })));
  };
  if (status.isPending) return <Spinner />;
  const s = status.data;
  const last = turns[turns.length - 1];
  return (
    <div className="flex flex-col gap-3 max-w-3xl">
      <header className="flex items-center justify-between gap-2 flex-wrap">
        <h1 className="text-lg font-semibold">{t('chat_title')}</h1>
        <div className="flex items-center gap-2 text-xs text-muted">
          {s?.ready && s.model && <span dir="ltr">{s.model}</span>}
          {turns.length > 0 && (
            <button
              className="btn btn-sm"
              onClick={() => {
                // a new conversation: a new id, and the old one's lookups are dropped on the worker
                api.del(`/api/chat/${chatId}`).catch(() => {});
                setChatId(newChatId());
                setTurns([]);
              }}
            >
              {t('chat_clear')}
            </button>
          )}
        </div>
      </header>
      <p className="text-xs text-muted">{t('chat_help')}</p>

      {s && !s.ready && (
        <Card title={t('chat_not_ready')}>
          <ul className="text-sm list-disc ps-5 flex flex-col gap-1">
            {!s.provider && (
              <li>
                <Link to="/settings" className="underline">
                  {t('chat_setup_provider')}
                </Link>
              </li>
            )}
            {s.provider && s.provider !== 'local' && s.vaultLocked && (
              <li>
                {t('chat_setup_unlock')} <Cmd>.\finc unlock</Cmd>
              </li>
            )}
            {s.provider && s.provider !== 'local' && !s.vaultLocked && !s.keyInVault && (
              <li>
                {t('chat_setup_key')} <Cmd>{`.\finc vault set ai_${s.provider}`}</Cmd>
              </li>
            )}
            {s.provider === 'local' && <li className="num">{t('chat_setup_local')}</li>}
          </ul>
        </Card>
      )}

      {turns.length === 0 && s?.ready && (
        <div className="flex flex-wrap gap-2">
          {([1, 2, 3, 4] as const).map((n) => (
            <Chip key={n} onClick={() => send(t(`chat_example_${n}` as Key))}>
              {t(`chat_example_${n}` as Key)}
            </Chip>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-3">
        {turns.map((x, i) => (
          <div key={i} className={`flex ${x.role === 'user' ? 'justify-start' : 'justify-end'}`}>
            <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap ${x.role === 'user' ? 'bg-accent-dim text-text' : x.error ? 'card text-neg' : 'card'}`} dir="auto">
              <BidiText text={x.content} />
              {x.steps && x.steps.length > 0 && (
                <details className="mt-2 text-xs text-muted">
                  <summary className="cursor-pointer">{t('chat_looked_at')}</summary>
                  <ul className="mt-1 flex flex-col gap-0.5 num" dir="ltr">
                    {x.steps.map((st, j) => (
                      <li key={j}>{st.summary}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          </div>
        ))}
        {/* follow-up chips: under the last assistant turn only, hidden while a question is pending */}
        {!ask.isPending && s?.ready && last?.role === 'assistant' && last.followUps && last.followUps.length > 0 && (
          <div className="flex flex-wrap gap-2 justify-end">
            {last.followUps.map((f) => (
              <Chip key={f} onClick={() => send(f)}>
                <span dir="auto">
                  <BidiText text={f} />
                </span>
              </Chip>
            ))}
          </div>
        )}
        {ask.isPending && <div className="text-xs text-muted">{t('chat_thinking')}</div>}
        <div ref={endRef} className="h-2" />
      </div>

      <form
        className="flex gap-2 sticky bottom-20 md:bottom-2 bg-bg/95 backdrop-blur py-2 -mx-1 px-1"
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        <input className="input flex-1" value={text} onChange={(e) => setText(e.target.value)} placeholder={t('chat_placeholder')} disabled={!s?.ready || ask.isPending} maxLength={1000} />
        <button className="btn btn-primary" disabled={!s?.ready || ask.isPending || !text.trim()}>
          {t('chat_send')}
        </button>
      </form>
    </div>
  );
}

/** A shell command inside a sentence: left-to-right, monospace, selectable as one piece. */
function Cmd({ children }: { children: string }) {
  return (
    <code dir="ltr" className="num bg-surface-2 border border-border rounded px-1.5 py-0.5 select-all">
      {children}
    </code>
  );
}
