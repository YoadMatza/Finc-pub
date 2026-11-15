# 03 — What exists outside Israel

Researched on 2026-11-08. **[PK]** marks prior knowledge that was not re-checked against a live source.

## Commercial apps

| App | Philosophy | Standout ideas | Aggregator |
|---|---|---|---|
| **Monarch Money** | Tracking + "Flex" budget | Three buckets (fixed, non-monthly, flexible) with **one number to watch**. **Confirm newly detected recurring items.** Cash-flow forecast, partner sharing, AI assistant over your data ([flex](https://www.monarch.com/blog/flex-budgeting-simplify-your-spending-with-just-one-number), [AI](https://help.monarch.com/hc/en-us/articles/37526856682260-AI-in-Monarch)) | Plaid / MX / Finicity, switchable |
| **Copilot Money** | ML-first tracking (Apple) | Categoriser learns from corrections. "Needs review" inbox. Beautiful UI. Web app since Dec 2025 ([dispatch](https://www.copilot.money/dispatch/web-app)) | Plaid + fallbacks |
| **YNAB** | Zero-based envelopes | Credit-card payment categories; scheduled transactions; targets **[PK]** | Plaid / MX / TrueLayer |
| **Rocket Money** | Subscription killer | Detects and cancels subscriptions; AI "Rowan" | Plaid |
| **Emma / Snoop (UK)** | Tracking + nudges | Subscription detection; "bill went up" alerts; cancellation guides | UK Open Banking |
| **Lunch Money** | Power user, multi-currency | **Rules engine** with actions (link to recurring, split, mark reviewed). Creating a recurring item creates a rule. Full public API ([rules](https://support.lunchmoney.app/setup/rules)) | Plaid + CSV |
| **Simplifi (Quicken)** | Spending plan | **"Available to spend" = income − bills − savings − spent**, live. Projected balance chart and what-if ([review](https://www.thepennyhoarder.com/budgeting/simplifi-app/)) | Quicken / Plaid / Finicity |
| **PocketGuard** | Safe-to-spend | "In My Pocket" number | Plaid |
| **Empower** | Net worth / investments | Net worth, fee analyser, retirement planner | Yodlee |
| **Cleo** | AI chat-first | Conversational coach | Plaid |

## Open-source / self-hosted

| Project | Stack / licence | Highlights | Verdict for us |
|---|---|---|---|
| **Actual Budget** | TS/React, local-first, MIT | Strong rules engine; schedules with match windows; linked transfer pairs; very active (26.11 adds automatic bank sync) ([transfers](https://actualbudget.org/docs/transactions/transfers)). Israeli importers exist. | Best "build-on" candidate. Its UX is envelope (YNAB) style, not RiseUp cashflow style. |
| **Firefly III** | PHP/Laravel, AGPL | Double-entry; explicit withdrawal/deposit/transfer types; rich rules; subscriptions | Mature but heavy. Its UI is accounting-ish. |
| **Sure** (fork of Maybe) | Rails/Postgres, AGPL | Net worth, AI chat, LLM categorisation, Sankey chart ([repo](https://github.com/we-promise/sure)) | Good for ideas (AI categoriser, Sankey). |
| **Ghostfolio** | Angular/NestJS, AGPL | Investments and portfolio | Possible later add-on for investments. |
| **hledger / Beancount + Fava** | Plain-text double-entry | Declarative CSV rules; forecasting | Inspiration for importer mapping files. |
| Budget Zen, Paisa | — | Archived / alpha | Skip. |

## Techniques worth stealing

1. **Plaid-style recurring "streams"** ([Plaid blog](https://plaid.com/blog/recurring-transactions/)):
   - Group by normalized merchant, then by cadence (7/14/30/61/91/365 days ± tolerance), then by amount stability.
   - A stream has `frequency`, `avg_days_apart`, `last_amount`, `next_expected` and `is_active`.
   - It becomes *mature* after 3 hits, or 2 for annual streams. Before that it is in *early detection*.
   - Mark it inactive after 1.5× the interval with no charge.
2. **Ask before trusting** (Monarch): new recurring streams go to a "confirm" queue. This would have prevented RiseUp's coffee-shop-as-fixed-expense mistake.
3. **Transfers as first-class links** (Actual, Firefly): a pair of opposite-sign transactions across your *own* accounts is never income or expense.
4. **Categorisation pipeline**:
   1. user rules,
   2. merchant memory (the last category used for this merchant),
   3. LLM fallback with a confidence score,
   4. **review inbox**,
   5. "make this a rule?" after a manual correction.
5. **Safe-to-spend number** (Simplifi, PocketGuard, Monarch Flex): this is RiseUp's headline, made better.
6. **Projected balance line** for the next 30–90 days, built from recurring streams plus installments plus card billing dates.
7. **Ad-hoc tags / events** (Lunch Money groups ≈ RiseUp "כמה עלה לי").
8. **AI chat over your own data** (Monarch, Sure, Rocket): an LLM with a read-only SQL tool. This is cheap to add once the data model is clean.
9. **Sankey "where did the money go"** (Sure): a great hub visual.
