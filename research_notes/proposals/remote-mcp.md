# Remote MCP: ChatGPT and the Claude apps, from anywhere, with a passkey

Status: **proposal** (2026-11-17), not built. Builds on [mcp-server.md](mcp-server.md) (local MCP, built and
live-checked). Decisions at the end.

## 1. What and why

Local MCP works with AI apps that run on the PC. ChatGPT and the Claude web and phone apps only use **remote** MCP
servers: an https address that **their** servers call, after the owner signs in through OAuth. So asking ChatGPT or
Claude on the phone needs finc to:

1. answer MCP over HTTP on the public entry (`https://<host>:7443/mcp`);
2. be its own small OAuth authorization server, where the owner approves an app with a **passkey**.

The tools, the allow-lists, the identifier scrub and the canary tests stay exactly as they are: **what an app can
get does not change**. What changes is who can knock: today `/mcp` answers 404 from outside; this opens one
door, for one owner, through a passkey.

Who calls finc: OpenAI's or Anthropic's servers, not the phone. The data path is the same as with a local app (the
provider sees what the tools return); the new part is an internet-facing sign-in.

## 2. What never changes

- Every result goes through `runPrivateTool` (allow-list per tool, `guardEgress` with `scrubIdentifiers`); the
  canary suite covers the remote route too.
- Read-only. No resources, prompts or sampling. No write tools.
- The vault, device tokens, passkeys, PIN, the control token and local MCP tokens never work on `/mcp` from outside,
  and an OAuth token works nowhere but `/mcp`.

## 3. The flow (MCP authorization, spec 2026-07-28; 2025-11-25 also)

```
Owner, at home: Settings → AI → Remote AI apps → "Connect an app" (opens a 10-minute window)
ChatGPT / Claude: add connector https://<host>:7443/mcp
  → POST /mcp without a token → 401 + WWW-Authenticate: Bearer resource_metadata=…, scope="finc.read"
  → GET /.well-known/oauth-protected-resource/mcp            (RFC 9728)
  → GET /.well-known/oauth-authorization-server               (RFC 8414: endpoints, S256, CIMD, iss)
  → client id: ChatGPT's metadata document URL (CIMD) or Claude's registration (DCR), allow-listed (§4.2)
  → the owner's browser opens /oauth/authorize?…&code_challenge=…&resource=https://<host>:7443/mcp
       finc's consent page: which app, where it returns, what it gets and never gets
       → "Approve with passkey": a fresh WebAuthn signature over this request's id
  → redirect to the app's callback with code + iss (RFC 9207)
  → POST /oauth/token (code + code_verifier + resource) → access token (1 h) + refresh token (rotating)
  → POST /mcp with Bearer → the same ten tools
```

## 4. Safety in detail

### 4.1 A connection can only start when the owner opened the door

An authorization request is refused unless the owner pressed **Connect an app** at home (PC or Tailscale, not a
passkey session from outside) in the last 10 minutes. A link sent by someone else ("approve this connection")
therefore fails outside that window, and the window closes after one approval. This is the main defence against
consent phishing, which a passkey alone does not stop (the owner would be signing a real finc page).

### 4.2 Only known apps, only their callbacks

- **ChatGPT** through a Client ID Metadata Document. finc fetches the client's document **only** if its URL is on an
  allow-list (`https://chatgpt.com/oauth/client.json`, plus what OpenAI publishes; checked at build time), over
  https, with a size cap, a short timeout, no redirects, and only to public addresses (no SSRF into the home
  network). Its `redirect_uris` must be ChatGPT's (`https://chatgpt.com/connector_platform_oauth_redirect` or
  `https://chatgpt.com/connector/oauth/<id>`).
- **Claude** (web, desktop, phone) through Dynamic Client Registration, accepted only when every redirect URI is
  Claude's (`https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`). DCR is deprecated
  in the spec but still what Claude uses; registrations are capped and expire unused after a day.
- Any other client is refused. Adding one is a code change with its callback, not a setting.

### 4.3 Approval needs a fresh passkey signature

The consent page shows the app's name (from finc's allow-list, not from the client's own words), the host it returns
to, and the same "gets / never gets" text as Settings. Approve runs a WebAuthn assertion whose challenge binds this
authorization request; an existing passkey session is not enough. PIN and device tokens cannot approve.

### 4.4 Tokens

- OAuth 2.1 with PKCE S256 required; authorization codes single-use, 60 seconds, bound to the client, redirect URI,
  code challenge and resource.
- Access tokens: opaque, random 256-bit, 1 hour, stored as SHA-256, audience = `https://<host>:7443/mcp` (RFC 8707:
  a token for another resource is refused), scope `finc.read` only.
- Refresh tokens: 30 days, rotated on every use; reusing an old one revokes the whole grant (theft detection).
- One **grant** per app, listed in Settings next to local apps, with last use, calls today and Revoke. The panic
  button revokes every grant. Turning **Remote AI apps** off refuses every remote call at once (separate from the
  local switch).
