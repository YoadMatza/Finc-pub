/** Shapes returned by the worker's /api (mirrors packages/core/src/hub). Money is in agorot, signed. */
import type { Limits } from './limits';

export interface Bucket {
  count: number;
  sum: number;
}

export interface ExpectedSlot {
  streamId: number;
  merchantId: number;
  categoryId: number | null;
  expectedDate: string;
  amount: number;
  direction: 'income' | 'expense';
  matchedTxnId: number | null;
  status: 'matched' | 'upcoming' | 'missing';
}

export interface MonthSummary {
  month: string;
  view: 'purchase' | 'billing';
  income: Bucket;
  expense: Bucket;
  fixed: Bucket;
  variable: Bucket;
  installments: Bucket;
  savings: Bucket;
  refundsNetted: number;
  excluded: { settlements: Bucket; transfers: Bucket; refunds: Bucket; other: Bucket };
  net: number;
  expectedFixed: ExpectedSlot[];
  expectedFixedRemaining: number;
  expectedIncomeRemaining: number;
  expectedInstallments: Array<{ planId: number; n: number; totalN: number; expectedDate: string; amount: number }>;
  byAccount: Array<{ accountId: number; displayName: string | null; type: string; income: number; out: number; count: number }>;
  byCategory: Array<{ categoryId: number | null; key: string | null; nameHe: string | null; group: string | null; section: string | null; count: number; sum: number }>;
  integrity: { bucketsSum: number; nonExcludedSum: number; ok: boolean; unmatchedSettlementDebits: Array<{ txnId: number; date: string; amount: number; description: string }>; pendingCount: number };
}

export interface Insight {
  key: string;
  kind: 'missing_fixed' | 'refund_matched' | 'uncategorised' | 'candidate' | 'price_change' | 'big_purchase' | 'unusual_charge' | 'sync_error' | 'stale_sync' | 'integrity' | 'suggested_links' | 'over_target';
  severity: 'warn' | 'info' | 'ok';
  amount?: number;
  count?: number;
  name?: string;
  date?: string;
  txnId?: number;
  streamId?: number;
  merchantId?: number;
  categoryId?: number;
  institutionId?: string;
  reference?: number;
}

export interface GroupLine {
  group: string;
  section: string;
  spent: number;
  expected: number;
  count: number;
  basis: string;
}

export interface Txn {
  id: number;
  date: string;
  chargeDate: string | null;
  month: string;
  amount: number;
  netAmount: number;
  originalAmount: number | null;
  originalCurrency: string;
  name: string;
  descriptionRaw: string;
  memo: string | null;
  accountId: number;
  accountName: string | null;
  accountType: string;
  institutionId: string;
  status: string;
  kind: string | null;
  bucket: string;
  excluded: boolean;
  categoryId: number | null;
  categoryKey: string | null;
  categorySource: string | null;
  categoryConfidence: number | null;
  merchantId: number | null;
  installment: { n: number; total: number; planId: number | null } | null;
  streamId: number | null;
  note: string | null;
  refunds: Array<{ linkId: number; txnId: number; date: string; amount: number; zone: string; decision: string | null; description: string }>;
  refundOf: { linkId: number; txnId: number; date: string; amount: number; description: string; zone: string; decision: string | null } | null;
  /** a bank row that pays a card: what it paid (`first` only when it paid exactly one card row) */
  settles?: { count: number; account: string; first?: { txnId: number; description: string; date: string; amount: number } };
  /** a card row paid by a bank settlement */
  settledBy?: { txnId: number; date: string; account: string; count: number };
  /** income rows: this payment's own regular/extra tag; null = follows its category. Absent on an older hub. */
  incomeKind?: IncomeKind | null;
  /** step 3: this incoming payment is money paid back to the owner (counts against day-to-day spending). Absent on an older hub. */
  paidBack?: boolean;
  /** step 3: finc asks whether this payer is paying the owner back. Absent on an older hub. */
  askPaidBack?: boolean;
  /** step 3: paid back because the owner said this payer always pays back (a remembered rule). */
  paidBackByRule?: boolean;
  /** step 3: false when the bank text is shared by several payers, so an answer can cover only this payment. */
  canRemember?: boolean;
  /** split across categories (spending only); the row's own category stays the main one */
  split: boolean;
}

export interface TxnDetail extends Omit<Txn, 'split'> {
  identifier: string | null;
  source: string;
  annotations: Record<string, unknown> | null;
  merchantAliases: string[];
  links: Array<{ id: number; type: string; direction: 'from' | 'to'; otherTxnId: number; otherDate: string; otherDescription: string; otherAmount: number; amount: number; confidence: number; zone: string; decision: string | null; explanation: Array<{ signal: string; score: number; note: string }> }>;
  aiSuggestion: { categoryId: number | null; confidence: number; reason: string | null; model: string } | null;
  events: Array<{ id: number; name: string }>;
  /** the split's parts (negative agorot, adding up exactly to `amount`); null when not split */
  split: SplitPart[] | null;
}

/** One part of a split transaction, as the hub returns it. */
export interface SplitPart {
  categoryId: number;
  categoryKey: string;
  nameHe: string;
  nameEn: string;
  amount: number;
}

