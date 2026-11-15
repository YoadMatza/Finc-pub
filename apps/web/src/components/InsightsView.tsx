import { useQuery } from '@tanstack/react-query';
import { Fragment, useMemo, useState, type PointerEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { dayLabel, foreignMoney } from '../format';
import { useI18n } from '../i18n';
import { isNative, openExternalNative } from '../native';
import { INSIGHTS_STALE_MS, RETURN_KEYS, absPct, axisNum, betaReading, buildChart, crossCheckNote, diffTone, drawdownView, insightsReady, lastYear, nearestIndex, ptsText, trendReadings, unavailableReason, type ChartBox } from '../insights';
import { gainTone, pctText, stamp, toneClass } from '../live';
import { groupResults, jerusalemDay, lastKnownText, noneApplyText, nowText, restSummary, ruleSentence, sinceDay, sourceText } from '../holdingRules';
import { RATING_LABEL, analystsParts, changeText, monthYear, ratingColor, sharePct } from '../insightsAnalysts';
import type { HoldingInsights, HoldingRuleResult, HoldingView, InsightCompanyNote, InsightFigure, InsightFiling, InsightPoint, LiveHoldingRow } from '../types';
import { FILINGS_VISIBLE, TREND_ARROW, basisCaption, companyUnavailableReason, compactNumber, figureCurrency, filingText, isolateLtr, latestSecDate, marginTrend, noteText, openSecLink, periodLabel, placeNotes, ratioText, secLink, type MarginTrend } from '../insightsCompany';
import { Amount, Bar, ErrorBox } from './ui';

/** a payload that passed insightsReady: no `unavailable`, asOf set */
type Ready = HoldingInsights & { asOf: string };

const SMA50_COLOR = '#a78bfa';
const SMA200_COLOR = '#f472b6';

/**
 * Insights for one security (stock insights step 1, design §3 A–D, I): your position, price and trend,
 * returns against SPY, risk, dividends and splits, and the sources. Read-only; fetched once when opened
 * and kept for 30 minutes (no background refetch). Every reading is a neutral description, never advice.
 */
export function InsightsView({ p, r, share, onBack }: { p: HoldingView; r: LiveHoldingRow | undefined; share: number; onBack: () => void }) {
  const { t } = useI18n();
  const id = p.id;
  const q = useQuery({
    queryKey: ['insights', id],
    queryFn: () => api.get<HoldingInsights>(`/api/holdings/${id}/insights`),
    enabled: id !== undefined,
    staleTime: INSIGHTS_STALE_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: false,
    retry: 1,
  });
  const d = q.data;
  const ready = insightsReady(d) ? d : undefined;
  return (
    <div className="flex flex-col gap-5 text-sm">
      <button className="btn btn-sm self-start" onClick={onBack}>
        <span aria-hidden className="rtl:rotate-180 inline-block">
          ←
        </span>
        {t('ins_back')}
      </button>
      <PositionSection p={p} r={r} share={share} />
      {d?.rules && <RulesSection rules={d.rules} symbol={p.symbol} />}
      {q.isPending ? (
        <Skeleton />
      ) : q.isError ? (
        <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
      ) : ready ? (
        <>
          <CrossCheck d={ready} />
          <TrendSection d={ready} />
          <MarketSection d={ready} />
          <RiskSection d={ready} />
          <CompanySection d={ready} />
          <AnalystsSection d={ready} />
          <FilingsSection d={ready} />
          <EventsSection d={ready} />
        </>
      ) : (
        <>
          <div className="card p-4 border-warn/40 flex flex-col gap-1">
            <span className="font-semibold text-warn">{t('ins_unavailable')}</span>
            {unavailableReason(t, d) && (
              <span className="text-muted" dir="auto">
                {unavailableReason(t, d)}
              </span>
            )}
          </div>
          {/* the SEC and Finnhub parts do not depend on the price data: shown whenever the hub sent them */}
          {d && (
            <>
              <CompanySection d={d} />
              <AnalystsSection d={d} />
              <FilingsSection d={d} />
            </>
          )}
        </>
      )}
      <Footer d={ready} sec={d} />
    </div>
  );
}

function Section({ title, help, children }: { title: string; help?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <header className="flex flex-col gap-0.5">
        <h3 className="font-semibold">{title}</h3>
        {help && <p className="text-xs text-muted leading-relaxed">{help}</p>}
      </header>
      {children}
    </section>
  );
}

function Reading({ children }: { children: ReactNode }) {
  return <li className="leading-relaxed">{children}</li>;
}

/** A. From the holdings data already on the screen: value, gain since purchase, today. */
function PositionSection({ p, r, share }: { p: HoldingView; r: LiveHoldingRow | undefined; share: number }) {
  const { t } = useI18n();
  const cur = r?.currency || p.currency;
  const price = r ? r.price : p.price;
  const valueIls = r ? r.valueIls : p.valueIls;
  const valueOrig = r ? r.valueOrig : p.valueOrig;
  const gainOrig = r?.gainOrig ?? null;
  const gainPct = r ? r.gainPct : p.fromCostPct;
  const dayOrig = r?.dayChangeOrig ?? null;
  const dayPct = r ? r.dayChangePct : p.dailyChangePct;
  return (
    <Section title={t('ins_position')} help={t('ins_position_help')}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 flex items-baseline gap-2">
          <span className="font-semibold num shrink-0" dir="ltr">
            {p.symbol}
          </span>
          <span className="text-muted truncate" dir="auto">
            {p.name}
          </span>
        </span>
        <span className="text-end shrink-0">
          <Amount value={valueIls} tone="neutral" decimals={0} className="block text-lg font-bold" />
          {valueOrig !== null && cur !== 'ILS' && (
            <span className="block text-xs text-muted num" dir="ltr">
              {foreignMoney(valueOrig, cur)}
            </span>
          )}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        <Stat label={t('ins_quantity')}>
          <span className="num" dir="ltr">
            {p.quantity.toLocaleString('en-US', { maximumFractionDigits: 4 })} × {price !== null ? foreignMoney(price, cur) : '?'}
          </span>
        </Stat>
        {p.costPrice !== null && (
          <Stat label={t('holdings_cost')}>
            <span className="num" dir="ltr">
              {foreignMoney(p.costPrice, p.currency)}
            </span>
          </Stat>
        )}
        <Stat label={t('live_gain')}>
          <span className={`num font-semibold ${toneClass(gainTone(gainPct ?? gainOrig))}`} dir="ltr">
            {gainOrig !== null ? `${foreignMoney(gainOrig, cur, { sign: 'always' })} ` : ''}
            {pctText(gainPct)}
          </span>
        </Stat>
        <Stat label={t('live_day')}>
          <span className={`num ${toneClass(gainTone(dayPct ?? dayOrig))}`} dir="ltr">
            {dayOrig !== null ? `${foreignMoney(dayOrig, cur, { sign: 'always' })} ` : ''}
            {pctText(dayPct)}
          </span>
        </Stat>
      </dl>
      <div className="flex items-center gap-2 text-xs text-muted">
        <span className="shrink-0">{t('ins_share')}</span>
        <Bar value={share} max={1} className="flex-1" />
        <span className="num w-10 text-end">{Math.round(share * 100)}%</span>
      </div>
    </Section>
  );
}

/**
 * The owner's own rules for this holding (stock decision aids A): the ones that apply with the value checked, its
 * source and since when; then a muted count of the rest, which opens to list them. Unknown is never shown as "doesn't
 * apply". No rules at all: only a small link to set some.
 */
function RulesSection({ rules, symbol }: { rules: HoldingRuleResult[]; symbol: string }) {
  const { t } = useI18n();
  const editTo = `/stock-rules?symbol=${encodeURIComponent(symbol)}`;
  if (rules.length === 0) {
    return (
      <Link to={editTo} className="text-xs text-accent underline-offset-2 hover:underline self-start">
        {t('hr_set_link')}
      </Link>
    );
  }
  const g = groupResults(rules);
  const rest = restSummary(t, g);
  return (
    <Section title={t('hr_ins_title')} help={t('hr_ins_help')}>
      {g.applies.length > 0 ? (
        <ul className="card px-3 py-1 divide-y divide-border text-xs border-accent/40">
          {g.applies.map((x) => (
            <li key={x.ruleId} className="py-2 flex flex-col gap-0.5">
              <span className="text-[10px] font-semibold text-accent">{t('hr_applies')}</span>
              <span className="text-sm leading-snug">{ruleSentence(t, x.template, x.params)}</span>
              <RuleFacts r={x} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted">{noneApplyText(t, g)}</p>
      )}
      {rest && (
        <details className="text-xs text-muted">
          <summary className="cursor-pointer">{rest}</summary>
          <ul className="mt-1 flex flex-col gap-1.5 ps-1">
            {[...g.unknown, ...g.clear].map((x) => (
              <li key={x.ruleId} className="flex flex-col gap-0.5">
                <span>
                  <span className="font-semibold">{t(x.state === 'clear' ? 'hr_state_clear' : 'hr_state_unknown')}</span>
                  {' · '}
                  {ruleSentence(t, x.template, x.params)}
                </span>
                <RuleFacts r={x} />
              </li>
            ))}
          </ul>
        </details>
      )}
      <Link to={editTo} className="text-xs text-accent underline-offset-2 hover:underline self-start">
        {t('hr_edit_link')}
      </Link>
    </Section>
  );
}

/** "now: 41 sessions · Yahoo · since 9 Nov", the parts that are known. */
function RuleFacts({ r }: { r: HoldingRuleResult }) {
  const { t, locale } = useI18n();
  const now = nowText(t, r.template, r.value, r.state);
  const src = sourceText(t, r.source);
  const day = r.state === 'applies' ? sinceDay(r.since) : null;
  const parts = [now, src, day ? t('hr_since', { d: dayLabel(day, locale, { year: true }) }) : null, lastKnownText(t, r)].filter((x): x is string => !!x);
  if (parts.length === 0) return null;
  return (
    <span className="text-[11px] text-muted">
      {parts.join(' · ')}
    </span>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Yahoo and the bank disagree on the price: say so, with both prices. */
function CrossCheck({ d }: { d: Ready }) {
  const { t, locale } = useI18n();
  const n = crossCheckNote(d.crossCheck);
  if (!n) return null;
  if (n.kind === 'intraday') return <p className="text-[11px] text-muted">{t('ins_cross_intraday')}</p>;
  const money = (v: number | null) => (v !== null ? foreignMoney(v, d.currency) : '–');
  return (
    <div className="card p-3 border-warn/50 text-warn flex flex-col gap-1 text-xs" role="note">
      <span className="font-semibold">{t('ins_cross_warn', { p: absPct(n.diffPct) })}</span>
      <span>{t('ins_cross_prices', { y: money(n.yahoo), yd: n.yahooDate ? dayLabel(n.yahooDate, locale) : '–', b: money(n.bank), bd: n.bankAt ? stamp(n.bankAt) : '–' })}</span>
    </div>
  );
}

/** B. The 1-year chart and the readings against the averages and the 52-week range. */
function TrendSection({ d }: { d: Ready }) {
  const { t } = useI18n();
  const tr = d.trend;
  const readings = trendReadings(t, d);
  return (
    <Section title={t('ins_trend')} help={t('ins_trend_help')}>
      <PriceChart series={d.series ?? []} currency={d.currency} />
      <ul className="flex flex-col gap-1 list-disc ps-5">
        {readings.map((s) => (
          <Reading key={s}>{s}</Reading>
        ))}
      </ul>
      {tr.low52 !== null && tr.high52 !== null && (
        <span className="text-xs text-muted">
          {t('ins_range')}:{' '}
          <span className="num" dir="ltr">
            {foreignMoney(tr.low52, d.currency)} – {foreignMoney(tr.high52, d.currency)}
          </span>
        </span>
      )}
    </Section>
  );
}

const BOX: ChartBox = { width: 340, height: 172, left: 4, right: 46, top: 8, bottom: 20 };

/**
 * The last year of closes with the 50- and 200-day averages, in SVG (time always runs left to right,
 * also in Hebrew). Touch or hover to read a day; otherwise the last session is shown.
 */
function PriceChart({ series, currency }: { series: InsightPoint[]; currency: string }) {
  const { t, locale } = useI18n();
  const year = useMemo(() => lastYear(series), [series]);
  const m = useMemo(() => buildChart(year, BOX), [year]);
  const [hover, setHover] = useState<number | null>(null);
  if (!m) return <p className="text-xs text-muted">{t('ins_no_series')}</p>;
  const step = m.yTicks.length > 1 ? m.yTicks[1]!.v - m.yTicks[0]!.v : 1;
  const i = hover ?? m.n - 1;
  const pt = year[i]!;
  const month = new Intl.DateTimeFormat(locale, { month: 'short' });
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    // the SVG keeps its aspect ratio, so one scale for x
    const scale = BOX.width / rect.width;
    setHover(nearestIndex((e.clientX - rect.left) * scale, m.n, BOX));
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-x-3 gap-y-0.5 flex-wrap text-xs" dir="ltr">
        <span className="text-muted">{dayLabel(pt.d, locale, { year: true })}</span>
        <span className="num font-semibold">{foreignMoney(pt.c, currency)}</span>
        {pt.sma50 !== null && (
          <span className="num" style={{ color: SMA50_COLOR }}>
            50d {foreignMoney(pt.sma50, currency)}
          </span>
        )}
        {pt.sma200 !== null && (
          <span className="num" style={{ color: SMA200_COLOR }}>
            200d {foreignMoney(pt.sma200, currency)}
          </span>
        )}
      </div>
      <div dir="ltr">
        <svg
          viewBox={`0 0 ${BOX.width} ${BOX.height}`}
          className="w-full h-auto touch-pan-y select-none"
          role="img"
          aria-label={t('ins_chart_label')}
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => setHover(null)}
        >
          {m.yTicks.map((tk) => (
            <g key={tk.v}>
              <line x1={BOX.left} x2={BOX.width - BOX.right} y1={tk.y} y2={tk.y} className="stroke-border" strokeWidth={0.75} />
              <text x={BOX.width - BOX.right + 4} y={tk.y} dominantBaseline="middle" className="fill-muted" fontSize={10}>
                {axisNum(tk.v, step)}
              </text>
            </g>
          ))}
          {m.xTicks.map((tk) => (
            <g key={tk.d}>
              <line x1={tk.x} x2={tk.x} y1={BOX.top} y2={BOX.height - BOX.bottom} className="stroke-border" strokeWidth={0.5} strokeDasharray="2 3" />
              <text x={tk.x} y={BOX.height - 6} textAnchor="middle" className="fill-muted" fontSize={10}>
                {month.format(new Date(`${tk.d}T00:00:00`))}
              </text>
            </g>
          ))}
          <path d={m.sma200} fill="none" stroke={SMA200_COLOR} strokeWidth={1.25} strokeLinejoin="round" />
          <path d={m.sma50} fill="none" stroke={SMA50_COLOR} strokeWidth={1.25} strokeLinejoin="round" />
          <path d={m.close} fill="none" className="stroke-accent" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
          <line x1={m.x(i)} x2={m.x(i)} y1={BOX.top} y2={BOX.height - BOX.bottom} className="stroke-muted" strokeWidth={0.75} opacity={hover === null ? 0 : 0.8} />
          <circle cx={m.x(i)} cy={m.y(pt.c)} r={3} className="fill-accent" />
        </svg>
      </div>
      <div className="flex items-center gap-4 text-[11px] text-muted flex-wrap">
        <Legend color="var(--color-accent)" label={t('ins_close')} />
        <Legend color={SMA50_COLOR} label={t('ins_sma50')} />
        <Legend color={SMA200_COLOR} label={t('ins_sma200')} />
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-block w-3 h-0.5 rounded" style={{ background: color }} aria-hidden />
      {label}
    </span>
  );
}

/**
 * C. Returns of the security, of SPY and of the company's sector fund over the same periods, with the difference
 * in points against each (green = the security rose more, red = less).
 */
function MarketSection({ d }: { d: Ready }) {
  const { t } = useI18n();
  const comps = [d.benchmark, d.sector ?? null].filter((c): c is NonNullable<typeof c> => !!c);
  const cell = 'py-1.5 ps-2 text-end num';
  return (
    <Section title={t('ins_market')} help={t('ins_market_help')}>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-muted align-bottom">
            <th className="text-start font-normal py-1">{t('ins_period')}</th>
            <th className="text-end font-normal py-1 ps-2 num" dir="ltr">
              {d.symbol}
            </th>
            {comps.map((c) => (
              <Fragment key={c.symbol}>
                <th className="text-end font-normal py-1 ps-2 num" dir="ltr">
                  {c.symbol}
                </th>
                <th className="text-end font-normal py-1 ps-2">
                  <bdi>{t('ins_vs', { s: c.symbol })}</bdi>
                </th>
              </Fragment>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {RETURN_KEYS.map((k) => (
            <tr key={k}>
              <td className="py-1.5">{t(`ins_${k}`)}</td>
              <td className={`${cell} ${toneClass(gainTone(d.returns[k]))}`} dir="ltr">
                {pctText(d.returns[k], 1)}
              </td>
              {comps.map((c) => (
                <Fragment key={c.symbol}>
                  <td className={`${cell} text-muted`} dir="ltr">
                    {pctText(c.returns[k], 1)}
                  </td>
                  <td className={`${cell} font-semibold ${toneClass(diffTone(c.diffPts[k]))}`} dir="ltr">
                    {ptsText(c.diffPts[k])}
                  </td>
                </Fragment>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!d.benchmark && <p className="text-xs text-muted">{t('ins_no_benchmark')}</p>}
      {d.sector && (
        <p className="text-[11px] text-muted">
          {t('ins_sector_note', { s: d.sector.symbol, n: d.sector.name })}
        </p>
      )}
    </Section>
  );
}

/** D. Volatility, deepest drops with dates, beta vs SPY. */
function RiskSection({ d }: { d: Ready }) {
  const { t, locale } = useI18n();
  const rk = d.risk;
  const day = (s: string) => dayLabel(s, locale, { year: true });
  const beta = betaReading(t, rk.beta1y);
  return (
    <Section title={t('ins_risk')} help={t('ins_risk_help')}>
      <dl className="flex flex-col gap-2.5 text-xs">
        <RiskRow label={t('ins_volatility')} value={absPct(rk.volatility1y)} note={t('ins_volatility_help')} />
        {(
          [
            ['ins_dd1y', rk.maxDrawdown1y],
            ['ins_dd5y', rk.maxDrawdown5y],
          ] as const
        ).map(([k, raw]) => {
          const dd = drawdownView(raw);
          if (dd?.kind === 'none') return <RiskRow key={k} label={t(k)} value={t('ins_dd_none')} tone="text-muted font-normal text-xs" />;
          return <RiskRow key={k} label={t(k)} value={dd ? `−${absPct(dd.pct)}` : '–'} tone={dd ? 'text-neg' : ''} note={dd ? t('ins_dd_dates', { a: day(dd.peakDate), b: day(dd.troughDate) }) : undefined} />;
        })}
        <RiskRow label={t('ins_beta')} value={rk.beta1y !== null ? rk.beta1y.toFixed(2) : '–'} note={beta ?? undefined} />
      </dl>
    </Section>
  );
}

function RiskRow({ label, value, note, tone = '' }: { label: string; value: string; note?: string | undefined; tone?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-baseline justify-between gap-3">
        <dt className="text-muted">{label}</dt>
        <dd className={`num font-semibold text-sm ${tone}`}>{value}</dd>
      </div>
      {note && <p className="text-[11px] text-muted leading-relaxed">{note}</p>}
    </div>
  );
}

interface CoRow {
  key: string;
  label: string;
  /** the value as text; `ltr` for pure numbers (percent, ratio, per-share money) */
  value: string;
  ltr?: boolean;
  sub?: ReactNode;
  help?: string;
  fig: InsightFigure;
}

/**
 * E. The company's own figures from its SEC filings, grouped (growth, profitability, balance sheet, shares).
 * Every value carries its period and filing as a caption (repeated captions inside a group are shown once).
 * Missing figures are left out; colours stay neutral — these are descriptions, not grades.
 */
function CompanySection({ d }: { d: HoldingInsights }) {
  const { t, lang } = useI18n();
  const c = d.company;
  if (!c) {
    const why = companyUnavailableReason(t, d.companyUnavailableCode);
    if (!why) return null;
    return (
      <Section title={t('ins_co')}>
        <p className="text-xs text-muted">{why}</p>
      </Section>
    );
  }
  const f = c.figures;
  const money = (g: InsightFigure) => compactNumber(t, lang, g.value, figureCurrency(g, c.currency));
  const pct = (v: number) => `${ratioText(v, 1)}%`;
  const yoy = (g: InsightFigure | null, main: InsightFigure) =>
    g ? <span>{t(main.basis === 'annual' ? 'ins_co_yoy_annual' : 'ins_co_yoy', { p: isolateLtr(pctText(g.value, 1)) })}</span> : undefined;
  const trendLine = (labelKey: 'ins_co_margin_1y' | 'ins_co_margin_3y', then: InsightFigure | null) => {
    if (!then) return null;
    const dir = marginTrend(f.netMarginPct?.value, then.value);
    return (
      <span key={labelKey} className="inline-flex items-baseline gap-1">
        <span>{t(labelKey, { p: isolateLtr(pct(then.value)) })}</span>
        {dir && <TrendMark dir={dir} />}
      </span>
    );
  };
  const groups: Array<{ title: string; rows: Array<CoRow | null> }> = [
    {
      title: t('ins_co_growth'),
      rows: [
        f.revenueTtm && { key: 'rev', label: periodLabel(t, t('ins_co_revenue'), f.revenueTtm.basis), value: money(f.revenueTtm), sub: yoy(f.revenueYoYPct, f.revenueTtm), fig: f.revenueTtm },
        f.netIncomeTtm && { key: 'ni', label: periodLabel(t, t('ins_co_net_income'), f.netIncomeTtm.basis), value: money(f.netIncomeTtm), sub: yoy(f.netIncomeYoYPct, f.netIncomeTtm), fig: f.netIncomeTtm },
      ],
    },
    {
      title: t('ins_co_profit'),
      rows: [
        f.netMarginPct && {
          key: 'margin',
          label: periodLabel(t, t('ins_co_margin'), f.netMarginPct.basis),
          value: pct(f.netMarginPct.value),
          ltr: true,
          help: t('ins_co_margin_help'),
          sub:
            f.netMarginPct1yAgo || f.netMarginPct3yAgo ? (
              <span className="flex flex-wrap gap-x-3 gap-y-0.5">
                {trendLine('ins_co_margin_1y', f.netMarginPct1yAgo)}
                {trendLine('ins_co_margin_3y', f.netMarginPct3yAgo)}
              </span>
            ) : undefined,
          fig: f.netMarginPct,
        },
        f.epsTtm && { key: 'eps', label: periodLabel(t, t('ins_co_eps'), f.epsTtm.basis), value: foreignMoney(f.epsTtm.value, figureCurrency(f.epsTtm, c.currency), { sign: 'auto' }), ltr: true, fig: f.epsTtm },
        f.pe && { key: 'pe', label: t('ins_co_pe'), value: ratioText(f.pe.value, 1), ltr: true, help: t('ins_co_pe_help'), fig: f.pe },
      ],
    },
    {
      title: t('ins_co_balance'),
      rows: [
        f.cash && { key: 'cash', label: t('ins_co_cash'), value: money(f.cash), fig: f.cash },
        f.totalDebt && { key: 'debt', label: t('ins_co_debt'), value: money(f.totalDebt), help: t('ins_co_debt_help'), fig: f.totalDebt },
        f.financeLeases ? { key: 'leases', label: t('ins_co_leases'), value: money(f.financeLeases), fig: f.financeLeases } : null,
        f.debtToEquity && { key: 'de', label: t('ins_co_de'), value: ratioText(f.debtToEquity.value), ltr: true, help: t('ins_co_de_help'), fig: f.debtToEquity },
      ],
    },
    {
      title: t('ins_co_shares'),
      rows: [
        f.sharesOutstanding && { key: 'shares', label: t('ins_co_shares_out'), value: compactNumber(t, lang, f.sharesOutstanding.value), fig: f.sharesOutstanding },
        f.sharesChange1yPct && { key: 'sharesChg', label: t('ins_co_shares_change'), value: pctText(f.sharesChange1yPct.value, 1), ltr: true, help: t('ins_co_shares_help'), fig: f.sharesChange1yPct },
      ],
    },
  ];
  const shown = groups.map((g) => ({ ...g, rows: g.rows.filter((r): r is CoRow => !!r) })).filter((g) => g.rows.length > 0);
  const placed = placeNotes(c.notes, shown.flatMap((g) => g.rows.map((r) => r.key)));
  if (shown.length === 0 && placed.bottom.length === 0) return null;
  return (
    <Section title={t('ins_co')} help={t('ins_co_help')}>
      {c.name && (
        <span className="text-xs text-muted" dir="auto">
          {c.name}
          {c.sicDescription ? ` · ${c.sicDescription}` : ''}
        </span>
      )}
      {shown.map((g) => (
        <div key={g.title} className="flex flex-col gap-1">
          <h4 className="text-xs font-semibold text-muted">{g.title}</h4>
          <dl className="card px-3 py-1 divide-y divide-border text-xs">
            {g.rows.map((r, i) => {
              const cap = basisCaption(t, r.fig);
              const prev = i > 0 ? basisCaption(t, g.rows[i - 1]!.fig) : null;
              return <CompanyRow key={r.key} row={r} caption={cap !== prev ? cap : null} notes={placed.byRow[r.key]} />;
            })}
          </dl>
        </div>
      ))}
      {placed.bottom.length > 0 && <NoteList notes={placed.bottom} label={t('ins_co_notes')} />}
      {placed.method.length > 0 && (
        <details className="text-[11px] text-muted">
          <summary className="cursor-pointer">{t('ins_co_method')}</summary>
          <NoteList notes={placed.method} label={t('ins_co_method')} className="mt-1" />
        </details>
      )}
    </Section>
  );
}

function NoteList({ notes, label, className = '' }: { notes: InsightCompanyNote[]; label: string; className?: string }) {
  const { t } = useI18n();
  return (
    <ul className={`flex flex-col gap-0.5 text-[11px] text-muted ${className}`} aria-label={label}>
      {notes.map((n) => {
        const v = noteText(t, n);
        return (
          <li key={`${n.code}|${n.figure ?? ''}`} dir={v.raw ? 'auto' : undefined} className={v.raw ? 'opacity-80' : undefined}>
            {v.text}
          </li>
        );
      })}
    </ul>
  );
}

function CompanyRow({ row, caption, notes }: { row: CoRow; caption: string | null; notes?: InsightCompanyNote[] | undefined }) {
  return (
    <div className="py-2 flex flex-col gap-0.5">
      <div className="flex items-baseline justify-between gap-3">
        <dt className="text-muted">{row.label}</dt>
        <dd className="num font-semibold text-sm text-end" dir={row.ltr ? 'ltr' : undefined}>
          {row.value}
        </dd>
      </div>
      {row.sub && <div className="text-[11px] text-muted">{row.sub}</div>}
      {row.help && <p className="text-[11px] text-muted leading-relaxed">{row.help}</p>}
      {caption && <p className="text-[10px] text-muted/80">{caption}</p>}
      {notes && notes.length > 0 && <NoteList notes={notes} label={row.label} />}
    </div>
  );
}

/** A muted arrow for the margin's direction since then, with words for screen readers and on hover. */
function TrendMark({ dir }: { dir: MarginTrend }) {
  const { t } = useI18n();
  const label = t(dir === 'up' ? 'ins_co_trend_up' : dir === 'down' ? 'ins_co_trend_down' : 'ins_co_trend_flat');
  return (
    <span className="text-muted" title={label}>
      <span aria-hidden>{TREND_ARROW[dir]}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * Decision aids B. What the analysts who cover the company published (Finnhub): the five rating counts as one bar in
 * a single hue (an ordered scale, not good/bad colours), the buy and sell shares, the change of the buy share vs 3
 * months ago, and the next / last earnings report. The caveat is always shown with the ratings. Without ratings, a
 * muted reason; the section is left out when the hub sent nothing at all (an older hub).
 */
function AnalystsSection({ d }: { d: HoldingInsights }) {
  const { t, locale } = useI18n();
  const parts = analystsParts(t, d, jerusalemDay(new Date().toISOString()));
  if (!parts) return null;
  const { view: v, why, next, last } = parts;
  const change = v ? changeText(t, v) : null;
  return (
    <Section title={t('ins_an')}>
      {v ? (
        <>
          <span className="text-xs text-muted">{t('ins_an_count', { n: v.total, m: monthYear(v.period, locale) })}</span>
          <div
            className="flex h-3 w-full overflow-hidden rounded bg-surface-2"
            role="img"
            aria-label={t('ins_an_bar_label', { list: v.segments.map((x) => `${t(RATING_LABEL[x.key])} ${x.count}`).join(', ') })}
          >
            {v.segments
              .filter((x) => x.count > 0)
              .map((x) => (
                <span key={x.key} className="h-full border-e border-bg last:border-e-0" style={{ width: `${x.frac * 100}%`, background: ratingColor(x.key) }} />
              ))}
          </div>
          <ul className="grid grid-cols-5 gap-1 text-[11px]">
            {v.segments.map((x) => (
              <li key={x.key} className="flex flex-col items-start gap-0.5 min-w-0">
                <span className="inline-flex items-center gap-1 text-muted min-w-0">
                  <span className="inline-block w-2 h-2 rounded-sm shrink-0" style={{ background: ratingColor(x.key) }} aria-hidden />
                  <span className="truncate">{t(RATING_LABEL[x.key])}</span>
                </span>
                <span className="num font-semibold text-sm">{x.count}</span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
            <span>{t('ins_an_buy_share', { p: sharePct(v.buyPct) })}</span>
            <span>{t('ins_an_sell_share', { p: sharePct(v.sellPct) })}</span>
          </div>
          {change && <span className="text-xs text-muted">{change}</span>}
          <p className="text-[11px] text-muted leading-relaxed">{t('ins_an_caveat')}</p>
        </>
      ) : (
        why && <p className="text-xs text-muted">{why}</p>
      )}
      {(next || last) && (
        <ul className="flex flex-col gap-0.5 text-xs">
          {next && <li>{next}</li>}
          {last && <li className="text-muted">{last}</li>}
        </ul>
      )}
      {(parts.analystsSource || parts.earningsSource) && (
        <span className="flex flex-col text-[10px] text-muted/80">
          {parts.analystsSource && <span>{parts.analystsSource}</span>}
          {parts.earningsSource && <span>{parts.earningsSource}</span>}
        </span>
      )}
    </Section>
  );
}

/**
 * F. The latest SEC filings, newest first: form, what it is about (8-K items as titles), date. Tapping opens
 * the filing on sec.gov outside finc; a link that is not https://www.sec.gov/ is shown but not opened.
 */
function FilingsSection({ d }: { d: HoldingInsights }) {
  const { t } = useI18n();
  const [all, setAll] = useState(false);
  const list = d.filings ?? [];
  if (list.length === 0) return null;
  const shown = all ? list : list.slice(0, FILINGS_VISIBLE);
  return (
    <Section title={t('ins_filings')} help={t('ins_filings_help')}>
      <ul className="card px-3 py-1 divide-y divide-border text-xs">
        {shown.map((f, i) => (
          <li key={`${f.url}-${i}`}>
            <FilingRow f={f} />
          </li>
        ))}
      </ul>
      {list.length > FILINGS_VISIBLE && (
        <button className="btn btn-sm self-start" onClick={() => setAll(!all)} aria-expanded={all}>
          {all ? t('ins_filings_less') : t('ins_filings_all', { n: list.length })}
        </button>
      )}
    </Section>
  );
}

function FilingRow({ f }: { f: InsightFiling }) {
  const { t, locale } = useI18n();
  const href = secLink(f.url);
  const text = filingText(t, f);
  const body = (
    <>
      <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold num" dir="ltr">
        {f.form}
      </span>
      <span className="flex-1 min-w-0 leading-snug" dir="auto">
        {text ?? ''}
      </span>
      <span className="shrink-0 text-muted">{f.filed ? dayLabel(f.filed.slice(0, 10), locale, { year: true }) : ''}</span>
      {href && (
        <span aria-hidden className="shrink-0 text-muted">
          ↗
        </span>
      )}
    </>
  );
  const cls = 'w-full py-2 flex items-baseline gap-2 text-start';
  if (!href) return <div className={`${cls} opacity-70`}>{body}</div>;
  return (
    <button type="button" className={`${cls} hover:bg-surface-2/50 rounded`} onClick={() => openSecLink(href, isNative ? (u) => void openExternalNative(u) : undefined)}>
      {body}
    </button>
  );
}

/** Dividends and splits from the price history, collapsed. */
function EventsSection({ d }: { d: Ready }) {
  const { t, locale } = useI18n();
  const items = [
    ...(d.events?.dividends ?? []).map((e) => ({ d: e.d, kind: 'div' as const, text: foreignMoney(e.amount, d.currency, { decimals: e.amount < 1 ? 4 : 2 }) })),
    ...(d.events?.splits ?? []).map((e) => ({ d: e.d, kind: 'split' as const, text: String(e.ratio) })),
  ].sort((a, b) => b.d.localeCompare(a.d));
  if (items.length === 0) return null;
  return (
    <details className="card p-3 text-xs">
      <summary className="cursor-pointer font-semibold text-sm">
        {t('ins_events')} <span className="text-muted num">({items.length})</span>
      </summary>
      <ul className="mt-2 divide-y divide-border">
        {items.map((e) => (
          <li key={`${e.kind}-${e.d}`} className="py-1.5 flex items-baseline justify-between gap-3">
            <span className="text-muted">{dayLabel(e.d, locale, { year: true })}</span>
            <span className="flex items-baseline gap-2">
              <span>{t(e.kind === 'div' ? 'ins_dividend' : 'ins_split')}</span>
              <span className="num" dir="ltr">
                {e.text}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** I. Not advice; the source and when it was fetched. */
function Footer({ d, sec }: { d: Ready | undefined; sec: HoldingInsights | undefined }) {
  const { t, locale } = useI18n();
  // the SEC sections show without the price data too, so their date comes from the payload either way
  const secDate = latestSecDate(sec);
  return (
    <footer className="border-t border-border pt-3 flex flex-col gap-1 text-[11px] text-muted">
      <span className="font-semibold">{t('ins_disclaimer')}</span>
      {d && <span>{t('ins_source', { d: dayLabel(d.asOf, locale, { year: true }), t: stamp(d.fetchedAt) })}</span>}
      {secDate && <span>{t('ins_source_sec', { d: dayLabel(secDate, locale, { year: true }) })}</span>}
    </footer>
  );
}

function Skeleton() {
  const block = 'rounded bg-surface-2 animate-pulse';
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      <div className={`${block} h-4 w-32`} />
      <div className={`${block} h-40 w-full`} />
      <div className={`${block} h-3 w-3/4`} />
      <div className={`${block} h-3 w-2/3`} />
      <div className={`${block} h-4 w-40 mt-2`} />
      <div className={`${block} h-24 w-full`} />
      <div className={`${block} h-4 w-24 mt-2`} />
      <div className={`${block} h-16 w-full`} />
    </div>
  );
}
