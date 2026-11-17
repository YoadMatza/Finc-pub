# Unusual-charge alert (proposal, 2026-11-16)

Idea from Snoop / Copilot (the original plan's "extras"), chosen by the owner on 2026-11-16 (gaps plan D8). **Built 2026-11-16** (`07a8ee7`).

## What it is

A Telegram alert (and a review-inbox item) when a charge is far above what that merchant usually costs you: the
supermarket that is always ₪300–₪500 suddenly charges ₪2,400; a ₪49.90 subscription charges ₪499. Catches mistakes,
double charges and fraud that stay under the big-purchase threshold.

Today: the big-purchase alert fires on any charge over a fixed amount (₪1,000 by default), and the price-change insight
covers recurring payments only.

## Rule

- History: the merchant's completed charges on the same account in the last 12 months, at least 4 of them.
- Unusual: the new charge is more than **3×** that merchant's median and at least **₪200** above it; for a confirmed
  recurring payment the existing price-change insight already covers it, so those are skipped.
- Not alerted: instalment plans (the first slice already has its own alert), refunds, transfers, person-to-person
  money, merchants with fewer than 4 charges (no "usual" yet), and a charge already alerted as a big purchase (one
  alert per charge).
- Pending charges count, like the big-purchase alert, so a mistake is seen before it completes.

## Where it shows

- Telegram money alert (type `unusual_charge`, on by default, quiet hours respected): "Unusual for SUPER YUDA: ₪2,400,
  usually about ₪420 (12 charges this year)".
- Review inbox item with the same text and a link to the transaction.
- Alert settings: on/off and the multiplier (2–10×).

## Cost

Small: one query per new charge in the alert ticker, tests on hand-made histories.

## Decision for the owner

The defaults (3×, ₪200 above, 4 past charges): OK, or other numbers?