export interface TxnPage {
  items: Txn[];
  total: number;
  sum: number;
  netSum: number;
}

export interface Forecast {
  day: number;
  dim: number;
  daysLeft: number;
  isCurrentMonth: boolean;
  early: boolean;
  income: { actual: number; expected: number; total: number };
  committed: { fixedActual: number; fixedExpected: number; installmentsActual: number; installmentsExpected: number; total: number };
  savings: { actual: number; planned: number; total: number };
  variableSpent: number;
  roomBeforeVariable: number;
  left: number;
  variable: { med3: number | null; pace: number; w: number; predicted: number; remaining: number; typicalByToday: number | null };
  projected: { end: number; lo: number; hi: number; lo90: number; hi90: number };
  weekly: { envelope: number | null; spentThisWeek: number; weeksLeft: number };
  state: 'comfortable' | 'tight' | 'short';
}

export interface HubOverview {
  month: string;
  view: 'purchase' | 'billing';
  today: string;
  isCurrentMonth: boolean;
  summary: MonthSummary;
  projected: { end: number; netSoFar: number; incomeRemaining: number; fixedRemaining: number; installmentsRemaining: number; variableRemaining: number; variableBudget: number; variableSpent: number; budgetBasis: 'targets' | 'history' };
  safeToSpend: { perDay: number; daysLeft: number; remaining: number };
  breakdown: GroupLine[];
  forecast: Forecast;
  accuracy: { monthsEvaluated: number; insideBand: number; maeEnd: number | null; maeVariable: number | null };
  /** what moved "left to spend" since the last daily snapshot; null until a second day is logged */
  change: { since: string; before: number; now: number; delta: number; arrived: Array<{ name: string; amount: number; date: string }>; arrivedCount: number; arrivedSum: number } | null;
  comparison: { lastMonthSameDay: number; lastMonthTotal: number; typicalSameDay: number | null; dayOfMonth: number; prevMonth: string };
  attention: Insight[];
  upcoming: Array<{ date: string; amount: number; name: string; kind: 'fixed' | 'installment' | 'income'; streamId?: number; planId?: number; status: 'upcoming' | 'missing' }>;
  recent: Txn[];
  daily: Array<{ date: string; out: number; cumulative: number }>;
  months: { first: string; last: string };
  /** now-screen step 1 (all optional: absent on an older hub) */
  incomeSplit?: IncomeSplit;
  withoutExtra?: WithoutExtra;
  typical?: TypicalMonth | null;
  spread?: SpreadInfo;
  explain?: ExplainTerm[];
  /** now-screen step 2: the monthly spending limit; null = no limit set (or a future month); absent on an older hub */
  limit?: SpendLimit | null;
  /** now-screen step 3: payments paid back to the owner this month; absent on an older hub */
  paidBack?: PaidBack;
}

/** Money paid back to the owner this month (agorot, total positive); counted against day-to-day spending. */
export interface PaidBack {
  total: number;
  /** byRule: counted because the owner said this payer always pays back */
  items: Array<{ id: number; name: string; amount: number; date: string; byRule: boolean }>;
}

/** POST /api/transactions/:id/paid-back */
export type PaidBackAnswer = 'always' | 'once' | 'no' | 'no_once' | 'undo';

/**
 * The monthly limit on day-to-day (variable) spending; amounts agorot. delta = spent − byToday (positive = ahead of
 * pace); leftWithin negative = over the limit; week null for past months; targets null when no category targets.
 */
export interface SpendLimit {
  amount: number;
  spent: number;
  usedPct: number;
  pace: { byToday: number; delta: number; state: 'on' | 'ahead' | 'under' };
  leftWithin: number;
  over: boolean;
  week: { limit: number; spent: number } | null;
  targets: { sum: number; exceeds: boolean } | null;
}

export type IncomeKind = 'regular' | 'extra';

/** This month's income by kind; amounts agorot. `kinds` maps income category keys to their kind. */
export interface IncomeSplit {
  regular: { received: number; expected: number };
  extra: { received: number; expected: number; items: Array<{ id: number | null; name: string; amount: number; date: string; categoryKey: string | null; status?: 'received' | 'expected'; askPaidBack?: boolean; canRemember?: boolean }> };
  kinds: Record<string, IncomeKind>;
}

/** What the month leaves on regular income alone (agorot) and how it reads */
export interface WithoutExtra {
  left: number;
  tone: 'positive' | 'balanced' | 'short';
}

/** Median of the last complete months (agorot) */
export interface TypicalMonth {
  months: number;
  income: number;
  regularIncome: number;
  fixed: number;
  variable: number;
}

/** Whether a large extra income is left out of the weekly envelope and the projection, and the figures with it */
export interface SpreadInfo {
  extraExcluded: boolean;
  reason: 'large_extra' | null;
  /** the owner chose to spread a large extra into the weekly amount this month (newer hub) */
  extraIncluded?: boolean;
  /** the forecast state on regular income alone, when the extra is kept out (newer hub) */
  stateRegular?: Forecast['state'];
  /** the weekly envelope on regular income alone; null when the regular part leaves nothing (newer hub) */
  weeklyRegular?: number | null;
  weeklyAll: number | null;
  projectedAll: { end: number; lo: number; hi: number } | null;
}

