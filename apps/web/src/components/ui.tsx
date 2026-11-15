import type { ReactNode } from 'react';
import { useI18n } from '../i18n';
import { money } from '../format';

export function Card({ title, children, className = '', action }: { title?: ReactNode; children: ReactNode; className?: string; action?: ReactNode }) {
  return (
    <section className={`card p-4 ${className}`}>
      {(title || action) && (
        <header className="mb-3 flex items-center justify-between gap-2">
          {title && <h2 className="text-sm font-semibold text-muted tracking-wide">{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

/** Money with meaning: negative = out (plain), positive = in (green) unless `tone` says otherwise. */
export function Amount({ value, tone = 'auto', currency, sign = 'never', className = '', decimals }: { value: number; tone?: 'auto' | 'neutral' | 'pos' | 'neg' | 'muted'; currency?: string | undefined; sign?: 'auto' | 'never' | 'always'; className?: string; decimals?: 0 | 2 }) {
  const t = tone === 'auto' ? (value > 0 ? 'pos' : 'neutral') : tone;
  const color = t === 'pos' ? 'text-pos' : t === 'neg' ? 'text-neg' : t === 'muted' ? 'text-muted' : '';
  return <span className={`num ${color} ${className}`}>{money(value, { sign, ...(currency ? { currency } : {}), ...(decimals !== undefined ? { decimals } : {}) })}</span>;
}

export function Chip({ children, on = false, onClick, tone }: { children: ReactNode; on?: boolean; onClick?: () => void; tone?: 'warn' | 'neg' | 'pos' | 'pending' }) {
  const toneCls = tone === 'warn' ? 'text-warn border-warn/40' : tone === 'neg' ? 'text-neg border-neg/40' : tone === 'pos' ? 'text-pos border-pos/40' : tone === 'pending' ? 'text-pending' : '';
  return (
    <span className={`chip ${on ? 'chip-on' : ''} ${toneCls} ${onClick ? 'cursor-pointer hover:border-muted' : ''}`} onClick={onClick}>
      {children}
    </span>
  );
}

export function Bar({ value, max, tone = 'accent', color, className = '' }: { value: number; max: number; tone?: 'accent' | 'pos' | 'neg' | 'warn' | 'muted'; color?: string; className?: string }) {
  const p = max ? Math.min(100, Math.round((Math.abs(value) / Math.abs(max)) * 100)) : 0;
  const bg = tone === 'pos' ? 'bg-pos' : tone === 'neg' ? 'bg-neg' : tone === 'warn' ? 'bg-warn' : tone === 'muted' ? 'bg-muted' : 'bg-accent';
  return (
    <div className={`bar ${className}`}>
      <div className={color ? '' : bg} style={{ width: `${p}%`, ...(color ? { background: color } : {}) }} />
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-2 text-muted p-6 justify-center">
      <span className="inline-block h-4 w-4 rounded-full border-2 border-muted border-t-accent animate-spin" />
      <span>{label ?? t('loading')}</span>
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useI18n();
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="card p-4 border-neg/40 text-neg flex items-center justify-between gap-3">
      <span>
        {t('error')}: {msg}
      </span>
      {onRetry && (
        <button className="btn btn-sm" onClick={onRetry}>
          {t('retry')}
        </button>
      )}
    </div>
  );
}

/** Side sheet on desktop, bottom sheet on the phone. */
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex md:items-stretch items-end md:justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div className="relative w-full md:w-[480px] max-h-[92vh] md:max-h-none md:h-full overflow-y-auto bg-surface border-t md:border-t-0 md:border-s border-border rounded-t-2xl md:rounded-none p-4" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-base">{title}</h2>
          <button className="btn btn-sm" onClick={onClose} aria-label="close">
            ✕
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: Array<{ key: T; label: ReactNode; count?: number }> }) {
  return (
    <div className="flex gap-1 overflow-x-auto pb-1">
      {items.map((it) => (
        <button key={it.key} className={`btn btn-sm ${value === it.key ? 'btn-primary' : ''}`} onClick={() => onChange(it.key)}>
          {it.label}
          {it.count !== undefined && it.count > 0 && <span className="num opacity-80">{it.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="text-muted text-sm p-4 text-center">{children}</div>;
}

export function Row({ children, onClick, className = '' }: { children: ReactNode; onClick?: () => void; className?: string }) {
  return (
    <div className={`flex items-center gap-3 px-2 py-2 -mx-2 rounded-lg ${onClick ? 'row-link' : ''} ${className}`} onClick={onClick}>
      {children}
    </div>
  );
}

/** A tiny pulse-free dot with a short label, for values priced live ("● Live · 14:32"). */
export function LiveTag({ text, kind = 'live', className = '' }: { text: string; kind?: 'live' | 'stale' | 'closed' | 'bank'; className?: string }) {
  const dot = kind === 'live' ? 'bg-pos' : kind === 'bank' ? 'bg-warn' : 'bg-muted';
  return (
    <span className={`inline-flex items-center gap-1 text-xs text-muted ${className}`}>
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${dot}`} aria-hidden />
      <span>{text}</span>
    </span>
  );
}
