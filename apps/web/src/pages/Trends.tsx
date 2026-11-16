import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Bar, Cell, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Sankey, Tooltip, XAxis, YAxis } from 'recharts';
import { api, qs } from '../api';
import { MonthNav } from '../components/MonthNav';
import { NetWorthCard } from '../components/NetWorthCard';
import { Amount, Bar as Meter, Card, Chip, Empty, ErrorBox, Row, Spinner } from '../components/ui';
import { addMonths, dayLabel, money, monthLabel } from '../format';
import { type Key, useI18n } from '../i18n';
import type { CategorySeries, SankeyNode, TrendSeries, TrendsOverview, YearlyReport } from '../types';
import { GROUP_COLOR } from './Categories';

/**
 * Trends (design §6): in / out / net bars over 12 or 24 months, one line per group and per notable
 * category, a Sankey of one finished month, and the last twelve months against the year before. The Year chip
 * switches to the yearly report (one printable page per year).
 */
const colorOf = (g: string) => GROUP_COLOR[g] ?? '#8b93a7';
const TOOLTIP_STYLE = { background: '#171a21', border: '1px solid #262b36', borderRadius: 8, fontSize: 12 };
const thisMonth = () => new Date().toISOString().slice(0, 7);

export function Trends() {
  const { t, lang, locale } = useI18n();
  const [mode, setMode] = useState<12 | 24 | 'year'>(12);
  const months = mode === 'year' ? 12 : mode;
  const [sankeyMonth, setSankeyMonth] = useState(addMonths(thisMonth(), -1));
  const narrow = useNarrow();
  const q = useQuery({ queryKey: ['trends', months, sankeyMonth], queryFn: () => api.get<TrendsOverview>(`/api/trends${qs({ months, sankey: sankeyMonth })}`), placeholderData: (prev) => prev, enabled: mode !== 'year' });
  const sk = q.data?.sankey ?? { nodes: [], links: [] };
  const modeChips = (
    <div className="flex gap-2 print:hidden">
      {([12, 24] as const).map((n) => (
        <Chip key={n} on={mode === n} onClick={() => setMode(n)}>
          {t('trends_months_n', { n })}
        </Chip>
      ))}
      <Chip on={mode === 'year'} onClick={() => setMode('year')}>
        {t('year_tab')}
      </Chip>
    </div>
  );
  if (mode === 'year')
    return (
      <div className="flex flex-col gap-3">
        <header className="flex items-center justify-between flex-wrap gap-2 print:hidden">{modeChips}</header>
        <YearReport />
      </div>
    );
  if (q.isPending) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const groupName = (key: string) => (t(`group_${key}` as Key) === `group_${key}` ? key : t(`group_${key}` as Key));
  const short = (m: string) => new Intl.DateTimeFormat(locale, { month: 'short' }).format(new Date(`${m}-01T00:00:00Z`));
  const chart = d.months.map((m) => ({ ...m, label: short(m.month) }));
  const finished = d.months.filter((m) => !m.partial);

  return (
    <div className="flex flex-col gap-3">
      <header className="flex items-center justify-between flex-wrap gap-2">
        {modeChips}
        {d.story && (
          <span className="text-sm text-muted">
            {t('trends_story', { n: d.story.months, a: money(d.story.variableFirst, { decimals: 0 }), b: money(d.story.variableLast, { decimals: 0 }), net: money(d.story.netSum, { sign: 'auto', decimals: 0 }) })}
          </span>
        )}
      </header>

      {/* --- net worth (design §6) */}
      <NetWorthCard />

      {/* --- in / out / net */}
      <Card title={t('trends_in_out')}>
        {finished.length < 2 ? (
          <Empty>{t('trends_no_data')}</Empty>
        ) : (
          <div className="h-56" dir="ltr">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chart} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={2}>
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#8b93a7' }} axisLine={false} tickLine={false} />
                <YAxis hide domain={[(min: number) => Math.min(0, min), (max: number) => max]} />
                <ReferenceLine y={0} stroke="#262b36" />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  labelFormatter={(_, p) => (p?.[0]?.payload ? monthLabel((p[0].payload as { month: string }).month, locale) : '')}
                  formatter={(v, name) => [money(Number(v), { sign: name === 'net' ? 'auto' : 'never', decimals: 0 }), t(`trends_${String(name)}` as Key)]}
                />
                <Bar dataKey="income" fill="#34d399" radius={[3, 3, 0, 0]} isAnimationActive={false}>
                  {chart.map((m) => (
                    <Cell key={m.month} fillOpacity={m.partial ? 0.45 : 0.9} />
                  ))}
                </Bar>
                <Bar dataKey="out" fill="#8b93a7" radius={[3, 3, 0, 0]} isAnimationActive={false}>
                  {chart.map((m) => (
                    <Cell key={m.month} fillOpacity={m.partial ? 0.45 : 0.9} />
                  ))}
                </Bar>
                <Line type="monotone" dataKey="net" stroke="#2dd4bf" strokeWidth={2} dot={{ r: 2.5, fill: '#2dd4bf', strokeWidth: 0 }} isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
        <div className="flex gap-4 text-xs text-muted mt-1 flex-wrap">
          <Legend color="#34d399" label={t('trends_income')} />
          <Legend color="#8b93a7" label={t('trends_out')} />
          <Legend color="#2dd4bf" label={t('trends_net')} line />
          <span>· {t('trends_partial')}</span>
        </div>
      </Card>

      {/* --- groups */}
      <Card title={t('trends_groups')}>
        <div className="flex flex-col divide-y divide-border">
          {d.groups
            .filter((g) => g.total > 0)
            .map((g) => (
              <SeriesRow key={g.key} name={groupName(g.key)} color={colorOf(g.key)} s={g} />
            ))}
        </div>
      </Card>

      {/* --- categories */}
      <Card title={t('trends_categories')}>
        <div className="flex flex-col divide-y divide-border">
          {d.categories
            .filter((c) => c.total > 0)
            .slice(0, 10)
            .map((c) => (
              <SeriesRow key={c.key} name={lang === 'he' ? c.nameHe : c.nameEn} sub={groupName(c.group)} color={colorOf(c.group)} s={c} />
            ))}
        </div>
      </Card>

      {/* --- sankey */}
      <Card title={t('trends_sankey')} action={<MonthNav month={sankeyMonth} onChange={setSankeyMonth} max={addMonths(thisMonth(), -1)} />}>
        {d.sankey.links.length === 0 ? (
          <Empty>{t('trends_no_data')}</Empty>
        ) : narrow ? (
          <>
            <FlowVertical s={d.sankey} groupName={groupName} />
            <details className="mt-2 text-sm">
              <summary className="cursor-pointer text-xs text-muted">{t('trends_flow_details')}</summary>
              <div className="mt-2">
                <FlowBreakdown s={d.sankey} groupName={groupName} />
              </div>
            </details>
          </>
        ) : (
          <div className="h-[380px]" dir="ltr">
            <ResponsiveContainer width="100%" height="100%">
              <Sankey
                data={{ nodes: sk.nodes.map((n) => ({ name: n.kind === 'group' ? groupName(n.key) : nodeName(n, lang) })), links: sk.links }}
                nodePadding={12}
                nodeWidth={8}
                margin={{ top: 8, right: 118, bottom: 8, left: 100 }}
                link={{ stroke: '#2dd4bf', strokeOpacity: 0.18, fill: 'none' }}
                node={<SankeyNodeShape nodes={sk.nodes} lang={lang} />}
                iterations={48}
              >
                <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v) => [money(Number(v), { decimals: 0 }), '']} />
              </Sankey>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      {/* --- year over year */}
      <Card title={t('trends_yoy')}>
        <YoY d={d} />
      </Card>
      <Link to="/events" className="md:hidden btn self-center">
        {t('events_link')}
      </Link>
    </div>
  );
}

/** True below the sm breakpoint; follows rotation and resizes. */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < 640);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 639px)');
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}

