import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useEffect } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router';
import { api } from '../api';
import { useI18n } from '../i18n';
import { takeLaunchPath } from '../native';
import type { Health, ReviewInbox } from '../types';

/** Minimal line icons (24×24 strokes) so the navigation reads as an app, not a chat. */
const ICONS = {
  hub: 'M3 11.5 12 4l9 7.5M5 10v10h14V10M10 20v-6h4v6',
  transactions: 'M4 7h16M4 12h16M4 17h10',
  recurring: 'M4 12a8 8 0 0 1 13.7-5.7L20 8M20 4v4h-4M20 12a8 8 0 0 1-13.7 5.7L4 16M4 20v-4h4',
  categories: 'M4 20V10M10 20V4M16 20v-8M22 20H2',
  trends: 'M3 17l6-6 4 4 8-8M15 7h6v6',
  events: 'M20 12V7a2 2 0 0 0-2-2h-3.2a2 2 0 0 1-1.4-.6l-.8-.8A2 2 0 0 0 11.2 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7M16 16h6M19 13v6',
  chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12zM8 12h.01M12 12h.01M16 12h.01',
  alerts: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0',
  accounts: 'M3 10l9-6 9 6M4 10v10h16V10M9 14v6M15 14v6',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
} as const;

export function Icon({ name, className = 'h-5 w-5' }: { name: keyof typeof ICONS; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

const items = [
  { to: '/', key: 'nav_hub', icon: 'hub' },
  { to: '/transactions', key: 'nav_transactions', icon: 'transactions' },
  { to: '/recurring', key: 'nav_recurring', icon: 'recurring' },
  { to: '/categories', key: 'nav_categories', icon: 'categories' },
  { to: '/trends', key: 'nav_trends', icon: 'trends' },
  { to: '/events', key: 'nav_events', icon: 'events', mobile: false },
  { to: '/chat', key: 'nav_chat', icon: 'chat', mobile: false },
  { to: '/alerts', key: 'alerts_page_nav', icon: 'alerts', mobile: false },
  { to: '/accounts', key: 'nav_accounts', icon: 'accounts' },
  { to: '/settings', key: 'nav_settings', icon: 'settings' },
] as const;

export function Shell({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const review = useQuery({ queryKey: ['review'], queryFn: () => api.get<ReviewInbox>('/api/review'), staleTime: 60_000 });
  const health = useQuery({ queryKey: ['health'], queryFn: () => api.get<Health>('/api/health'), refetchInterval: 30_000 });
  const pending = review.data ? review.data.counts.suggestedLinks + review.data.counts.uncategorised + review.data.counts.candidates + review.data.counts.overdue : 0;
  const bad = health.data?.connections.some((c) => c.enabled && c.lastError && (!c.lastOkAt || (c.lastErrorAt ?? '') > c.lastOkAt));
  const location = useLocation();
  const navigate = useNavigate();
  // push alerts (push-alerts.md): a tapped notification opens its page (the alerts list, or a bank's code field)
  useEffect(() => {
    const check = () => void takeLaunchPath().then((p) => p && navigate(p));
    check();
    const onShow = () => document.visibilityState === 'visible' && check();
    document.addEventListener('visibilitychange', onShow);
    return () => document.removeEventListener('visibilitychange', onShow);
  }, [navigate]);
  return (
    <div className="min-h-full md:flex">
      {/* phone: the chat is one tap away from every screen; the bottom bar is full */}
      {location.pathname !== '/chat' && (
        <NavLink to="/chat" className="md:hidden fixed z-30 end-4 bottom-[5.25rem] btn btn-primary rounded-full shadow-lg px-4 h-11 flex items-center gap-2" aria-label={t('nav_chat')}>
          <Icon name="chat" className="h-5 w-5" />
          <span className="text-sm">{t('chat_fab')}</span>
        </NavLink>
      )}
      <aside className="hidden md:flex md:flex-col w-56 shrink-0 border-e border-border p-4 gap-1 sticky top-0 h-screen">
        <div className="flex items-center gap-2 px-2 mb-4">
          <img src="/icon.svg" alt="" className="h-7 w-7 rounded-lg" />
          <span className="font-bold text-lg tracking-tight">finc</span>
          {bad && <span className="chip text-warn border-warn/40 ms-auto">!</span>}
        </div>
        {items.map((it) => (
          <NavLink key={it.to} to={it.to} end={it.to === '/'} className={({ isActive }) => `flex items-center gap-3 px-3 py-2 rounded-lg ${isActive ? 'bg-surface-2 text-text' : 'text-muted hover:text-text'}`}>
            <Icon name={it.icon} />
            <span>{t(it.key)}</span>
            {it.to === '/transactions' && pending > 0 && <span className="chip chip-on ms-auto num">{pending}</span>}
          </NavLink>
        ))}
        <div className="mt-auto text-xs text-muted px-2">
          {health.data?.vault === 'locked' && <div className="text-warn">{t('vault_locked')}</div>}
          {health.data?.syncRunning && <div className="text-accent">{t('sync_running')}</div>}
          <div>v{health.data?.version ?? ''}</div>
        </div>
      </aside>
      <main className="flex-1 min-w-0 p-4 pb-24 md:pb-6 max-w-6xl mx-auto w-full">{children}</main>
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-30 bg-surface/95 backdrop-blur border-t border-border flex justify-around px-1 pt-1.5 pb-[max(0.4rem,env(safe-area-inset-bottom))]">
        {items.filter((it) => !('mobile' in it) || it.mobile !== false).map((it) => (
          <NavLink key={it.to} to={it.to} end={it.to === '/'} className={({ isActive }) => `relative flex flex-col items-center gap-0.5 px-1 py-1 rounded-lg text-[10px] min-w-0 ${isActive ? 'text-accent' : 'text-muted'}`}>
            <Icon name={it.icon} className="h-5 w-5" />
            <span>{t(it.key)}</span>
            {it.to === '/transactions' && pending > 0 && <span className="absolute -top-1 end-0 chip chip-on num text-[10px] px-1 leading-none">{pending}</span>}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