export type ExplainKey =
  | 'income_regular_received'
  | 'income_regular_expected'
  | 'income_extra_received'
  | 'income_extra_expected'
  | 'fixed_paid'
  | 'fixed_expected'
  | 'installments_paid'
  | 'installments_expected'
  | 'savings_actual'
  | 'savings_planned'
  | 'variable_spent';

/** One term of "how is this calculated": income positive, the rest negative; the terms add up to the headline */
export interface ExplainTerm {
  key: ExplainKey | (string & {});
  amount: number;
  items: Array<{ id: number | null; name: string; amount: number; date: string | null; status: 'received' | 'expected' | 'paid' }>;
  /** items not listed */
  more?: number;
}

export interface ChatStatus {
  provider: 'anthropic' | 'openai' | 'local' | null;
  model: string | null;
  baseUrl: string | null;
  vaultLocked: boolean;
  keyInVault: boolean;
  ready: boolean;
}
export interface ChatResult {
  answer: string;
  steps: Array<{ tool: string; args: Record<string, unknown>; summary: string }>;
  model: string;
  rounds: number;
  /** chat v2 step 4: up to 3 questions to offer as chips under the answer. Absent from older workers. */
  followUps?: string[];
}

export interface HoldingView {
  /** holding_snapshot row id; live rows point at it (two USD rows can share a symbol) */
  id?: number;
  kind: 'security' | 'currency';
  symbol: string;
  name: string;
  quantity: number;
  price: number | null;
  currency: string;
  valueIls: number;
  valueOrig: number | null;
  costPrice: number | null;
  dailyChangePct: number | null;
  fromCostPct: number | null;
  history: Array<{ date: string; valueIls: number }>;
  share: number;
  /** how many of the owner's own rules apply to this holding now (stock decision aids A); absent on an older hub */
  rulesApplying?: number;
}
export interface HoldingsOverview {
  accountId: number;
  takenAt: string | null;
  totalIls: number;
  positions: HoldingView[];
  history: Array<{ date: string; totalIls: number }>;
  /** live market prices on top of the bank's snapshot; missing on an older hub */
  live?: LiveHoldings;
}

export type MarketState = 'open' | 'closed' | 'unavailable';
export type LiveState = 'live' | 'closed';
/** One position priced live (or by the bank when no live price). *Orig are in the position's currency (major units); *Ils are agorot. */
export interface LiveHoldingRow {
  /** holding_snapshot row id of the position this prices */
  id?: number;
  symbol: string;
  source: 'live' | 'bank';
  price: number | null;
  prevClose: number | null;
  currency: string;
  valueOrig: number | null;
  valueIls: number;
  gainOrig: number | null;
  gainPct: number | null;
  dayChangeOrig: number | null;
  dayChangePct: number | null;
}
export interface LiveHoldings {
  asOf: string | null;
  marketState: MarketState;
  fx: { pair: 'USD/ILS'; rate: number; at: string } | null;
  rows: LiveHoldingRow[];
  /** agorot */
  totalIls: number;
  /** agorot */
  gainIls: number | null;
  /** agorot */
  dayChangeIls: number | null;
  /** percent, from the server (not recomputed here) */
  gainPct?: number | null;
  dayChangePct?: number | null;
  /** today's change includes the move of the dollar rate */
  dayChangeIncludesFx?: boolean;
  /** how the gain since purchase is measured: in dollars, converted at today's rate */
  gainBasis?: 'usd_at_today_rate';
}

export interface NetWorthLine {
  key: string;
  name: string;
  kind: string;
  side: 'asset' | 'liability';
  value: number;
  asOf: string | null;
  source: 'snapshot' | 'cards' | 'manual';
  accountId?: number;
  manualId?: number;
  currency: string;
  /** securities / FX accounts on a newer hub: value at live prices (agorot) */
  liveValueIls?: number;
  liveAsOf?: string;
  liveState?: LiveState;
}
export interface ManualHolding {
  id: number;
  name: string;
  kind: string;
  side: 'asset' | 'liability';
  currency: string;
  note: string | null;
  archived: boolean;
  value: number | null;
  asOf: string | null;
  history: Array<{ date: string; value: number }>;
}
export interface NetWorthOverview {
  today: string;
  total: number;
  assets: number;
  liabilities: number;
  lines: NetWorthLine[];
  history: Array<{ date: string; total: number; assets: number; liabilities: number }>;
  manual: ManualHolding[];
}

export interface EventView {
  id: number;
  name: string;
  note: string | null;
  fromDate: string | null;
  toDate: string | null;
  archived: boolean;
  count: number;
  spent: number;
  income: number;
  net: number;
  firstDate: string | null;
  lastDate: string | null;
  byGroup: Array<{ group: string; sum: number }>;
  byCategory: Array<{ key: string | null; nameHe: string | null; nameEn: string | null; sum: number; count: number }>;
}