function nodeName(n: SankeyNode, lang: 'he' | 'en'): string {
  return lang === 'he' ? n.nameHe : n.nameEn;
}

function Legend({ color, label, line = false }: { color: string; label: string; line?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={line ? 'inline-block w-3 h-0.5 rounded' : 'inline-block w-2.5 h-2.5 rounded-sm'} style={{ background: color }} />
      {label}
    </span>
  );
}

/** One row: colour, name, last finished month against the median, and a sparkline of the window. */
function SeriesRow({ name, sub, color, s }: { name: string; sub?: string; color: string; s: TrendSeries | CategorySeries }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const delta = s.median > 0 ? s.last - s.median : 0;
  const pct = s.median > 0 ? Math.round((delta / s.median) * 100) : 0;
  return (
    <button className="py-2.5 flex items-center gap-3 text-start w-full" onClick={() => navigate(`/categories`)}>
      <span className="inline-block h-2.5 w-2.5 rounded-full shrink-0" style={{ background: color }} />
      <span className="flex-1 min-w-0">
        <span className="block truncate text-sm">{name}</span>
        <span className="block text-xs text-muted truncate">
          {sub ? `${sub} · ` : ''}
          {t('trends_median', { x: money(s.median, { decimals: 0 }) })}
        </span>
      </span>
      <Sparkline values={s.series} color={color} />
      <span className="text-end shrink-0 w-24">
        <Amount value={-s.last} tone="neutral" decimals={0} className="block text-sm" />
        {s.median > 0 && Math.abs(pct) >= 5 && <span className={`block text-xs num ${delta > 0 ? 'text-warn' : 'text-pos'}`}>{`${delta > 0 ? '+' : '−'}${Math.abs(pct)}%`}</span>}
      </span>
    </button>
  );
}

