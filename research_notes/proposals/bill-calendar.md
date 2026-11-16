# Bill calendar (proposal, 2026-11-16)

Idea from Monarch / Simplifi (the original plan's "extras"), chosen by the owner on 2026-11-16 (gaps plan D8). Nothing
is built yet.

## What it is

A month grid of the days fixed money moves: rent on the 1st, the phone on the 25th, the card bill on the 2nd, salary on
the 10th. Each day shows what is due, what already came, and what is late. Helps avoid an overdraft before the salary
day and shows when the month's money goes out.

Today the Now screen lists the next 14 days of fixed charges; the calendar shows the whole month at once and adds the
card bills.

## What it shows

- Every expected slot of confirmed recurring streams (fixed expenses and fixed income) for the month: matched (paid,
  with the real amount), upcoming, or missing (late).
- Instalment slices due that month.
- The card bills: each card's expected charge to the bank account, from its billing day and the card's current
  statement (the settlement engine already links past bills; the next one is the card's unbilled total so far).
- Per day: the sum going out and coming in; above the grid the month's running balance line for the bank account
  (today's balance plus what is still to come, day by day), with the lowest point marked.
- Phone: a list by day instead of the grid; tap a day for its items.

## Data

Nothing new stored: expected slots, instalment plans, settlement links and the bank balance already exist. One new
read endpoint `GET /api/calendar?month=YYYY-MM`.

## Cost

Small to medium: the card-bill estimate is the only new calculation; the rest is a view.

## Decision for the owner

Where: a tab in Recurring (suggested), or its own screen in the menu?
