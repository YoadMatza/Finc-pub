# Stock decision aids: analysts' view + your own rules (plan, 2026-11-11)

The owner asked for buy/sell/hold suggestions. finc will not produce its own verdict on a holding (personal
investment advice; an AI verdict from public numbers would sound far more certain than it is). Instead, two aids that
leave the decision with the owner:

1. **What professional analysts say** — third-party ratings, attributed, never presented as finc's opinion.
2. **The owner's own rules** — thresholds the owner sets; finc only reports which of them a holding meets right now.

Builds on `stock-insights.md` (steps 1–2 live in 0.8.0). Nothing here is built yet.

## Part A — The owner's own rules (no new data source)

### What a rule is
A template from a fixed list + the owner's numbers + a scope (all holdings or one) + "tell me on Telegram" on/off.
Rules are plain conditions over numbers finc already has; there is no free-text or code rule (nothing to inject, easy
to explain). The panel says "your rule applies", never "sell" or "buy".

### Templates (each lists the data it uses and what happens when that data is missing)

| # | Template (owner sets the numbers) | Based on | Missing data → |
|---|---|---|---|
| 1 | Price is **X%** or more below my purchase price | bank cost price × live/bank price (P0 holdings data) | unknown |
| 2 | Price is **X%** or more above my purchase price | same | unknown |
| 3 | Below the 200-day average for **N**+ sessions | step-1 trend (`daysAboveSma200`) | unknown |
| 4 | Above the 200-day average for **N**+ sessions | same | unknown |
| 5 | **X%** or more below the 52-week high | step-1 trend | unknown |
| 6 | Moved **X%** or more today (either way) | live prices (`dayChangePct`) | unknown |
| 7 | Fell **X%** or more in the last month / 3 months | step-1 returns | unknown |
| 8 | Lagged the S&P 500 by **X** points or more over 1 year | step-1 benchmark | unknown |
| 9 | P/E above **X** / below **X** | step-2 company figures (`pe`) | unknown |
| 10 | Revenue growth below **X%** vs a year ago | step-2 `revenueYoYPct` | unknown |
| 11 | Net margin down **X** points or more vs a year ago | step-2 margins | unknown |
| 12 | Shares outstanding up **X%** or more in a year (dilution) | step-2 `sharesChange1yPct` | unknown |
| 13 | This holding is **X%** or more of my portfolio | holdings totals (live or bank) | unknown |
| 14 | Analysts' consensus moved toward sell / toward buy | Part B | unknown |
| 15 | Earnings report within **N** days | Part B (earnings date) | unknown |