/** Inline SVG sparkline: cheap enough for a list, the last (partial) point dimmed. */
function Sparkline({ values, color }: { values: number[]; color: string }) {
  const w = 72;
  const h = 24;
  const max = Math.max(1, ...values);
  const n = values.length;
  const pts = values.map((v, i) => [n === 1 ? w / 2 : (i / (n - 1)) * (w - 2) + 1, h - 1 - (v / max) * (h - 3)] as const);
  const path = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  return (
    <svg width={w} height={h} className="shrink-0" aria-hidden="true" style={{ direction: 'ltr' }}>
      <path d={path} fill="none" stroke={color} strokeWidth={1.5} strokeOpacity={0.8} strokeLinejoin="round" />
      {last && <circle cx={last[0]} cy={last[1]} r={2} fill={color} fillOpacity={0.5} />}
    </svg>
  );
}

/** Money paid back to the owner flows in beside income but is not income: its own, quieter colour. */
const PAID_BACK_COLOR = '#5eead4';

/** Node rectangles with labels, since the default Sankey node has none. */
function SankeyNodeShape(props: { x?: number; y?: number; width?: number; height?: number; index?: number; payload?: { name: string; value: number }; nodes: SankeyNode[]; lang: 'he' | 'en' }) {
  const { x = 0, y = 0, width = 0, height = 0, index = 0, payload, nodes } = props;
  const n = nodes[index];
  const color = n?.kind === 'group' ? colorOf(n.key) : n?.kind === 'income' || n?.kind === 'pool' || n?.kind === 'left' ? '#34d399' : n?.kind === 'paid_back' ? PAID_BACK_COLOR : n?.kind === 'deficit' ? '#f87171' : '#8b93a7';
  const left = n?.kind === 'income' || n?.kind === 'paid_back' || n?.kind === 'deficit';
  const full = payload?.name ?? '';
  const label = full.length > 18 ? `${full.slice(0, 17)}…` : full;
  const amount = payload ? money(payload.value, { decimals: 0 }) : '';
  const tx = left ? x - 6 : x + width + 6;
  const anchor = left ? 'end' : 'start';
  // a dark halo keeps the text readable where it crosses a ribbon
  const halo = { stroke: '#171a21', strokeWidth: 3, paintOrder: 'stroke' as const, strokeLinejoin: 'round' as const };
  return (
    <g>
      <rect x={x} y={y} width={width} height={Math.max(1, height)} fill={color} fillOpacity={0.85} rx={2} />
      {height >= 16 ? (
        <text x={tx} y={y + height / 2} textAnchor={anchor} dominantBaseline="middle" fontSize={10.5} fill="#e6e8ee" {...halo}>
          <tspan x={tx} dy="-0.55em">
            {label}
          </tspan>
          <tspan x={tx} dy="1.15em" fill="#8b93a7">
            {amount}
          </tspan>
        </text>
      ) : height >= 9 ? (
        <text x={tx} y={y + height / 2} textAnchor={anchor} dominantBaseline="middle" fontSize={10.5} fill="#e6e8ee" {...halo}>
          {label}
          <tspan fill="#8b93a7"> {amount}</tspan>
        </text>
      ) : null}
    </g>
  );
}

