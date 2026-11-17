/**
 * Output allow-lists for the tools whose results leave finc (the chat's lookups and the MCP server, design
 * research_notes/proposals/mcp-server.md §5). A tool result is projected onto its shape before `guardEgress` sees it:
 * a key that is not listed, or a value of the wrong type, is dropped. So a field added to a hub function a tool reuses
 * (an account number, a description) cannot reach a model by accident; the projection reports what it dropped, and
 * the tests require that list to be empty for every normal result.
 *
 * A shape is a scalar spec ('num' | 'str' | 'bool', or several joined with '|'), an array of one shape, or an object
 * of shapes. null is accepted everywhere (it carries nothing).
 */

export type Shape = string | readonly [Shape] | { readonly [key: string]: Shape };

const CAT = { key: 'str', he: 'str', en: 'str', group: 'str' } as const;
const CURRENCY_UNKNOWN = { count: 'num', total: 'num', months: 'str', counted: 'str' } as const;
/** keys any object-shaped result may carry */
const COMMON = { error: 'str', method: 'str', note: 'str' } as const;

export const TOOL_SHAPES: Readonly<Record<string, Shape>> = {
  spend_summary: {
    ...COMMON,
    from: 'str',
    to: 'str',
    months: 'num',
    total: 'num',
    monthlyAverage: 'num',
    yearlyEstimate: 'num',
    count: 'num',
    currencyFilter: 'str',
    currencyUnknown: CURRENCY_UNKNOWN,
    category: { kind: 'str', key: 'str', name: 'str', he: 'str' },
    groupBy: 'str',
    groups: [{ name: 'str', he: 'str', total: 'num', count: 'num', monthlyAverage: 'num' }],
    otherGroups: { groups: 'num', total: 'num', count: 'num' },
    paidBackSubtracted: 'num',
    currentMonthSoFar: { month: 'str', total: 'num', count: 'num' },
  },
  month_summary: {
    ...COMMON,
    month: 'str',
    income: 'num',
    fixed: 'num',
    variable: 'num',
    installments: 'num',
    savings: 'num',
    net: 'num',
    transactions: 'num',
    day: 'num',
    leftToSpend: 'num',
    expectedFixedStillToCome: 'num',
    projectedEnd: 'num',
    projectedRange: ['num'],
    regularIncome: 'num',
    extraIncome: 'num',
    leftWithoutExtra: 'num',
    extraExcluded: 'num|bool',
    projectedAll: 'num',
    projectedAllRange: ['num'],
    paidBackToYou: { total: 'num', payments: 'num', countedAgainst: 'str' },
    spendingLimit: { limit: 'num', spent: 'num', usedPct: 'num', pace: 'str', paceDelta: 'num', leftWithinLimit: 'num', thisWeekShare: 'num', spentThisWeek: 'num' },
  },
  compare_periods: {
    ...COMMON,
    month: 'str',
    against: { kind: 'str', month: 'str', from: 'str', to: 'str' },
    group: 'str',
    total: { now: 'num', then: 'num', change: 'num' },
    categories: [{ category: CAT, now: 'num', then: 'num', change: 'num', changePct: 'num' }],
    otherCategories: 'num',
  },
  spend_by_category: {
    ...COMMON,
    group: 'str',
    month: 'str',
    from: 'str',
    to: 'str',
    categories: [{ category: CAT, spent: 'num', count: 'num' }],
  },
  top_merchants: { ...COMMON, from: 'str', to: 'str', merchants: [{ merchant: 'str', spent: 'num', count: 'num' }] },
  find_transactions: {
    ...COMMON,
    from: 'str',
    to: 'str',
    currencyFilter: 'str',
    total: 'num',
    shown: 'num',
    countAll: 'num',
    totalAll: 'num',
    currencyUnknown: CURRENCY_UNKNOWN,
    rows: [{ date: 'str', merchant: 'str', amount: 'num', category: 'str', kind: 'str', currency: 'str', via: 'str', refunded: 'num' }],
  },
  recurring: [{ name: 'str', amount: 'num', frequency: 'str', next: 'str', category: 'str', direction: 'str' }],
  trends: {
    ...COMMON,
    months: [{ month: 'str', income: 'num', out: 'num', net: 'num', variable: 'num', fixed: 'num', partial: 'bool' }],
    groups: [{ group: 'str', perMonth: ['num'], median: 'num' }],
  },
  events: [{ name: 'str', cost: 'num', transactions: 'num', from: 'str', to: 'str' }],
  net_worth: { ...COMMON, total: 'num', assets: 'num', liabilities: 'num', lines: [{ kind: 'str', side: 'str', value: 'num', name: 'str' }] },
};

const scalarOk = (spec: string, v: unknown): boolean =>
  spec.split('|').some((t) => (t === 'num' ? typeof v === 'number' && Number.isFinite(v) : t === 'str' ? typeof v === 'string' : t === 'bool' ? typeof v === 'boolean' : false));

/**
 * The value cut down to its shape. `dropped` collects the path of every key or value left out (paths only, never
 * values, so they may be logged).
 */
export function project(value: unknown, shape: Shape, dropped: string[] = [], path = '$'): unknown {
  if (value === null) return null;
  if (typeof shape === 'string') {
    if (scalarOk(shape, value)) return value;
    dropped.push(path);
    return undefined;
  }
  if (Array.isArray(shape)) {
    if (!Array.isArray(value)) {
      dropped.push(path);
      return undefined;
    }
    const inner = (shape as readonly [Shape])[0];
    return value.map((v, i) => project(v, inner, dropped, `${path}[${i}]`)).filter((v) => v !== undefined);
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    dropped.push(path);
    return undefined;
  }
  const spec = shape as { readonly [key: string]: Shape };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined) continue;
    const s = Object.prototype.hasOwnProperty.call(spec, k) ? spec[k] : undefined;
    if (s === undefined) {
      dropped.push(`${path}.${k}`);
      continue;
    }
    const p = project(v, s, dropped, `${path}.${k}`);
    if (p !== undefined) out[k] = p;
  }
  return out;
}

/** A tool's result on its allow-list; an `{error}` answer of an array-shaped tool keeps just its error. */
export function projectToolResult(tool: string, value: unknown): { value: unknown; dropped: string[] } {
  const shape = TOOL_SHAPES[tool];
  const dropped: string[] = [];
  if (!shape) return { value: { error: 'unknown tool' }, dropped: ['$'] };
  if (Array.isArray(shape) && value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { error?: unknown }).error === 'string') {
    return { value: { error: (value as { error: string }).error }, dropped };
  }
  const v = project(value, shape, dropped);
  return { value: v === undefined ? { error: 'the lookup returned nothing usable' } : v, dropped };
}
