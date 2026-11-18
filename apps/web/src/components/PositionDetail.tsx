import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { api } from '../api';
import { dayLabel, foreignMoney, money } from '../format';
import { type Key, useI18n } from '../i18n';
import { isolateLtr } from '../insightsCompany';
import { gainTone, pctText, stamp, toneClass } from '../live';
import type { PositionMissing, PositionPayload, PositionReady } from '../types';

const STALE_MS = 5 * 60 * 1000;

/**
 * Position view, step 3 (research_notes/proposals/position-view.md): the owner's own result on this holding, from the
 * bank's purchase list: the result and its yearly rate, the same money in the S&P 500, the dollar's part, a sale
 * today, what-if and the weight in net worth, then the purchases behind a toggle. Facts only, never "you should".
 */
export function PositionDetail({ id }: { id: number }) {
  const { t } = useI18n();
  const q = useQuery({
    queryKey: ['position', id],
    queryFn: () => api.get<PositionPayload>(`/api/holdings/${id}/position`),
    staleTime: STALE_MS,
    refetchOnWindowFocus: false,
    retry: 1,
  });
  if (q.isPending) return <div className="rounded bg-surface-2 animate-pulse h-24 w-full" aria-busy="true" />;
  if (q.isError) return <p className="text-xs text-muted">{t('pos_error')}</p>;
  const d = q.data;
  if (!d.available) return <p className="text-xs text-muted">{t(`pos_unavailable_${d.code}` as Key)}</p>;
  return <Ready d={d} />;
}

const ils = (v: number, sign: 'never' | 'always' = 'never') => money(v, { sign, decimals: 0 });
const missingText = (t: (k: Key) => string, m: PositionMissing | null) => (m ? t(`pos_missing_${m}` as Key) : '–');

function Block({ title, help, children }: { title: string; help?: string; children: ReactNode }) {
  return (
    <div className="card p-3 flex flex-col gap-1.5 text-xs">
      <h4 className="font-semibold text-sm">{title}</h4>
      {help && <p className="text-muted leading-relaxed">{help}</p>}
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted">{label}</span>
      <span className="num text-end" dir="ltr">
        {children}
      </span>
    </div>
  );
}