export interface TrendMonth {
  month: string;
  income: number;
  fixed: number;
  variable: number;
  installments: number;
  savings: number;
  out: number;
  net: number;
  partial: boolean;
}
export interface TrendSeries {
  key: string;
  section: string;
  series: number[];
  total: number;
  median: number;
  last: number;
  prev: number;
}
export interface CategorySeries extends TrendSeries {
  nameHe: string;
  nameEn: string;
  group: string;
}
export interface SankeyNode {
  key: string;
  kind: 'income' | 'paid_back' | 'pool' | 'group' | 'category' | 'left' | 'deficit';
  nameHe: string;
  nameEn: string;
}
export interface TrendsOverview {
  months: TrendMonth[];
  groups: TrendSeries[];
  categories: CategorySeries[];
  sankey: { month: string; nodes: SankeyNode[]; links: Array<{ source: number; target: number; value: number }> };
  yoy: {
    rows: Array<{ month: string; now: { income: number; out: number; net: number } | null; then: { income: number; out: number; net: number } | null }>;
    now: { income: number; out: number; net: number; months: number };
    then: { income: number; out: number; net: number; months: number };
  };
  story: { months: number; variableFirst: number; variableLast: number; netSum: number } | null;
}

/** GET /api/trends/year (packages/core/src/hub/yearly.ts): amounts in agorot, positive unless named signed. */
export interface YearMonth {
  month: string;
  income: number;
  spending: number;
  savings: number;
  out: number;
  net: number;
  partial: boolean;
  hasData: boolean;
}
export interface YearlyReport {
  year: number;
  today: string;
  view: 'purchase' | 'billing';
  partial: boolean;
  empty: boolean;
  availableYears: number[];
  months: YearMonth[];
  totals: { income: number; spending: number; savings: number; out: number; net: number; saved: number; savingsRate: number | null; paidBack: number; months: number };
  best: { month: string; net: number } | null;
  worst: { month: string; net: number } | null;
  previous: { year: number; months: number; income: number; spending: number; saved: number } | null;
  groups: Array<{ key: string; section: string; total: number; previous: number | null; categories: Array<{ key: string; nameHe: string; nameEn: string; total: number; previous: number | null }> }>;
  merchants: Array<{ merchantId: number | null; name: string; total: number; count: number }>;
  fixed: {
    total: number;
    streams: Array<{ id: number; name: string; frequency: string; state: string; cost: number; count: number; firstDate: string; lastDate: string; isNew: boolean; ended: boolean }>;
    priceChanges: Array<{ streamId: number; name: string; from: number; to: number; date: string }>;
  };
  big: {
    purchases: Array<{ txnId: number; date: string; name: string; amount: number }>;
    plans: Array<{ id: number; name: string; firstDate: string; totalN: number; total: number }>;
    events: Array<{ id: number; name: string; spent: number; net: number; firstDate: string | null; lastDate: string | null; count: number }>;
  };
  netWorth: { start: { date: string; total: number; assets: number; liabilities: number } | null; end: { date: string; total: number; assets: number; liabilities: number } | null };
}

export interface Health {
  version: string;
  vault: 'unlocked' | 'locked' | 'missing';
  syncRunning: boolean;
  nextRunAt: string | null;
  connections: Array<{ institutionId: string; displayName: string; kind: string; enabled: boolean; lastOkAt: string | null; lastError: string | null; lastErrorAt: string | null; consecutiveFailures: number; nextRunAt: string | null; lastRun: { id: number; status: string; startedAt: string; endedAt: string | null; rowsSeen: number; rowsNew: number; errorType: string | null } | null; accounts: Array<{ id: number; displayName: string | null; type: string; txns: number; pending: number; oldestTxnDate: string | null; newestTxnDate: string | null; latestBalance: { balance: number; takenAt: string; source: string } | null }> }>;
}

export interface CategoryView {
  id: number;
  key: string;
  nameHe: string;
  nameEn: string;
  group: string;
  section: string;
  icon: string | null;
  track: boolean;
  monthlyTarget: number | null;
  sortOrder: number;
  spent: number;
  count: number;
  paceTarget: number | null;
  sparkline: Array<{ month: string; sum: number }>;
  topMerchants: Array<{ merchantId: number | null; name: string; sum: number; count: number }>;
}

export interface CategoriesOverview {
  month: string;
  elapsedShare: number;
  groups: Array<{ key: string; section: string; spent: number; target: number | null; groupTarget: number | null; categories: CategoryView[] }>;
}

export interface StreamView {
  id: number;
  state: string;
  stateSource: string;
  direction: 'income' | 'expense';
  frequency: string;
  expectedAmount: number;
  amountTolerance: number;
  amountModel: string;
  originalCurrency: string | null;
  expectedOriginalAmount: number | null;
  expectedDay: number | null;
  nextExpectedDate: string | null;
  lastTxnDate: string | null;
  occurrences: number;
  label: string | null;
  merchantId: number;
  merchantName: string;
  accountId: number;
  accountName: string | null;
  categoryId: number | null;
  categoryKey: string | null;
  firstDate: string | null;
  lastAmount: number | null;
  yearly: number;
  runningMonths: number;
  thisMonth: { status: 'matched' | 'upcoming' | 'missing' | 'none'; expectedDate: string | null; matchedTxnId: number | null; actualAmount: number | null };
  priceChange: { from: number; to: number; date: string } | null;
}

