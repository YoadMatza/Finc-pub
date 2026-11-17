# 04 — Proposed architecture (draft for discussion)

> Working name: **finc**. Personal use, single user, self-hosted.
> Nothing here is final.

## 1. Guiding principles

1. **Your data stays yours.** It runs on your machine or home server. Credentials are encrypted locally. Nothing goes to a third party unless you opt in, for example for LLM categorisation.
2. **Raw data is immutable, interpretation is layered.** We never edit what the bank gave us. Categories, links (refund, transfer, installment) and exclusions are a separate layer that can be recomputed or overridden.
3. **Every automatic decision is explainable and reversible.** For example: "Marked as refund of X because same merchant, same amount, 3 days later". One click undoes it.
4. **Expected vs actual everywhere.** This is RiseUp's best idea. Every recurring item, installment and budget has an expectation.
5. **Each source is a pluggable connector**: scraper, RiseUp MCP, Excel import, or manual entry.

## 2. High-level diagram

```
                ┌───────────────────── your PC / home server (Docker) ─────────────────────┐
                │                                                                           │
 Bank sites ◄───┤  Connector workers                    Core                    Hub (web/PWA)│
 (FIBI, Isracard│  ┌──────────────────┐   raw rows   ┌──────────────────┐  API  ┌──────────┐ │
  Max …)        │  │ israeli-bank-    │────────────► │ Ingest + dedupe  │──────►│ Dashboard│ │
                │  │ scrapers (Node)  │              │ Normalize        │       │ Txns     │ │
 RiseUp API ◄───┤  ├──────────────────┤              │ Link engine      │◄──────│ Recurring│ │
 (PAT, backfill)│  │ RiseUp MCP/API   │              │  • transfers     │ edits │ Budgets  │ │
                │  ├──────────────────┤              │  • card settle   │       │ Settings │ │
 Excel/CSV ─────┤  │ File importer    │              │  • refunds/cancel│       └──────────┘ │
                │  └──────────────────┘              │  • installments  │            ▲      │
                │         ▲   scheduler (cron)       │ Recurring detect │            │      │
                │         │   + OTP prompt           │ Categorizer      │   phone (Tailscale │
                │  ┌──────┴──────┐                   │ Forecast engine  │   / LAN)            │
                │  │ Secrets     │                   └────────┬─────────┘                    │
                │  │ vault (enc.)│                            │                              │
                │  └─────────────┘                   ┌────────▼─────────┐  ┌──────────────┐  │
                │                                    │ SQLite / Postgres│  │ Notifier     │──┼─► Telegram /
                │                                    └──────────────────┘  │ (alerts)     │  │   push
                │                                                          └──────────────┘  │
                └───────────────────────────────────────────────────────────────────────────┘
```

This was the first sketch. The deployment as built (four containers, the public entry, MCP and push) is in §11–§14.

## 3. Suggested stack