function Ready({ d }: { d: PositionReady }) {
  const { t, locale } = useI18n();
  const r = d.result;
  const foreign = d.currency !== 'ILS';
  const b = d.benchmark;
  const s = d.ifSold;
  const ty = d.taxYear;
  const tyGains = ty ? ty.gains.reduce((a, g) => a + g.amountIls, 0) : 0;
  return (
    <section className="flex flex-col gap-2">
      <header className="flex flex-col gap-0.5">
        <h3 className="font-semibold">{t('pos_title')}</h3>
        <p className="text-xs text-muted leading-relaxed">{t('pos_help')}</p>
      </header>

      <Block title={t('pos_result')}>
        <div className="flex items-baseline justify-between gap-3">
          <span className={`num text-lg font-bold ${toneClass(gainTone(r.gainIls))}`} dir="ltr">
            {ils(r.gainIls, 'always')}
          </span>
          <span className={`num font-semibold ${toneClass(gainTone(r.gainPct))}`} dir="ltr">
            {pctText(r.gainPct)}
          </span>
        </div>
        <Row label={t('pos_cost')}>{ils(r.costIls)}</Row>
        <Row label={t('pos_value')}>{ils(r.valueIls)}</Row>
        {foreign && (
          <Row label={t('pos_in_currency', { cur: d.currency })}>
            <span className={toneClass(gainTone(r.gainOrig))}>
              {foreignMoney(r.gainOrig, d.currency, { sign: 'always' })} {pctText(r.gainOrigPct)}
            </span>
          </Row>
        )}
        <Row label={t('pos_per_year')}>
          {d.perYear.pct !== null ? <span className={toneClass(gainTone(d.perYear.pct))}>{pctText(d.perYear.pct)}</span> : <span className="text-muted" dir="auto">{missingText(t, d.perYear.missing)}</span>}
        </Row>
      </Block>

      <Block title={t('pos_market')} help={t('pos_market_help')}>
        {b ? (
          <>
            <Row label={t('pos_market_value')}>
              {ils(b.valueIls)} <span className={toneClass(gainTone(b.gainPct))}>{pctText(b.gainPct)}</span>
            </Row>
            <p className={`font-semibold ${toneClass(gainTone(b.diffIls))}`}>
              {b.diffIls === 0
                ? t('pos_market_even')
                : t(b.diffIls > 0 ? 'pos_market_ahead' : 'pos_market_behind', { v: isolateLtr(ils(Math.abs(b.diffIls))), p: b.diffPts !== null ? Math.abs(b.diffPts).toFixed(1) : '–' })}
            </p>
          </>
        ) : (
          <p className="text-muted">{missingText(t, d.benchmarkMissing)}</p>
        )}
      </Block>

      {d.dollarPart && (
        <Block title={t('pos_dollar')} help={t('pos_dollar_help')}>
          <Row label={t('pos_dollar_stock')}>
            <span className={toneClass(gainTone(d.dollarPart.stockIls))}>{ils(d.dollarPart.stockIls, 'always')}</span>
          </Row>
          <Row label={t('pos_dollar_fx')}>
            <span className={toneClass(gainTone(d.dollarPart.fxIls))}>{ils(d.dollarPart.fxIls, 'always')}</span>
          </Row>
          <p className="text-muted">{t('pos_dollar_rate', { a: isolateLtr(d.dollarPart.rateAtBuy.toFixed(3)), b: isolateLtr(d.dollarPart.rateNow.toFixed(3)) })}</p>
        </Block>
      )}

      <Block title={t('pos_sold')}>
        <Row label={t('pos_value')}>{ils(s.valueIls)}</Row>
        {s.feeRate > 0 && <Row label={t('pos_sold_fee', { p: `${(s.feeRate * 100).toFixed(2)}%` })}>−{ils(s.feeIls)}</Row>}
        <Row label={t('pos_sold_tax', { p: `${Math.round(s.taxRate * 100)}%` })}>{s.taxIls > 0 ? `−${ils(s.taxIls)}` : ils(0)}</Row>
        <Row label={t('pos_sold_proceeds')}>
          <span className="font-semibold">{ils(s.proceedsIls)}</span>
        </Row>
        {s.realisedLossIls !== null && <p className="text-neg">{t('pos_sold_loss', { v: isolateLtr(ils(Math.abs(s.realisedLossIls))) })}</p>}
        <p className="text-muted leading-relaxed">{t('pos_sold_note')}</p>
        {ty && (
          <p className="text-muted">
            {t('pos_tax_year', { y: String(ty.year), l: isolateLtr(ils(Math.abs(ty.lossesIls))), g: isolateLtr(ils(tyGains)) })}
          </p>
        )}
      </Block>

      <Block title={t('pos_whatif')} help={t('pos_whatif_help')}>
        <table className="w-full">
          <thead>
            <tr className="text-muted">
              <th className="text-start font-normal">{t('pos_whatif_move')}</th>
              <th className="text-end font-normal">{t('pos_value')}</th>
              <th className="text-end font-normal">{t('pos_whatif_gain')}</th>
            </tr>
          </thead>
          <tbody>
            {d.whatIf.moves.map((m) => (
              <tr key={m.movePct}>
                <td className="text-start">
                  <span className="num">{pctText(m.movePct, 0)}</span>
                </td>
                <td className="text-end">
                  <span className="num">{ils(m.valueIls)}</span>
                </td>
                <td className={`text-end ${toneClass(gainTone(m.gainIls))}`}>
                  <span className="num">{ils(m.gainIls, 'always')}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {d.whatIf.breakEvenPrice > 0 && (
          <p className="text-muted">
            {t('pos_breakeven', { p: isolateLtr(foreignMoney(d.whatIf.breakEvenPrice, d.currency)), m: isolateLtr(pctText(d.whatIf.breakEvenMovePct)) })}
          </p>
        )}
      </Block>

      {d.weight.ofNetWorthPct !== null && <p className="text-xs text-muted">{t('pos_weight', { p: isolateLtr(`${d.weight.ofNetWorthPct.toFixed(1)}%`) })}</p>}

      <details className="text-xs">
        <summary className="cursor-pointer text-muted">{t('pos_lots', { n: String(d.lots.length) })}</summary>
        <ul className="mt-1 card px-3 py-1 divide-y divide-border">
          {d.lots.map((l, i) => (
            <li key={`${l.tradeDate}-${i}`} className="py-1.5 flex items-baseline justify-between gap-3">
              <span className="flex flex-col">
                <span>{dayLabel(l.tradeDate, locale, { year: true })}</span>
                <span className="text-muted" dir="auto">
                  {l.actionText}
                </span>
              </span>
              <span className="flex flex-col text-end num" dir="ltr">
                <span>
                  {l.quantity.toLocaleString('en-US', { maximumFractionDigits: 4 })} × {foreignMoney(l.costPrice, l.currency)}
                </span>
                <span className="text-muted">{ils(l.costIls)}</span>
              </span>
            </li>
          ))}
        </ul>
      </details>

      <p className="text-[11px] text-muted">
        {t('pos_source', {
          d: d.lotsAt ? stamp(d.lotsAt) : '–',
          s: t(d.priceSource === 'live' ? 'pos_source_live' : 'pos_source_bank'),
          t: d.asOf ? stamp(d.asOf) : '–',
        })}
      </p>
      <p className="text-[11px] text-muted font-semibold">{t('pos_disclaimer')}</p>
    </section>
  );
}
