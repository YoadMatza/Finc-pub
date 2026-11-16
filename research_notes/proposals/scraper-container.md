# The bank connectors in a container of their own (design note, 2026-11-16)

Security research P0-05/P0-06 leftovers and audit M5. Nothing here is built yet; this note is for a decision.

## 1. Why

Today one container does everything: the hub that answers the internet (through Caddy), the scheduler, the unlocked
vault, and Chromium logging in to the banks. Chromium is the largest attack surface in finc (it parses bank pages, and
it runs with `--no-sandbox` in Docker), and it shares a process space and a filesystem with the vault and the hub.
A Chromium escape is a hub compromise; a hub compromise can drive Chromium on the bank sites.

## 2. The split

| | `worker` (hub) | `scraper` (new) |
|---|---|---|
| Talks to | Caddy (edge network), the CLI | the banks only (its own network, internet, nothing of finc's) |
| Holds | database, vault, alerts, scheduler | the browser profiles; bank credentials only during one run |
| Image | Node, no Chromium | Node + Debian Chromium + israeli-bank-scrapers |
| Writes | `data/` | the profiles volume and dumps only |

- **One sync** = the worker sends the scraper one job over a private socket: institution, months, the credential
  fields from the vault (in memory, over a Unix socket on a volume only these two share, so nothing is on a network),
  and a one-time job token. The scraper runs the existing `runScrape` without a database (`db = null` already exists
  for dry runs), returns the raw result, and forgets the credentials. The worker ingests it exactly as today.
- **OTP**: the scraper asks back over the same socket ("need a code for X"); the worker relays it as today (CLI,
  Telegram).
- **The vault never enters the scraper.** It sees one institution's fields for the length of one job.
- **Chromium sandbox (M5)**: in its own container Chromium can get the one capability its sandbox needs
  (`SYS_ADMIN` is too broad; the usual answer is a seccomp profile that allows user namespaces, plus `--no-sandbox`
  removed). Decided in the build step after testing; if no safe profile works, the split still holds without it.
- **Network**: the scraper's network reaches the internet but not the worker's port or Caddy; the worker's edge
  network has no route to the banks it does not need.

## 3. Cost

- One more container (~400 MB image, ~0.4 GB memory while a sync runs, idle otherwise).
- The worker image loses Chromium and fonts (~250 MB smaller).
- `finc spike` / headful logins stay on the host as today.
- More moving parts: a job protocol, its tests, and a fallback message when the scraper is down.

## 4. Build order (each step tested, deployed and checked with a real sync)

1. Extract the job protocol: `runScrape` behind an interface the worker calls (in-process first; no behaviour change).
2. The scraper service and image; the worker calls it over the socket; profiles volume moves to it.
3. The worker image without Chromium; compose networks split.
4. Chromium's sandbox in the scraper (seccomp profile), if a safe one works on Docker Desktop and on the Pi.

## 5. Decisions for the owner

1. Build it now, or after the Raspberry Pi move (the Pi changes Docker's networking, and the sandbox question differs
   there).
2. The sandbox step (4): try it, or accept `--no-sandbox` inside the isolated container.
