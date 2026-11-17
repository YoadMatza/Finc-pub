# MCP server: ask an AI app about your money, without giving it your bank

Status: **built** 2026-11-17 (M1 local stdio only, M2 `find_transactions` included, M3 off by default). Live check the same day: 19 calls through `finc mcp` against the real data, every answer scanned for the accounts' ids, card endings, bank-side descriptions, emails and 7+ digit numbers: zero found; nothing dropped by the allow-lists; stdout JSON-RPC only. Setup: docs/mcp.md.

## 1. What and why

An MCP server lets an AI app the owner already uses (Claude Desktop, Claude Code, another MCP client) answer
questions from finc's numbers: "how much did we spend on food this year", "what fixed bills come next week",
"compare October with September". Today the same questions go through finc's own chat ("Ask my money"), which uses
the provider finc is configured with. MCP moves the conversation into the owner's AI app; finc stays the only place
that reads the database.

**The rule that decides everything below:** whatever an MCP tool returns is sent to the AI app's model provider and
may be stored there. So an MCP result is egress, exactly like a chat lookup, and it gets the same treatment, plus
more, because finc does not choose the model or see the conversation.

## 2. What never leaves (the hard line)

Never, in any tool result, error, tool description or log line that reaches the client:

- account numbers, card numbers (including the last four digits), branch numbers, IBANs, external ids, finc's own
  internal ids;
- balances per account (only totals and lines by kind: bank, cards, securities, foreign currency, manual holdings);
- raw or normalised bank descriptions, memos, notes, the payer of an income, the person on a person-to-person
  transfer;