| Layer | Choice | Why |
|---|---|---|
| Language | **TypeScript end-to-end** | The scrapers are Node. One language for everything. |
| Scraping | `israeli-bank-scrapers` (pinned), Puppeteer, persistent browser profile | The only maintained option. Pinning gives controlled upgrades. |
| Backend | Node (Fastify or Hono) + a job scheduler (node-cron / BullMQ-lite) | Simple. |
| DB | **SQLite** (Drizzle ORM). Can move to Postgres later. | Single user, one file, trivial backup. |
| Frontend | **Next.js or Vite + React**, Tailwind, shadcn/ui, Recharts/ECharts, **RTL Hebrew first** | Web hub on desktop plus an installable PWA on the phone. |
| Remote access | Tailscale or LAN; **from 2026-11-09 also a public HTTPS entry** at `finc-example.duckdns.org` (Caddy, Let's Encrypt via DuckDNS DNS-01) that accepts paired-device tokens only — see §10 | The owner wants the Android app to work anywhere without Tailscale on the phone; the PIN is never accepted from the internet. |
| Packaging | Docker Compose. **As built:** `worker` (hub + API + scheduler + vault + DB), `scraper` (Chromium, bank logins), `caddy`, `duckdns` — see §11 | Easy to run on the PC, a NAS, or a mini-PC. |
| Secrets | Encrypted vault (libsodium) keyed by a master password, or Windows DPAPI | No plaintext credentials. |
| Optional AI | Claude API for the categorisation fallback and "ask my money" chat | Opt-in; only merchant and amount data is sent. |

**Alternative considered: build on Actual Budget plus the Israeli importer.**
- Faster to a working ledger.
- But its UX is envelope budgeting, and you want a RiseUp-style cashflow hub with cancel-netting. We'd be fighting its model.
- **Recommendation:** custom app, but steal ideas from Actual and Firefly.

## 4. Data model (core tables)

```
institution      (id, kind: bank|card|pension|manual, scraper_id, display_name)
account          (id, institution_id, type: checking|credit_card|savings|loan|cash,
                  last4, currency, billing_day, settles_to_account_id)
connection       (institution_id, enabled, last_ok_at, last_error, last_error_at, consecutive_failures, next_run_at)
                 -- status only. The encrypted credentials live in the vault FILE (data/vault.json), not in the DB,
                 -- so a DB backup never contains credential material (changed from `credential` on 2026-11-08)
sync_run         (id, institution_id, started_at, ended_at, status, rows_new, rows_updated, error)

raw_transaction  (id, account_id, source, source_hash UNIQUE, payload_json, first_seen, last_seen)
transaction      (id, raw_id, account_id,
                  txn_date, charge_date, cashflow_month,
                  amount_ils, original_amount, original_currency,
                  description_raw, merchant_id, memo,
                  status: pending|completed|voided,
                  kind: expense|income|transfer|refund|fee|interest,
                  category_id, category_source: rule|memory|ai|user|riseup,
                  excluded BOOL, note, tags[])

merchant         (id, canonical_name, aliases[], default_category_id, logo)
category         (id, name_he, group: income|fixed|variable|savings|transfer, parent_id,
                  monthly_target, track BOOL, order)

link             (id, type: transfer|card_settlement|refund|cancellation|installment|split,
                  from_txn_id, to_txn_id, amount, confidence, source: auto|user, explanation)
installment_plan (id, merchant_id, original_amount, total_n, start_month, account_id)
recurring_stream (id, merchant_id, category_id, frequency, expected_amount, amount_tolerance,
                  expected_day, next_expected_date, state: candidate|confirmed|paused|ended,
                  last_txn_id)
rule             (id, priority, conditions_json, actions_json, created_from_txn_id)
goal / plan      (id, name, target_amount, target_date, linked_account_or_category)
event_tag        (id, name)  -- "how much did it cost me" (trip, wedding, renovation)
insight          (id, type, key (dedupe), payload, created_at, dismissed_at)

balance_snapshot (id, account_id, sync_run_id, taken_at, balance, source)
                 -- one row per account per successful sync; feeds the balance reconciliation
account_alias    (id, account_id, source, external_id)
                 -- maps each source's account identifier (scraper account number, RiseUp
                 -- accountNumberHash, import file label) onto one account row
```

### 4a. Conventions (added 2026-11-08 at the start of Phase 1)

- **Amount sign.** `transaction.amount_ils` is **signed**: negative = money out, positive = money in. Scrapers
  already return signed `chargedAmount`. RiseUp returns absolute `amount` plus `isIncome`; the importer
  converts it to signed. `original_amount` follows the same sign.
- **Raw rows are per source.** `raw_transaction.source` is `scraper:<institution>`, `riseup`, or `import:<file-hash>`.
  `source_hash` is unique **within a source**; the same purchase arriving from two sources produces two raw rows.
- **Cross-source dedupe happens in `transaction`.** A normalized row has a `fingerprint =
  hash(account_id, txn_date, amount_ils, normalized_description, installment n/N?)`. When a second
  source produces the same fingerprint, no second `transaction` row is created. Precedence:
  `scraper` > `import` > `riseup`. A lower-precedence source only **annotates** the existing row (RiseUp
  category, exclusion flag, comments, sequence name go into `transaction.annotations_json`, keyed by source).
- **Pending rows** are matched to a later completed row by (account, amount, merchant, ±5 days, same
  original-currency amount), using the shared engine in §7a with a narrow window. On a match the pending
  row's `status` becomes `completed` and the raw rows are both kept.
- **Balance reconciliation.** For a bank account: `balance_snapshot(t1) − balance_snapshot(t0)` must equal
  the sum of `transaction.amount_ils` with `status=completed` and `txn_date` in `(t0, t1]`. Card accounts
  are reconciled through their settlement debit instead (§7b). RiseUp cannot supply this: its balance
  history covers 90 days and omits card bill payments, so reconciliation runs on scraper data only, from
  the first sync onward.

## 5. Processing pipeline (every sync)

```
1 Fetch      connector → raw rows
2 Dedupe     source_hash = hash(source, account, date, amount, normalized desc, identifier?, occurrence#)
             upsert raw (first_seen/last_seen); detect pending→completed transitions;
             pending that vanished > 7d → VOIDED. Snapshot the account balance.
3 Normalize  merchant normalization (strip branch #, "בע"מ", city, card noise, "תשלום 7/12")
             FX fields, cashflow_month (by your start day), kind guess
             cross-source fingerprint (§4a): create the transaction row or annotate the existing one
4 Link       a) card_settlement : bank debit "ישראכרט/מקס" ↔ sum(card cycle) → transfer, excluded
                a') immediate charges: Max "חיוב עסקות מיידי" rows (about a third of the first load) each produce
                    their OWN bank debit a few days later, next to the monthly cycle debit on the 2nd.
                    Link 1:1 by amount within ±7 days; only the remaining rows sum to the cycle debit.
             b) transfer        : own-account pairs, opposite amounts, ±3 days
             c) installments    : group into installment_plan, project remaining slices
             d) refund/cancel   : see §6
5 Categorize rules → merchant memory → RiseUp's label → keyword heuristics → (opt) model → else "Needs review"
             model = pluggable provider (local OpenAI-compatible server, Anthropic, OpenAI); asked once per
             merchant, answer cached in ai_suggestion with the exact payload sent; applies as source 'ai'
             and never overrides a user, rule or memory decision (Phase 3, 2026-11-08)
6 Recurring  update streams; new candidates → "confirm?" queue; missed expected → insight
7 Forecast   recompute month-end, safe-to-spend, projected balance curve
8 Insights   dedupe by stream (not by amount!) → notifier
```

## 6. Cancellation and refund engine (core requirement)

| Case | Signal | Treatment |
|---|---|---|
| **Authorization voided** | Pending row disappears without completing | `status=voided`. Shown struck through in the pending list and excluded. |
| **Full cancellation** | Credit with the same merchant (fuzzy) and the same absolute amount within 0–60 days | Link `cancellation`. **Both rows** shown grouped with a "בוטל" badge, struck through, net ₪0, excluded from totals. |
| **Partial refund** | Same merchant, credit smaller than the purchase | Link `refund`. The purchase shows its *net* (₪500 → ₪350 with a "₪150 refunded" chip), counted in the **original category and month**. It is never counted as income. |
| **FX refund** | Same merchant, original currency matches, ILS differs by up to 5% | Same as above. The FX difference becomes a small "FX diff" line. |
| **Installment refund** | Credit against an installment plan | Link to the plan. Remaining expected slices are cancelled or reduced. |
| **Bank returns** | "החזרת חיוב", "ביטול הוראת קבע", "החזר" + matching amount | Same linking on the bank side. |
| **Returned cheque** (seen 2026-09) | "החזרת שיק 1000123" credit next to "משיכת שיק 1000123" debit, same amount, same cheque number; the replacement payment follows a day later | The cheque number is a **reference id** (§7a): it overrides name similarity. Cheque + return link as `cancellation` (net ₪0); the replacement counts once. RiseUp instead excluded the replacement. |
| **Ambiguous** | Several candidates, or a different merchant (e.g. Bit refund from a person) | Suggest the match in the Review inbox. You confirm or pick. |

**Scoring:** uses the shared multi-signal matching engine in §7a (merchant, amount, currency, dates, card, reference ids, keywords, structure, memo, your history). It is not based on dates alone.

## 7. Recurring detection

- **Group key:** normalized merchant (plus category).
- **Cadence buckets:** weekly, bi-weekly, monthly, **bi-monthly** (Arnona, water), quarterly, annual. Snap the gaps between charges with ±20% tolerance.
- **Amount model:**
  - fixed (coefficient of variation < 5%),
  - variable-bounded (electricity, water: use a range and the average),
  - **price change detection**, which produces a "your gym went up ₪20" insight.
- **States:** `candidate` (2 hits) → shown in "Confirm recurring?" → `confirmed` (user, or 3+ hits with high confidence) → `ended` (missed 1.5× the interval, or you mark it cancelled).
- **Expected occurrences** for the month are created as *virtual rows*. They feed "expected" totals and the "fixed expense hasn't arrived" alert, which fires **once per stream**.
- **Installments are deterministic,** not detected statistically.

## 7a. One matching engine, many signals (used by every "is this the same thing?" decision)

Days apart is never the only test. The refund/cancellation matching, recurring-payment matching, transfer and card-settlement linking, and pending→completed tracking all use **one scoring engine**. It combines and cross-references every available signal.

| Signal | How it's used | Example |
|---|---|---|
| **Merchant name** | Normalized name, alias table, fuzzy/trigram similarity, Hebrew↔English variants | "SP* STREAMLY STREAMLY.COM US" = "Streamly"; "סופר אלונית -סניף מרכז" ≈ "אלונית" |
| **Amount** | Exact > within tolerance > partial (refund smaller than purchase); sums (one refund = several purchases, or a card cycle total = the bank debit) | ₪3,410.5 bank debit = sum of the Max cycle |
| **Original currency** | Match on the $/€ amount when the shekel amount drifts | $15 every month even though ₪54/55/57 differ |
| **Dates** | Proximity weighted by type: refund up to 90 days, monthly stream ±7 days, transfer ±3 days | — |
| **Account / card** | Same card is a strong signal; own-account pairs signal a transfer | Refund credited to the same card ****1234 |
| **Reference ids** | Bank reference number (אסמכתא), authorization id, installment plan id, cheque number | Pending→completed follows the same auth id |
| **Keywords and type** | זיכוי, ביטול, החזר, refund, reversal, העברה, transaction type from the scraper | — |
| **Structure** | Installment n/N, the stream's history (usual day and amount), card billing cycle | Credit against an installment plan |
| **Payment-app memo** | Bit/PayBox notes and counterpart names | A friend's Bit refund for a shared dinner |
| **Your history** | Matches you confirmed or rejected before teach merchant-specific weights | You always confirm Zara refunds → auto next time |

**How a decision is made**
1. **Candidate search:** a cheap filter (same direction rules, a plausible window, a plausible amount) keeps the comparison set small.
2. **Scoring:** a weighted sum of the signals, and every signal's contribution is stored.
3. **Assignment, not greedy:** when several purchases and refunds compete, pick the best global pairing. Two ₪100 refunds won't both grab the same ₪100 purchase.
4. **Three zones:**
   - **auto-link**: high score.
   - **suggest**: medium score; goes to the review inbox showing "why".
   - **ignore**: low score.
5. **Explanation saved** with every link, for example: "same merchant (0.95), same card, $ amount equal, 4 days apart". Undo is one click.
6. **Learning:** your confirmations and rejections adjust the weights and thresholds per merchant over time.
7. **Tuning:** the initial weights are calibrated on your RiseUp history. RiseUp's own exclusions and categories act as a rough answer key, and the rules are refined as we go.

## 7b. Counting rules: no double counting (fixes RiseUp's Streamly bug)

RiseUp showed the same Streamly charge twice: the actual ₪57 under *variable* and an expected ₪55 under *fixed* ("not yet charged"). It failed to match the charge to its expected occurrence because the amount drifts with the USD rate. These rules prevent that:

1. **Exactly one bucket.** Every real transaction belongs to exactly one section: fixed, variable, installments, savings, income or transfer. The section comes from its stream or category, never from both.
2. **Expected occurrences are consumed, not added.** When an actual transaction matches an expected occurrence, the expected one is **replaced**. Totals use `actual + (expected occurrences not yet matched)`, never both.
3. **Tolerant matching.** Same merchant stream; date within ±7 days of the expected date (wider for annual streams); amount within the stream's tolerance. **FX streams match on the original-currency amount**, e.g. $55, not on shekels.
4. **One occurrence per period.** A monthly stream has one expected slot per month. A second charge in the same month is flagged ("charged twice this month?"), not silently duplicated.
5. **A recurring charge never counts as variable.** If a transaction matches a confirmed stream, it is removed from the variable bucket automatically.
6. **Reconciliation checks run after every sync.**
   - Sum of section totals = sum of non-excluded transactions.
   - Bank balance delta = sum of bank transactions.
   - Card cycle total = the settlement debit in the bank.
   - Any mismatch raises a "data integrity" warning in the hub with drill-down. These checks will also be part of the automated test suite.

## 7c. Pensions, savings and investments (provider-agnostic)

- **Generic `holding` model:** provider, product type (pension, gemel, hishtalmut, investment gemel, brokerage, deposit), balance snapshots, monthly deposits, fees, and returns.
- **Connectors, in priority order:**
  1. **Deposits:** these already appear as bank transactions (e.g. "Pension Fund A 500"). Auto-link them to their holding.
  2. **Balances:** manual or file import of the yearly or quarterly report from any provider, plus the government consolidated pension view ("Har HaKesef" / the pension clearinghouse report), which covers all providers at once. ⚠ Export formats need verifying at build time.
  3. **Brokerage:** CSV import; Interactive Brokers Flex Query (API) if relevant; Ghostfolio-style performance view later.
- Feeds **net worth** = bank + savings + pension + investments − debts and loans.

## 7d. Notifications (pluggable)

- `channel` plugins: **Telegram** and **Web Push** (phase 1); **Email** and **WhatsApp** (later).
- `alert_type` catalogue, for example:
  - missing fixed expense
  - price change
  - big transaction
  - refund matched
  - over target
  - low forecast
  - sync failed or OTP needed
  - weekly summary
- A **per alert type × channel toggle matrix** in Settings, plus quiet hours.
- The Telegram bot can also **receive OTP codes** when a bank asks for SMS verification.
- **Amended 2026-11-10 (security research P1-02/03/04).**
  - Money leaving is alerted per new transaction (`alerts/money.ts`), not from the month's attention list:
    - money out at or above a threshold, of any kind;
    - new instalment purchases, on their full amount;
    - card bills that do not match their card;
    - card testing.
  - Exceptions: exact card bills and confirmed recurring charges. Urgent alerts skip quiet hours.
  - Rows are judged only after the engine processed them, and at most 3 days back. A flood guard turns more than 10 at
    once into one summary.
  - Sync health alerts:
    - a sync error, once per outage;
    - no successful sync for 36 hours.
  - The Telegram chat is bound by a one-time code made at home, and alert settings change from home only.
- **Amended 2026-11-16/17.**
  - Unusual charge (`alerts/money.ts`): more than 3× the merchant's median on the same account over the last year (at
    least 4 earlier charges) and at least ₪200 above it.
  - The channels are **Telegram** and **push** to the Android app (not Web Push); the toggle matrix is per alert type ×
    {telegram, push}. Push is content-free, see §14.

