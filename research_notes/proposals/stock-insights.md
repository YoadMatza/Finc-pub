# Stock insights: design (2026-11-11)

Tap a holding → a panel that explains how the company and the stock are doing, from facts, so the owner can decide.
finc never says buy, sell or hold. This note is the design; it is built (the stock panel in the hub), with decision aids C and E on top (stock-decision-aids.md).

## 1. Principles

1. **Facts first, AI last.** Every number is computed by finc from a named source, with a formula in code and tests.
   The AI may only explain those facts in words; it never produces a number or a verdict.
2. **Every number carries its source and date** ("SEC 10-Q, filed 2026-10-31", "Yahoo close 2026-11-10"). Nothing is
   shown without them; stale data is labelled, never passed off as current.
3. **Two sources where it matters.** A price from Yahoo is checked against the bank's own price (FIBI, twice a day);
   company figures come from the company's own SEC filings, the legal source.
4. **No verdict, no single score.** A "strength score" reads as advice and hides what drives it. Instead: separate
   dimensions, each with a neutral, explained reading ("price above its 200-day average for 7 months").
5. **Privacy:** only ticker symbols (and SEC company numbers) leave the PC, as with live prices. Never quantities,
   amounts or gains — not to Yahoo, not to SEC, not to the AI.
6. **Fail closed:** a section whose data is missing, stale or inconsistent is hidden with a short reason, not guessed.

## 2. Sources (checked 2026-11-11 from the worker container)

| Source | What | Key | Status |
|---|---|---|---|
| Yahoo chart endpoint | daily history 5 y, splits, dividends, adjusted closes, instrument type, exchange | none | works |
| Yahoo search endpoint | news headlines per ticker (title, publisher, time, link) | none | works |
| SEC EDGAR `company_tickers.json` | ticker → CIK (company number) | none (needs a User-Agent with a contact) | works |
| SEC EDGAR `companyfacts` (XBRL) | revenue, net income, EPS, cash, debt, equity, shares outstanding, by period, from 10-K/10-Q (20-F/6-K for foreign filers) | same | works |
| SEC EDGAR `submissions` | filing list (10-K, 10-Q, 8-K…), SIC industry code | same | works |
| Bank (FIBI) holdings | price, quantity, cost, twice daily | — | in finc already |
| Yahoo `quoteSummary` (analyst ratings, P/E, margins) | — | — | blocked (crumb + cookie); not used |
| Stooq (second price history) | — | — | blocked (403); not used |
| Finnhub (optional) | analyst recommendation trends, earnings calendar, company news | free key | not used unless the owner adds a key |

SEC rules: at most 10 requests/second, a User-Agent naming the app and a contact e-mail. finc caches facts for a day,
so a panel open costs at most 2 SEC requests.

## 3. What the panel shows

Holdings so far are single companies (instrument type EQUITY), so every section applies. An ETF would get
sections A–C, F and G only.

**A. Your position** (exists): quantity, value, gain since purchase, today's change, share of the portfolio.

**B. Price and trend** (from adjusted daily closes, 5 years):
- 1-year chart with the 50- and 200-day moving averages;
- price vs. each average (above/below, by how much, for how long);
- place in the 52-week range (% from the high and from the low);
- returns over 1 m, 3 m, 6 m, 1 y, 3 y (annualised), from adjusted closes (splits and dividends included).

**C. Compared with the market:** the same returns for the S&P 500 (SPY) and for the company's sector ETF (SIC code →
one of the 11 SPDR sector funds, e.g. technology → XLK), side by side: "beat the market by 8 points over 1 y".

**D. Risk:** volatility (annualised standard deviation of daily returns, 1 y), deepest drop from a high in 1 y and 5 y
(max drawdown), beta vs. SPY (1 y of daily returns).

**E. The company's numbers** (SEC filings; stocks only):
- revenue and net income: last 4 quarters summed (TTM) and growth vs. the year before;
- profit margin (net income / revenue, TTM) and its direction over 3 years;
- EPS (diluted, TTM) and P/E = price / EPS TTM (shown only when EPS > 0);
- cash, total debt, debt-to-equity (latest balance sheet);
- shares outstanding vs. a year ago (buybacks or dilution);
- each figure with its filing (form, period end, filing date). TTM built from quarterly facts with fiscal periods
  checked (no double-counted Q4 from a 10-K), falling back to the latest annual figure, and labelled so.