function YoY({ d }: { d: TrendsOverview }) {
  const { t, locale } = useI18n();
  const rows = d.yoy.rows.filter((r) => r.now || r.then);
  if (!rows.length) return <Empty>{t('trends_no_data')}</Empty>;
  const cell = (v: number | undefined, sign: 'auto' | 'never' = 'never') => (v === undefined ? <span className="text-muted">–</span> : <Amount value={v} tone={sign === 'auto' ? 'auto' : 'neutral'} sign={sign} decimals={0} className="text-xs sm:text-sm" />);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs sm:text-sm">
        <thead className="text-xs text-muted whitespace-nowrap">
          <tr>
            <th className="text-start font-normal py-1"></th>
            <th className="text-end font-normal py-1" colSpan={2}>
              {t('trends_income')}
            </th>
            <th className="text-end font-normal py-1" colSpan={2}>
              {t('trends_out')}
            </th>
            <th className="text-end font-normal py-1" colSpan={2}>
              {t('trends_net')}
            </th>
          </tr>
          <tr>
            <th></th>
            {[0, 1, 2].flatMap((i) => [
              <th key={`${i}a`} className="text-end font-normal pb-1">
                {t('trends_last_year')}
              </th>,
              <th key={`${i}b`} className="text-end font-normal pb-1">
                {t('trends_this_year')}
              </th>,
            ])}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr key={r.month}>
              <td className="py-1.5 text-muted">{new Intl.DateTimeFormat(locale, { month: 'short' }).format(new Date(`${r.month}-01T00:00:00Z`))}</td>
              <td className="text-end py-1.5 text-muted">{cell(r.then?.income)}</td>
              <td className="text-end py-1.5">{cell(r.now?.income)}</td>
              <td className="text-end py-1.5 text-muted">{cell(r.then?.out)}</td>
              <td className="text-end py-1.5">{cell(r.now?.out)}</td>
              <td className="text-end py-1.5 text-muted">{cell(r.then?.net, 'auto')}</td>
              <td className="text-end py-1.5">{cell(r.now?.net, 'auto')}</td>
            </tr>
          ))}
          <tr className="font-semibold">
            <td className="py-2 text-muted font-normal text-xs">{t('trends_total_n', { n: d.yoy.now.months })}</td>
            <td className="text-end py-2 text-muted">{cell(d.yoy.then.income)}</td>
            <td className="text-end py-2">{cell(d.yoy.now.income)}</td>
            <td className="text-end py-2 text-muted">{cell(d.yoy.then.out)}</td>
            <td className="text-end py-2">{cell(d.yoy.now.out)}</td>
            <td className="text-end py-2 text-muted">{cell(d.yoy.then.net, 'auto')}</td>
            <td className="text-end py-2">{cell(d.yoy.now.net, 'auto')}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/**
 * The phone's answer to "where did the money go": a Sankey does not fit 360px, so the same flow is a list in
 * two stages. Income sources add up to one total; the total goes out to each group, each bar scaled to the
 * total, and what is left (or what came from the balance) closes the list.
 */
function FlowBreakdown({ s, groupName }: { s: TrendsOverview['sankey']; groupName: (k: string) => string }) {
  const { t, lang } = useI18n();
  const pool = s.nodes.findIndex((n) => n.kind === 'pool');
  const into = s.links.filter((l) => l.target === pool).map((l) => ({ n: s.nodes[l.source]!, v: l.value }));
  const outOf = s.links.filter((l) => l.source === pool).map((l) => ({ n: s.nodes[l.target]!, v: l.value }));
  const income = into.filter((x) => x.n.kind === 'income').sort((a, b) => b.v - a.v);
  const deficit = into.find((x) => x.n.kind === 'deficit');
  const paidBack = into.find((x) => x.n.kind === 'paid_back');
  const groups = outOf.filter((x) => x.n.kind === 'group').sort((a, b) => b.v - a.v);
  const left = outOf.find((x) => x.n.kind === 'left');
  const total = into.reduce((a, x) => a + x.v, 0);
  const name = (n: SankeyNode) => (n.kind === 'group' ? groupName(n.key) : lang === 'he' ? n.nameHe : n.nameEn);
  const row = (key: string, label: string, v: number, color: string, muted = false) => (
    <Row key={key}>
      <span className="inline-block h-2.5 w-2.5 rounded-full shrink-0" style={{ background: color }} />
      <span className={`flex-1 min-w-0 truncate text-sm ${muted ? 'text-muted' : ''}`}>{label}</span>
      <Meter value={v} max={total || 1} color={color} className="w-24" />
      <Amount value={v} tone="neutral" decimals={0} className="text-sm w-20 text-end" />
    </Row>
  );
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted uppercase tracking-wide">{t('trends_income')}</span>
      {income.map((x) => row(x.n.key, name(x.n), x.v, '#34d399'))}
      {paidBack && row('paid_back', name(paidBack.n), paidBack.v, PAID_BACK_COLOR, true)}
      {deficit && row('deficit', name(deficit.n), deficit.v, '#f87171', true)}
      <div className="flex items-center justify-between py-2 mt-1 border-t border-b border-border text-sm">
        <span className="font-semibold">{t('trends_total_in')}</span>
        <Amount value={total} tone="pos" decimals={0} className="font-semibold" />
      </div>
      <span className="text-xs text-muted uppercase tracking-wide mt-1">{t('trends_out')}</span>
      {groups.map((x) => row(x.n.key, name(x.n), x.v, colorOf(x.n.key)))}
      {left && (
        <div className="flex items-center justify-between py-2 mt-1 border-t border-border text-sm">
          <span className="font-semibold">{name(left.n)}</span>
          <Amount value={left.v} tone="pos" decimals={0} className="font-semibold" />
        </div>
      )}
    </div>
  );
}

/**
 * The phone's Sankey, drawn top to bottom by hand (recharts only draws left to right): income sources along
 * the top flow into one total band, the band flows down into the groups, and what was left closes the row.
 * Widths are proportional; nodes too narrow for a label get a dot and appear in the details list.
 */