## 7e. Internationalisation

- UI strings go through i18n with Hebrew and English. The layout switches between RTL and LTR.
- Merchant names stay as the source gives them, with an optional user alias.
- Numbers use the ₪ locale format in both languages.

## 8. Forecast and "safe to spend"

```
month_end_forecast = current checking balance
                   + expected remaining income        (confirmed income streams)
                   − expected remaining fixed          (confirmed streams not yet hit)
                   − remaining installment slices this month
                   − unbilled card spend due this cycle (cash view)
                   − remaining variable budget         (targets − spent, or 3-mo avg pace)
safe_to_spend_today = (variable budget remaining) / days left, adjusted for pace
```

The projected balance line (daily, 30–90 days) is drawn from the same expectations.

**Amended 2026-11-09 (engine/forecast.ts, after a private note, not in the repo).** The hero
number is grounded in cash, never in a history median: `room before variable = income (actual + still expected) −
committed (fixed actual + still expected + installments actual + remaining) − savings (actual + planned)`, and
`left to spend = room − variable spent so far`. A negative is shown as a shortfall, not hidden. The month-end
projection assumes the usual pace: predicted variable total `V̂ = w·pace + (1−w)·med3` with `w = day/dim`
(refund-netted med3 of the last 3 complete months), `projected end = left − (V̂ − spent)`, with a p25–p75 band from
the blend's backtested error quantiles (18 months; error measured at day 10, sign of the month-end right in 14/18).
Weekly, not daily, envelope when left is positive (weekly CV 0.68 vs daily 1.65). Salary slots are consumed by any
unlinked income within 0.7–1.4× the expected amount, so a salary outside the stream tolerance is never expected twice.