A rule's state is **applies / doesn't apply / unknown** — unknown is shown as such, never as "doesn't apply".
Every applied rule shows the value that triggered it and its source ("below the 200-day average for 41 sessions ·
Yahoo, 10.11"; "P/E 46 · 10-Q filed 31.10").

### Evaluation
- A pure core module (`packages/core/src/rules/`) evaluates a rule against a "facts" object assembled from the existing
  holdings, live-price, insights and company payloads — no new fetching for rules.
- When: whenever a panel is built (immediate), and once a day for all holdings (after the US close, 23:30 Israel
  time) and after each bank sync; the daily run fetches what the panels would (cached, within the existing limits).
- **Hysteresis** so a rule doesn't flap around its threshold: it turns off only when the value is past the threshold
  by a margin (e.g. 10% of the threshold, at least 1 point), or on the next day's evaluation.
- State stored per rule and holding: applies since, last value, last notified.

### Where it shows
- **Insights panel**: a "Your rules" section at the top: rules that apply (with value + source), then "N rules don't
  apply", "M unknown (data missing)", and a link to edit.
- **Holdings list**: a small badge with the number of the owner's rules that apply to that holding.
- **Telegram** (per rule, off by default): one message when a rule starts to apply ("Your rule: TICKER is 27% below
  your purchase price (rule: 25%)"), at most once per rule and holding per day; none when it stops applying (optional
  later). Sent through the existing alert path (main bot when the vault is open; the alarm bot otherwise).
- **Settings → My rules**: list, add from a template, edit numbers and scope, Telegram on/off, enable/disable, delete.
  A few example rules are offered but start **off** — the owner chooses.

### Data model
- `holding_rule`: id, template, params (JSON, validated per template), scope_symbol (null = all), notify, enabled,
  created_at, updated_at.
- `holding_rule_state`: rule_id, symbol, state (applies|clear|unknown), since, last_value, last_notified_at.
- Rule changes are recorded in the security log (`rules.changed`, keys only).

### Who can change rules
Any signed-in device or session (phone included) — rules only affect what finc shows and tells the owner. Limits for
callers away from home as elsewhere (P2-02 style: 30 edits/hour).

## Part B — What analysts say (Finnhub, free key)

### Source
Finnhub (finnhub.io), free plan: 60 calls/minute. Endpoints used (all free tier):
- `/stock/recommendation?symbol=` — monthly counts of strong buy / buy / hold / sell / strong sell, aggregated from
  the analysts covering the company;
- `/calendar/earnings?symbol=&from=&to=` — next earnings date (and EPS estimate vs actual for past ones);
- `/stock/profile2?symbol=` — industry classification (a better sector than the SIC code for step 2's sector fund).
Price targets are a paid feature and are not used. The key lives in the vault (`.\finc vault set finnhub`); only the
ticker goes to Finnhub (fixed host, no redirects, timeouts, the same rules as Yahoo/SEC).

### Accuracy and honesty
- Show the latest month with the count of analysts ("25 analysts, November 2026") and the change vs 3 months ago;
  hide when fewer than 3 analysts cover the company.
- Validate: symbol echoed, period is a recent month, counts are whole numbers ≥ 0.
- The section says plainly: "These are the published ratings of the analysts who cover the company, not finc's
  view. Analysts are often wrong, and 'sell' ratings are rare."
- Cached 24 h in a small table so the last known view (with its date) still shows while the vault is locked (the
  key is only needed to refresh).

### Where it shows
- Insights panel: "Analysts" section — a five-part bar (strong buy → strong sell), counts, change vs 3 months ago,
  next earnings date.
- Rules 14 and 15 above.

## Part C — News and an AI summary (added 2026-11-11)

**Built 2026-11-16** (core insights/news.ts, GET /api/holdings/:id/news, the panel's News section, Settings → AI switch). Not
yet: Yahoo as a fallback, and opening news links in the Android app (its link check allows sec.gov only; next app build).

### Sources
- **Finnhub `/company-news?symbol=&from=&to=`** (free tier, same key): headline, source, time, link, short summary,
  per company. Last 14 days, newest first, up to 10 after de-duplication (same link or near-identical headline).
- **SEC 8-K filings** (already in the panel, step 2) are the company's own announcements and outrank news.
- Yahoo's search news as a fallback when Finnhub has nothing.

### AI part (the owner's configured chat provider; one call per ticker per 12 h, cached)
- **Input:** the headlines (title, source, date, Finnhub's one-line summary), the 8-K titles, and the panel's computed
  facts with ids. Never quantities, amounts, cost or gains.
- **Output, validated by code before it is shown:**
  - a **tone per headline** about the company: positive / neutral / negative (a fixed enum);
  - a **4–6 sentence summary**: what has driven the stock lately and what to watch, every sentence citing headline or
    fact ids; every number must exist in the input; an advice-word list in he and en (buy, sell, hold, should,
    recommend, target, לקנות, למכור, להחזיק, כדאי, מומלץ…) rejects the output; no links in the text.
- **Headlines are untrusted text** (they can contain instructions aimed at the AI): passed as delimited data, no
  tools, output is a strict JSON schema; anything off-schema → no summary ("summary unavailable").
- Counted under the chat limits for callers away from home (P2-02).

### Where it shows
"News" section: headlines with source, date, tone dot and link (opens in the browser); the AI summary above them,
labelled "AI summary of the headlines and figures above — can be wrong".

### What Part C sends, and what it costs (written 2026-11-16, before building)
- **New outside service:** none. Finnhub is already set up (same key, same host `finnhub.io`); Yahoo is already used
  for prices. The AI provider is the one the chat already uses (now OpenAI `gpt-5-mini`).
- **What leaves the PC:**
  - to Finnhub: the ticker and a 14-day date window (as for analysts today);
  - to the AI provider: public headlines (title, source, date, Finnhub's one-line summary), the 8-K titles, and the
    panel's public market facts (price trend, returns against the S&P 500, the company's reported figures). Never
    a quantity, cost, gain, account or anything from the bank.
- **Calls:** Finnhub's free tier allows 60 calls a minute; finc makes one news call per holding per 12 hours. The AI
  call is cached per ticker for 12 hours, so at most 2 a day per stock, and only when the panel is opened.
- **Size:** about 2,000 tokens in and 400 out per summary (10 headlines and the facts). For a handful of stocks that is
  a few thousand tokens a day, inside the chat's existing limits for callers away from home; nothing runs on a
  schedule.
- **Turn off:** the summary has its own switch (Settings → AI); without a Finnhub key or an AI provider the News
  section shows the headlines it can get, or "not available", and the board's news tone stays "not available".

## Part D — Reddit attention (ApeWisdom, no key)

- **Source:** `https://apewisdom.io/api/v1.0/filter/all-stocks/page/N` — the most-mentioned tickers across stock
  subreddits with mentions, upvotes, rank, and the same 24 h earlier. finc downloads the public list (all pages, ~9)
  **without sending any ticker**: nothing about the holdings leaves the PC.
- **Kept daily** in a small table (ticker, day, mentions, rank) for the held tickers only, so "vs usual" means vs the
  30-day median, not just vs yesterday.
- **Reading:** attention only — "mentions this week 3× the usual, rank 14" / "barely mentioned" / "not in the list".
  It is never read as positive or negative: crowd attention says how loud, not which way, and stock subreddits are
  regularly used to pump tickers. The section says so.
- Refreshed every 6 h; fixed host, no redirects, size cap, validation (ints ≥ 0, ticker format).
- Rule 16 (new): "Reddit attention is **X×** its usual or more".

## Part E — The signals board (instead of a combined score)

**Built 2026-11-16** (core insights/signals.ts, the stock panel's "Signals board"): trend, against the market, company and
analysts by the rules below; news tone reads "not available" until Part C; Reddit dropped (owner, 2026-11-16).

A single combined score would need arbitrary weights ("analysts 30%, Reddit 10%") and would read as a verdict. The
board instead gives every source the same simple, documented reading and shows where they agree:

| Source | Reading | Rule (deterministic, shown on tap) |
|---|---|---|
| Trend | up / down / mixed | above both 50- and 200-day averages and the 200-day rising → up; below both → down; else mixed |
| vs the market | ahead / behind / in line | 6-month and 1-year difference vs SPY both > +5 points → ahead; both < −5 → behind; else in line |
| Company | growing / shrinking / mixed | revenue growth > 0 and margin not down > 2 points → growing; revenue growth < 0 and margin down → shrinking |
| Analysts | positive / negative / mixed | buy+strong buy ≥ 60% → positive; sell+strong sell ≥ 20% → negative; else mixed (hidden under 3 analysts) |
| News tone | positive / negative / mixed | ≥ 60% of the last 14 days' toned headlines one way → that way; else mixed (needs ≥ 3 headlines) |
| Reddit | attention: high / normal / low | vs its 30-day median (not a direction) |
| Your rules | N apply | from Part A |

Bottom line, in plain words, never a number score and never buy/sell/hold:
"Readings: trend up, ahead of the market, company growing, analysts positive, news mixed · Reddit attention high ·
2 of your rules apply." plus "The sources agree" / "The sources disagree: …". Each reading links to its section, and a
reading with missing data says "not available", never a guess.

## Safety
- No verdict anywhere in finc's own words; rule results are the owner's conditions; analyst ratings are attributed
  third-party data with a caveat; the board shows readings and agreement, never a score or an action.
- AI output is validated by code (schema, cited ids, numbers from the input, advice words); news text is untrusted.
- Rules are fixed templates with validated numbers — no code, no free text, nothing an attacker can inject.
- No new data leaves the PC for Part A; Part B sends only tickers to one fixed host.
- All rule evaluation is deterministic and tested; unknown is never shown as "doesn't apply".

## Build order (each step reviewed, tested, deployed and checked on the phone)
1. **Rules engine + panel section + Settings editor** (templates 1–13), no Telegram yet.
2. **Telegram notifications** for rules (per-rule switch, daily evaluation, hysteresis).
3. **Finnhub analysts + earnings date** (after the owner creates a key) and rules 14–15; profile2 sector; `vault set
   finnhub` asks for the key directly (stored as `apiKey`; the owner's first entry used the field name `apiKey`).
4. **News + AI summary and headline tone** (Part C).
5. **Reddit attention** (Part D) and rule 16.
6. **Signals board** (Part E) — last, once its sources exist.

Updated order agreed 2026-11-11: steps 3 → 6 next; step 2 (Telegram for rules) can slot in any time.

## Decisions for the owner

**Decided 2026-11-16:** parts A and B are built; next C (news and an AI summary) and E (the signals board); D (Reddit
attention) is dropped.
1. Start with rules only (Part A), or both together.
2. Telegram for rules: built in step 2 as planned, or not at all.
3. Which example rules to suggest (all start off), or none.
4. For Part B: create a free account at finnhub.io and store the key with `.\finc vault set finnhub`.
