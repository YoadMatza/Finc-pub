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

## From anywhere: ChatGPT and Claude

ChatGPT and the Claude apps (web, desktop, phone) cannot start a program on your PC; their servers call MCP servers
over the internet. finc can answer them at `https://<your host>:7443/mcp` once you allow it. The tools and the
privacy checks are the same as above; what is new is a sign-in that faces the internet, so it is guarded closely.

1. **Turn it on** at home: Settings → AI → Remote AI apps. The public address must be set (Settings → Phone access).
2. Press **Connect an app**. A connection can only start in the next 10 minutes, and only one.
3. In the app, add a custom connector / MCP server with the address shown (`https://<your host>:7443/mcp`). ChatGPT
   needs Developer Mode; for Claude, Settings → Connectors → Add custom connector.
4. The app opens finc's approval page: check the app's name and where it returns, then **Approve with passkey**.

You get a Telegram alert for every approval. Settings lists each connected app with its last use and calls today;
**Revoke** ends it at once. Turning the switch off refuses every remote call; the panic button revokes everything.

What protects it:

- Only ChatGPT and Claude can connect, and only to their own callback addresses. finc fetches nothing for a
  connection except ChatGPT's fixed client description.
- An approval needs a fresh passkey signature on finc's page, inside the 10-minute window you opened at home.
- PKCE on every sign-in; codes are single-use for 60 seconds. Access tokens last an hour and work only on finc's
  `/mcp`; refresh tokens last 30 days and change on every use, and a reused one ends the connection (with an alert).
  finc stores only hashes of tokens.
- Calls from a web page are refused (no `Origin` allowed on `/mcp`); 30 calls a minute and 1,000 a day per app.
- Every step is in the security log, never a token, a code or a result.

What it cannot protect: once approved, OpenAI's or Anthropic's servers can call finc's read-only tools until you
revoke them, and the provider keeps what its model saw under its own terms.

## How it works

`finc mcp` runs inside the worker's container and speaks MCP (JSON-RPC over stdio, protocol 2025-11-25 and earlier)
to the app. It holds no database: each call goes to the worker on `127.0.0.1` with the app's token, and the worker runs
the tool through the same privacy path as the chat. The `/mcp` routes answer 404 through the public site. Design:
[research_notes/proposals/mcp-server.md](../research_notes/proposals/mcp-server.md).
