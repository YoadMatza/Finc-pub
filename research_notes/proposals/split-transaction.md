# Split one transaction across categories (proposal, 2026-11-16)

Idea from YNAB / Actual (the original plan's "extras"), chosen by the owner on 2026-11-16 (gaps plan D8). Nothing is
built yet.

## What it is

One charge, several categories: a Super-Pharm receipt of ₪240 that was ₪150 pharmacy and ₪90 household. Today a
transaction has exactly one category, so the whole ₪240 lands in one of them.

## How it works

- In the transaction sheet, "Split" opens rows: category + amount. The rows must add up to the charge exactly; the
  last row takes the remainder. Two to eight parts.
- The transaction keeps its own category as the "main" one (for rules, merchant memory and the AI, which never see
  splits). Everything that sums money by category reads the parts instead: the month summary, Trends (series, the
  Sankey), Categories, the spending limit's per-category view, the chat's lookups, the yearly report.
- Buckets do not change: a split purchase is still one fixed / variable / instalment row; only its category share
  moves. So left-to-spend, the limit, the forecast and the integrity check are unaffected.
- Undo: "Remove split" puts the whole amount back on the main category.
- Refunds: a refund linked to a split purchase is split in the same proportions.

## Data

New table `txn_split` (txn_id, category_id, amount, sort). No row = not split. A check in the integrity panel: parts
of every split add up to its transaction.

## Cost

Medium: one table, one sheet, and every per-category sum moves to a shared helper (that refactor is most of the work).

## Decision for the owner

Allowed on income too (a payment that was part salary, part refund)? Suggested: spending only, to start.