export interface PlanView {
  id: number;
  merchantId: number | null;
  merchantName: string;
  accountId: number;
  accountName: string | null;
  totalN: number;
  seenN: number;
  sliceAmount: number;
  originalAmount: number | null;
  firstDate: string;
  status: string;
  remainingN: number;
  remainingAmount: number;
  nextDate: string | null;
  endsMonth: string | null;
  thisMonth: { status: 'matched' | 'upcoming' | 'missing' | 'none'; n: number | null; txnId: number | null };
}

/** GET /api/calendar (core hub/calendar.ts) */
export interface CalendarItem {
  date: string;
  kind: 'fixed' | 'income' | 'installment' | 'card_bill';
  name: string;
  amount: number;
  expected?: number;
  status: 'paid' | 'upcoming' | 'missing';
  via: 'card' | 'bank';
  streamId?: number;
  planId?: number;
  accountId?: number;
  txnId?: number;
  count?: number;
}
export interface CalendarDay {
  date: string;
  items: CalendarItem[];
  out: number;
  in: number;
}
export interface BillCalendar {
  month: string;
  today: string;
  isCurrentMonth: boolean;
  days: CalendarDay[];
  totals: { out: number; in: number; paidOut: number; toComeOut: number; toComeIn: number };
  balance?: { start: number; asOf: string; points: Array<{ date: string; balance: number }>; lowest: { date: string; balance: number } };
}

export interface RecurringOverview {
  month: string;
  streams: StreamView[];
  plans: PlanView[];
  audit: { yearlySubscriptions: number; monthlyFixed: number; monthlyIncome: number; overAYear: number; priceChanges: number };
}

export interface ReviewInbox {
  counts: { suggestedLinks: number; uncategorised: number; lowConfidence: number; candidates: number; overdue: number; exclusions: number; gapCycles: number };
  suggestedLinks: Array<{ linkId: number; type: string; confidence: number; from: TxnLite; to: TxnLite; explanation: Array<{ signal: string; score: number; note: string }> }>;
  uncategorised: Array<{ merchantId: number | null; name: string; rows: number; spend: number; lastDate: string; sampleTxnId: number; ai: { categoryId: number | null; confidence: number; reason: string | null } | null }>;
  lowConfidence: Array<{ merchantId: number; name: string; rows: number; categoryId: number; categoryKey: string; confidence: number; reason: string | null; sampleTxnId: number }>;
  candidates: Array<{ streamId: number; merchantId: number; name: string; frequency: string; expectedAmount: number; occurrences: number; lastDate: string | null; categoryKey: string | null }>;
  overdue: Array<{ streamId: number; name: string; expectedDate: string; amount: number; frequency: string }>;
  exclusions: Array<{ txnId: number; date: string; amount: number; name: string; comment: string | null }>;
  gapCycles: Array<{ linkId: number; date: string; bankAmount: number; txnId: number }>;
}

export interface TxnLite {
  id: number;
  date: string;
  amount: number;
  name: string;
  accountName: string | null;
}

export interface AccountsOverview {
  accounts: Array<{
    id: number;
    institutionId: string;
    displayName: string | null;
    type: string;
    last4: string | null;
    currency: string;
    balance: { amount: number; takenAt: string; source: string } | null;
    balanceHistory: Array<{ date: string; balance: number }>;
    txns: number;
    pending: number;
    newestTxnDate: string | null;
    card: { nextBillingDate: string | null; nextBillingAmount: number; nextBillingRows: number; lastBillingDate: string | null; lastBillingAmount: number; cycleSpend: number } | null;
    /** securities / FX accounts on a newer hub: value at live prices (agorot) */
    liveValueIls?: number;
    liveAsOf?: string;
    liveState?: LiveState;
  }>;
  connections: Health['connections'];
  runs: Array<{ id: number; institutionId: string; source: string; trigger: string; startedAt: string; endedAt: string | null; status: string; rowsSeen: number; rowsNew: number; rowsUpdated: number; errorType: string | null; error: string | null }>;
}

export interface Settings {
  version: string;
  language: 'he' | 'en';
  pinSet: boolean;
  ai: {
    provider: 'anthropic' | 'openai' | 'local' | null;
    model: string | null;
    baseUrl: string | null;
    /** the chat's own model (chat v2 step 4), null = the chat uses `model`. Absent from older workers. */
    chatModel?: string | null;
    /** the chat-model tiers offered for this provider; null for local / none */
    chatModels?: { fast: string; better: string } | null;
  };
  schedule: { times: string[]; jitterMinutes: number; timezone: string; monthsBack: number };
  vault: 'unlocked' | 'locked' | 'missing';
  cashflow: { month: string; salaryShift: string; cardView: string };
  publicUrl: string | null;
  trusted: boolean;
  via: 'session' | 'token' | 'device' | 'passkey' | 'none';
  /** Paired devices unused this many days are removed automatically; 0 = never (P1-09). Absent from older workers. */
  deviceIdleDays?: number;
  /** /lockdown works from Telegram (the alarm bot is set up). Absent from older workers: read as false. */
  lockdownTelegram?: boolean;
  /** Caps away from home (P2-02). Absent from older workers: unknown, read through readLimits(). */
  limits?: Limits;
  /** income category key → regular | extra (now-screen step 1). Absent from older workers. */
  incomeKinds?: Record<string, IncomeKind>;
  /** the monthly spending limit for the current month (agorot; null = off). Absent from older workers. */
  spendLimit?: { month: string; amount: number | null };
}

