# finc

Personal, single-user, self-hosted finance hub for Israeli bank and card accounts (an alternative to RiseUp).

**New here?** Follow [docs/getting-started.md](docs/getting-started.md): build, configure, start, first sync and daily use, step by step.
Want to help? See [CONTRIBUTING.md](CONTRIBUTING.md).

## Layout

| Path | What |
|---|---|
| `packages/core` | Schema, vault, dedupe/normalization, importers, RiseUp client. No I/O to banks. |
| `apps/worker` | `finc` CLI, scheduler, bank connectors (israeli-bank-scrapers), control port. |
| `apps/web` | The hub: Vite + React, Hebrew RTL / English, PWA. Built into `apps/web/dist` and served by the worker. |
| `fixtures/` | Anonymized sample data for tests. **Never real data.** |
| `data/` | Gitignored. SQLite DB, encrypted vault, browser profiles, imports. |

## Dev on Windows

```bash
pnpm install
pnpm -r build      # the worker and web app import the built @finc/core
pnpm test
.\finc health
```

## First-time setup

`.\finc` is a launcher that needs only Node on the PATH (`finc.cmd` for cmd, `finc.ps1` for PowerShell; `./finc.sh` on Linux and macOS). `pnpm finc …` does the same when pnpm is on your PATH. Rebuild with `pnpm -r build` after code changes.

```bash
.\finc vault init                     # choose a master password (never stored)
.\finc vault set beinleumi            # prompts: username, password (hidden)
.\finc vault set isracard             # prompts: ID, card last 6 digits, password
.\finc vault set max                  # prompts: username, password
.\finc vault set riseup               # prompts: riseup_pat_… token
.\finc vault check                    # each institution has what its connector needs
```

## Everyday commands

