# "Your position" view (plan, 2026-11-11)

The owner asked "is it worth it for me, and what is the correct move". finc will not name a move (personal investment
advice; it also depends on goals, horizon and risk that finc does not know). It will show the facts about **the
owner's own position** next to the general data (stock-insights, decision aids), so the decision is made with
everything in one place, or taken to a licensed advisor with exact numbers.

Step 1 is built (2026-11-18, §4): the purchase lots and this year's tax summary are read on every FIBI sync. Step 2
is built (2026-11-18, §5): the calculations and `GET /api/holdings/:id/position`. Step 3 is built (2026-11-18, §6): the
view in the stock panel.

## 1. What finc knows today, and what is missing

| Fact | Today | Gap |
|---|---|---|
| Quantity, current price, value (USD and ILS) | bank holdings page, twice a day; live prices | — |
| Cost | bank's "adjusted cost price" per unit, **in USD only** | no purchase dates, no shekel cost, no fees |
| Real gain for tax | — | the bank computes it; finc does not read it |

The bank's site has two pages finc does not read yet (seen in the 2026-11-10 explore run):
- **ביצועים (executions)**: the trade history: security, action (buy/sell), date, price, quantity, and likely fees and
  the shekel amount.
- **רווח הון (capital gains)**: the bank's own per-security figures: shekel cost, value, real gain, and probably the
  tax it would withhold. These are the binding numbers for the tax; finc should show them, not re-derive them.

## 2. Plan

### Step 1: read the two pages (connector + storage)
- One explore run of the FIBI connector on those two pages (headless, during a normal sync, with the vault open), to
  learn their exact layout. Dumps stay in `data/dumps/` (local, retention 14 days).
- Parsers in `packages/core/src/ingest/fibi-pages.ts`, fail-closed like the holdings parser (a page that doesn't parse
  is skipped and logged as a code; never half-read).
- Tables:
  - `security_trade`: date, symbol, side (buy/sell), quantity, price, currency, fee, amount in ILS, FX rate if shown,
    source row hash (dedupe across syncs).
  - `capital_gain_snapshot`: taken_at, symbol, cost in ILS, value in ILS, real gain in ILS, tax estimate in ILS
    (whatever the bank shows; nulls for what it doesn't).
- Read on every bank sync (the same login; two extra page loads).

### Step 2: the calculations (pure core module, tested on hand-computed fixtures)
1. **Your result:** gain in ₪ and % (from the bank's capital-gains page when present; else value − cost at today's
   rate, labelled "estimate"), and **per year** (money-weighted return over the actual trade dates: XIRR).
2. **Against the market:** the same purchases, on the same dates and amounts, put into the S&P 500 (SPY, adjusted
   closes incl. dividends): what that money would be worth today, and the difference in ₪ and %.
3. **The dollar's part:** your result in USD vs in ₪: how much came from the stock and how much from USD/ILS.
4. **If you sold today:**
   - proceeds = value − estimated fee (the fee rate your own past trades show; else a setting, default 0) − tax;
   - tax = the bank's figure when it shows one; otherwise an estimate of 25% of the real gain (the general Israeli
     rate for individuals), labelled "estimate — the bank's calculation is binding";
   - at a loss: the loss that would be realised (it can offset other capital gains in the same tax year).
5. **What if:** position value at −30 / −10 / +10 / +30%, and the break-even price (cost incl. fees, before tax).
6. **Weight:** this stock's share of the securities portfolio and of total net worth.
Every figure shows its source (bank page / computed / live price) and date.

### Step 3: the view
- In the stock's insights panel, "Your position" grows into a section with the six blocks above, then the general view
  (trend, company, analysts, news, your rules) below it as today.
- A "trades" list (date, buy/sell, quantity, price, ₪) behind a toggle.
- Wording: facts only — "if you sold today you would receive about ₪X after an estimated ₪Y tax", never "you should".
  Footer: "Information, not investment advice. Tax figures are estimates unless they come from the bank; the bank's
  calculation is binding. For a recommendation that fits your situation, talk to a licensed investment advisor."

### Safety and privacy
- Everything is computed on the PC; nothing new leaves it (the S&P comparison uses Yahoo history finc already
  fetches for SPY).
