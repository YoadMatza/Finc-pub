/**
 * SQLite schema, Phase 1 subset of architecture §4.
 *
 * Conventions (§4a):
 *  - money is stored as INTEGER minor units (agorot / cents), signed: negative = out, positive = in
 *  - dates are 'YYYY-MM-DD' text; timestamps are ISO-8601 text (UTC)
 *  - raw_transaction is immutable apart from last_seen bookkeeping
 */
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const institution = sqliteTable('institution', {
  id: text('id').primaryKey(), // beinleumi | isracard | max | riseup | manual
  kind: text('kind').notNull(), // bank | card | aggregator | manual
  scraperId: text('scraper_id'),
  displayName: text('display_name').notNull(),
});

export const account = sqliteTable('account', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  institutionId: text('institution_id')
    .notNull()
    .references(() => institution.id),
  type: text('type').notNull(), // checking | credit_card | savings | loan | cash
  displayName: text('display_name'),
  last4: text('last4'),
  currency: text('currency').notNull().default('ILS'),
  billingDay: integer('billing_day'),
  settlesToAccountId: integer('settles_to_account_id'),
  createdAt: text('created_at').notNull(),
});

/** Maps each source's own account identifier onto one account row (§4a). */
export const accountAlias = sqliteTable(
  'account_alias',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => account.id),
    source: text('source').notNull(), // scraper:max | riseup | import:<label>
    externalId: text('external_id').notNull(),
  },
  (t) => [uniqueIndex('account_alias_source_external').on(t.source, t.externalId)],
);

/** Connection status only; credentials live in the vault file. */
export const connection = sqliteTable('connection', {
  institutionId: text('institution_id')
    .primaryKey()
    .references(() => institution.id),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  lastOkAt: text('last_ok_at'),
  lastError: text('last_error'),
  lastErrorAt: text('last_error_at'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  nextRunAt: text('next_run_at'),
  lastRunId: integer('last_run_id'),
});

export const syncRun = sqliteTable(
  'sync_run',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    institutionId: text('institution_id').notNull(),
    source: text('source').notNull(),
    trigger: text('trigger').notNull(), // scheduled | manual | import
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
    status: text('status').notNull(), // running | ok | error | otp_required
    rowsSeen: integer('rows_seen').notNull().default(0),
    rowsNew: integer('rows_new').notNull().default(0),
    rowsUpdated: integer('rows_updated').notNull().default(0),
    rowsCompleted: integer('rows_completed').notNull().default(0),
    rowsVoided: integer('rows_voided').notNull().default(0),
    rowsAnnotated: integer('rows_annotated').notNull().default(0),
    errorType: text('error_type'),
    error: text('error'),
    metaJson: text('meta_json'),
  },
  (t) => [index('sync_run_institution_started').on(t.institutionId, t.startedAt)],
);

export const rawTransaction = sqliteTable(
  'raw_transaction',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => account.id),
    source: text('source').notNull(),
    sourceHash: text('source_hash').notNull(),
    payloadJson: text('payload_json').notNull(),
    firstSeenAt: text('first_seen_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
    firstSeenRunId: integer('first_seen_run_id'),
    lastSeenRunId: integer('last_seen_run_id'),
  },
  (t) => [uniqueIndex('raw_transaction_source_hash').on(t.sourceHash), index('raw_transaction_account').on(t.accountId)],
);