## 9. Security checklist

- Bind to localhost or Tailscale only. No public port. **Amended 2026-11-09:** the worker still binds to 127.0.0.1, but
  Caddy on the same PC publishes it on TCP 7443 as `finc-example.duckdns.org:7443`. From public addresses only paired-device tokens
  are accepted; the PIN works on trusted networks only. See §10.
- App login with a passphrase (or Windows Hello / passkey) and a session timeout.
- Vault encrypted with Argon2id + XChaCha20. The master password is entered at start (or uses DPAPI).
  - **Phase 1 implementation (2026-11-08):** the worker starts *locked*. `finc unlock` posts the master password
    to the worker's control port on 127.0.0.1 (never to disk, never logged, 5 attempts per 10 minutes); the derived key
    stays in worker memory until `finc lock` or restart. Scheduled syncs while locked are recorded as `LOCKED` runs so
    health shows them. Decided over a key file on disk (convenient but weaker).
- Encrypted nightly backup of the DB. **Built 2026-11-10** (security research P1-12):
  - 03:40 to another physical disk (`E:\finc-backup` → `/backup`);
  - DB snapshot (`serialize()`) and `vault.json`, sealed with a `crypto_kdf` subkey of the vault key, metadata
    authenticated, so it opens with the master password of that day;
  - verified after writing, retention 7 daily, 4 weekly, 6 monthly;
  - restore on the host only, with the worker container stopped: staged swap with rollback; money alerts re-based
    after the first sync.