- personal identifiers that can sit inside bank text: ID numbers, phone numbers, emails, addresses;
- anything from the vault (bank logins, API keys, the master password), device tokens, passkeys, the control token;
- holdings quantities, cost and account per position (only what the chat's `net_worth` already returns).

What may leave is exactly what finc's chat already sends (chat.ts header, security research P1-14): category names,
amounts, dates, counts, the owner's own stream labels, event names, manual holding names, and merchant names of card
purchases only, all through `modelName` and `guardEgress`.

## 3. Threats and the answer to each

| Threat | Answer |
|---|---|
| A tool returns a field that holds an identifier | Results are built from an **allow-list per tool** (a strict output schema), not a deny-list. A field not in the schema is dropped before the guard even looks. |
| An identifier hides inside an allowed string (a merchant name with a phone number) | `guardEgress` already replaces 5+ digit runs and any exact bank description. MCP adds a stronger pass (§5.2): separated digit groups (`052-123-4567`, `1234 5678 9012 3456`), IBANs, emails, Israeli ID numbers, and every stored account number / card last-4 / external id **as a string seen in text**. |
| The client asks many narrow questions to rebuild the data (exfiltration by aggregation) | Only the fixed aggregation tools; no SQL, no raw rows, no search over descriptions or memos (`q` matches only names the model may see). Per-token rate limits (per minute, per day) and a cap on result size. |
| Prompt injection inside data (a merchant named "ignore previous instructions…") | Names are already cleaned and capped; MCP results carry a fixed note that they are data. finc's tools are read-only (§4), so an injected instruction cannot make finc do anything. |
| Someone else on the network or the internet calls the MCP endpoint | v1 is **local only**: stdio on the PC, through `docker exec` into the worker. The HTTP route it uses is refused by Caddy at the public entry, and needs its own token. No remote MCP in v1 (§8). |
| A stolen or leaked MCP token | Tokens are scoped to MCP read tools only, stored hashed, named per app, revocable in Settings, rate-limited, logged (security events), and kept in a file (never an env var, never in the AI app's config). |
| The AI app or its logs keep finc data | Stated plainly in the docs and the Settings switch; the owner chooses the app. finc logs the tool name and an argument summary, never a result. |
| A finc bug adds a new field to a hub function a tool reuses | The output schema drops it, and the canary test (§5.3) fails if anything sensitive comes through. |
| Writing through MCP (change a category, start a sync, unlock) | Not offered. v1 is read-only; every tool is marked `readOnlyHint`. |

## 4. Shape

```
AI app (Claude Desktop / Code)
   │ stdio (JSON-RPC, MCP)
   ▼
finc mcp            ← `finc.cmd mcp` → docker compose exec -T worker node apps/worker/dist/cli.js mcp
   │ HTTP on 127.0.0.1:7733 inside the container, Authorization: Bearer <mcp token from /data/mcp/<name>.token>
   ▼
worker API  /api/mcp/tools, /api/mcp/call   ← the only place that reads the database
   │
   ▼
core: runPrivateTool(name, args)  = CHAT_TOOLS[name].run → strict output schema → guardEgress → size cap
```

- **No second database reader.** The MCP process holds no database handle; the one-writer rule stays (never open
  data/finc.db from the host while the worker runs). The bridge only relays to the worker.
- **One egress path for chat and MCP.** `runPrivateTool` is pulled out of the chat loop, so a fix to the guard
  protects both, and the chat's eval keeps testing it.
- **`-T`, not `-it`.** finc.cmd runs `exec -it` today; a TTY would corrupt the JSON-RPC stream, so `mcp` gets its
  own branch with `-T` and nothing else written to stdout (logs go to stderr).
- **Vault lock does not matter.** MCP needs no key from the vault; the tools read the same tables the hub shows.
  An off switch (§6) is the way to stop it.

## 5. Safety in detail

### 5.1 Tools (v1)

The chat's tools, renamed only where a clearer name helps an outside model, with the same argument rules:
`spend_summary`, `month_summary`, `compare_periods`, `spend_by_category`, `top_merchants`, `find_transactions`,
`recurring`, `trends`, `events`, `net_worth`. Each has an `inputSchema` (strict, unknown keys refused, bounded
numbers and dates) and an `outputSchema`; results go in `structuredContent` and as JSON text. No resources, no
prompts, no sampling: tools only.

`find_transactions` is the most detailed (dates, amounts, card merchant names). It is in v1 only if the owner
agrees (decision M2).

### 5.2 A stronger egress guard (helps the chat too)

Add to `guardEgress`, in core, with tests:

- digit groups joined by spaces, dashes or dots that total 7+ digits → `…`;
- IBAN (`IL\d{2}…`), email addresses, `+972` / `05x` phone shapes → removed;
- a 9-digit number that passes the Israeli ID check digit → removed (already covered by 5+ digits; kept as a test);
- **known identifiers**: at call time, the set of every account's number, last-4, branch and external id; a string
  that contains one of them next to a card / account word ("כרטיס", "חשבון", "card", "account", "****") is replaced.
  Bare 4-digit amounts stay (a ₪1,234 charge is not a card number).

### 5.3 Canary tests (the proof)

A test database seeded with made-up but realistic identifiers in every place they could hide: account numbers and
external ids, card last-4 in descriptions and memos, a phone and an email in a merchant name, an ID number in a note,
an IBAN in a transfer description, a payer's name on a salary. Then every tool runs with a spread of arguments
(empty, every month, every category, `q` set to each canary and to pieces of it), and the test fails if any canary,
or its digits without separators, appears anywhere in the serialized result. The same suite runs against the chat.

### 5.4 Tokens, switch and record

- `finc mcp token create <app-name>`: PC only (needs the control token, like other admin actions); writes
  `data/mcp/<app-name>.token` (owner-only file), stores only a hash; prints how to connect, never the token.
- Settings → AI → **AI apps (MCP)**: off by default; the list of tokens with last use and calls today; Revoke.
  Turning the switch off refuses every MCP call at once.
- Limits: 30 calls a minute, 1,000 a day per token (tunable); results capped at 12,000 characters, like the chat.
- Every call is a security event (`mcp.call`, token name, tool, argument summary), aggregated; a refused call
  (`mcp.refused`) says why. Never the result.
- Caddy answers 404 for `/api/mcp/*` at the public entry; the route also refuses the hub's session cookie and
  device tokens: only an MCP token works.

## 6. What the owner sees

1. Settings → AI → AI apps (MCP) → turn on; the hub shows the command to run on the PC.
2. `.\finc mcp token create claude-desktop` (once per app).
3. Add finc to the AI app, e.g. Claude Code: `claude mcp add finc -- D:\projects\finc\finc.cmd mcp --token claude-desktop`;
   Claude Desktop: the same command in its MCP settings. The token name is passed, not the token.
4. Ask. The AI app shows each finc call (tool + arguments) before or as it runs, per its own settings.

## 7. Plan

Each step is its own commit, tested, mirrored to Finc-pub; deploy and push only when asked.

| # | Step | Done when |
|---|---|---|
| 1 | **Core egress layer**: `runPrivateTool` (tool → output schema → guard → cap) used by the chat; output schemas per tool | chat tests and the 28-case chat eval unchanged |
| 2 | **Stronger guard** (§5.2) | new guard tests; chat eval unchanged |
| 3 | **Canary suite** (§5.3) for every tool, through `runPrivateTool` | fails on purpose when a canary field is added to a tool, passes after |
| 4 | **Worker routes and tokens**: `/api/mcp/tools`, `/api/mcp/call`, token kind `mcp` (hash, name, last use, revoke), limits, security events, Caddy 404 | route tests: wrong token, device token, cookie, switch off, rate limit, unknown tool, bad args all refused |
| 5 | **The bridge**: `cli.js mcp` stdio server (official TypeScript SDK, exact pinned version at least two weeks old, or a minimal hand-written JSON-RPC if the SDK is mid-major), `finc.cmd mcp` with `-T` | an in-memory MCP client test lists the tools and calls each one; nothing but JSON-RPC on stdout |
| 6 | **Hub**: Settings switch, token list, revoke, last use | web tests; seen in the hub |
| 7 | **Docs**: docs/mcp.md (setup, what is sent, how to turn off), a row in docs/external-services.md | read through |
| 8 | **Live check**: connect Claude Code on this PC, ask the chat eval's questions, scan the replies for the owner's real account numbers and card last-4 (counts only) | zero matches; Yoad approves |

Rough size: steps 1–3 a day, 4–5 a day, 6–8 half a day. Steps 4 and 6 can go to a helper agent with the route
contract (as with the bill calendar and the news section).

## 8. Not in v1

- **Remote MCP** (Streamable HTTP through the public entry, for a phone or a cloud AI app). The spec requires OAuth
  for that; finc would need an authorization server with passkey consent. Possible later, as its own proposal.
- **Write tools** (set a category, tag an event). Each would need a confirmation the owner sees in finc, not only in
  the AI app.
- **Stocks** (insights, news). They are public market data plus the position; the position is private. Later, with
  the position left out.

## 9. Decisions for Yoad

- **M1 Transport:** local stdio only in v1 (recommended), or also remote now.
- **M2 `find_transactions`:** include it (card merchant names, dates, amounts; as the chat does), or leave it out
  and keep MCP to totals and summaries.
- **M3 Default:** off until turned on in Settings (recommended).