- No new credentials; the extra bank pages are read in the existing logged-in session.
- Trades and capital gains are personal financial data: same handling as transactions (local DB, encrypted backups,
  never in logs, never to the AI or Telegram as raw rows).

### Build order (each step reviewed, tested, deployed and checked on the phone)
1. Explore run → parsers → tables (the owner checks a few trades against the bank's site).
2. Calculations + API.
3. The view.

## 3. Decisions for the owner

**Decided 2026-11-16:** yes to all three with the defaults: both bank pages join the sync, fee 0 when the trades page
shows none, the S&P 500 comparison is in.
1. OK to add the two bank pages to the sync (one explore run first, during a normal sync).
2. Fee assumption when the trades page shows no fee: 0, or a rate you give.
3. Include the "same money in the S&P 500" comparison (yes by default).

## 4. Explore run results (2026-11-18, manual, old capital-market area)

The bank's names differ from the guesses above. What the pages hold (layout only; dumps in `data/dumps/`):
- **עלות נומינלית לחישוב רווח הון** (מסים): one row per purchase lot: security (name + number), action (buy on the
  exchange, split/merge received, dividend in shares received), quantity, nominal cost price incl. the purchase fee,
  cost in ILS, currency, execution date, average price (old lots only), current price, % change from cost. Lots of the
  same security are listed separately by date. The bank labels these raw figures, not the full tax cost. **This fills
  the main gap: purchase dates, per-lot cost and the fee.**
- **פירוט אירועי מס - סיכום שנתי** (מסים): per tax year (three years shown): losses, gains by tax rate, tax withheld by
  rate, interest and dividend income and the tax withheld on it. Realised results only.
- **סימולציית מס לתיק** (מסים): holdings with an editable quantity; the tax figures appear only after "חשב לניירות
  שנבחרו". Not needed: finc computes "if you sold today" itself.
- **תנועות בני"ע**: needs a date range before it shows anything (the run recorded the empty form: filters for
  security type, movement type and security). Sells come from here; one more run with a range, or the connector
  fills the range itself.
- **הוראות וביצועים** (new area): recent orders and executions only (security, action, executed quantity, price,
  value, currency); not a history.

Revised step 1: read the cost-lots page and the annual tax summary on every sync; trade history from תנועות בני"ע with
a date range once its result layout is recorded.

## 5. Step 2 as built (2026-11-18)

Core `insights/position.ts` (pure, tested on hand-computed fixtures) and `GET /api/holdings/:id/position` (same
404s and outside rate limit as the insights route).

- **Joining lots to holdings.** The cost page names a paper by the bank's number and a shortened name, the holdings
  page by ticker, and the two names often differ. A paper's lots are joined to the one holding with the same total
  quantity, the same currency and a current price within 5%; a paper that fits none or several holdings, or a holding
  two papers fit, stays unmatched (`available: false, code: 'not_matched'`). On the real portfolio all five papers
  matched one holding each.
- **Cost** is the bank's per-lot cost in shekels (purchase fee included); value is the live value when the quote is
  fresh, else the bank's.
- **Per year** (XIRR over the lot dates) only when every lot was bought and the first is a year old or more; shares
  received (split, dividend in shares) have a result but no yearly rate and no market comparison
  (`received_shares`).
- **S&P 500**: each bought lot's dollar cost into SPY at the dividend-adjusted close of its date (or the last session
  before it), valued at SPY's last close and today's rate; left out when SPY's last close is over 7 days old or its
  history (10 years, fetched for this view; the panel's is 5) starts after the first lot.
- **The dollar's part**: the paper's move at today's rate, and the rest of the shekel result (the rate's move on the
  money paid); the two add up to the result exactly. The rate at purchase is the bank's (shekel cost / dollar cost).