- Logs never contain credentials or full card numbers.
- The LLM is opt-in. It receives only `merchant, amount, date`; never names, ID numbers or account numbers. Since
  2026-11-17 the same rule covers AI apps over MCP; both go through one egress path (§12).
- **Data retention (security research P2-10, 2026-11-16, `db/retention.ts`):** nightly at 03:20, raw bank payloads
  older than 24 months are slimmed to the fields the engine reads, the alert log keeps 12 months, `ai_suggestion`'s
  sent payload is cleared after 90 days, imported statement files go 30 days after a successful import, scraper dumps
  and failure screenshots after 14 days. Transactions, balances, the security log and backups are untouched.

## 10. Remote access and the Android app (added 2026-11-09)

The owner asked for an Android app that reaches the hub from anywhere without Tailscale on the phone, at no cost. This
reverses the "no public port" rule in §9, so this section is mostly about what protects the data.

**Transport.** Caddy on the PC terminates HTTPS for `finc-example.duckdns.org` (DuckDNS, free, created by the owner and
pointing at the home IP) with a Let's Encrypt certificate obtained through the DNS-01 challenge (Caddy's `duckdns`
module), so only TCP 7443 is forwarded on the router and port 80 stays closed. The app's address is therefore `https://finc-example.duckdns.org:7443`. Caddy proxies to the worker on
127.0.0.1:7733 and adds HSTS. The DuckDNS token lives in Caddy's own environment file, readable by the owner's account only;
finc never sees it (finc reads no secrets from the environment at all). A scheduled task refreshes the DuckDNS A record
every 5 minutes. Chosen over Cloudflare Tunnel (needs a paid domain, and Cloudflare would read the traffic at its edge)
and a VPS (the database would leave the PC). Fallback if the ISP turns out to use carrier-grade NAT: `tailscale funnel
7733`, which is public, end-to-end encrypted and needs nothing on the phone.