function FlowVertical({ s, groupName }: { s: TrendsOverview['sankey']; groupName: (k: string) => string }) {
  const { lang } = useI18n();
  const W = 360;
  const H = 400;
  const PAD = 10;
  const GAP = 5;
  const NODE_H = 14;
  const Y_TOP = 46;
  const Y_POOL = 196;
  const Y_BOTTOM = 334;
  const pool = s.nodes.findIndex((n) => n.kind === 'pool');
  const into = s.links.filter((l) => l.target === pool).map((l) => ({ n: s.nodes[l.source]!, v: l.value }));
  const outOf = s.links.filter((l) => l.source === pool).map((l) => ({ n: s.nodes[l.target]!, v: l.value }));
  const total = into.reduce((a, x) => a + x.v, 0) || 1;
  const name = (n: SankeyNode) => (n.kind === 'group' ? groupName(n.key) : lang === 'he' ? n.nameHe : n.nameEn);
  const color = (n: SankeyNode) => (n.kind === 'group' ? colorOf(n.key) : n.kind === 'deficit' ? '#f87171' : n.kind === 'paid_back' ? PAID_BACK_COLOR : '#34d399');
  // lay a row out from the right (Hebrew reads that way), biggest first
  const layout = (items: Array<{ n: SankeyNode; v: number }>) => {
    const sorted = [...items].sort((a, b) => b.v - a.v);
    const usable = W - 2 * PAD - GAP * Math.max(0, sorted.length - 1);
    let right = W - PAD;
    return sorted.map((x) => {
      const w = Math.max(3, (x.v / total) * usable);
      const seg = { ...x, x: right - w, w };
      right -= w + GAP;
      return seg;
    });
  };
  const top = layout(into);
  const bottom = layout(outOf);
  // the middle band is narrower than the rows, so the ribbons visibly converge into it and fan out again
  const poolW = Math.round(W * 0.58);
  const poolX = (W - poolW) / 2;
  let cursorTop = poolX + poolW;
  let cursorBottom = poolX + poolW;
  const ribbon = (x0: number, w0: number, y0: number, x1: number, w1: number, y1: number, fill: string) => {
    const ym = (y0 + y1) / 2;
    return <path key={`${x0}-${y0}-${x1}`} d={`M${x0},${y0} C${x0},${ym} ${x1},${ym} ${x1},${y1} h${w1} C${x1 + w1},${ym} ${x0 + w0},${ym} ${x0 + w0},${y0} z`} fill={fill} fillOpacity={0.14} stroke={fill} strokeOpacity={0.45} strokeWidth={0.75} />;
  };
  const label = (seg: { x: number; w: number; n: SankeyNode; v: number }, y: number, below: boolean) => {
    if (seg.w < 46) return null;
    const cx = seg.x + seg.w / 2;
    const text = name(seg.n);
    const short = text.length > Math.max(6, Math.floor(seg.w / 7)) ? `${text.slice(0, Math.max(5, Math.floor(seg.w / 7) - 1))}…` : text;
    return (
      <text key={`l-${seg.x}-${y}`} x={cx} y={below ? y + NODE_H + 14 : y - 18} textAnchor="middle" fontSize={11} fill="#e6e8ee">
        <tspan x={cx}>{short}</tspan>
        <tspan x={cx} dy="1.2em" fill="#8b93a7">
          {money(seg.v, { decimals: 0 })}
        </tspan>
      </text>
    );
  };
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} className="block" aria-hidden="true" style={{ direction: 'ltr' }}>
      {top.map((seg) => {
        const w1 = (seg.v / total) * poolW;
        cursorTop -= w1;
        return ribbon(seg.x, seg.w, Y_TOP + NODE_H, cursorTop, w1, Y_POOL, color(seg.n));
      })}
      {bottom.map((seg) => {
        const w0 = (seg.v / total) * poolW;
        cursorBottom -= w0;
        return ribbon(cursorBottom, w0, Y_POOL + NODE_H, seg.x, seg.w, Y_BOTTOM, color(seg.n));
      })}
      {top.map((seg) => (
        <rect key={`t-${seg.x}`} x={seg.x} y={Y_TOP} width={seg.w} height={NODE_H} rx={3} fill={color(seg.n)} />
      ))}
      <rect x={poolX} y={Y_POOL} width={poolW} height={NODE_H} rx={3} fill="#34d399" />
      <text x={W / 2} y={Y_POOL + NODE_H + 16} textAnchor="middle" fontSize={11} fill="#e6e8ee">
        {lang === 'he' ? 'הכנסות' : 'Income'} <tspan fill="#8b93a7">{money(total, { decimals: 0 })}</tspan>
      </text>
      {bottom.map((seg) => (
        <rect key={`b-${seg.x}`} x={seg.x} y={Y_BOTTOM} width={seg.w} height={NODE_H} rx={3} fill={color(seg.n)} />
      ))}
      {top.map((seg) => label(seg, Y_TOP, false))}
      {bottom.map((seg) => label(seg, Y_BOTTOM, true))}
    </svg>
  );
}