- **If sold today**: fee rate 0 (decided), tax 25% of the nominal shekel gain after the fee, labelled an estimate
  (the real gain the bank computes may differ; the bank's figure is binding); at a loss, the loss that would be
  realised. This year's realised figures from the tax page come along as `taxYear`, not applied to the estimate.
- **What if** −30/−10/+10/+30% and the break-even price at today's rate; **weight** of the securities account and of
  net worth.

## 6. Step 3 as built (2026-11-18)

`apps/web/src/components/PositionDetail.tsx`, under "Your position" in the stock panel (InsightsView), fetched on
its own (kept 5 minutes) so a slow insights answer never holds it up. Blocks: gain or loss (shekels, the paper's
currency, per year), against the S&P 500, the dollar's part (foreign papers only), if you sold today (with the
bank's realised figures for this year), what if with the break-even price, the share of net worth, the purchases
behind a toggle, the sources line and the disclaimer. A block that cannot be computed says why in one line; with no
lots, or lots that fit no holding, the section is a single muted line. Hebrew and English texts; numbers are LTR
isolates inside Hebrew sentences. Wording is facts only ("you would receive about"), never "you should".

## 7. Trade history explore run (built and run 2026-11-21)

תנועות בני"ע shows nothing until it gets a date range, so the explore run (`--explore`) now fills its form itself:
`#TrFrom` / `#TrTill` in dd/mm/yyyy, 10, 3 and 1 years back to today (how far back the bank allows is unknown), then
the page's own `show()`. Each answer (visible text and markup of every frame) goes to one owner-only file,
`data/dumps/beinleumi-trades-explore-<time>.json`; the log gets counts only (form found, shown, lines with a date). The
wider portal survey runs only with `FINC_EXPLORE_ALL=1` or in manual mode. Checked against a local fake page (all three
ranges submitted with the right dates); the bank run is the owner's, from the host (the scraper container cannot write
dumps): stop the worker, `.\finc spike beinleumi --explore --headless`, start the worker, unlock. The parser for sells
follows once the result layout is recorded.

**First run (2026-11-21):** the bank refuses a range that starts more than about 2.9 years back (1,055 days) and names
its earliest date ("ניתן להציג תנועות רק מתאריך"); 10 and 3 years were refused. One year back answered with a table of
17 columns (paper, symbol, value date, action, quantity, price, account type, currency, gross and net proceeds, tax in
Israel and abroad, commission, a derivatives fee, reason for a non-execution, registration and payment dates): 16 rows,
dividends and custody fees, no buys or sells. The purchases behind the current lots are older than the bank's limit,
so cost stays on the lots page; this page can add sells, dividends and fees within the limit. The run now asks for 10
years, then again from the date the bank names, with 1 year as the last fallback (checked against a local fake page).

**Second run (2026-11-21):** 10 years refused, then from the bank's earliest date (about 2.9 years) one page of 41
rows: dividends (most of them, in dollars), custody fees (in shekels), one executed exchange buy with its commission,
five buy orders that did not execute (marked "שער לא תפס" in the reason column, so a parser must drop them), one
received benefit and two dividend-tax rows. No sells in the window. What a parser here would add to the view:
dividends received per paper, custody fees, and the real commission on a buy (instead of the fee assumption).

## 8. Trade history in the sync and the view (built 2026-11-21)

- Every FIBI sync now also reads תנועות בני"ע: 10 years asked, then from the date the bank names, 1 year as the
  fallback. `parseFibiTradesText` reads the range line and the 17-column rows (the paper's name and number sit on the
  lines above each row; custody-fee rows have none), fail-closed, and leaves out orders that never went through
  (a non-execution reason), counting them. On the 2026-11-21 page: 36 rows read, 5 left out.
- Rows go to `security_trade` (migration 0023), each kept once (`row_key` from its own fields) and never rewritten, so
  history older than the bank's ~3-year window stays once seen.
- The position route adds `trades` (`positionTrades`): this paper's dividends per currency (gross, net, tax), its
  sales, the account's commission rate on past buys and sells, and its custody fees in the last 12 months. Papers tie to
  the matched lots by number, leading zeros dropped. When a commission rate exists, "if you sold today" uses it
  (`feeSource: 'bank_trades'`, decision 2) instead of the assumed 0.
- The stock panel shows a "Dividends and costs" block: dividends net with their tax, any sales, the custody fees, and
  how far back the bank's history reaches. Dividends are shown apart from "your result", which stays price-only.