export const transactions = sqliteTable(
  'transaction',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    rawId: integer('raw_id')
      .notNull()
      .references(() => rawTransaction.id),
    accountId: integer('account_id')
      .notNull()
      .references(() => account.id),
    /** Which source currently owns the core fields (scraper > import > riseup). */
    source: text('source').notNull(),
    fingerprint: text('fingerprint').notNull(),
    txnDate: text('txn_date').notNull(),
    chargeDate: text('charge_date'),
    cashflowMonth: text('cashflow_month').notNull(), // YYYY-MM, calendar month of txn_date (decision #8)
    amountIls: integer('amount_ils').notNull(), // agorot, signed
    originalAmount: integer('original_amount'), // minor units, signed
    originalCurrency: text('original_currency').notNull().default('ILS'),
    descriptionRaw: text('description_raw').notNull(),
    descriptionNorm: text('description_norm').notNull(),
    memo: text('memo'),
    identifier: text('identifier'),
    status: text('status').notNull(), // pending | completed | voided
    txnType: text('txn_type').notNull(), // normal | installments
    installmentN: integer('installment_n'),
    installmentTotal: integer('installment_total'),
    /** Set by the truth engine: expense|income|transfer|settlement|refund|fee|savings, or paid_back (money coming
     *  in that repays something the owner paid for: counted against day-to-day spending, set by the owner or a
     *  'paid_back' counterparty rule, engine/paidback.ts). Null until it runs. */
    kind: text('kind'),
    merchantId: integer('merchant_id'),
    installmentPlanId: integer('installment_plan_id'),
    categoryId: integer('category_id'),
    /** rule | user | memory | riseup | heuristic | ai */
    categorySource: text('category_source'),
    categoryConfidence: real('category_confidence'),
    recurringStreamId: integer('recurring_stream_id'),
    excluded: integer('excluded', { mode: 'boolean' }).notNull().default(false),
    note: text('note'),
    /** The owner's re-tag of one income payment: regular | extra; null = by its category (Now screen, engine/income.ts). */
    incomeKindOverride: text('income_kind_override'),
    /** Per-source extras, e.g. {"riseup": {categoryLabel, isExcluded, ...}} */
    annotationsJson: text('annotations_json'),
    completedAt: text('completed_at'),
    voidedAt: text('voided_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('transaction_fingerprint').on(t.fingerprint),
    index('transaction_account_date').on(t.accountId, t.txnDate),
    index('transaction_status').on(t.status),
    index('transaction_month').on(t.cashflowMonth),
  ],
);

/**
 * Every fingerprint that resolves to a transaction. A transaction has its own (primary) fingerprint
 * plus one per cross-source twin that was merged into it (same day and amount, different spelling),
 * so a re-ingest of the twin's source lands on the same row.
 */
export const txnFingerprint = sqliteTable(
  'txn_fingerprint',
  {
    fingerprint: text('fingerprint').primaryKey(),
    transactionId: integer('transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
  },
  (t) => [index('txn_fingerprint_txn').on(t.transactionId)],
);

// ---------- Phase 2: truth engine ----------

export const merchant = sqliteTable(
  'merchant',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Normalized key (see engine/merchant.ts). */
    key: text('key').notNull(),
    name: text('name').notNull(),
    /** Raw spellings seen for this merchant. */
    aliasesJson: text('aliases_json').notNull().default('[]'),
    /** Source-specific ids, e.g. {"max": ["033657"], "isracard": ["12345"]} */
    externalIdsJson: text('external_ids_json').notNull().default('{}'),
    defaultCategoryId: integer('default_category_id'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('merchant_key').on(t.key)],
);

export const installmentPlan = sqliteTable(
  'installment_plan',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => account.id),
    merchantId: integer('merchant_id'),
    /** ARN for Max; (account, merchant, total amount, n, start month) otherwise. */
    planKey: text('plan_key').notNull(),
    totalN: integer('total_n').notNull(),
    originalAmount: integer('original_amount'), // minor, signed, full price
    sliceAmount: integer('slice_amount'), // minor, typical slice
    firstDate: text('first_date').notNull(), // purchase date of slice 1 (observed or inferred)
    seenN: integer('seen_n').notNull().default(0), // highest slice number seen
    status: text('status').notNull().default('active'), // active | done | cancelled
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('installment_plan_key').on(t.accountId, t.planKey)],
);

/** Explainable, reversible relations between transactions (§6, §7a). */
export const link = sqliteTable(
  'link',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    type: text('type').notNull(), // transfer | card_settlement | refund | cancellation | installment | split
    fromTxnId: integer('from_txn_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    toTxnId: integer('to_txn_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    amount: integer('amount').notNull(), // minor, the linked amount
    confidence: real('confidence').notNull(), // 0..1
    zone: text('zone').notNull(), // auto | suggest
    source: text('source').notNull(), // auto | user
    /** Per-signal contributions, e.g. [{"signal":"merchant","score":0.95,"note":"same merchant"}] */
    explanationJson: text('explanation_json').notNull(),
    /** User verdict on a suggestion or an auto link: null | confirmed | rejected */
    decision: text('decision'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('link_from').on(t.fromTxnId), index('link_to').on(t.toTxnId), index('link_type').on(t.type)],
);

/** "This counterparty is me / my savings / rent": description patterns the user confirmed. */
export const counterpartyRule = sqliteTable('counterparty_rule', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** Substring matched against description_norm (lowercased). */
  pattern: text('pattern').notNull(),
  /** savings | transfer | rent | income | fee | ignore | paid_back (income and paid_back act on money coming in) */
  kind: text('kind').notNull(),
  accountId: integer('account_id'), // null = any account
  note: text('note'),
  createdAt: text('created_at').notNull(),
});