export type AlertType = 'sync_error' | 'stale_sync' | 'otp_needed' | 'missing_fixed' | 'big_purchase' | 'instalment_purchase' | 'card_bill_gap' | 'card_testing' | 'unusual_charge' | 'refund_matched' | 'over_target' | 'price_change' | 'candidate' | 'uncategorised' | 'weekly_summary' | 'spend_limit';
export interface AlertsPayload {
  /** amounts: whole shekels; money out from `big` is alerted, from `urgent` it goes out even in quiet hours */
  config: { matrix: Record<AlertType, { telegram: boolean }>; quiet: { from: string; to: string } | null; weekly: { day: number; hour: number }; amounts: { big: number; urgent: number }; unusualFactor: number; telegramChatId: string | null };
  telegram: { tokenInVault: boolean; tokenValid: boolean | null; bot: string | null; chatId: string | null; vaultLocked: boolean };
  quietNow: boolean;
  recent: Array<{ id: number; type: string; key: string; channel: string; text: string; ok: boolean; error: string | null; sentAt: string }>;
  /** Alert settings and the chat binding change only from home (P0-02). Absent from older workers. */
  canEdit?: boolean;
}

export interface Device {
  id: number;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
  lastAddress: string | null;
  revokedAt: string | null;
  /** Why it was removed (P1-09): by hand, unused too long, or "lock everything". Absent from older workers. */
  revokedReason?: 'removed' | 'expired' | 'panic' | null;
  userAgent: string | null;
}

/** POST /api/panic: how many paired devices and sessions were ended, and whether the vault is now locked. */
export interface PanicResult {
  /** false after a partial failure (the status is still 200): read this, not the HTTP status */
  ok: boolean;
  devices: number;
  sessions: number;
  passkeys: number;
  vaultLocked: boolean;
  /** whether the security alert went out (Telegram) */
  alerted: boolean;
  /** what failed, when ok is false */
  errors?: string[];
}

export interface DevicesPayload {
  devices: Device[];
  pendingCodes: number;
  publicUrl: string;
  trusted: boolean;
}

/** Whether passkey sign-in is set up: the public address is set and at least one passkey exists. */
export interface PasskeysInfo {
  available: boolean;
  rpId: string | null;
}