**Two authentication tiers.** The worker learns the real client address from Caddy's `X-Forwarded-For`, trusted only
when the TCP peer is 127.0.0.1.

- *Trusted networks* (loopback, RFC 1918 LAN, Tailscale 100.64.0.0/10): PIN login as today.
- *Everything else*: only a **paired-device token**. The PIN form is not offered, and a PIN attempt from a public address
  is rejected before the hash is checked, so the internet cannot brute-force a 4–6 digit PIN.
- Device tokens are 256-bit random values sent as `Authorization: Bearer finc_dev_…` and stored as SHA-256 hashes in a
  `devices` table (name, created, last seen, last address, revoked). Rate limit: 20 failed token or pairing attempts
  per address per 10 minutes, then 429 for the rest of the window; failures are logged with the address only.
- Session cookies get the `Secure` flag when the request arrived as HTTPS (`X-Forwarded-Proto`).

**Amended 2026-11-10 (security research P0-03, P0-04, passkeys).**

- **Trust:** behind Docker Desktop every client arrives from the bridge gateway, so "trusted" is decided by Caddy's
  `X-Finc-Edge: public` stamp: a stamped request is never trusted.
- **PIN sessions:** a PIN cookie session counts only on a trusted connection and is tied to the current PIN (a stamp
  of the PIN hash), so a PIN change ends them all.
- **Device tokens:** a device token is checked before the failure counter, so a flood of junk from the shared address
  never refuses a valid token.
- **A third credential, the passkey** (WebAuthn, relying party = the host of `ui.publicUrl`):
  - It is added only through a one-time link made at home.
  - Signing in with it gives a 12-hour fixed session that counts from the internet. The session is tied to the PIN
    and to its passkey.
  - It can never pass an admin check (`requireTrusted`) and is refused on operating endpoints (vault unlock/lock,
    syncs, alert sends).
  - Sign-in challenges are stateless (HMAC + expiry; only successful ones are remembered).

**Pairing.** Settings → "Pair a phone", available only to a PIN-authenticated session on a trusted network, creates a
single-use 128-bit code valid for 5 minutes and shows it as a QR code containing the hub URL and the code. The app scans
it, posts the code to `/api/devices/pair`, receives its token, and stores token and URL in Android's encrypted storage.
Settings lists paired devices with last seen and a Revoke button; revocation is immediate.

**The app.** `apps/web/android` is a Capacitor shell around the same `apps/web` build, so there is one UI. Native parts: QR
scanning for pairing, encrypted storage for the token, fingerprint or device-PIN lock on open and after 5 minutes in the
background (BiometricPrompt), and later the push channel for Phase 5 alerts. The web code detects the native shell and
sends the Bearer token instead of relying on cookies. Built with Gradle into a sideloaded APK signed with a local
keystore (gitignored, backed up with the vault); no Play Store.

**Operations.** Docker Compose runs the worker, Caddy (built with the DuckDNS module, HTTPS on the
public port, also serves the APK) and a DuckDNS updater container (which replaced the scheduled task above), and since
2026-11-17 a fourth, the bank scraper (§11); the worker trusts `X-Forwarded-*` only from Caddy's fixed address on the
`edge` network (P1-07). The same file runs on the PC and on a Raspberry Pi, where Docker starts at boot. The vault still needs
`finc unlock` after a restart; the app can do that from the Accounts screen over HTTPS with the master password, which
is never stored on the phone. Headful bank logins (`finc spike`) run from the CLI on a machine with a screen, with the
host's own Chromium, against the same data/ and with the worker stopped.
(A Windows-logon-task deployment was tried on 2026-11-09 and retired: it needed a Windows account password to start
before login, which the owner rightly refused for this project.)