// ---------- Phase 3: understanding ----------

export const category = sqliteTable(
  'category',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** stable machine key, e.g. "lifestyle.eating_out" */
    key: text('key').notNull(),
    nameHe: text('name_he').notNull(),
    nameEn: text('name_en').notNull(),
    /** income | fixed | installments | lifestyle | car | daily | savings | transfers | fees */
    groupKey: text('group_key').notNull(),
    /** cashflow section the group belongs to: income | fixed | variable | savings | transfer */
    section: text('section').notNull(),
    parentId: integer('parent_id'),
    monthlyTarget: integer('monthly_target'), // minor
    track: integer('track', { mode: 'boolean' }).notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    icon: text('icon'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('category_key').on(t.key)],
);

/** User rules: conditions_json → actions_json (architecture §4). */
export const rule = sqliteTable('rule', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  priority: integer('priority').notNull().default(100),
  /** {"merchantId"?: n, "descriptionContains"?: "...", "accountId"?: n, "amountMin"?: minor, "amountMax"?: minor, "kind"?: "expense"} */
  conditionsJson: text('conditions_json').notNull(),
  /** {"categoryId"?: n, "exclude"?: true, "kind"?: "savings"} */
  actionsJson: text('actions_json').notNull(),
  createdFromTxnId: integer('created_from_txn_id'),
  note: text('note'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
});

export const recurringStream = sqliteTable(
  'recurring_stream',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id').notNull(),
    merchantId: integer('merchant_id').notNull(),
    categoryId: integer('category_id'),
    /** weekly | biweekly | monthly | bimonthly | quarterly | annual */
    frequency: text('frequency').notNull(),
    expectedAmount: integer('expected_amount').notNull(), // minor, signed
    amountTolerance: integer('amount_tolerance').notNull(), // minor, +/- around expected
    /** fixed | variable */
    amountModel: text('amount_model').notNull(),
    originalCurrency: text('original_currency'),
    expectedOriginalAmount: integer('expected_original_amount'),
    expectedDay: integer('expected_day'), // day of month for monthly-ish streams
    nextExpectedDate: text('next_expected_date'),
    lastTxnDate: text('last_txn_date'),
    lastTxnId: integer('last_txn_id'),
    occurrences: integer('occurrences').notNull().default(0),
    /** candidate | confirmed | paused | ended | rejected */
    state: text('state').notNull().default('candidate'),
    /** auto | user */
    stateSource: text('state_source').notNull().default('auto'),
    /** income | expense */
    direction: text('direction').notNull(),
    label: text('label'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('recurring_stream_merchant').on(t.merchantId)],
);

/** Key/value settings that are not secrets (AI provider, model, base URL). Secrets live in the vault. */
export const setting = sqliteTable('setting', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** What a model said about a merchant, so it is asked once and the answer is auditable. */
export const aiSuggestion = sqliteTable(
  'ai_suggestion',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    merchantId: integer('merchant_id').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    categoryId: integer('category_id'),
    confidence: real('confidence').notNull(),
    reason: text('reason'),
    /** exactly what was sent for this merchant (merchant name, amounts, dates) */
    sentJson: text('sent_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('ai_suggestion_merchant').on(t.merchantId)],
);

/**
 * A paired phone (Phase 4b). The token itself is never stored: only its SHA-256. From outside the trusted
 * networks a device token is the only way in; the PIN is refused there.
 */
export const device = sqliteTable('device', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  userAgent: text('user_agent'),
  createdAt: text('created_at').notNull(),
  lastSeenAt: text('last_seen_at'),
  lastAddress: text('last_address'),
  revokedAt: text('revoked_at'),
  /** why it was revoked: 'removed' (by hand), 'expired' (idle too long) or 'panic' (lock everything); null on old rows */
  revokedReason: text('revoked_reason'),
});

/**
 * A passkey (WebAuthn credential) for signing in from outside the home network (QUESTIONS 17). Only the public key
 * is kept; the private key never leaves the authenticator (the phone's password manager). Bound to the relying
 * party id `rp_id` (the public host). Revocation is a timestamp, like devices.
 */
export const passkey = sqliteTable('passkey', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** base64url credential id, as the browser reports it */
  credentialId: text('credential_id').notNull().unique(),
  /** base64url COSE public key */
  publicKey: text('public_key').notNull(),
  counter: integer('counter').notNull().default(0),
  /** JSON array of transports ("internal", "hybrid", …), for the allow list */
  transportsJson: text('transports_json'),
  rpId: text('rp_id').notNull(),
  name: text('name').notNull(),
  deviceType: text('device_type'),
  backedUp: integer('backed_up', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
  lastUsedAt: text('last_used_at'),
  revokedAt: text('revoked_at'),
});

export const balanceSnapshot = sqliteTable(
  'balance_snapshot',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => account.id),
    syncRunId: integer('sync_run_id'),
    takenAt: text('taken_at').notNull(),
    balance: integer('balance').notNull(), // agorot
    source: text('source').notNull(),
  },
  (t) => [index('balance_snapshot_account_taken').on(t.accountId, t.takenAt)],
);

