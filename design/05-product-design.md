# 05 — Product design: "the hub" (draft for discussion)

The goal is to keep RiseUp's "how will this month end?" clarity and add a real desktop dashboard, honest cancellation handling, and control over the rules.
**Hebrew RTL first.** Mobile is a PWA with the same screens stacked.

## Information architecture

```
🏠 Hub (Now)          ← default
💸 Transactions       (all, filters, search, review inbox)
🔁 Recurring          (fixed income & expenses, subscriptions, installments)
📊 Categories         (lifestyle, car, food, … with targets)
🏦 Accounts           (balances, card cycles, connection health)
📈 Trends             (months/years, Sankey, net worth)
🏷  Events            ("how much did it cost me?")
⚙  Settings          (connections, rules, categories, cashflow start day, alerts)
```

## 1. Hub: "what's going on right now"

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  נובמבר 2026  ◄ ►            last sync 05:53 ✓  FIBI ✓ Isracard ✓ Max ⚠        │
├───────────────────────┬───────────────────────┬──────────────────────────────┤
│ MONTH WILL END AT     │ IN  (income)          │ OUT (expenses)               │
│   −2,140 ₪   🔴       │ 10,400 / 10,400 exp.  │ 11,860 / 16,320 expected      │
│ ▁▂▃▅▆▇ projected line │ ███████████ 100%      │ ██████▋──── 66%               │
├───────────────────────┴───────────────────────┴──────────────────────────────┤
│ SAFE TO SPEND  ₪0 /day for 22 days    (variable budget used: 720 / 720)      │
├──────────────────────────────────────┬───────────────────────────────────────┤
│ OUT BREAKDOWN (donut or bars)        │ ATTENTION (deduped insights)          │
│  Fixed         8,730 / 10,050        │ ⚠ Streamly ₪55 expected, not yet      │
│  Installments  2,340 / 2,340         │ ✓ Cancelled: AliExpress ₪58 refunded  │
│  Lifestyle       668 / 600  🔴+68    │ ? 3 transactions need a category      │
│  Car             280 / 650           │ ↑ Gym went up ₪12 vs last month       │
│  Food out        270 / 1,400         │ 🔁 New recurring? "AI TOOLS" ₪39 /mo   │
│  Supermarket     430 / 1,250         │                                       │
│  Savings           0 / 500           │                                       │
├──────────────────────────────────────┴───────────────────────────────────────┤
│ UPCOMING 14 DAYS: 11.11 Pension A 450 · 13.11 Insurer B 7/12 84 · 15.11 Gas  │
│ 91 · 22.11 Municipality 2/3 1,140 · 10.12 Isracard settlement 1,650 …         │
├──────────────────────────────────────────────────────────────────────────────┤
│ RECENT  (pending greyed, cancelled struck-through)                           │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Key interactions**
- Click any number to see the transactions behind it. Every number is traceable.
- The **Spend view / Cash view** toggle switches between counting card purchases by purchase date or by billing date.
- Insights are one per stream. They can be dismissed or snoozed and never repeat for the same thing.

## 2. Transactions

- Table on desktop, list on mobile.
- **Columns:** date, merchant (logo + normalized name, raw text on hover), account/card, category chip, amount, status badges.
- **Badges:** `ממתין` (pending), `בוטל` (cancelled, struck through), `זיכוי חלקי −150`, `תשלום 7/12`, `קבוע`, `העברה` (hidden by default), `FX $45.00`.
- **Linked groups:** a purchase and its refund render as one expandable row showing the net amount.
- **Filters:**
  - by section: Fixed / Lifestyle / Car / Food / Income / Transfers / Cancelled
  - by account
  - by status
  - by date range
  - free text
- **Actions:** change category (offers "apply to all from this merchant?" and "create rule?"), link or unlink refund, mark as transfer, exclude, split, add note, add to event, mark as recurring.
- **Review inbox tab:** uncategorized items, low-confidence AI guesses, suggested refund matches, new recurring candidates. Triage them like email.

## 3. Recurring (the "fixed" section)

```
Fixed expenses                         expected   this month   next
 🏠 Rent (cheque)        monthly  1st    4,800     ✓ 4,800      1.12
 🏛 Arnona               bi-monthly        740     ✓ 740        1.01
 🏥 Insurer A health     monthly  20th     118     ·  pending    20.11
 📺 Streamly             monthly  ~3rd     54–57   ⚠ 1 of 2 missing
 📱 Telco A              monthly  15th      89     ·           15.11
 💻 Digital (4)          monthly          120     2/4 ✓
Installments
 Insurer B car           7/12    84/mo   ends 04.2027   remaining 420
 Municipality            2/3  1,140/mo   ends 12.2026   remaining 1,140
 Store C                 2/6 & 6/6 …
Fixed income
 Salary (Employer Ltd)   monthly 1st   10,400 ✓
Candidates (confirm?)    AI TOOLS ₪39 ×2 · Cafe Nova ₪28–95 ×6 → probably NOT fixed  [Confirm][Ignore]
```

- The **subscriptions audit** shows total yearly cost per subscription, flags any running for over a year, and lists price changes.

## 4. Categories (lifestyle, car, and the rest)

- **Category groups** (editable):
  - **Income**
  - **Fixed / Recurring**: housing, utilities, insurance, health, communication, digital, sport
  - **Installments**
  - **Lifestyle**: eating out, leisure, shopping, travel
  - **Car**: fuel, insurance, maintenance, parking, tolls
  - **Daily**: supermarket, pharm, pets
  - **Savings / investments**
  - **Transfers**: hidden
  - **Fees**
- Each tracked category shows spent against target, a pace bar (weekly or monthly), a 6-month sparkline, and its top merchants.

## 5. Accounts

- Bank balance and its history line.
- Per card: current cycle spend, **next billing date and amount**, credit limit usage.
- **Connection health:** last success, last error, a "re-enter OTP" button, and history of sync runs.

## 6. Trends

- Monthly in / out / net bars for 12–24 months.
- Category trends.
- **Sankey:** income → groups → categories.
- Year-over-year view.
- Net worth (bank + savings + pension, entered manually or via a later connector).

## 7. Events ("how much did it cost me?")

- Tag transactions across months: "Trip to Rome", "Car repair 2026". Shows the total and a breakdown.

## Visual language (proposal)

- **Look:** calm, data-dense, card-based. A neutral background with one accent colour.
- **Colour meaning:** red means over or negative, green means within target or positive, grey means pending or expected.
- **Typography:** Hebrew-friendly (Heebo / Rubik / Assistant). Numbers use tabular figures and ₪ formatting.
- **Layout:** dark mode. On desktop a 3-column hub grid; on mobile a single column, mirroring RiseUp's feel.
- **Wording:** plain-language Hebrew, like RiseUp ("נשאר להוציא", "צפוי לצאת", "חריגה").

## Notifications (optional)

- **Telegram bot** (simplest, used by moneyman) or web push:
  - daily or weekly summary,
  - "fixed expense missing",
  - "big transaction",
  - "refund received and matched",
  - "sync failed / OTP needed".
- **Later:** an "Ask my money" chat (Claude over read-only SQL), e.g. "how much did I spend on the car this year?".