**F. Events:** recent filings (10-K, 10-Q, 8-K with their item titles, e.g. "results of operations",
"departure of directors"), dividends and splits from the price history.

**G. News:** latest 5–8 headlines (publisher, time, link). Opened in the phone's browser, never inside finc.

**H. AI summary (optional):** 4–6 sentences: what has driven the stock and the company lately, and what to watch,
built only from sections B–G. Labelled "AI summary of the facts above".

**I. Footer:** "Information, not investment advice", the sources and when each was fetched.

## 4. Accuracy

- **Formulas in one core module**, each with tests on fixed fixtures (known series → known moving average,
  drawdown, volatility, beta; known XBRL facts → known TTM).
- **Adjusted vs. raw prices:** returns and averages from adjusted closes; the current price and the bank comparison
  from raw closes.
- **Cross-check:** the latest Yahoo close vs. the bank's price at the bank's sync; more than 2% apart → section B is
  labelled "prices disagree with the bank" and the bank price is shown next to it. Per-ticker mismatch counts are
  logged (counts only).
- **SEC facts:** the right concept per figure (e.g. `Revenues` or `RevenueFromContractWithCustomerExcludingAssessedTax`,
  choosing by the most recent filing that reports it), the right unit (USD, USD/share, shares), deduplicated by
  accession number, latest amendment wins; sanity bounds (revenue ≥ 0, shares > 0, margin between −500% and 100%),
  otherwise the figure is hidden.
- **Ticker → company:** from SEC's own list; a ticker missing there (non-US listing) skips section E with a reason.
- **Golden test:** for one well-known company, the computed TTM revenue, EPS and P/E are checked by hand against the
  10-Q once, and stored as a regression fixture.

## 5. The AI part, made safe

- **Input:** a structured JSON of the facts from B–G (numbers already computed, each with an id), the company name and
  the headlines. No quantities, amounts, gains, cost or anything about the owner.
- **Instructions:** describe, don't advise; every claim must point to fact ids; no buy/sell/hold, no price targets,
  no "should", no predictions stated as fact; Hebrew or English as the app language.
- **Headlines are untrusted data:** passed in a delimited block, the model is told they may contain instructions to
  ignore; no tools, no browsing, no links in the output.
- **Output validation (code, not the model):** every number in the text must appear in the input (± rounding);
  each sentence cites ≥ 1 fact id; a word list in both languages rejects advice wording (buy, sell, hold, recommend,
  target, should, לקנות, למכור, להחזיק, מומלץ, כדאי…); length limit. Any failure → no summary, "summary unavailable".
- **Cost:** one summary per ticker per 12 hours (cached), shared by phone and PC; counted under the P2-02 chat limits
  for callers away from home.

## 6. Safety and privacy

- Fixed hosts only (query1/query2.finance.yahoo.com, www.sec.gov, data.sec.gov), no redirects, no cookies, timeouts,
  symbol and CIK validation (same rules as live prices).
- SEC User-Agent: "finc personal finance app <contact>" — the contact is the owner's choice (a dedicated alias is fine).
- Caches in memory and a small table (`insight_cache`: key, fetched_at, source, JSON), never holding amounts.
- Fetches only when a panel is opened (and the daily SEC refresh for held tickers); no background polling of news.
- The panel is read-only; it changes nothing in finc.

## 7. Build order (each step usable on its own, each reviewed)

1. **Price analytics** (B, C, D) + bank cross-check — no new hosts beyond Yahoo, no AI.
2. **Company numbers and filings** (E, F) from SEC EDGAR — needs the contact for the User-Agent.
3. **News** (G).
4. **AI summary** (H) with the validator; can be switched off.
5. **Optional later:** Finnhub (analyst consensus, next earnings date), Telegram notes on big moves (e.g. crossing the
   200-day average, a drop > 10% in a week), portfolio view (concentration per company and sector, currency exposure).

## 8. Decisions for the owner

1. The contact e-mail for SEC's User-Agent (or "use a dedicated alias I'll create").
2. AI summary: on or off.
3. Later: a Finnhub key for analyst consensus and earnings dates — yes/no.