/**
 * What the Now screen said on each day (one row per calendar day, latest wins), so the forecast can be
 * judged against the finished month: did the actual month end fall inside the band it promised?
 */
export const forecastLog = sqliteTable(
  'forecast_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    month: text('month').notNull(), // YYYY-MM the forecast was about
    date: text('date').notNull().unique(), // YYYY-MM-DD it was made
    day: integer('day').notNull(),
    leftToSpend: integer('left_to_spend').notNull(),
    roomBeforeVariable: integer('room_before_variable').notNull(),
    variableSpent: integer('variable_spent').notNull(),
    predictedVariable: integer('predicted_variable').notNull(),
    projectedEnd: integer('projected_end').notNull(),
    bandLo: integer('band_lo').notNull(),
    bandHi: integer('band_hi').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('forecast_log_month').on(t.month)],
);

/** Every alert that went out (or was skipped), keyed so the same event is never sent twice per channel. */
export const alertLog = sqliteTable(
  'alert_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    type: text('type').notNull(),
    key: text('key').notNull(),
    channel: text('channel').notNull(), // telegram | app
    text: text('text').notNull(),
    ok: integer('ok', { mode: 'boolean' }).notNull(),
    error: text('error'),
    sentAt: text('sent_at').notNull(),
  },
  (t) => [uniqueIndex('alert_log_key_channel').on(t.key, t.channel), index('alert_log_sent').on(t.sentAt)],
);

/** Events (design §7): "how much did X cost me" across months. A transaction may belong to several. */
export const event = sqliteTable('event', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  note: text('note'),
  fromDate: text('from_date'), // YYYY-MM-DD, optional hints for the picker
  toDate: text('to_date'),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const eventTxn = sqliteTable(
  'event_txn',
  {
    eventId: integer('event_id')
      .notNull()
      .references(() => event.id, { onDelete: 'cascade' }),
    txnId: integer('txn_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    addedAt: text('added_at').notNull(),
  },
  (t) => [uniqueIndex('event_txn_unique').on(t.eventId, t.txnId), index('event_txn_txn').on(t.txnId)],
);

/** Net worth (design §6): holdings finc cannot scrape yet, entered by hand with a value history. */
export const manualAsset = sqliteTable('manual_asset', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  kind: text('kind').notNull(), // pension | savings | investment | property | cash | loan | other
  /** 'asset' adds to net worth, 'liability' subtracts (a loan entered as a positive balance) */
  side: text('side').notNull().default('asset'),
  currency: text('currency').notNull().default('ILS'),
  note: text('note'),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const manualAssetValue = sqliteTable(
  'manual_asset_value',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    assetId: integer('asset_id')
      .notNull()
      .references(() => manualAsset.id, { onDelete: 'cascade' }),
    date: text('date').notNull(), // YYYY-MM-DD the value is for
    value: integer('value').notNull(), // agorot, positive
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('manual_asset_value_unique').on(t.assetId, t.date)],
);

/** What is inside a securities or foreign-currency account, one row per position per sync (FIBI pages). */
export const holdingSnapshot = sqliteTable(
  'holding_snapshot',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => account.id),
    syncRunId: integer('sync_run_id'),
    takenAt: text('taken_at').notNull(),
    kind: text('kind').notNull(), // security | currency
    symbol: text('symbol').notNull(), // ticker, or the ISO currency code
    name: text('name').notNull(),
    quantity: real('quantity').notNull(), // units held, or the currency balance
    price: real('price'), // last price in `currency` (securities), or the exchange rate to ILS (currency)
    currency: text('currency').notNull().default('ILS'),
    valueIls: integer('value_ils').notNull(), // agorot
    valueOrig: real('value_orig'), // in `currency`
    costPrice: real('cost_price'), // adjusted cost per unit, securities
    dailyChangePct: real('daily_change_pct'),
    fromCostPct: real('from_cost_pct'),
    source: text('source').notNull(),
  },
  (t) => [index('holding_snapshot_account_taken').on(t.accountId, t.takenAt)],
);

