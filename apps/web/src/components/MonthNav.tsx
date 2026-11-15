import { useSearchParams } from 'react-router';
import { addMonths, monthLabel } from '../format';
import { useI18n } from '../i18n';

export function useMonth(fallback: string): [string, (m: string) => void] {
  const [sp, setSp] = useSearchParams();
  const month = sp.get('month') ?? fallback;
  return [
    month,
    (m) => {
      const n = new URLSearchParams(sp);
      n.set('month', m);
      setSp(n, { replace: true });
    },
  ];
}

export function MonthNav({ month, onChange, min, max }: { month: string; onChange: (m: string) => void; min?: string; max?: string }) {
  const { locale, lang } = useI18n();
  const prev = addMonths(month, -1);
  const next = addMonths(month, 1);
  const back = lang === 'he' ? '›' : '‹';
  const fwd = lang === 'he' ? '‹' : '›';
  return (
    <div className="flex items-center gap-2">
      <button className="btn btn-sm" disabled={min !== undefined && prev < min} onClick={() => onChange(prev)} aria-label="previous month">
        {back}
      </button>
      <span className="font-semibold min-w-[9rem] text-center">{monthLabel(month, locale)}</span>
      <button className="btn btn-sm" disabled={max !== undefined && next > max} onClick={() => onChange(next)} aria-label="next month">
        {fwd}
      </button>
    </div>
  );
}