/**
 * The yearly report (research_notes/proposals/yearly-report.md): one page per year, static, every number from the
 * month summaries (so it adds up to Now and Trends). Prints cleanly: the controls and the app's chrome hide in print.
 */
function YearReport() {
  const { t, lang, locale } = useI18n();
  const [year, setYear] = useState(() => new Date().getFullYear());
  const q = useQuery({ queryKey: ['trends-year', year], queryFn: () => api.get<YearlyReport>(`/api/trends/year${qs({ year })}`), placeholderData: (prev) => prev });
  const d = q.data;
  const years = d ? [...new Set([year, ...d.availableYears])].sort((a, b) => b - a) : [year];
  const groupName = (key: string) => (t(`group_${key}` as Key) === `group_${key}` ? key : t(`group_${key}` as Key));
  const short = (m: string) => new Intl.DateTimeFormat(locale, { month: 'short' }).format(new Date(`${m}-01T00:00:00Z`));
  const m0 = (v: number, sign: 'auto' | 'never' = 'never') => money(v, { sign, decimals: 0 });
  const pct = (r: number) => `${Math.round(r * 100)}%`;

  const controls = (
    <div className="flex items-center gap-2 print:hidden">
      <select className="input" style={{ width: 'auto', padding: '0.25rem 0.5rem', fontSize: 14 }} aria-label={t('year_pick')} value={year} onChange={(e) => setYear(Number(e.target.value))}>
        {years.map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </select>
      <button className="btn" onClick={() => window.print()} disabled={!d || d.empty}>
        {t('year_print')}
      </button>
    </div>
  );
  if (q.isPending) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!d || d.empty)
    return (
      <Card title={t('year_title', { y: year })} action={controls}>
        <Empty>{t('year_empty')}</Empty>
      </Card>
    );

  const tt = d.totals;
  const chart = d.months.map((m) => ({ ...m, label: short(m.month) }));
  const maxGroup = Math.max(1, ...d.groups.map((g) => g.total));
  const maxMerchant = Math.max(1, ...d.merchants.map((m) => m.total));
  const arrow = lang === 'he' ? '←' : '→';
  const delta = (now: number, prev: number | null) => {
    if (prev === null || prev === 0) return null;
    const p = Math.round(((now - prev) / prev) * 100);
    if (Math.abs(p) < 5) return null;
    return <span className={`text-xs num ${p > 0 ? 'text-warn' : 'text-pos'}`}>{`${p > 0 ? '+' : '−'}${Math.abs(p)}%`}</span>;
  };
  const nw = d.netWorth;

  return (
    <div className="flex flex-col gap-3 year-report">
      {/* --- the year in one line */}
      <Card
        title={
          <span className="flex items-center gap-2">
            {t('year_title', { y: d.year })}
            {d.partial && <Chip>{t('year_so_far')}</Chip>}
          </span>
        }
        action={controls}
      >
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label={t('year_income')} value={<Amount value={tt.income} tone="pos" decimals={0} />} />
          <Stat label={t('year_spending')} value={<Amount value={tt.spending} tone="neutral" decimals={0} />} />
          <Stat label={t('year_saved')} value={<Amount value={tt.saved} tone={tt.saved >= 0 ? 'pos' : 'neg'} sign="auto" decimals={0} />} />
          <Stat label={t('year_rate')} value={<span className={`num ${tt.savingsRate !== null && tt.savingsRate < 0 ? 'text-neg' : ''}`}>{tt.savingsRate === null ? '–' : pct(tt.savingsRate)}</span>} />
        </div>
        <div className="mt-3 flex flex-col gap-0.5 text-xs text-muted">
          <span>{t('year_months_n', { n: tt.months })}</span>
          {tt.savings > 0 && <span>{t('year_to_savings', { x: m0(tt.savings) })}</span>}
          {tt.paidBack > 0 && <span>{t('year_paid_back', { x: m0(tt.paidBack) })}</span>}
          {d.previous && <span>{t('year_prev_line', { y: d.previous.year, i: m0(d.previous.income), o: m0(d.previous.spending), s: m0(d.previous.saved, 'auto') })}</span>}
        </div>
      </Card>

      {/* --- month by month */}
      <Card title={t('year_months')}>
        <div className="h-48" dir="ltr">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chart} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={2}>
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#8b93a7' }} axisLine={false} tickLine={false} />
              <YAxis hide />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                labelFormatter={(_, p) => (p?.[0]?.payload ? monthLabel((p[0].payload as { month: string }).month, locale) : '')}
                formatter={(v, name) => [m0(Number(v)), t(name === 'income' ? 'trends_income' : 'trends_out')]}
              />
              <Bar dataKey="income" fill="#34d399" radius={[3, 3, 0, 0]} isAnimationActive={false}>
                {chart.map((m) => (
                  <Cell key={m.month} fillOpacity={m.partial ? 0.45 : 0.9} />
                ))}
              </Bar>
              <Bar dataKey="out" fill="#8b93a7" radius={[3, 3, 0, 0]} isAnimationActive={false}>
                {chart.map((m) => (
                  <Cell key={m.month} fillOpacity={m.partial ? 0.45 : 0.9} />
                ))}
              </Bar>
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div className="flex gap-4 text-xs text-muted mt-1 flex-wrap">
          <Legend color="#34d399" label={t('trends_income')} />
          <Legend color="#8b93a7" label={t('trends_out')} />
          {d.partial && <span>· {t('trends_partial')}</span>}
        </div>
        {(d.best || d.worst) && (
          <div className="mt-2 flex flex-col">
            {d.best && (
              <Row>
                <span className="flex-1 text-sm">{t('year_best')}</span>
                <span className="text-sm text-muted">{monthLabel(d.best.month, locale)}</span>
                <Amount value={d.best.net} sign="auto" decimals={0} className="text-sm w-24 text-end" />
              </Row>
            )}
            {d.worst && (
              <Row>
                <span className="flex-1 text-sm">{t('year_worst')}</span>
                <span className="text-sm text-muted">{monthLabel(d.worst.month, locale)}</span>
                <Amount value={d.worst.net} tone={d.worst.net < 0 ? 'neg' : 'auto'} sign="auto" decimals={0} className="text-sm w-24 text-end" />
              </Row>
            )}
          </div>
        )}
      </Card>

      {/* --- where it went */}
      <Card title={t('year_where')} action={d.previous ? <span className="text-xs text-muted">{t('year_vs_prev', { y: d.previous.year })}</span> : undefined}>
        <div className="flex flex-col divide-y divide-border">
          {d.groups
            .filter((g) => g.total > 0)
            .map((g) => (
              <div key={g.key} className="py-2 avoid-break">
                <div className="flex items-center gap-3">
                  <span className="inline-block h-2.5 w-2.5 rounded-full shrink-0" style={{ background: colorOf(g.key) }} />
                  <span className="flex-1 min-w-0 truncate text-sm">{groupName(g.key)}</span>
                  <Meter value={g.total} max={maxGroup} color={colorOf(g.key)} className="w-20 sm:w-32" />
                  <span className="w-14 text-end">{delta(g.total, g.previous)}</span>
                  <Amount value={g.total} tone="neutral" decimals={0} className="text-sm w-24 text-end" />
                </div>
                <div className="ps-5 mt-0.5 flex flex-col">
                  {g.categories.slice(0, 3).map((c) => (
                    <div key={c.key} className="flex items-center gap-3 text-xs text-muted">
                      <span className="flex-1 min-w-0 truncate">{lang === 'he' ? c.nameHe : c.nameEn}</span>
                      <span className="w-14 text-end">{delta(c.total, c.previous)}</span>
                      <Amount value={c.total} tone="muted" decimals={0} className="w-24 text-end" />
                    </div>
                  ))}
                </div>
              </div>
            ))}
        </div>
      </Card>

      {/* --- top merchants */}
      <Card title={t('year_merchants')}>
        {d.merchants.length === 0 ? (
          <Empty>{t('year_nothing')}</Empty>
        ) : (
          <div className="flex flex-col">
            {d.merchants.map((m, i) => (
              <Row key={`${m.merchantId ?? m.name}-${i}`}>
                <span className="w-5 text-xs text-muted num">{i + 1}</span>
                <span className="flex-1 min-w-0">
                  <span className="block truncate text-sm">{m.name}</span>
                  <span className="block text-xs text-muted">{t('year_charges', { n: m.count })}</span>
                </span>
                <Meter value={m.total} max={maxMerchant} className="w-20 sm:w-32" />
                <Amount value={m.total} tone="neutral" decimals={0} className="text-sm w-24 text-end" />
              </Row>
            ))}
          </div>
        )}
      </Card>

      {/* --- fixed costs */}
      <Card title={t('year_fixed')} action={d.fixed.streams.length ? <span className="text-xs text-muted">{t('year_fixed_total', { x: m0(d.fixed.total) })}</span> : undefined}>
        {d.fixed.streams.length === 0 ? (
          <Empty>{t('year_nothing')}</Empty>
        ) : (
          <div className="flex flex-col">
            {d.fixed.streams.map((s) => (
              <Row key={s.id}>
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-1.5 text-sm">
                    <span className="truncate">{s.name}</span>
                    {s.isNew && <Chip tone="pos">{t('year_new')}</Chip>}
                    {s.ended && <Chip>{t('year_ended')}</Chip>}
                  </span>
                  <span className="block text-xs text-muted">{t('year_charges', { n: s.count })}</span>
                </span>
                <Amount value={s.cost} tone="neutral" decimals={0} className="text-sm w-24 text-end" />
              </Row>
            ))}
          </div>
        )}
        {d.fixed.priceChanges.length > 0 && (
          <div className="mt-3">
            <span className="text-xs text-muted uppercase tracking-wide">{t('year_price_changes')}</span>
            {d.fixed.priceChanges.map((p) => (
              <Row key={`${p.streamId}-${p.date}`}>
                <span className="flex-1 min-w-0 truncate text-sm">{p.name}</span>
                <span className="text-xs text-muted">{dayLabel(p.date, locale)}</span>
                <span className={`text-sm flex items-center gap-1 ${p.to > p.from ? 'text-warn' : 'text-pos'}`}>
                  <Amount value={p.from} tone="muted" />
                  <span aria-hidden="true">{arrow}</span>
                  <Amount value={p.to} tone="neutral" />
                </span>
              </Row>
            ))}
          </div>
        )}
      </Card>

      {/* --- big moments */}
      <Card title={t('year_big')}>
        <div className="flex flex-col gap-3">
          <MomentList title={t('year_purchases')} empty={t('year_nothing')}>
            {d.big.purchases.map((p) => (
              <Row key={p.txnId}>
                <span className="flex-1 min-w-0 truncate text-sm">{p.name}</span>
                <span className="text-xs text-muted">{dayLabel(p.date, locale)}</span>
                <Amount value={p.amount} tone="neutral" decimals={0} className="text-sm w-24 text-end" />
              </Row>
            ))}
          </MomentList>
          <MomentList title={t('year_plans')} empty={t('year_nothing')}>
            {d.big.plans.map((p) => (
              <Row key={p.id}>
                <span className="flex-1 min-w-0">
                  <span className="block truncate text-sm">{p.name}</span>
                  <span className="block text-xs text-muted">
                    {dayLabel(p.firstDate, locale)} · {t('year_plan_n', { n: p.totalN })}
                  </span>
                </span>
                <Amount value={p.total} tone="neutral" decimals={0} className="text-sm w-24 text-end" />
              </Row>
            ))}
          </MomentList>
          <MomentList title={t('year_events')} empty={t('year_nothing')}>
            {d.big.events.map((e) => (
              <Row key={e.id}>
                <span className="flex-1 min-w-0">
                  <span className="block truncate text-sm">{e.name}</span>
                  {e.firstDate && <span className="block text-xs text-muted">{e.lastDate && e.lastDate !== e.firstDate ? `${dayLabel(e.firstDate, locale)} – ${dayLabel(e.lastDate, locale)}` : dayLabel(e.firstDate, locale)}</span>}
                </span>
                <Amount value={e.spent} tone="neutral" decimals={0} className="text-sm w-24 text-end" />
              </Row>
            ))}
          </MomentList>
        </div>
      </Card>

      {/* --- net worth */}
      <Card title={t('year_networth')}>
        {!nw.start && !nw.end ? (
          <Empty>{t('year_nw_none')}</Empty>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            <Stat label={t('year_nw_start')} value={nw.start ? <Amount value={nw.start.total} tone="neutral" sign="auto" decimals={0} /> : <span className="text-muted">–</span>} />
            <Stat label={d.partial ? t('year_nw_today') : t('year_nw_end')} value={nw.end ? <Amount value={nw.end.total} tone="neutral" sign="auto" decimals={0} /> : <span className="text-muted">–</span>} />
            <Stat label={t('year_nw_change')} value={nw.start && nw.end ? <Amount value={nw.end.total - nw.start.total} tone={nw.end.total >= nw.start.total ? 'pos' : 'neg'} sign="always" decimals={0} /> : <span className="text-muted">–</span>} />
          </div>
        )}
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="text-xs text-muted truncate">{label}</span>
      <span className="text-lg font-semibold">{value}</span>
    </div>
  );
}

function MomentList({ title, empty, children }: { title: string; empty: string; children: ReactNode[] }) {
  return (
    <div className="avoid-break">
      <span className="text-xs text-muted uppercase tracking-wide">{title}</span>
      {children.length ? <div className="flex flex-col">{children}</div> : <div className="text-sm text-muted py-1">{empty}</div>}
    </div>
  );
}