/**
 * The security log (security research P1-08): who signed in, paired, removed, unlocked, changed settings or locked
 * everything, and when. Append-only: triggers in migration 0013 refuse UPDATE and DELETE. Never holds secrets, tokens,
 * PINs, passwords, codes, amounts or merchant names. No retention for now (rows are tiny).
 */
export const securityEvent = sqliteTable(
  'security_event',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** ISO UTC */
    at: text('at').notNull(),
    kind: text('kind').notNull(),
    /** 'pc' | 'device:<id>' | 'passkey:<id>' | 'telegram' | 'cli' | 'control' | 'public' | 'system' */
    actor: text('actor').notNull(),
    /** the device or passkey name at that time */
    actorName: text('actor_name'),
    /** the client address as the worker sees it */
    address: text('address'),
    /** short text or JSON */
    detail: text('detail'),
  },
  (t) => [index('security_event_kind').on(t.kind, t.id)],
);

/**
 * The owner's own rules for holdings (research_notes/proposals/stock-decision-aids.md, Part A): a fixed template, the
 * owner's numbers (JSON, validated per template in rules/templates.ts), a scope (null = every holding, or one symbol).
 * No free text, no code. `notify` is for the Telegram step (stored, not used yet).
 */
export const holdingRule = sqliteTable('holding_rule', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  template: text('template').notNull(),
  /** JSON object: the template's param keys → numbers */
  params: text('params').notNull(),
  /** upper-case ticker, or null for every holding */
  scopeSymbol: text('scope_symbol'),
  notify: integer('notify', { mode: 'boolean' }).notNull().default(false),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** The last evaluation of a rule for one held symbol (rules/store.ts). */
export const holdingRuleState = sqliteTable(
  'holding_rule_state',
  {
    ruleId: integer('rule_id')
      .notNull()
      .references(() => holdingRule.id, { onDelete: 'cascade' }),
    symbol: text('symbol').notNull(),
    /** the latest evaluation, raw (no hysteresis): applies | clear | unknown */
    state: text('state').notNull(),
    /** ISO time it turned 'applies'; kept through 'unknown' evaluations, cleared only by a known 'clear' */
    since: text('since'),
    /** the value of the last known (applies or clear) evaluation */
    lastValue: real('last_value'),
    /** the last known state (applies | clear), kept through 'unknown' evaluations; null before the first */
    lastKnownState: text('last_known_state'),
    lastKnownAt: text('last_known_at'),
    lastEvaluatedAt: text('last_evaluated_at').notNull(),
    lastNotifiedAt: text('last_notified_at'),
  },
  (t) => [primaryKey({ columns: [t.ruleId, t.symbol] })],
);

/**
 * Third-party market data kept between restarts (stock-decision-aids.md, Part B): the validated rows of one answer
 * (never the raw body), per source and key, e.g. ('finnhub', 'recommendation:TICKER'). Only public data about a
 * ticker: never a quantity, amount or anything about the owner. Lets the last known analysts' view and earnings date
 * show while the vault (and so the API key) is locked.
 */
export const marketDataCache = sqliteTable(
  'market_data_cache',
  {
    source: text('source').notNull(),
    key: text('key').notNull(),
    /** ISO time the answer was fetched */
    fetchedAt: text('fetched_at').notNull(),
    json: text('json').notNull(),
  },
  (t) => [primaryKey({ columns: [t.source, t.key] })],
);