- `iss` in every authorization response (RFC 9207), so ChatGPT can use its stable callback.

### 4.5 The internet-facing part stays small

- New public paths, nothing else: `/mcp` (exact), `/.well-known/oauth-protected-resource[/mcp]`,
  `/.well-known/oauth-authorization-server`, `/oauth/authorize`, `/oauth/token`, `/oauth/register`, and the consent
  page. Local MCP's `/mcp/tools` and `/mcp/call` stay 404 from outside.
- Limits: the same 30 calls a minute and 1,000 a day per grant; the OAuth endpoints get tight global limits (Docker
  Desktop hides callers' addresses, so per-address limits do not work and the providers cannot be allow-listed by IP).
- Every step is a security event (window opened, client registered, consent shown, approved, token issued,
  refresh reused, call, refusal), never a token, code or result. A Telegram alert on every approval and on a reused
  refresh token.
- `MCP-Protocol-Version` and the `Origin` header are checked; no cookies are read on `/mcp`.

### 4.6 What it cannot protect

- Once approved, OpenAI or Anthropic hold a token for up to 30 days of refreshes, and their servers can call
  finc's read tools. The answers are the privacy-checked ones, and the owner can revoke at any time, but a breach on
  their side would expose the same totals and card-merchant names the chat already shares.
- The provider keeps what its model saw under its own terms. Same as local MCP and finc's chat.

## 5. Transport

Streamable HTTP, stateless: each POST carries one JSON-RPC request and gets one JSON answer (no server-sent events,
no `Mcp-Session-Id`). Both 2025-11-25 (with `initialize`) and 2026-07-28 (per-request `_meta`, `resultType`) are
answered, reusing the local bridge's dispatcher behind a different link (in-process instead of HTTP). The OAuth parts
are hand-written against the RFCs above, or an OAuth library if a mature one fits finc's dependency rules; this is
decided after a short spike (step 1).

## 6. Plan

| # | Step | Done when |
|---|---|---|
| 1 | **Spike**: point ChatGPT (developer mode) and Claude at a test endpoint; record the exact client ids, callbacks, discovery calls and protocol versions they use | a short note in this file with what each sends |
| 2 | **OAuth core** (core): tables for clients, codes, grants, tokens (hashes only); PKCE, rotation, reuse detection, expiry; the connection window | unit tests for every rule in §4.4, including replay, wrong verifier, wrong resource, expired code |
| 3 | **Discovery and registration** (worker): the two metadata documents, CIMD fetch with the allow-list and SSRF guard, DCR with Claude's callbacks only | tests: unlisted client, bad redirect, private-address CIMD URL, oversized document, redirect all refused |
| 4 | **Consent with passkey** (worker + hub): authorize endpoint, the consent page, a WebAuthn assertion bound to the request, iss in the redirect | tests: no window, stale window, session without fresh signature, second approval, all refused |
| 5 | **`/mcp` over HTTP**: bearer check (audience, scope, expiry), the shared dispatcher, limits, events, Remote switch, panic | route tests, plus the canary suite through `/mcp` |
| 6 | **Hub**: Remote AI apps switch, Connect an app, grants list with Revoke (helper agent against the route contract) | web tests; seen in the hub |
| 7 | **Docs**: docs/mcp.md (remote setup for ChatGPT and Claude), external-services.md, a security review of the new public paths (the research checklist used for P0–P3) | review findings fixed or written down |
| 8 | **Live**: connect ChatGPT and Claude, ask from the phone, scan the answers for the real identifiers (counts only), test revoke and panic | zero identifiers; Yoad approves |

Rough size: 3–4 days, most of it steps 2–4. Step 6 can run in parallel with a helper agent.

## 7. Decisions for Yoad

- **R1 Apps:** ChatGPT and Claude only, by allow-list (recommended); or any MCP app with a metadata document (wider,
  harder to guard).
- **R2 Connection window:** required for every new connection (recommended).
- **R3 Token life:** access 1 hour, refresh 30 days rotating (recommended); shorter means re-approving with a passkey
  more often.
- **R4 Remote tools:** the same ten as local, `find_transactions` included (recommended for one set of rules); or
  totals and summaries only from outside.
- **R5 Plans:** ChatGPT needs Developer Mode on a paid plan to add a custom MCP connector; Claude custom connectors
  depend on the Claude plan. Yoad confirms which apps he will actually use before step 1.

## Sources

- MCP authorization, 2026-07-28: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
- OpenAI Apps SDK authentication: https://developers.openai.com/apps-sdk/build/auth (CIMD, DCR, PKCE, callbacks)
- Claude custom connectors: https://support.claude.com/en/articles/11503834 (DCR, `https://claude.ai/api/mcp/auth_callback`)
