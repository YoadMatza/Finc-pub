# Outside services, APIs and keys

finc runs on your own machine. This page lists **every** service outside it that finc can talk to: what each one is
for, whether you need it, what account or key it takes, where that key goes, exactly what is sent, and what it costs.
Anything not on this list is never contacted at run time.

Where keys go: **always the encrypted vault** (`finc vault set <entry>`), never `.env` or an environment variable.
The two exceptions are DuckDNS's token, which only Caddy and the DuckDNS updater read (`data/caddy.env`), and the
alarm bot's token (`data/alarm-bot.json`, written by `finc alerts alarm setup`, kept outside the vault on purpose so
security alerts work while the vault is locked).

## At a glance

| Service | Needed? | Account / key | Stored in | Cost |
|---|---|---|---|---|
| Your banks and card companies | **Yes**, at least one | your normal online-banking login | vault: `beinleumi`, `isracard`, `max` | free |
| RiseUp API | No (history import only) | RiseUp personal access token | vault: `riseup` | your RiseUp subscription |
| OpenAI **or** Anthropic **or** a local model | No (chat, AI categorisation) | API key, or none for a local model | vault: `ai_openai` / `ai_anthropic` | pay per use, cents a day |
| Telegram Bot API | No, but recommended (alerts, one-time codes) | two bots from @BotFather | vault: `telegram`; `data/alarm-bot.json` | free |
| Yahoo Finance (public chart endpoint) | No (live prices, stock facts) | none | — | free |
| SEC EDGAR | No (company figures for US stocks) | none, a contact e-mail | `.env`: `FINC_SEC_CONTACT` | free |
| Finnhub | No (analysts' ratings, earnings dates) | free API key | vault: `finnhub` | free tier |
| DuckDNS | Only for access from outside home | DuckDNS account + token | `data/caddy.env` | free |
| Let's Encrypt | Only for access from outside home | none (automatic) | — | free |
| A NAS over SFTP (your own) | No (off-machine backup copies) | an upload-only SSH user | vault: `nas_backup` | your hardware |

Without any of the optional services finc still syncs your banks, computes every number, and shows the hub at home.

---

## Banks and card companies (required)

| | |
|---|---|
| **For** | Fetching transactions, balances and (FIBI) securities holdings, twice a day by default (`FINC_SYNC_TIMES`). |
| **How** | A headless Chromium on your machine logs in to the bank's own website through [israeli-bank-scrapers](https://github.com/eshaham/israeli-bank-scrapers), exactly as you would. There is no bank API and no aggregator in between. |
| **Hosts** | Bank Beinleumi (FIBI): `online.fibi.co.il`. Isracard: `digital.isracard.co.il`. Max: `www.max.co.il`, `onlinelcapi.max.co.il`. |
| **Setup** | `finc vault set beinleumi` (username, password), `finc vault set isracard` (ID number, card's last 6 digits, password), `finc vault set max` (username, password). |
| **Sent** | Your login, to your bank only. |
| **Notes** | Banks sometimes ask for a one-time SMS code; with Telegram set up, the bot asks you and the sync continues. Turn a bank off for scheduled syncs with `finc disable <bank>`. |

## RiseUp (optional, one-time import)

| | |
|---|---|
| **For** | Importing your full RiseUp history, with its categories, exclusions and notes, when you move to finc. |
| **Host** | `input.riseup.co.il` |
| **Setup** | Create a personal access token in RiseUp (`riseup_pat_…`), then `finc vault set riseup`, then `finc import riseup`. |
| **Sent** | The token, in the request header. |
| **Turn off** | Remove it when done: `finc vault rm riseup`. |

## AI provider (optional): OpenAI, Anthropic, or a local model

| | |
|---|---|
| **For** | "Ask my money" (the chat) and categorising merchants the rules could not place (`finc ai run`). |
| **Hosts** | OpenAI: `api.openai.com`. Anthropic: `api.anthropic.com`. Local: any OpenAI-compatible server you run, e.g. Ollama at `http://localhost:11434/v1` (from inside Docker: `http://host.docker.internal:11434/v1`). |
| **Setup** | `finc ai config --provider openai` and `finc vault set ai_openai` (key starts with `sk-`); or `--provider anthropic` and `finc vault set ai_anthropic` (`sk-ant-`); or `finc ai config --provider local --base-url <url> --model <name>` (no key). Then Settings → AI → Chat model: Fast or Better. |
| **Default models** | Categorisation: `gpt-5-mini` / `claude-haiku-5-5` / `llama3.1`. Chat: Fast = `gpt-5-mini` / `claude-haiku-5-5`, Better = `gpt-5` / `claude-sonnet-5-5`. |
| **Sent** | Merchant names, amounts and dates (months for categorisation), and your question. **Never** account or card numbers, raw bank descriptions, balances by account, or error text. The model only picks one of a few fixed local lookups; finc computes the answer on your machine. |
| **Cost** | Pay per use with your own key. Normal use is a few cents a day; `finc chat-eval` costs a few cents per run. Away from home, phones and passkeys are limited to 30 questions an hour and 100 a day. |
| **Turn off** | `finc ai config --clear`. |

## Telegram (optional, recommended)

| | |
|---|---|
| **For** | Alerts (failed syncs, large charges, card bills that do not match, spending limit, weekly summary), relaying a bank's one-time code, and security alerts with an emergency `/lockdown`. |
| **Host** | `api.telegram.org` (the Bot API). |
| **Setup** | Two bots from **@BotFather** (`/newbot`): the main bot (`finc vault set telegram`, then Settings → Alerts → Find the chat) and a send-only **alarm bot** (`finc alerts alarm setup`). See the README's Alerts section. |
| **Sent** | Alert text: merchant names, amounts, dates, and short fixed phrases. Never account numbers, tokens or error text. |
| **Turn off** | Each alert type is a toggle in Settings → Alerts; `finc alerts alarm remove` drops the alarm bot. |

## Yahoo Finance (optional, on when you hold securities)

| | |
|---|---|
| **For** | Live prices for held stocks and the dollar rate between bank syncs, and the price history behind the stock facts panel. |
| **Hosts** | `query1.finance.yahoo.com`, `query2.finance.yahoo.com` (the public chart endpoint; no account). |
| **Sent** | Ticker symbols only, in the URL. Never quantities, values, accounts or names. No cookies. |
| **Turn off** | `FINC_LIVE_PRICES=off` in `.env`. |

## SEC EDGAR (optional)

| | |
|---|---|
| **For** | A US company's own figures from its filings (revenue, net income, margins, EPS, debt, shares) in the stock panel. |
| **Hosts** | `data.sec.gov`, `www.sec.gov`. |
| **Setup** | SEC requires a contact e-mail in every request's User-Agent: set `FINC_SEC_CONTACT=<e-mail>` in `.env`. A dedicated alias is fine. |
| **Sent** | The company's SEC number (CIK) and your contact e-mail. Nothing about your holdings. |
| **Turn off** | Leave `FINC_SEC_CONTACT` empty (the default). |

## Finnhub (optional)

| | |
|---|---|
| **For** | Analysts' buy / hold / sell counts and earnings dates in the stock panel, and rules that watch them. |
| **Host** | `finnhub.io` |
| **Setup** | A free key from finnhub.io → Dashboard, then `finc vault set finnhub`. |
| **Sent** | Ticker symbols, and the key in a request header. |
| **Turn off** | `finc vault rm finnhub`. |

## DuckDNS and Let's Encrypt (only for access from outside home)

| | |
|---|---|
| **For** | A free public name for your home connection, and a real HTTPS certificate for it, so the Android app and passkey browsers can reach the hub. |
| **Hosts** | `www.duckdns.org` (the updater, every 5 minutes; also the DNS-01 challenge), `acme-v02.api.letsencrypt.org` (Caddy, about every 60 days). |
| **Setup** | A DuckDNS account and sub-domain; `FINC_PUBLIC_HOST` and `FINC_DUCKDNS_DOMAIN` in `.env`; `DUCKDNS_TOKEN=…` in `data/caddy.env`; forward TCP 7443 on your router. See getting-started section 5C. |
| **Sent** | To DuckDNS: the token and your sub-domain (your public IP is seen by the request). To Let's Encrypt: the host name. finc's worker never reads the DuckDNS token. |
| **Turn off** | Run only the worker (getting-started section 5B). |

The router port is the only thing opened to the internet, and it leads to Caddy, which accepts only paired devices and
passkeys from outside.

## Your own NAS over SFTP (optional)

| | |
|---|---|
| **For** | A copy of each nightly encrypted backup on another machine (e.g. a Raspberry Pi), through an upload-only user that cannot delete. |
| **Host** | Your NAS on your home network (port 22). |
| **Setup** | `finc backup nas setup` (prints the commands to run on the NAS), then `finc backup nas test`. The SSH key and the NAS's pinned host key go to the vault entry `nas_backup`. |
| **Sent** | The encrypted backup file only. |
| **Turn off** | `finc backup nas remove`. |

---

## Downloads when you build or update (not at run time)

Building finc fetches code, not data. None of these see anything about your money.

| What | From | When |
|---|---|---|
| npm packages | `registry.npmjs.org` | `pnpm install` |
| pnpm itself | `registry.npmjs.org` | `npm install -g pnpm` (or corepack on Node 24 and older) |
| Chromium for bank logins on the host | Google's Chrome-for-Testing storage (Puppeteer) | `pnpm install`; skip with `PUPPETEER_SKIP_DOWNLOAD=true` if you only use Docker |
| Base images (Node, Caddy, Alpine) | Docker Hub | `docker compose up --build` |
| Debian packages (Chromium, fonts) | Debian mirrors | building the worker image |
| Caddy's DuckDNS module | GitHub / the Go module proxy | building the Caddy image |
| Gradle, Android libraries | `services.gradle.org`, Google Maven, Maven Central | building the Android app |

## Network ports at a glance

| Port | Where | Who can reach it |
|---|---|---|
| 7733 | the worker (hub, API, CLI) | this machine only (`127.0.0.1`) |
| 7443 | Caddy (HTTPS) | the internet, if you forward it; only paired devices and passkeys get in |
| 5173 | Vite dev server (development only) | this machine |

The hub's web pages load no fonts, scripts or images from outside: opening it contacts nothing beyond your own machine.
