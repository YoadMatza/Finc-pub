# Ask an AI app about your money (MCP)

finc can answer questions from an AI app you already use (Claude Desktop, Claude Code, or another app that speaks
MCP), without giving it your bank. It is **off by default**, **read-only**, and **local**: the app starts finc's MCP
server on this PC; nothing about it faces the internet.

## What the app gets, and what it never gets

The app calls the same ten tools finc's own chat uses: spending totals and averages, a month's summary, what changed
against earlier months, spending per category, top merchants, a transaction search, fixed bills, trends, tagged
events and net worth by kind. It gets amounts, dates, counts, category names, your own labels, and the merchant names
of card purchases.

It never gets account or card numbers (not even the last four digits), IBANs, bank descriptions, memos, notes, who
paid you or who you paid, balances per account, holdings per account, or anything from the vault. Each tool's result
is cut to a list of allowed fields, and every text in it passes a last check that removes numbers that look like
identifiers (phones, card and account numbers, ID numbers), emails and IBANs. Tests plant made-up identifiers in every
place a bank can put them and fail if one comes out.

Whatever the tools return goes to the app's model provider under the app's terms. Pick an app you trust with your
spending totals.

## Setup (once per app)

1. **Turn it on:** Settings → AI → AI apps (MCP). From the PC at home only.
2. **Make a token** on the PC (it is kept in `data\mcp\<app>.token` and never shown):

   ```
   .\finc mcp token create claude-code
   ```

3. **Add finc to the app.** Claude Code:

   ```
   claude mcp add finc -- D:\path\to\finc\finc.cmd mcp --token claude-code
   ```

   Claude Desktop and other apps: add an MCP server that runs the same command (`<finc folder>\finc.cmd` with the
   arguments `mcp --token <app>`). The worker must be running.

4. Ask: "How much did we spend on food this year?", "What fixed bills come next week?", "Compare October with
   September."

## Limits and records

- 30 calls a minute and 1,000 a day per app; a result over 24,000 characters is refused (ask a narrower question).
- Every call is in Settings → Security log as `mcp.call` with the tool and the argument names, never their values or
  the result. Settings shows each app's last use and calls today.

## Turning it off

- One app: Revoke in Settings, or `.\finc mcp token revoke <app>` (also deletes its token file).
- All apps: turn the switch off (every call is refused at once). The panic button revokes every app's token.

## How it works

`finc mcp` runs inside the worker's container and speaks MCP (JSON-RPC over stdio, protocol 2025-11-25 and earlier)
to the app. It holds no database: each call goes to the worker on `127.0.0.1` with the app's token, and the worker runs
the tool through the same privacy path as the chat. The `/mcp` routes answer 404 through the public site. Design:
[research_notes/proposals/mcp-server.md](../research_notes/proposals/mcp-server.md).
