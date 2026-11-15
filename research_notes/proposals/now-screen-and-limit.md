# The "Now" screen and a monthly spending limit (plan, 2026-11-12)

> All amounts in this document are illustrative, not real figures.

The owner's question on 2026-11-12: "left to spend ₪11,379 — something feels off, and what is it based on?" It was
arithmetically right (all income this month − fixed and instalments − savings − day-to-day spent) but it treated a
one-off ₪11,640 freelance payment as this month's spending money, which also inflated the weekly envelope (₪4,900) and
the month-end projection. Both incomes are real and either can stop, so finc shows **how much rests on what** instead
of hiding one of them, and adds a spending limit as a separate, owner-set line.

Nothing here is built yet.

## 1. Definitions

- **Regular vs extra income** — by category, editable: salary and recurring income = regular; freelance, gifts,
  one-off transfers, refunds from outside, cashback = extra. Settings → Categories shows the tag per income category;
  a single payment can be re-tagged from its transaction sheet. Unknown income categories default to extra.
- **Received vs expected** — received = income transactions already in the bank this month; expected = recurring income
  finc predicts for the rest of the month (the forecast's existing "still expected" slots), shown separately and marked
  as expected.
- **Paid back to me** — an incoming Bit / bank transfer that repays something you paid for (a shared dinner, a ticket).
  Marked as such, it reduces day-to-day spending instead of counting as income. finc asks once per payer ("Is X paying
  you back?" — always / this time / no) and remembers the answer as a counterparty rule (the existing
  `counterparty_rule` table gains a `paid_back` action). Until answered, the payment counts as extra income.
- **Typical month** — the median of the last 6 complete months (median, so one unusual month — e.g. May 2026 — does not
  distort it): income, regular income, fixed + instalments, day-to-day spending.

## 2. The "left to spend" card

```
נשאר להוציא החודש            ₪11,379            (headline: all income, unchanged formula)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 משכורת וקבועות  │ הכנסה נוספת                  (split bar: regular part | extra part)
 −₪275           │ +₪11,640 (פרילנס 9.11)
 התקבל: ₪27,872 · עוד צפוי: ₪0                  (received vs expected)
 בלי ההכנסה הנוספת: בערך מאוזן (−₪275)          (is the normal month OK on its own?)
 חודש טיפוסי (6 ח׳): הכנסה ₪22.6K · הוצאה ₪21.8K   (typical month)
 [איך זה מחושב?]
```

- The headline keeps the full, honest number. The split shows what it rests on.
- "Without the extra": regular income (received + expected) − fixed − instalments − savings − day-to-day so far.
  Tone: "comfortably positive" / "about break-even" (within ±5% of regular income) / "short by ₪X".
- The weekly envelope and the month-end projection are computed **on the regular part** when a large extra exists
  (> 20% of the month's income), with a note "the extra ₪11,640 is not spread into your weekly amount"; the owner can
  switch this per month ("spread the extra too").
- **"How is this calculated?"** opens a sheet listing every term with its transactions: each income (received /
  expected, regular / extra), fixed and instalments (paid / still expected), savings, day-to-day spent, paid-back
  amounts netted — so every shekel of the headline can be traced.

## 3. The monthly spending limit

- **What it limits:** day-to-day (variable) spending for the calendar month — the same "משתנות" total the screen shows,
  net of paid-back money. Fixed bills, instalments and savings are not part of it.
- **Setting it:** Settings → "Monthly spending limit" (amount, or off), and a quick edit from the Now screen. Optional;
  with no limit, the screen works as today plus section 2. The value applies from the current month on; earlier months
  keep the limit they had (stored per month, so history stays honest).
- **The card (when set):**
  ```
  הוצאות יומיומיות: ₪2,180 מתוך ₪5,000
  ▓▓▓▓░░░░░░░░░░░░░░  │ (pace marker: where you'd be today if spread evenly — ₪2,050)
  בקצב · נשאר במסגרת: ₪2,820 · השבוע: ₪140 מתוך ₪1,160
  ```
  - pace: actual vs the even-spread amount by today → "on pace" / "₪X ahead of pace" / "₪X under pace";
  - left within the limit, and this week's share (what's left of the limit ÷ weeks left, Sunday–Saturday);
  - the existing category targets (Categories screen) listed under it, with a warning when their sum exceeds the limit.
- **Two numbers on the Now screen when a limit exists:** "left within your limit" (the limit card) and "cash left
  after bills" (the card in section 2). They answer different questions and are labelled so.
- **Alerts (optional, Telegram):** at 80% and at 100% of the limit, once each per month; and "ahead of pace by more than
  20%" at most once a week. Through the existing alert matrix (quiet hours respected).

## 4. Data and API

- Settings: `income.kind.<categoryKey>` (regular|extra; defaults as in §1), `spend.limit.<YYYY-MM>` (agorot) with the
  latest value carried forward, `spend.alerts` (on/off), `spend.spreadExtra.<YYYY-MM>` (bool).
- Transactions: `income_kind_override` (nullable), and the paid-back marker via the counterparty rule or a
  per-transaction flag (`paid_back`).
- `GET /api/hub` (the Now payload) gains: `income: { regular: {received, expected}, extra: {received, expected,
  items: [{id, name, amount, date}]} }`, `withoutExtra: { left, tone }`, `typical: { income, regularIncome, fixed,
  variable, months }`, `limit: { amount, spent, pace, leftWithin, week: {limit, spent}, alerts } | null`,
  `explain: [...]` (the terms for the sheet). Existing fields unchanged.
- `PATCH /api/settings` for the limit and income kinds (from home and from the phone — it only changes what finc shows;
  limits away from home as elsewhere); `PATCH /api/transactions/:id` for overrides and paid-back.

## 5. Accuracy and safety
- All computed on the PC from data finc already has; nothing new leaves it.
- Pure functions with hand-computed tests: the split, without-extra, typical (median), pace, weekly share, carry-forward
  of the limit, paid-back netting (never double-subtracted), the large-extra rule for the weekly envelope.
- The headline formula does not change; everything new is additional and explained.
- Wording stays descriptive ("ahead of pace by ₪X"), never instructions.

## 6. Build order (each step reviewed, tested, deployed and checked on the phone)
1. Income kinds + received/expected + without-extra + typical month + the "how is this calculated" sheet.
2. The spending limit (settings, card, pace, weekly share, category-target check).
3. Paid-back money (ask once per payer, rule, netting).
4. Telegram alerts for the limit.

## 7. Decisions for the owner
1. Defaults for income kinds as in §1 (freelance = extra) — or freelance as regular.
2. Weekly envelope: computed on the regular part when a large extra arrives (default), or always on everything.
3. Limit alerts on by default once a limit is set, or off.