**What stays true.** No financial data reaches any third party: DuckDNS sees only the home IP address and Let's Encrypt
only the hostname. Bank credentials never leave the vault.

## 11. Containers and how they talk (as built, 2026-11-17)

```
 internet ── the router forwards TCP 7443 only
     │
     ▼
 caddy       (edge network, fixed address) HTTPS for the public name; stamps X-Finc-Edge: public;
     │       404 on the PIN, control and local-MCP paths
     │ HTTP worker:7733
     ▼
 worker      (edge network) hub + API + scheduler + vault + SQLite + alerts + MCP + OAuth; no Chromium
     │       ◄── 127.0.0.1:7733: the CLI and the PC's browser
     │ Unix socket /run/finc-scraper/scraper.sock (volume scraper_socket, mounted by these two only)
     ▼
 scraper     (own network, no port) Chromium + israeli-bank-scrapers, sandboxed ──► bank sites

 duckdns     (own network) ──► DuckDNS every 5 minutes; reaches nothing of finc's
```

| Service | Image (Dockerfile target) | Holds | Network | Notes |
|---|---|---|---|---|
| `worker` | `runtime` | DB, vault (unlocked in memory), alerts, scheduler | `edge` | read-only root, no capabilities, 127.0.0.1:7733 published for the CLI |
| `scraper` | `scraper` (same code + Debian Chromium) | bank browser profiles (volume `browser_profiles`), `data/screenshots`, the socket | `scraper` (internet only) | no vault, no DB, no port; Chromium sandbox on |
| `caddy` | `deploy/caddy` | its certificate and key (volume `caddy_data`) | `edge` | the only public listener; reads `secrets/caddy.env` |
| `duckdns` | curl, pinned by digest | the DuckDNS token | `duckdns` | cannot reach the worker |

`caddy-perms` is a one-shot that hands Caddy's volumes to its unprivileged user and exits.

**A sync** (`connectors/scraper-socket.ts`, design `research_notes/proposals/scraper-container.md`): the worker opens
the socket and sends one newline-delimited JSON job, protocol v1: the institution, months back, and that institution's
login fields read from the vault. The scraper runs the existing `runScrape` with no database, may answer `otp_needed`
(the worker relays the code from the CLI, Telegram or the app, and sends it back on the same connection), then returns
the raw result or an error, and forgets the fields. The worker ingests as before. One job per connection, messages
size-capped, a 20-minute job timeout. The socket lives on a volume only these two containers mount, so nothing about a
sync is on a network. Without `FINC_SCRAPER_SOCKET` (a host run, `finc spike`, `--show-browser`) the browser runs in
the CLI's own process.

**Scraper isolation.** It never sees the vault or the database, only one institution's fields for one job. It is on
its own network (not `edge`), has no published port, a read-only root, no capabilities, `no-new-privileges`, and a
seccomp profile (`deploy/scraper/seccomp-chromium.json`: Docker's default plus `clone`/`unshare`/`chroot`) that lets
Chromium start its own namespace sandbox without `SYS_ADMIN`. `FINC_CHROMIUM_SANDBOX=0` falls back to `--no-sandbox`.
A Chromium escape lands in a container with no finc data beyond the browser profiles.

**Image age.** Both images record their build day (`/etc/finc-image-built`); after 35 days the hub and an alert ask for
`docker compose build worker scraper`, so Debian's Chromium keeps getting security fixes.

## 12. One egress path for the chat and MCP (2026-11-16/17)

Everything a model can see goes through `runPrivateTool` (`packages/core/src/ai/chat.ts`): the tool runs locally, its
result is projected onto the tool's allow-list (`TOOL_SHAPES` in `ai/egress.ts`; an unlisted key or a wrong type is
dropped, and tests require nothing to be dropped from a normal result), then every string passes `guardEgress` /
`scrubIdentifiers` (numbers that look like card, account, ID or phone numbers, emails, IBANs). An unknown tool or an
error becomes a short `{error}`, never the exception text. Canary tests plant made-up identifiers wherever a bank can
put them and fail if one comes out.

The ten tools (spend summary, month summary, `compare_periods`, spend by category, top merchants, find transactions,
recurring, trends, events, net worth) serve three callers through that one function:

- the hub's chat ("Ask my money"), with the provider from Settings and its key from the vault;
- **local MCP**: `finc mcp --token <app>` (stdio, started by the AI app on the PC, run inside the worker container by
  the launcher) holds no database; it calls the worker's `GET /mcp/tools` and `POST /mcp/call` on 127.0.0.1 with the
  app's token (made by `finc mcp token create`, kept in `data/mcp/<app>.token`, stored as a hash). Caddy answers 404
  on `/mcp/*`;
- **remote MCP** (§13) on `POST /mcp`.

Off by default; 30 calls a minute and 1,000 a day per app; every call is a `mcp.call` security event with the tool and
argument names, never values or results.

## 13. Remote MCP: finc as a one-owner OAuth server (2026-11-17)

ChatGPT and the Claude apps call MCP servers from their own servers, so finc answers MCP over Streamable HTTP on the
public entry and is its own small authorization server (`packages/core/src/hub/oauth.ts`, routes in
`apps/worker/src/api/app.ts`; design `research_notes/proposals/remote-mcp.md`). All of it answers 404 while Settings →
AI → Remote AI apps is off.

| Endpoint | Role |
|---|---|
| `GET /.well-known/oauth-protected-resource[/mcp]` | resource metadata pointing at the issuer |
| `GET /.well-known/oauth-authorization-server` | issuer metadata (PKCE S256, `none` or `private_key_jwt`) |
| `POST /oauth/register` | Dynamic Client Registration (Claude), only inside an open connection window |
| `GET /oauth/authorize` | checks client and callback, then redirects to the hub's `/connect` approval page |
| `/api/oauth/requests/:id` (+ `/options`, `/approve`) | the approval page's API: a fresh passkey signature approves |
| `POST /oauth/token` | code and refresh exchange; a `private_key_jwt` assertion is verified when sent, and required for a grant made with one |
| `POST /mcp` | the tools (§12) with a bearer access token; other methods refused, any `Origin` refused |

- **Who can connect:** ChatGPT (by its client metadata document, the one allow-listed URL finc fetches, plus its JWKS)
  and Claude (by registration); every redirect URI must be that app's own callback.
- **When:** the owner opens a 10-minute window at home (Settings → **Connect an app**); authorize works only inside it,
  at most three requests per window, and an approval is refused when a window holds two.
- **Tokens:** codes single-use for 60 seconds, bound to client, redirect, PKCE challenge and resource; access tokens 1
  hour, scope `finc.read`, valid only on `/mcp`; refresh tokens 30 days, rotated on every use, and a reused one
  revokes the grant (with an alert). Only SHA-256 hashes are stored. The vault, device tokens, passkeys, PIN, the
  control token and local MCP tokens never work on `/mcp`.
- **Where it sits:** the issuer is the hub's public address, or `mcp.remote.publicUrl` when set: ChatGPT only calls
  port 443, so remote MCP can have its own address on 443 behind another reverse proxy at home that forwards only
  `/mcp`, `/oauth/register|token|authorize` and the two `/.well-known/oauth-*` documents to finc's Caddy (TLS again).
  The approval page stays on the hub's address, where the passkeys are bound.
- **Off switch:** turning it off revokes every connection; the panic button also clears codes and requests; Settings
  revokes one app.

## 14. Push alerts to the Android app (2026-11-17)

Design `research_notes/proposals/push-alerts.md`, setup `docs/push.md`.

```
alert due ─► dispatchAlerts (matrix[type].push) ─► queued per device (DB) ─► FCM v1 send: data = random id only
phone (FincPushService) wakes ─► GET /push/pending  (Bearer finc_push_…, pinned TLS) ─► notification text
```

- **Queue + empty ping.** `queuePush` stores the alert text per paired device that has a push token; the worker then
  asks Firebase Cloud Messaging (service-account key in the vault entry `push_fcm`, set by `finc push setup`) to
  deliver a message carrying only a random id. A test checks every field Firebase receives. Google learns that an
  alert happened and when, nothing else.
- **`/push/*` with the push secret.** The app's background receiver cannot wait for the fingerprint the device token
  needs, so each device gets a narrow secret (`finc_push_…`, hashed in the DB, kept on the phone under a Keystore key
  of its own) that works only on `GET /push/pending` (take this device's queued alerts) and `POST /push/token` (update
  its FCM token). It is replaced at every registration (`POST /api/devices/me/push-token` with the device token);
  revoking the device or the panic button ends it. The open app reads the same queue with its device token
  (`GET /api/alerts/pending`).
- **The app** shows private-on-lock-screen notifications; a tap opens the hub's Alerts page, where a bank's one-time
  code can be typed (the waiting sync takes the first answer, the app's or Telegram's). The build needs
  `apps/web/android/app/google-services.json` (git-ignored) from versionCode 35.
- Channels per alert type: Telegram and push, with the same quiet hours and flood summary.