| Command | What |
|---|---|
| `.\finc spike max` | Headful scrape, raw dump to `data/dumps/`, anonymized data-shape report. No DB writes. |
| `.\finc sync all` | Scrape + ingest all three institutions (delegates to the worker when it is running). |
| `.\finc import riseup` | Backfill the full RiseUp history with categories, exclusions and comments. |
| `.\finc import file <xlsx/csv>` | Fallback statement import (`--dry-run` to preview, `import headers` to inspect columns). |
| `.\finc health` | Connection health: last success, last error, next run, accounts, balances. |
| `.\finc runs` | Recent sync runs. |
| `.\finc reconcile` | Bank balance change = sum of completed transactions between snapshots. |
| `.\finc engine run` | Truth engine: merchants, installments, settlement links, refunds, categories, recurring streams (the worker runs it after every sync). |
| `.\finc month [YYYY-MM] [-c] [--billing]` | Monthly cashflow: income, fixed, variable, installments, savings, expected items, projected month end; `-c` by category. |
| `.\finc compare --cells` | Our months vs RiseUp's with every difference attributed. |
| `.\finc review` | The inbox: suggested links, uncategorised merchants, recurring candidates, overdue fixed items. |
| `.\finc cat report` / `cat set <id\|merchant:id> <category> [--rule]` | Categorisation coverage and decisions. |
| `.\finc recurring list` / `confirm\|reject <id>` / `month` | Fixed expenses, subscriptions and fixed income; expected vs actual per month. |
| `.\finc ai config --provider local\|anthropic\|openai` / `ai dry-run` / `ai run` | Model-assisted categorisation of the long tail. Keys: `finc vault set ai_openai` or `ai_anthropic` (vault only). |
| `.\finc worker` | Long-running scheduler + hub + API on 127.0.0.1:7733. |
| `.\finc unlock` | Unlock the vault inside the running worker (needed after every worker start; the hub's Accounts screen can do it too). |
| `.\finc ui pin [--clear]` | Set or reset the PIN that protects the hub. |

## The hub (Phase 4)

```bash
pnpm -r build          # builds core, the web app and the worker
.\finc worker          # serves http://127.0.0.1:7733
.\finc ui pin          # optional: choose the PIN here instead of in the first browser that opens the hub
```

Open http://127.0.0.1:7733. The first browser to open it sets the PIN (or use `finc ui pin`); after that every browser
signs in with it. Sessions live in the worker's memory and die with it. The CLI talks to the same port with the random
token the worker writes to `data/control.token`.

Screens: **Now** (how the month will end, safe to spend, where the money went, attention, next 14 days, recent),
**Transactions** (every §7b bucket is a filter; click a row for the full story and the decisions; the review inbox is a
tab), **Recurring** (fixed expenses and income with this month's status, installments, candidates), **Categories**
(targets, pace, six-month sparklines, top merchants), **Trends** (in / out / net bars over 12 or 24 months, one line per
group and per notable category against its median, a Sankey of one finished month from income through groups to
categories, and the last twelve months against the year before), **Net worth** (top of Trends: bank, foreign currency and securities balances minus what the cards have charged but not
yet taken, plus holdings entered by hand such as a pension or a loan with a value history; a line over time rebuilt from
the recorded balances), **Events** (tag transactions from several months into
"Trip to Rome" or "Car repair 2026" and see the cost with a breakdown; tag from the event's picker or from a transaction's
sheet; the phone reaches it from the bottom of Trends), **Ask my money** (a chat; the model only ever chooses one of
eight fixed local lookups — month summary, spend by category, top merchants, find transactions, recurring, trends,
events, net worth — and finc runs it here; merchant names, amounts and dates go out, never account numbers or raw
descriptions; every answer lists what was looked up; provider and model from Settings, the key from the vault entry
`ai_<provider>` only; reachable from the sidebar and the speech-bubble button on Now), **Accounts** (balances, card cycles, connections, unlock and sync
from the browser; tap the FIBI securities or foreign-currency account for its positions: quantity, price, cost, change and value, with the account's value over time), **Settings** (language, model provider, rules, run the engine). Every number in the hub is the same
number `finc month` prints.

**Phone.** The phone uses the public address through Caddy (see Docker below) with its paired-device token or a
passkey. Tailscale Serve was turned off on 2026-11-10 (security research P1-06): it sent every tailnet device straight
to the worker port as "home". Do not turn it back on without a tailnet ACL, and add its name to `FINC_ALLOWED_HOSTS`,
or the worker refuses it (421).

Dev loop for the UI: `pnpm --filter @finc/web dev` (Vite on :5173, proxies `/api` to the worker on :7733).

## Remote access and the Android app (Phase 4b)

The hub can also be reached from anywhere, without Tailscale on the phone, through `https://finc-example.duckdns.org:7443`
(design: architecture §10). Two rules keep it safe: **the PIN only works from the home network or Tailscale**, and
from the internet the only key is a **paired-device token** that the Android app holds in encrypted storage.

**On this PC (once):**

1. Router: forward TCP **7443** to this PC. Nothing else is opened; the certificate is obtained through DNS.
2. `data\caddy.env` with one line, `DUCKDNS_TOKEN=…` (your DuckDNS token; finc never reads this file).
3. `docker compose up -d --build` (see **Docker** below): the worker, Caddy with the DuckDNS module (certificate by
   DNS-01, nothing on port 80) and the DuckDNS updater come up together and restart with Docker.
4. In the hub, Settings → Phone access → Public address: `https://finc-example.duckdns.org:7443`.

**Pairing a phone:** Settings → Phone access → *Pair a phone* (from the home network) shows a QR code valid for 5 minutes,
once. In the Android app choose *Scan QR* (or type the address and the code). The phone appears under *Paired devices*
with last seen and address; *Revoke* cuts it off immediately.

The app's lock (security research P1-11, app 0.6.0, Android 11 or newer):
- the device token is encrypted under an Android Keystore key that opens only through the fingerprint or the phone's
  PIN prompt, on every open; nothing reaches the hub before that;
- an opaque cover goes up the moment the app leaves the screen, and screenshots, the recent-apps preview, screen
  recording and casting are blocked (FLAG_SECURE);
- after more than 30 s away (Android's uptime clock, so changing the phone's clock does not help) the token and every
  cached answer are dropped and the prompt comes back; the hub sends `Cache-Control: no-store`;
- a phone without a screen lock gets "set a screen lock first" instead of the app;
- enrolling a new fingerprint destroys the key on purpose: pair the phone again from the PC;
- after three failed unlocks the lock screen offers "Forget this pairing".

### The token stays native (security research P2-01, app 0.7.7+)

After the fingerprint, the phone app's native code (`FincVault`) keeps the paired hub's token and sends every hub
request itself (pinned HTTPS, `/api/` paths only, no redirects, no cookies); JavaScript never sees the token. The
bundled page has its own Content-Security-Policy (no inline or foreign scripts, no outside connections); the build
fails if an inline script appears. Injected code could still act inside the open app, but could not take the token
elsewhere.

### Phone pinning (security research P1-10, app 0.7.0+)

The app trusts only the hub's own TLS key, not any valid certificate for the name: someone who steals the DuckDNS token
can point the name elsewhere and get a real certificate, but the app refuses that server before it sends anything.
- Caddy keeps its key when the certificate renews (`reuse_private_keys`, Let's Encrypt only; `deploy/caddy/Caddyfile`).
- The release build pins two keys: the live one and an offline backup key. Pins are base64 SHA-256 of the public key,
  in `apps/web/android/keystore.properties` as `fincPins=<live>,<backup>` next to `fincPublicHost=<hub host>`; Gradle
  writes Android's network security config from them, and a release build without two valid pins fails.
- Every hub request goes through Android's own HTTP stack (CapacitorHttp), which enforces the pins; redirects are not
  followed. The app pairs with and uses only the built-in host.
- The worker checks every 6 h that Caddy still serves a pinned key (`FINC_TLS_PINS` in `.env`, same list) and alarms
  through the alarm bot if not, or if the certificate stops renewing. It cannot see a hijacked public name (the local
  Caddy keeps serving the right key then); the phone's pin is what stops that.
- The browser on another computer cannot pin: this protects the Android app only.

**If the alarm says the key changed** (Caddy's storage volume lost or reset), the phone app stops connecting until the
hub serves a pinned key again. Recovery with the backup key (kept outside the repo, in the password manager and on the
NAS; never in `data/`):
1. `docker compose stop caddy`.
2. Put the backup key in Caddy's storage in place of the live key: copy it to
   `/data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/<host>/<host>.key` in the `caddy_data` volume and
   delete the `.crt` next to it (e.g. `docker run --rm -v finc_caddy_data:/data -v <folder with the key>:/k alpine sh`).
3. `docker compose start caddy`: with `reuse_private_keys` it gets a new certificate for that key. Check with the
   watchdog (`/health` → `tls.state` = `ok`) and the phone.
4. Make a new backup key, put its pin second in `fincPins` and `FINC_TLS_PINS` (the old backup is now the live key),
   rebuild and publish the APK, recreate the worker.

**Building the app** (`apps/web/android`, a Capacitor shell around the same web build; needs JDK 21 and the Android SDK):

```bash
pnpm --filter @finc/web build
pnpm --filter @finc/web exec cap sync android
cd apps/web/android && ./gradlew assembleRelease    # signed APK in app/build/outputs/apk/release/ (needs keystore.properties)
```

Install over USB with `adb install -r app/build/outputs/apk/release/app-release.apk`, or copy the APK to `data\apk\finc.apk`
and open `https://finc-example.duckdns.org:7443/finc.apk` on the phone (Caddy serves that one file; no secrets inside). Not on the
Play Store.

**After a code change:** `docker compose up -d --build` rebuilds the worker image and restarts only what changed; then
`.\finc unlock`. Nothing finc-related runs outside Docker on the host; the only host pieces are the `.\finc` CLI (unlock, spike, reports) and the Android build toolchain.

After a PC restart the vault is locked until `.\finc unlock` (or *Unlock* on the Accounts screen, also from the app).

### From another computer

The PIN is accepted only on the PC at home (security audit 2026-11-09), and browser sessions opened with it count only
there. From anywhere else, use a **passkey** (since 2026-11-10):

1. **Once, at home:** Settings → Passkeys → *Add a passkey* shows a QR code (5 minutes, single use). Scan it with the
   phone, open the link in Chrome and confirm with your fingerprint; the passkey is saved in Google Password Manager
   and syncs to your other Chrome sign-ins.
2. **On any computer:** open `https://finc-example.duckdns.org:7443`, press *Sign in with a passkey*, and confirm through
   Google Password Manager or by scanning the QR code with the phone (Bluetooth on, on both).

A passkey session lasts 12 hours, can read and make decisions, but cannot do admin (devices, public address, AI and
alert settings) or operate the worker (vault unlock/lock, syncs, sending alerts); Telegram tells you about every
passkey sign-in. Changing the PIN or removing the passkey in Settings ends its sessions at once. If Chrome labels the
site "Dangerous" (a Google Safe Browsing false positive for DuckDNS names), it also refuses the passkey until the
warning is dismissed.

The manual fallback still works: at home, Settings → Phone access → Pair a phone makes a code (5 minutes, single use);
in the other browser open `https://finc-example.duckdns.org:7443/pair?code=<code>` and press "Pair this browser". That
browser is then a paired device, listed in Settings and revocable there. Sign out in Settings forgets it.

## Alerts (Phase 5)

Telegram first (§7d). Once, on this PC:

1. In Telegram, talk to **@BotFather**, `/newbot`, copy the token.
2. `.\finc vault set telegram` and paste the token (hidden; vault only, never an environment variable).
3. Open your new bot in Telegram and press **Start**.
4. Hub → Settings → Alerts → **Find the chat**, then **Send a test message**.

The worker then sends, after every sync and on an hourly check: a failed sync (once per outage), a bank that has not
synced for 36 hours, a bank asking for a one-time code (reply with the code in Telegram and the sync continues), a fixed
expense past its date, a refund matched, a group over its target, a price increase on a recurring charge, and a weekly
summary (Sunday 08:00 by default). Money leaving is checked per new transaction (since 2026-11-10): **any charge or
transfer out of ₪1,000 or more** (card bills that match their card exactly and confirmed recurring charges excepted), a
**new purchase in instalments** on its full amount, a **card bill that does not match** its card's charges, and **card
testing** (four or more charges at one merchant on one card in one day). From ₪5,000, and for card testing, the message
goes out even in quiet hours. Both amounts are in Settings → Alerts (home network only). Every type is a toggle; quiet
hours default to 23:00–07:00. Nothing but merchant names, amounts and dates ever appears in a message.

### Security alerts and the alarm bot (since 2026-11-10)

**Security alerts** cover:
- wrong PINs;
- pairings and device removals;
- passkey changes and sign-ins;
- wrong master passwords;
- "worker started, vault locked";
- "vault locked, sync waiting".

They go through a second, send-only Telegram bot, the **alarm bot**. That bot is how they still arrive while the vault
is locked: after every worker restart, until `.\finc unlock`.

- **Where its token lives:** in `data/alarm-bot.json`, outside the vault, on purpose (security research
  P1-05). Stolen, it can only message you. The main bot stays in the vault, because it also relays the banks'
  one-time codes.
- **How messages are sent:**
  - as plain text, so no name can break a message or slip a link into it;
  - one retry;
  - then the main bot, if the vault is open.
- **Failures are visible** in `.\finc health`, in `.\finc alerts alarm status`, and in the hub's health data.
- **Tied to one chat:** the alarm bot works only with the chat it was tested with. After Settings → Alerts → **Find the
  chat** moves alerts elsewhere, run setup again.
- **Not in the backups:** after a restore, run setup again.

```bash
.\finc alerts alarm setup    # needs the vault unlocked; create the bot in @BotFather (/newbot), press Start, type its token
.\finc alerts alarm status   # channel, bot, last delivery and last error (never the token)
.\finc alerts alarm test     # a test message through the alarm bot
.\finc alerts alarm remove   # back to the main bot only (silent while locked)
```

`.\finc vault set telegram` refuses the alarm bot's token, and alarm setup refuses the main bot's. While the vault is
locked, every page of the hub and the phone app shows a banner.

### A lost or stolen phone (security research P1-09, since 2026-11-11)

- **Unused phones expire.** A paired device that has not reached the hub for 30 days (Settings, home only:
  `deviceIdleDays`, 0 = never) is removed on its next request or by the daily sweep (03:25); an alert goes out 3 days
  before. Passkeys do not expire, so while away a browser with a passkey is the way back in.
- **Removing one device** works from anywhere signed in (Settings → devices), with an alert.
- **Lock everything** removes every paired device and passkey, ends every browser and passkey session, clears pairing
  codes, locks the vault and sends an alert. Getting back in needs the PC at home (`.\finc unlock`, pair again,
  re-add passkeys). Three ways:
  - the "Lock everything" card in Settings (phone app or any signed-in browser; type LOCK to confirm);
  - `.\finc panic` on the PC;
  - Telegram, from the chat the alarm bot is bound to: send `/lockdown`, the bot answers with a one-time code, send
    `/lockdown <code>` within 2 minutes. Works while the vault is locked. Other chats are ignored; 5 wrong codes
    block it for 10 minutes. `/status` answers briefly.
- Anyone signed in can use it, a thief included: the worst it does is lock you out until you are home (accepted).

### Who did what: the security log (security research P1-08, since 2026-11-11)

- **finc's security log** (table `security_event`, append-only: the database refuses edits and deletes; in the nightly
  backup) records sign-ins (PIN, passkey) and failures, every paired phone or passkey in use (hourly, and at once from
  a new address or app), pairing, removals, expiry, vault unlock/lock, settings changes, alert and alarm-bot changes,
  lock everything, the TLS watchdog, backups (NAS target, host key change, restore) and worker starts. Never tokens,
  PINs, passwords, codes or amounts. Floods (wrong PINs, junk tokens) become one row a minute with a count.
- **Read it:** the Security log card in Settings (phone or PC; addresses only on the PC), `.\finc events
  [--limit N] [--kind K]`, or `/status` to the alarm bot (last 5).
- **Caddy's access log:** JSON in `data/logs/caddy/access.log`, rolled at 10 MB, 10 files, 30 days; without
  Authorization, Cookie and Referer headers, pairing codes or search text.
- **Container logs** are capped at 10 MB × 5 and still go when a container is recreated; what matters is in the two
  logs above.
- **Limits:** behind Docker Desktop every outside client shows the same gateway address (only a Linux host such as the
  Pi shows real addresses). Optional, the owner's own step: Windows Firewall drop logging, in an admin PowerShell:
  `Set-NetFirewallProfile -All -LogBlocked True -LogMaxSizeKilobytes 16384`.

### Request limits (security research P2-12, since 2026-11-11)

Request bodies are capped at 256 KiB (the chat at 1 MiB, it sends the whole conversation), by Caddy and again by the
worker (413; oversized streamed bodies are cut off, not read; each refusal lands in the security log as
`http.body_too_large`). Caddy gives a client 10 s for its headers and 30 s for the whole request (no limit on
downloads, so the APK still downloads on a slow line); the worker allows 15 s / 30 s. Memory caps: worker 2.5 GB
(room for the scraper's Chromium), Caddy 256 MB, DuckDNS 32 MB.

### Limits away from home (security research P2-02, since 2026-11-11)

A paired phone or a passkey browser that is not on the home network (it reaches finc through the public site) is
limited, so a stolen one cannot hammer the banks or run up the AI bill; the PC and anything on the home network are not:
- manual bank sync: once every 30 minutes, 6 a day (kept across restarts), at most 3 months back; the 30 minutes are
  shared, so one outside sync also makes your own phone wait; each per-bank sync on Accounts counts as one;
- chat: 30 questions an hour and 100 a day per phone or passkey; a question up to 2,000 characters, older answers
  trimmed;
- alert test and weekly-summary send: 3 an hour each.
The app says when it works again. Change the numbers in Settings → "Limits away from home", from the PC. Scheduled
syncs, `.\finc sync` and P1-09's lock everything are not limited. A sync names each bank at most once.

### Error text stays home (security research P2-09, since 2026-11-11)

Telegram and the AI provider never get an error's own text: a failed sync, backup or NAS copy is reported as the
bank or step, a kind (wrong password, a code was needed, timeout, network, disk full, …) and a fixed phrase; the
details are in the worker log at home. Errors are cleaned before they are stored (no URL query strings, tokens,
e-mails, card, ID, account or phone numbers), and the log hides secret-looking fields at any depth. The master
password's bytes are wiped right after the vault opens (JavaScript cannot wipe the string itself). The vault does
not lock itself on a timer, on purpose: the 06:00 sync needs it open; lock everything (P1-09) is the emergency lock.

### Live prices for stocks and dollars (since 2026-11-11, 0.7.8)

The securities and foreign-currency accounts show live values between bank syncs: the worker asks Yahoo Finance's
public chart endpoint for the current price of each held ticker and for USD/ILS. Only the ticker symbols leave the PC,
never quantities or amounts (by design). During the US session (16:30–23:00 Israel time) prices refresh every
2 minutes while someone looks (15 otherwise); the dollar rate every 30 minutes. Quantities always come from the last
bank sync; a holding falls back to the bank's numbers (and says so) when a quote is stale, odd (more than 35% from the
bank's price), in another currency, or the holdings snapshot is older than the balance. Gain since purchase is in
dollars at today's rate. Totals and the net-worth history stay on bank values; the app labels live numbers
"Live · hh:mm" or "Last price". Switch off with `FINC_LIVE_PRICES=off` in `.env`.

### Stock insights (step 1 since 2026-11-11, 0.7.9)

Tap a holding in the holdings sheet: a 1-year chart with the 50- and 200-day averages, the place in the 52-week range,
returns over 1 m–3 y next to the S&P 500 for the same dates, volatility, the deepest drop (1 y and 5 y), beta, dividends
and splits, each with a neutral one-line explanation. Information, not investment advice: finc never says buy, sell or
hold. Data: Yahoo's daily history (symbols only leave the PC), refused when it looks wrong (unadjusted splits, jumps,
single bad prints); the price is checked against the bank's morning price (2%).

Step 2 (0.8.0): the company's own numbers from its SEC filings (SEC EDGAR; finc sends only the company's SEC number
and a contact e-mail SEC requires, `FINC_SEC_CONTACT` in `.env`): revenue and net income over 12 months and their
growth, net margin now and 1 and 3 years ago, diluted EPS and P/E, cash, borrowings (excl. leases), finance leases,
debt-to-equity (not for banks), shares and their 1-year change, each with its filing and period; recent filings
(opened on www.sec.gov); the sector fund next to the S&P 500. Splits are adjusted, stale or inconsistent figures are
left out with a note. Next steps (news, an AI summary of the facts): `research_notes/proposals/stock-insights.md`.

### Your own stock rules (since 2026-11-11, 0.8.1)

finc never says buy, sell or hold. Instead, Settings → My stock rules: pick a condition (15 templates: below/above your
purchase price, under or over the 200-day average for N sessions, below the 52-week high, today's move, a 1- or 3-month
drop, lagging the S&P 500, P/E, revenue growth, margin drop, dilution, share of your portfolio), set your numbers, for
all holdings or one. finc checks them when a stock's panel opens, after every sync and daily at 23:30, from data it
already has, and shows which of your rules apply (with the value and its source) at the top of the panel and as a badge
in the holdings list. Missing data shows as "couldn't be checked", never as "doesn't apply".

Analysts' ratings and earnings dates (0.8.2): with a free Finnhub key in the vault (`.\finc vault set finnhub`), each
US-priced stock's panel shows the analysts' buy/hold/sell counts, the buy and sell share and their 3-month change
(labelled as the analysts' published opinion, not finc's view), and the next and last earnings report. Only the ticker
goes to Finnhub; the key travels only in a request header. When Finnhub answers under another symbol (a share class,
another listing), finc accepts it only if Finnhub's company profile confirms it is the same company. If a refresh
fails or the vault is locked, the last data (up to 30 days) shows with its date. Rules can watch the buy share's
3-month change and an upcoming earnings report. Plan, including Telegram
notices and analysts' ratings next: `research_notes/proposals/stock-decision-aids.md`.

Both incomes on the Now screen (0.8.3): the "left to spend" headline is unchanged (all income), and under it finc shows how much of it rests on regular income (salary, recurring) and how much on extra income (freelance, gifts, one-off transfers, cashback), what is received vs still expected, what is left without the extra, and the typical month (median of the last 6). "How is this calculated?" lists every term. Income kinds are set per category in Settings or per payment on its transaction. A large extra is kept out of the weekly amount unless you switch it on for that month.

Monthly spending limit (0.8.4): set it in Settings or from the Now card. It covers day-to-day (variable) spending only, not bills, instalments or savings, and applies from the month you set it on. The card shows spent vs the limit, where an even spread would be today (on pace / ahead / under), what is left within it and this week's share, and notes when your category targets add up to more than the limit.

Paid back to you (0.8.5): when someone repays you by Bit or a bank transfer, finc asks once whether that person is paying you back (always / just this one / no). A paid-back payment counts against your day-to-day spending instead of as income. finc remembers a payer only when the bank text names them; undo returns a payment to income.

Spending limit alerts (0.8.6): with a limit set, Telegram tells you at 80% and at 100% of it (once each a month) and when day-to-day spending runs well ahead of an even spread (at most once a week). Turn it off under Settings → Alerts ("Monthly spending limit"); quiet hours apply.

Chat quality check (0.8.9): `.\finc chat-eval` asks the configured model 27 fixed questions about a fictional household (no real data leaves the PC) and prints how many it answered, got right, asked about instead, or leaked. It costs a few cents per run and asks for the master password. `--model <id>` tries another model; `--only car-avg-he` runs one case.

Chat model and follow-ups (0.8.13): Settings → AI has a "Chat model" choice, Fast or Better, separate from the model that categorises transactions (change it from the home network). Answers come with up to three suggested next questions as buttons, and Hebrew answers keep amounts, dates and English names in reading order.

## Docker (the deployment)

Three containers from one compose file, the same on this PC and on a Raspberry Pi (arm64):

| Service | What | Ports |
|---|---|---|
| `worker` | hub + API + scheduler + bank connectors (Node 24, Debian Chromium) | 127.0.0.1:7733 (CLI and local browser) |
| `caddy` | HTTPS for `finc-example.duckdns.org`, certificate via DuckDNS DNS-01, serves `data/apk/finc.apk` | 7443 (router forwards it) |
| `duckdns` | keeps the DuckDNS name on this connection's public IP, every 5 minutes | — |

```bash
docker compose up -d --build
.\finc unlock              # the worker starts locked; scheduled syncs are skipped until unlocked
.\finc health
docker compose logs -f worker
```

Needs: Docker, `data/` (the vault, the DB, browser profiles; a bind mount so the CLI on the host sees the same files),
`data/caddy.env` with `DUCKDNS_TOKEN=…`. Optional `.env`: `FINC_PUBLIC_HOST`, `FINC_PUBLIC_PORT`, `FINC_DUCKDNS_DOMAIN`, `TZ`.
The worker trusts `X-Forwarded-*` only from Caddy's fixed address on the `edge` network (`FINC_TRUSTED_PROXIES`); the
PIN still works only from trusted client addresses, never from the internet. It answers only to `localhost`,
`127.0.0.1`, `FINC_PUBLIC_HOST`, the configured public URL and `FINC_ALLOWED_HOSTS` (anything else: 421, against DNS
rebinding), and refuses every write whose Origin is another site (403) or whose body is not JSON (415). The DuckDNS
updater runs on its own network. On Docker Desktop any container or WSL process can still reach the published
`127.0.0.1:7733`, and the worker cannot tell it from the PC's browser; it can try PINs (escalating lock, alerts), nothing
more.

**One writer rule.** While the worker container runs, every `finc` command that reads the database runs *inside* the
container (`.\finc` does this by itself through `docker compose exec`). Never open `data/finc.db` from the host at the
same time: SQLite's locking does not work across the Docker Desktop file-sharing boundary and two writers corrupted the
database once (2026-11-09; recovered from a copy plus the raw rows). Backups live in `data/backup/`.
Since P1-13 the code enforces it too:
- the worker keeps a heartbeat in `data/finc.db.owner`;
- any finc process on another machine (the PC, while the worker runs in Docker) is refused before it touches the
  database, judged by the heartbeat and by whether the worker answers on 7733, so a lagging Docker clock cannot
  fool it;
- a command run on the PC with the worker stopped claims the file itself, so a worker starting meanwhile waits
  (up to 75 s) instead of sharing it;
- `finc sync --dump/--dry-run` go through the running worker (it owns the bank browser profiles);
- `--show-browser` and `spike` are refused while it runs.

No code can stop other tools: never open `data/finc.db` with DB Browser, sqlite3.exe or an editor extension while the
worker runs.

**Headful bank logins** (FIBI's stubborn login button, Isracard's bot wall) need a screen, so `.\finc spike <bank>` runs on
the host with the host's Node against the same `data/`; it writes nothing to the DB. It shares the worker's browser
profiles, so stop the worker first (`docker compose stop worker`); finc refuses it otherwise.

**Moving to the Raspberry Pi:** install Docker, copy the repository and the whole `data/` folder (vault, DB, `caddy.env`,
`apk/`), forward the router port to the Pi instead of the PC, run `docker compose up -d --build` (the first build compiles
Caddy and installs Chromium for arm64, allow 10–20 minutes), then `./finc.sh unlock`. Docker starts at boot there, so finc is
up without anyone logging in; only the vault unlock remains manual, by design.

Schedule: `FINC_SYNC_TIMES` (default `06:00,18:00`, Asia/Jerusalem) with up to `FINC_SYNC_JITTER_MIN` (30) minutes of jitter.

## Backups (since 2026-11-10)

Every night at 03:40 (`FINC_BACKUP_TIME`) the worker writes one encrypted, verified backup to the folder in **`FINC_BACKUP_HOST_DIR`** (for example
`E:\finc-backup`): on purpose a different physical disk from `data/`. Compose mounts it at `/backup`.

- **What is in a backup:** the database (a consistent snapshot taken in memory) and `vault.json`, sealed together in
  one `finc-<UTC time>.fincbak` file with a key derived from the vault's. It opens only with the **master password in
  use on the day it was made** (it still works after a password change, with the old password).
- **Not included:** `data/caddy.env`, `control.token`, browser profiles and the signing keystore. Keep the keystore
  and its passwords somewhere safe yourself.
- **Each backup is checked:** right after writing, it is decrypted again, the database's integrity check runs, and the
  row counts are compared.
- **Retention:** the newest of the last 7 days, 4 weeks and 6 months, about 15 files of roughly 13 MB.
- **If the database suddenly shrinks** (by more than 10%, or to zero), all older backups are kept and Telegram says
  so.
- **Telegram also alerts** when a backup fails, or when there has been no verified backup for 48 hours.
- **If the vault is locked** at 03:40, the backup waits and runs right after `.\finc unlock`. The Sunday digest shows
  the date of the last verified backup.

```bash
.\finc backup now        # one backup now, through the running worker
.\finc backup list       # newest first, with what retention keeps
.\finc backup verify     # practice restore of the newest (asks the master password; changes nothing)
```

**Restoring** (the database is lost or damaged):

1. Stop the worker: `docker compose stop worker`.
2. Run `.\finc backup restore <file>`. It runs on the PC only and refuses while the container is running,
   restarting or paused.
3. It asks for the master password of that day, shows what will happen, and wants `restore` typed to go ahead.
4. The current database files are **moved aside** as `finc.db.before-restore-<time>`, never deleted.
5. `--with-vault` restores `vault.json` too.
6. Then `docker compose start worker` and `.\finc unlock`.

After a restore, money alerts pause until the first sync and then send one "restored from a backup" line instead of
re-sending every charge since the backup.

### Off-PC copy on the NAS (since 2026-11-10)

After every nightly backup the worker also copies it to the NAS: for example a Raspberry Pi on the home network
(`<nas-host>`), folder `/srv/finc-backups/copies`. It uses SFTP as the user `finc-backup`, and each copy is read back and
checked with SHA-256.

- **What that user can do:** upload, and nothing else. It has no shell, is locked in its folder, and its files are
  read-only. It cannot delete, chmod or rename over a file. The worker never deletes on the NAS, so whoever takes over
  the PC cannot wipe the copies through it.
- **Keys:** the worker's SSH key and the Pi's pinned host key live in the vault (entry `nas_backup`). If the host key
  changes, the copy is refused.
- **When the vault is locked** at 03:40, the copy waits for the backup, which waits for `.\finc unlock`.
- **The NAS keeps every copy** (about 13 MB a night). Pruning is by hand on the Pi: `sudo rm` the old ones.
- **An interrupted upload** leaves a read-only `.<name>.part` file there. Remove it by hand.
- **Telegram alerts** when a copy fails, or when the newest copy is more than 3 days old.

```bash
.\finc backup nas status   # paired? last copy, last error
.\finc backup nas test     # copy the newest backup (and up to 3 missing older ones) now
.\finc backup nas setup    # (re)pair: a NEW key every run; do its NAS side before answering Yes
.\finc backup nas remove   # forget the NAS (the copies stay there)
```

**Re-pairing:** `finc-backup` already exists on the Pi, so a new `setup` only needs its key. Run the printed
`ssh -t pi@… "echo 'restrict …' | sudo tee /home/finc-backup/.ssh/authorized_keys"` line in a second window, then
answer Yes.

To restore from the NAS, copy a `.fincbak` file back to the backup folder (for example with
`scp pi@<nas-host>:/srv/finc-backups/copies/<file> E:\finc-backup\`), then follow the restore steps above.

## Privacy

- Credentials and API keys: encrypted vault only (`data/vault.json`, Argon2id + XChaCha20-Poly1305). Never in git, logs or `.env`. Environment variables are never read for secrets; every `*_API_KEY` / `*_TOKEN` / `*_PASSWORD`-style variable is deleted from the process at startup so other projects' keys on this machine can never be used.
- Raw bank data stays in `data/` (gitignored). `fixtures/` holds synthetic samples only.
- Nothing is sent to any external service except: the RiseUp token to `input.riseup.co.il`, and (if you configured a model) merchant names, amounts and months to the provider you chose. The hub binds to 127.0.0.1 and is protected by a PIN; fonts and scripts are self-hosted, so opening it contacts nothing outside.