export interface Passkey {
  id: number | string;
  name: string;
  rpId: string;
  deviceType: string;
  /** synced through the phone's password manager (multi-device passkey) */
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface PasskeysPayload extends PasskeysInfo {
  passkeys: Passkey[];
}

export interface PasskeyEnrollCode {
  code: string;
  url: string;
  expiresInMin: number;
}

export interface Pairing {
  code: string;
  expiresAt: string;
  url: string;
}

export interface Rule {
  id: number;
  priority: number;
  enabled: boolean;
  conditions: Record<string, unknown>;
  actions: Record<string, unknown>;
  note: string | null;
  merchantName: string | null;
  categoryKey: string | null;
  createdAt: string;
}

/** One row of GET /api/security-events (newest first). `at` is ISO UTC. */
export interface SecurityEvent {
  id: number;
  at: string;
  kind: string;
  /** 'pc' | 'device:<id>' | 'passkey:<id>' | 'telegram' | 'cli' | 'control' | 'public' | 'system' */
  actor: string;
  actorName: string | null;
  address: string | null;
  detail: string | null;
}
export interface SecurityEventsPage {
  events: SecurityEvent[];
  /** pass as ?before= for the next (older) page; null when there is none */
  nextBefore: number | null;
}

/**
 * GET /api/holdings/:id/insights (stock insights step 1, design research_notes/proposals/stock-insights.md §3 B–D).
 * Percent numbers are percents (12.3 = 12.3%); prices are in the holding's currency, major units.
 * Every number is computed by the hub from Yahoo daily closes; only the symbol leaves the PC.
 */
export interface InsightReturns {
  m1: number | null;
  m3: number | null;
  m6: number | null;
  y1: number | null;
  /** 3 years, annualised */
  y3Ann: number | null;
}
export type InsightReturnKey = keyof InsightReturns;
export interface InsightDrawdown {
  /** the fall from the peak, in percent (negative, e.g. −23.4) */
  pct: number;
  peakDate: string;
  troughDate: string;
}
export interface InsightPoint {
  d: string;
  c: number;
  sma50: number | null;
  sma200: number | null;
}
export interface HoldingInsights {
  id: number;
  symbol: string;
  name: string;
  currency: string;
  /** the last trading session in the series (YYYY-MM-DD) */
  asOf: string | null;
  /** when the hub fetched it (ISO) */
  fetchedAt: string;
  source: 'yahoo';
  instrumentType: string | null;
  crossCheck: {
    bankPrice: number | null;
    bankAt: string | null;
    yahooClose: number | null;
    /** the date of the Yahoo bar compared with the bank's price */
    yahooDate?: string | null;
    diffPct: number | null;
    ok: boolean | null;
    /** the bank's price was taken during the session (evening sync): not compared, ok is null */
    note?: 'intraday_snapshot';
  };
  trend: {
    price: number | null;
    sma50: number | null;
    sma200: number | null;
    vsSma50Pct: number | null;
    vsSma200Pct: number | null;
    /** consecutive days on the current side of the 200-day average; negative = days below */
    daysAboveSma200: number | null;
    /** the history ran out before the side changed: the count is a minimum */
    daysAboveSma200IsLowerBound?: boolean;
    high52: number | null;
    low52: number | null;
    fromHigh52Pct: number | null;
    fromLow52Pct: number | null;
  };
  returns: InsightReturns;
  benchmark: { symbol: 'SPY'; returns: InsightReturns; diffPts: InsightReturns } | null;
  risk: { volatility1y: number | null; maxDrawdown1y: InsightDrawdown | null; maxDrawdown5y: InsightDrawdown | null; beta1y: number | null };
  series: InsightPoint[];
  events: { dividends: Array<{ d: string; amount: number }>; splits: Array<{ d: string; ratio: string | number }> };
  /** set when the hub could not build the analytics (reason); the rest may be empty */
  unavailable?: string;
  /** why, as a code the app translates; `unavailable` is the English fallback */
  unavailableCode?: InsightUnavailableCode;
  /** step 2 (§3 E): the company's own figures from SEC EDGAR; null for funds or when unavailable */
  company: InsightCompany | null;
  /** why `company` is null (only then), when it is not simply a fund */
  companyUnavailableCode?: InsightCompanyUnavailableCode;
  /** step 2 (§3 F): recent SEC filings, newest first ([] when none) */
  filings: InsightFiling[];
  /** step 2 (§3 C): the company's sector fund (SPDR) over the same periods */
  sector: InsightSector | null;
  /** the owner's own rules evaluated for this holding (stock decision aids A); absent on an older hub */
  rules?: HoldingRuleResult[];
  /** decision aids E: one documented reading per source and where they agree; absent on an older hub */
  signals?: SignalsBoard;
  /** decision aids B: the analysts' published ratings (Finnhub), latest month; null when unavailable, absent on an older hub */
  analysts?: InsightAnalysts | null;
  /** why `analysts` is null, when known */
  analystsUnavailableCode?: InsightAnalystsUnavailableCode;
  /** decision aids B: the next and the last earnings report (Finnhub); null when unavailable */
  earnings?: InsightEarnings | null;
}

export type InsightAnalystsUnavailableCode = 'off' | 'no_key' | 'vault_locked' | 'not_covered' | 'busy' | 'unreachable' | 'invalid' | 'too_few';

/** One month of analyst ratings: counts per category; shares in percent (0–100) of the total. */
export interface InsightAnalystCounts {
  /** YYYY-MM */
  period: string;
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
  total: number;
  /** strong buy + buy, of the total */
  buyShare: number;
  /** sell + strong sell, of the total */
  sellShare: number;
}

export interface InsightAnalysts extends InsightAnalystCounts {
  /** the month 3 months before `period`, when Finnhub has it */
  prev3m: InsightAnalystCounts | null;
  /** buy share now minus 3 months ago, in points (+ = more buy ratings) */
  buyShareChange3mPts: number | null;
  fetchedAt: string;
  /** a cached copy the hub could not refresh */
  stale?: boolean;
  source: 'finnhub';
}

export interface InsightEarnings {
  next: { date: string; hour: 'bmo' | 'amc' | 'dmh' | null; epsEstimate: number | null } | null;
  last: { date: string; epsActual: number; epsEstimate: number | null; surprisePct: number | null } | null;
  fetchedAt: string;
  /** a cached copy the hub could not refresh */
  stale?: boolean;
}
export type InsightUnavailableCode = 'off' | 'not_covered' | 'busy' | 'unreachable' | 'unknown_symbol' | 'invalid';

export type InsightCompanyUnavailableCode = 'off' | 'not_covered' | 'busy' | 'unreachable' | 'invalid';

/** One company figure with where it came from. Money in the filer's currency, major units; percents as 12.3. */
export interface InsightFigure {
  value: number;
  /** 'USD' (or the filer's currency, e.g. 'EUR'), 'USD/shares' (per share), 'shares', '%', 'x', 'ratio' */
  unit: string;
  /** the period end (YYYY-MM-DD): the last day of the 12 months / year, or the balance-sheet date */
  periodEnd: string | null;
  basis: 'ttm' | 'annual' | 'instant' | 'derived';
  form: string | null;
  /** the filing date (YYYY-MM-DD) */
  filed: string | null;
  accn: string | null;
}

export interface InsightCompanyFigures {
  revenueTtm: InsightFigure | null;
  revenueYoYPct: InsightFigure | null;
  netIncomeTtm: InsightFigure | null;
  netIncomeYoYPct: InsightFigure | null;
  netMarginPct: InsightFigure | null;
  netMarginPct1yAgo: InsightFigure | null;
  netMarginPct3yAgo: InsightFigure | null;
  epsTtm: InsightFigure | null;
  pe: InsightFigure | null;
  cash: InsightFigure | null;
  /** loans and bonds, leases excluded */
  totalDebt: InsightFigure | null;
  /** finance lease liabilities, when reported */
  financeLeases: InsightFigure | null;
  debtToEquity: InsightFigure | null;
  sharesOutstanding: InsightFigure | null;
  sharesChange1yPct: InsightFigure | null;
}
export type InsightFigureKey = keyof InsightCompanyFigures;

export interface InsightCompany {
  name: string;
  cik: string | number;
  sic: string | number | null;
  sicDescription: string | null;
  /** the filer's reporting currency; null when it filed no XBRL figures */
  currency: string | null;
  figures: InsightCompanyFigures;
  /** what was adjusted or left out, by code; `figure` names the figure it is about (null = the whole section) */
  notes: InsightCompanyNote[];
}

export interface InsightCompanyNote {
  code: string;
  figure: InsightFigureKey | null;
  /** the hub's English text, shown for codes the app does not know */
  text: string;
}

export interface InsightFiling {
  form: string;
  filed: string;
  reportDate: string | null;
  title: string | null;
  /** 8-K items as "<code> <English title>" ("2.02 Results of operations"), or a bare code for unknown ones */
  items: string[];
  url: string;
}

export interface InsightSector {
  symbol: string;
  name: string;
  returns: InsightReturns;
  diffPts: InsightReturns;
}

/**
 * Stock decision aids, part A: the owner's own rules. A rule is a fixed template + the owner's numbers + a scope
 * (null = all holdings). finc only reports whether a rule applies; it never says what to do.
 */
export type HoldingRuleTemplateId =
  | 'below_cost_pct'
  | 'above_cost_pct'
  | 'below_sma200_sessions'
  | 'above_sma200_sessions'
  | 'from_high52_pct'
  | 'day_move_pct'
  | 'drop_1m_pct'
  | 'drop_3m_pct'
  | 'lag_spy_1y_pts'
  | 'pe_above'
  | 'pe_below'
  | 'revenue_yoy_below'
  | 'margin_drop_pts'
  | 'dilution_pct'
  | 'concentration_pct'
  | 'analysts_toward_buy_pts'
  | 'analysts_toward_sell_pts'
  | 'earnings_within_days';

export interface HoldingRule {
  id: number;
  /** a HoldingRuleTemplateId; a newer hub may send one this app does not know */
  template: string;
  params: Record<string, number>;
  scopeSymbol: string | null;
  notify: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface HoldingRuleParamSpec {
  key: string;
  kind: 'pct' | 'int' | 'number';
  min: number;
  max: number;
  default: number;
}

export interface HoldingRuleTemplate {
  id: string;
  params: HoldingRuleParamSpec[];
}

export interface HoldingRulesPayload {
  rules: HoldingRule[];
  templates: HoldingRuleTemplate[];
  /** the symbols a rule can be scoped to (the owner's securities) */
  symbols: string[];
}

export interface HoldingRuleInput {
  template: string;
  params: Record<string, number>;
  scopeSymbol?: string | null;
  notify?: boolean;
  enabled?: boolean;
}

export type HoldingRuleState = 'applies' | 'clear' | 'unknown';

/** decision aids E (core insights/signals.ts) */
export type SignalKey = 'trend' | 'market' | 'company' | 'analysts' | 'news';
export type SignalReading = 'up' | 'down' | 'mixed' | 'ahead' | 'behind' | 'in_line' | 'growing' | 'shrinking' | 'positive' | 'negative' | 'unavailable';
export interface BoardSignal {
  key: SignalKey;
  reading: SignalReading;
  direction: 1 | -1 | 0 | null;
  facts: Record<string, number | null>;
  why?: 'no_data' | 'not_built' | 'etf';
}
export interface SignalsBoard {
  signals: BoardSignal[];
  rules: { apply: number; checked: number; total: number };
  agreement: 'agree' | 'disagree' | 'none';
  favourable: SignalKey[];
  unfavourable: SignalKey[];
}

export interface HoldingRuleResult {
  ruleId: number;
  template: string;
  params: Record<string, number>;
  scopeSymbol: string | null;
  state: HoldingRuleState;
  /** the value the rule was checked against (percent as 27.3, sessions, points, P/E); null when unknown */
  value: number | null;
  /** where the value came from (a plain string from an older hub), or null */
  source: HoldingRuleSource | string | null;
  /** when the rule started to apply (ISO date or time), or null */
  since: string | null;
  /** only for `unknown`: the last state the hub could check, and when */
  lastKnownState?: HoldingRuleState | null;
  lastKnownAt?: string | null;
}

/** The source of a rule's value: live price, bank snapshot, Yahoo daily bar, SEC filing, the holdings totals or Finnhub. */
export interface HoldingRuleSource {
  kind: 'live' | 'bank' | 'yahoo' | 'sec' | 'holdings' | 'finnhub';
  /** YYYY-MM-DD (or ISO) of the bar, snapshot or filing */
  date: string | null;
  /** HH:MM (or ISO) of a live price or bank snapshot */
  time: string | null;
  /** the SEC form, e.g. "10-Q" */
  form: string | null;
}
