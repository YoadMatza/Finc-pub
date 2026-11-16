# Getting started with finc

This guide takes you from an empty machine to a running finc hub, your first bank sync, and daily use. It is written
for Windows (the main platform); Linux and Raspberry Pi notes are at the end. The [README](../README.md) is the
reference for each feature; this page is the order to do things in.

finc is a **single-user, self-hosted** finance hub for Israeli accounts. It logs in to your bank and card sites on
your own machine (through [israeli-bank-scrapers](https://github.com/eshaham/israeli-bank-scrapers)), keeps everything in
a local SQLite database, and shows it in a web app (Hebrew or English) and an optional Android app.

Supported sources today:

| Source | How | Vault entry |
|---|---|---|
| Bank Beinleumi (FIBI) | scraper, incl. securities and foreign-currency accounts | `beinleumi` |
| Isracard | scraper | `isracard` |
| Max | scraper | `max` |
| RiseUp | one-time history import through its read-only API token | `riseup` |
| Any bank or card | statement file import (CSV / XLSX) | — |

---

## 1. What you need

| Tool | Version | Needed for |
|---|---|---|
| [Node.js](https://nodejs.org) | 22.22.2 or newer (26 recommended; the Docker image runs 26) | everything |
| pnpm | 10.x (the repo pins the exact version) | building |
| Git | any | getting the code |
| [Docker Desktop](https://www.docker.com/products/docker-desktop/) | current | the recommended way to run finc |
| JDK 21 + Android SDK | — | only to build the Android app |
| A [DuckDNS](https://www.duckdns.org) name + a router you can forward a port on | — | only for access from outside home |
| Telegram | — | only for alerts |
| An OpenAI or Anthropic API key, or a local model | — | only for the chat and AI categorisation |

Every outside service finc can use (banks, AI, Telegram, price and filing sources, DuckDNS, a NAS), with the account
or key each one needs and exactly what it is sent, is listed in [external-services.md](external-services.md).

Install pnpm (once). The repo pins its exact version in `package.json`; any 10.x works to start, and this one
matches:

```bash
npm install -g pnpm@10.34.9
```

On Node 24 or older, `corepack enable` does the same. Node 25 and newer no longer include corepack.

---

## 2. Get the code and build it

```bash
git clone <repository url> finc
```

```bash
cd finc
```

```bash
pnpm install
```

```bash
pnpm -r build
```

```bash
pnpm test
```

- `pnpm install` also downloads the Chromium that Puppeteer uses for bank logins on this machine.
- `pnpm -r build` builds `packages/core` first; the worker and the web app import its built output, so tests and
  typecheck fail until it has run once. Run it again after every code change.
- All tests should pass. They use synthetic data only.

The `finc` command line is started with `.\finc` from the repository folder (`finc.ps1` for PowerShell, `finc.cmd`
for cmd; on Linux and macOS `./finc.sh`, see the end of this guide). Check it works:

```bash
.\finc --help
```

---

## 3. Configure

Copy the example settings file:

```bash
copy .env.example .env
```

`.env` holds **no secrets** — finc never reads passwords, tokens or API keys from the environment, and deletes any
`*_API_KEY` / `*_TOKEN` / `*_PASSWORD` variable at startup. Settings you may change:

| Setting | Meaning |
|---|---|
| `FINC_PUBLIC_HOST` | The public name of your hub, e.g. `your-name.duckdns.org`. Docker needs a value even for a home-only setup (use `localhost` then). |
| `FINC_DUCKDNS_DOMAIN` | The DuckDNS sub-domain (`your-name`). Any placeholder for a home-only setup. |
| `FINC_BACKUP_HOST_DIR` | Folder for the nightly encrypted backups. Put it on **another physical disk** than `data/`. Default `./backups`. |
| `TZ` | Time zone for the schedule (default `Asia/Jerusalem`). |
| `FINC_SYNC_TIMES` | When banks sync (default `06:00,18:00`, plus up to `FINC_SYNC_JITTER_MIN` minutes). |
| `FINC_TLS_PINS` | The two key pins of the Android app (section 9). |
| `FINC_SEC_CONTACT` | A contact e-mail SEC EDGAR requires, to show company figures for stocks. Empty = off. |
| `FINC_LIVE_PRICES` | `off` to stop live stock and dollar prices. |
| `LOG_LEVEL` | `info` by default. |

Everything finc stores lives in `data/` (git-ignored): the database, the encrypted vault, logs, the APK. Never commit
it.

---

## 4. Create the vault and add your accounts

All credentials live in one encrypted file, `data/vault.json` (Argon2id + XChaCha20-Poly1305), opened by a **master
password** that is never stored. Pick a strong one and keep it in your password manager: without it neither the vault
nor the backups can be opened.

```bash
.\finc vault init
```

Add the institutions you use. Each command asks for its fields with hidden input:

```bash
.\finc vault set beinleumi
```

```bash
.\finc vault set isracard
```

```bash
.\finc vault set max
```

| Entry | It asks for |
|---|---|
| `beinleumi` | username (קוד משתמש), password |
| `isracard` | ID number (9 digits), the card's last 6 digits, password |
| `max` | username, password |
| `riseup` | a RiseUp personal access token (`riseup_pat_…`), for the history import only |

Check that each entry has what its connector needs:

```bash
.\finc vault check
```

Other vault commands: `vault list` (names only, never values), `vault rm <name>`, `vault passwd` (change the master
password).

---

## 5. Start finc

Pick **one** of the three ways. Docker (B or C) is recommended: it restarts on its own and keeps Chromium and Node
versions fixed.

### A. Directly on the machine (quickest to try)

```bash
.\finc worker
```

The worker runs in that window (stop it with Ctrl+C) and serves the hub on http://127.0.0.1:7733. In a second window:

```bash
.\finc unlock
```

### B. Docker, home only

Docker needs a file for Caddy's DuckDNS token even when Caddy does not run. In `.env` set
`FINC_PUBLIC_HOST=localhost` and `FINC_DUCKDNS_DOMAIN=none`, then create an empty `secrets\caddy.env` and start only the
worker:

```bash
mkdir data, secrets
```

```bash
New-Item -ItemType File secrets\caddy.env
```

(That is PowerShell; in cmd use `mkdir data secrets` and `type nul > secrets\caddy.env`.)

```bash
docker compose up -d --build worker
```

```bash
.\finc unlock
```

The first build takes several minutes (it installs Chromium into the image).

### C. Docker with access from outside home (phone, other computers)

1. Create a DuckDNS sub-domain pointing at your home IP; put its name in `FINC_PUBLIC_HOST` and `FINC_DUCKDNS_DOMAIN`.
2. Create `secrets\caddy.env` with one line, `DUCKDNS_TOKEN=<your DuckDNS token>`. finc itself never reads this file.
3. On your router, forward TCP **7443** to this computer. Nothing else is opened: the certificate comes from Let's
   Encrypt through DNS, port 80 stays closed.
4. Start all three containers (worker, Caddy, DuckDNS updater):

```bash
docker compose up -d --build
```

```bash
.\finc unlock
```

5. In the hub (step 6), Settings → Phone access → Public address: `https://<your-name>.duckdns.org:7443`.

From outside, only paired devices and passkeys get in; the PIN works only from home (section 9).

### Important: the vault starts locked

Every worker start (a reboot, a Docker restart, an update) leaves the vault **locked**: no bank syncs, no backups, no
chat until you unlock it, with `.\finc unlock` or the **Unlock** button on the hub's Accounts screen (from home). This
is on purpose: the master password is never written to disk.

### Important: one writer

While the Docker worker runs, `.\finc` runs your commands **inside** the container by itself. Never open
`data\finc.db` with another tool (DB Browser, sqlite3, an editor extension) while the worker runs: SQLite locking does
not work across Docker Desktop's file sharing, and two writers can corrupt the database.

---

## 6. Open the hub and set a PIN

Open http://127.0.0.1:7733. The first browser to open it asks you to choose a **PIN** (6+ characters); after that
every browser at home signs in with it. You can also set or reset it from the command line:

```bash
.\finc ui pin
```

Settings → Language switches between Hebrew (right-to-left) and English.

---

## 7. Get your data in

### First sync

From the hub: Accounts → **Sync**. Or from the command line:

```bash
.\finc sync all
```

- `-m, --months <n>` sets how far back to fetch on the first run.
- Some banks sometimes ask for a one-time code. With Telegram alerts set up (section 8) the bot asks you for it and
  the sync continues when you reply.
- After every sync the **engine** runs on its own: it finds merchants, instalments, card-bill settlements, refunds,
  categories and recurring charges.
- After that, syncs run on the schedule (`FINC_SYNC_TIMES`) while the vault is unlocked.

Check the result:

```bash
.\finc health
```

```bash
.\finc month
```

### If a bank login gets stuck

Some bank logins need a visible browser (a stubborn login button, a bot check). Run a one-off **spike** with a
window on this computer; it writes nothing to the database, only a raw dump and a data-shape report in `data\dumps\`.
It shares the worker's browser profile, so stop the Docker worker first:

```bash
docker compose stop worker
```

```bash
.\finc spike beinleumi
```

```bash
docker compose start worker
```

Then `.\finc unlock` again.

### Optional: your RiseUp history

If you used RiseUp, bring in its full history with its categories, exclusions and notes (`.\finc vault set riseup`
first):

```bash
.\finc import riseup
```

### Optional: statement files

For a bank finc cannot log in to, or older history, import a downloaded statement:

```bash
.\finc import headers <file.xlsx>
```

```bash
.\finc import file <file.xlsx> --dry-run
```

```bash
.\finc import file <file.xlsx>
```

`headers` shows the columns finc sees, `--dry-run` previews the rows, and the last command imports. Re-importing the
same file is safe: duplicates are recognised.

---

## 8. Daily use

### The screens

| Screen | What it shows |
|---|---|
| **Now** | How the month is expected to end, what is left to spend, the regular vs extra income behind it, the monthly spending limit, items that need attention, the next 14 days, recent transactions. "How is this calculated?" lists every term. |
| **Transactions** | Every transaction with filters (section, account, status, dates, text). Tap a row for the full story: the original text, instalments, a linked refund, the category and why. The **review** tab is the inbox. |
| **Recurring** | Fixed expenses, subscriptions and fixed income with this month's status, instalment plans, and candidates to confirm. |
| **Categories** | Each category's target, pace, six-month trend and top merchants. |
| **Trends** | In / out / net over 12 or 24 months, groups against their median, where one month's money went (Sankey), this year against last year, and **Net worth** at the top. |
| **Events** | Tag transactions from several months ("Trip to Rome", "Car repair") and see the total cost. |
| **Ask my money** | A chat about your money (section 8, "Chat"). |
| **Accounts** | Balances, card cycles, each connection's health, **Unlock** and **Sync**. Tap a securities or foreign-currency account for its positions with live prices. |
| **Settings** | Language, PIN, phone access and passkeys, alerts, AI, income kinds, the spending limit, your stock rules, limits away from home, the security log. |

Every number in the hub is the same number `.\finc month` prints, and every number can be opened to see the
transactions behind it.

### A good routine

1. **After a reboot:** `.\finc unlock` (or Accounts → Unlock). Telegram reminds you if you forget.
2. **Once a week:** open Transactions → **review**. It holds suggested refund links, uncategorised merchants, new
   recurring candidates and overdue fixed items. Each decision is remembered.
3. **When you fix a category:** finc offers to apply it to every transaction from that merchant and to create a rule,
   so it is right next time.
4. **On the Now screen:** check "left to spend" and the spending limit card.

### Useful settings

- **Income kinds** (Settings, or per payment): mark income as regular (salary) or extra (freelance, gifts). The Now
  screen then shows how the month looks without the extra; a large extra is kept out of the weekly amount unless you
  switch it on.
- **Monthly spending limit** (Settings or the Now card): covers day-to-day spending only, not bills, instalments or
  savings. With alerts on, Telegram tells you at 80% and 100%, and when you run well ahead of pace.
- **Paid back to you:** when someone repays you by Bit or a bank transfer, finc asks once whether that person is paying
  you back. A repayment then reduces your spending instead of counting as income.

### Chat ("Ask my money") and AI categorisation (optional)

Choose a provider and store its key in the vault:

```bash
.\finc ai config --provider openai
```

```bash
.\finc vault set ai_openai
```

(or `--provider anthropic` with `vault set ai_anthropic`, or `--provider local --base-url <url> --model <name>` for a
model on your own machine). Then Settings → AI → **Chat model**: Fast or Better.

What leaves your machine: merchant names, amounts and dates only — never account numbers, card numbers or raw bank
descriptions. The model can only pick one of a few fixed local lookups; finc computes the answer here, and every answer
lists what it looked at.

AI categorisation of the merchants the rules could not place:

```bash
.\finc ai dry-run
```

```bash
.\finc ai run
```

To check the chat's quality on a fictional household (no real data is sent; costs a few cents):

```bash
.\finc chat-eval
```

### Telegram alerts (recommended)

1. In Telegram, talk to **@BotFather**, send `/newbot` and copy the token.
2. Store it: `.\finc vault set telegram`.
3. Open your new bot and press **Start**.
4. Hub → Settings → Alerts → **Find the chat**, then **Send a test message**.

You then get: a failed sync, a bank that has not synced for 36 hours, a bank asking for a one-time code (reply with the
code), a fixed expense past its date, refunds, a group over its target, price increases, large charges or transfers
(₪1,000+ by default), new instalment purchases, card bills that do not match, card testing, spending-limit alerts, and
a Sunday summary. Every type is a toggle; quiet hours default to 23:00–07:00.

**The alarm bot.** Security alerts (wrong PINs, pairings, sign-ins, "worker started, vault locked") must arrive even
while the vault is locked, so they go through a second, send-only bot whose token is kept outside the vault. Create a
second bot in @BotFather, press Start in it, then (vault unlocked):

```bash
.\finc alerts alarm setup
```

```bash
.\finc alerts alarm test
```

### Stocks (optional)

Securities accounts show live prices from Yahoo Finance (only ticker symbols leave your machine). Tap a holding for
facts: price history and averages, returns against the S&P 500, volatility, dividends; with `FINC_SEC_CONTACT` set, the
company's own figures from its SEC filings; with a free [Finnhub](https://finnhub.io) key
(`.\finc vault set finnhub`), analysts' ratings and earnings dates. finc never says buy, sell or hold. Instead,
Settings → **My stock rules** lets you set your own conditions and shows which apply.

### Useful commands

| Command | What |
|---|---|
| `.\finc health` | Each connection: last success, last error, next run, balances |
| `.\finc month [YYYY-MM] [-c]` | The month's cashflow; `-c` by category |
| `.\finc review` | The review inbox in the terminal |
| `.\finc recurring list` | Fixed expenses and income |
| `.\finc cat report` | How much is categorised, and by what |
| `.\finc reconcile` | Checks that bank balance changes equal the transactions between them |
| `.\finc runs` | Recent sync runs |
| `.\finc enable <bank>` / `disable <bank>` | Include or leave out a bank in the scheduled syncs |
| `.\finc events` | The security log |
| `.\finc panic` | Lock everything (section 10) |

---

## 9. Phone and other computers (needs setup C)

### The Android app

The app is a Capacitor shell around the same web app. It keeps its device token in the Android Keystore, opens with
your fingerprint or the phone's PIN, hides itself from screenshots and the recent-apps view, and trusts only your
hub's own TLS key (pinning). It is built by you and installed from your hub, not from the Play Store.

**1. Pins.** The app pins two public keys: Caddy's live key and an offline backup key you create and keep outside
`data/` (a password manager). A pin is the base64 SHA-256 of the public key:

```bash
openssl pkey -in <key.pem> -pubout -outform der | openssl dgst -sha256 -binary | openssl base64
```

Caddy's key is in the `caddy_data` Docker volume, under
`/data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/<host>/<host>.key`. Put both pins in `.env` as
`FINC_TLS_PINS=<live>,<backup>` so the worker can watch that Caddy keeps serving a pinned key.

**2. Signing.** Create a release keystore (`keytool -genkeypair …`) and the git-ignored file
`apps/web/android/keystore.properties`:

```properties
storeFile=<path to your .jks>
storePassword=<…>
keyAlias=<…>
keyPassword=<…>
fincPublicHost=<your-name>.duckdns.org
fincPins=<live pin>,<backup pin>
```

A release build refuses to run without `fincPublicHost` and two valid pins. Keep the keystore and its passwords
backed up yourself: they are not in finc's backups.

**3. Build** (JDK 21 and the Android SDK; set `JAVA_HOME` and `ANDROID_HOME`):

```bash
pnpm --filter @finc/web build
```

```bash
pnpm --filter @finc/web exec cap sync android
```

```bash
cd apps/web/android && ./gradlew assembleRelease
```

The signed APK is in `apps/web/android/app/build/outputs/apk/release/`.

**4. Install.** Either over USB (`adb install -r <apk>`), or copy it to `data\apk\finc.apk` and open
`https://<your-name>.duckdns.org:7443/finc.apk` on the phone.

**5. Pair.** At home: Settings → Phone access → **Pair a phone** shows a QR code (valid 5 minutes, once). In the app,
choose **Scan QR**. The phone appears under Paired devices, where **Revoke** cuts it off at once. A phone that has not
connected for 30 days is removed automatically.

### Another computer: passkeys

1. **Once, at home:** Settings → Passkeys → **Add a passkey** shows a QR code. Scan it with your phone, open the link
   in Chrome and confirm with your fingerprint.
2. **Anywhere:** open `https://<your-name>.duckdns.org:7443` and press **Sign in with a passkey**.

A passkey session lasts 12 hours and can read and make decisions, but not change admin settings or operate the worker
(unlock, sync). Telegram tells you about every passkey sign-in.

Away from home, phones and passkeys have limits (manual syncs, chat questions, test alerts) so a stolen device cannot
hammer the banks or the AI bill; change them in Settings from home.

---

## 10. Backups and safety

**Nightly backups.** At 03:40 the worker writes one encrypted, verified backup (database + vault) to
`FINC_BACKUP_HOST_DIR`. It opens only with the master password in use that day. Retention keeps about 15 files (7
daily, 4 weekly, 6 monthly); Telegram warns when a backup fails or none succeeded for 48 hours.

```bash
.\finc backup now
```

```bash
.\finc backup list
```

```bash
.\finc backup verify
```

`verify` is a practice restore of the newest backup that changes nothing; run it once in a while.

**Restoring:**

```bash
docker compose stop worker
```

```bash
.\finc backup restore <file>
```

```bash
docker compose start worker
```

The restore asks for that day's master password, wants `restore` typed to go ahead, and moves the current database
aside instead of deleting it. Add `--with-vault` to restore the vault too. Then `.\finc unlock`.

**Off-machine copies (optional).** The worker can also copy each backup over SFTP to a NAS, such as a Raspberry Pi,
with an upload-only user that cannot delete anything: `.\finc backup nas setup`, then `.\finc backup nas test`. See the
README's "Off-PC copy on the NAS".

**Not in the backups:** `secrets\caddy.env`, the Android signing keystore and its passwords, the alarm bot (run its setup
again after a restore). Keep those safe yourself.

**A lost or stolen phone.** Revoke it in Settings → Paired devices from any signed-in device. If you need everything
shut at once, **Lock everything** removes every paired device and passkey, ends all sessions and locks the vault. Use
the Settings card (type LOCK), `.\finc panic` on the PC, or send `/lockdown` to the alarm bot in Telegram. Getting back
in then needs the PC at home.

---

## 11. Updating

```bash
git pull
```

```bash
pnpm install
```

```bash
pnpm -r build
```

```bash
docker compose up -d --build
```

```bash
.\finc unlock
```

The database schema migrates itself on start. Rebuild and reinstall the Android app when the web app changed.

---

## 12. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `finc is not built yet` | Run `pnpm -r build`. |
| Tests or typecheck fail on a fresh clone with "Cannot find module '@finc/core'" | `@finc/core` is not built yet: `pnpm -r build`. |
| `docker compose` says `FINC_PUBLIC_HOST` is missing | Set it (and `FINC_DUCKDNS_DOMAIN`) in `.env`; placeholders are fine for a home-only setup. |
| `docker compose` says `secrets/caddy.env` not found | Create it: empty for home-only (5B), `DUCKDNS_TOKEN=…` for remote access (5C). |
| Syncs do not run, the hub shows a "vault locked" banner | The worker restarted: `.\finc unlock`. |
| The worker answers 421 | You opened it under a name it does not know. Use `127.0.0.1`, `localhost` or your public name, or add the name to `FINC_ALLOWED_HOSTS` in `.env`. |
| A bank keeps failing to log in | Check the password with `.\finc vault check`, then try a visible login with `.\finc spike <bank>` (section 7). |
| The phone app stopped connecting and Telegram says the TLS key changed | Caddy's key changed (its volume was reset). Follow "If the alarm says the key changed" in the README; the backup pin exists for this. |
| A command is refused because "the worker owns the database" | The one-writer rule (section 5): let `.\finc` run it through the worker, or stop the worker first. |
| Chrome marks the site "Dangerous" | A known Safe Browsing false positive for DuckDNS names; passkeys work again once the warning is dismissed. |

---

## Linux and Raspberry Pi

Docker Compose is the same on Linux (amd64 or arm64). Use **`./finc.sh`** wherever this guide says `.\finc`:

```bash
./finc.sh unlock
```

It works like the Windows launchers: while the worker container runs, commands run inside it (`docker compose
exec`); `spike` and `FINC_HOST=1 ./finc.sh …` run on the host, which needs Node and `pnpm -r build`; `backup restore`
refuses while the worker runs. Use `cp .env.example .env`, `mkdir -p data secrets` and `touch secrets/caddy.env`
instead of the Windows commands above. On a Raspberry Pi the first build compiles Caddy and installs Chromium for
arm64; allow 10–20 minutes. Docker starts at boot there, so only the vault unlock is manual.

To move an existing installation, copy the repository, the whole `data/` folder (vault, database,
`apk/`) and `secrets/caddy.env`, point the router's port forward at the new machine, run `docker compose up -d --build` and unlock.

Headful bank logins (`spike`) need a screen; run those on a desktop machine against a copy of `data/`, or skip them.
