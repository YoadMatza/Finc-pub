# Security policy

finc holds bank and card logins and a household's full financial history, so security reports are taken seriously.
Thank you for looking.

## Reporting a vulnerability

**Do not open a public issue, discussion or pull request for a security problem.**

Report it privately through GitHub: the repository's **Security** tab → **Report a vulnerability**. Only the
maintainers see the report, and we can work on a fix together in a private advisory.

Please include:

- what is affected (component, file, endpoint or screen) and the version or commit;
- what an attacker needs: their network position (the internet, the home network, the same machine), whether they
  need a paired device, a passkey, the PIN or access to the PC;
- what they get: read data, change data, take over the hub, reach the bank logins, run code;
- steps to reproduce, ideally against a test setup with made-up data.

**Never send real financial data, credentials, tokens or bank page dumps**, yours or anyone else's. If a proof needs
data, invent it.

## What to expect

finc is maintained by volunteers, so these are aims, not guarantees:

- an acknowledgement within 7 days;
- an assessment (accepted, need more information, or not a vulnerability, with the reason) within 30 days;
- a fix on `main` as fast as its severity calls for, then a published advisory that credits you, unless you prefer to
  stay anonymous.

Please give us a reasonable time to fix the problem before you disclose it; we will agree on a date with you.

## Supported versions

Only the latest commit on `main` is supported. There are no maintained release branches: update to `main` (see
[docs/getting-started.md](docs/getting-started.md), "Updating") before reporting, and check whether the problem is
still there.

## Scope

**In scope**: everything in this repository, for example:

- the worker's HTTP API and hub: authentication (PIN, sessions, passkeys), device pairing and tokens, host and origin
  checks, request limits;
- the vault and the backups (encryption, key derivation, what is stored outside them);
- the egress rules: anything that sends data off the machine beyond what the README's Privacy section lists;
- the Android app: token storage, biometric lock, certificate pinning, deep links;
- the Docker and Caddy configuration as shipped in this repository;
- the Telegram bots (alerts, one-time code relay, the alarm bot and its lockdown command);
- the CLI's protections (the one-writer guard, restore).

**Out of scope**:

- vulnerabilities in dependencies, unless finc uses them in an unsafe way (report the dependency upstream; tell us if
  finc needs a change in the meantime). Bank logins go through
  [israeli-bank-scrapers](https://github.com/eshaham/israeli-bank-scrapers);
- an attacker who already controls the PC or the user's account on it (they can read the unlocked worker's memory);
- the security of the banks' own sites, DuckDNS, Let's Encrypt, Telegram or the AI providers;
- a user's own configuration that departs from the documentation (for example exposing port 7733, or turning on
  Tailscale Serve without an access list);
- denial of service from a client on the home network, and findings that need physical access to an unlocked phone;
- reports from automated scanners without a demonstrated impact.

## The security model in short

So you can judge what counts as a break:

- **Secrets** (bank logins, API keys, the main Telegram bot token) live only in an encrypted vault (`data/vault.json`,
  Argon2id + XChaCha20-Poly1305). The master password is never stored; the vault starts locked on every worker start.
  Secrets are never read from environment variables.
- **The PIN works only from home** (loopback and private addresses, without a proxy header). From the internet the only
  ways in are a **paired-device token** (made by a single-use, 5-minute QR code at home) or a **passkey**. Passkey
  sessions last 12 hours and cannot change admin settings or operate the worker.
- **Remote access** goes through Caddy on one HTTPS port; the worker's own port is published only on 127.0.0.1. The worker trusts
  forwarding headers only from Caddy's fixed address, answers only to known host names, and refuses cross-site writes.
- **The Android app** keeps its token in the Android Keystore behind the fingerprint or the phone's PIN, sends every
  request from native code with pinned TLS keys, and blocks screenshots and the recent-apps preview.
- **Egress:** only merchant names, amounts and dates go to the chosen AI provider; only ticker symbols to price
  sources; error text never leaves the machine.
- **Lock everything** (Settings, `finc panic`, or `/lockdown` to the alarm bot) removes every device and passkey, ends
  every session and locks the vault.

## Known limitations

These are documented design limits, not vulnerabilities (but ideas to improve them are welcome as normal issues):

- While the vault is unlocked, the worker's memory holds the decrypted secrets; it does not lock itself on a timer,
  because scheduled syncs need it open.
- On Docker Desktop, any container or WSL process on the same PC can reach `127.0.0.1:7733` and counts as "home"; it can
  try PINs (with an escalating lock and alerts).
- Behind Docker Desktop every outside client shows the same address, so per-address limits and logs are coarse there;
  a Linux host sees real addresses.
- A browser on another computer cannot pin the hub's TLS key; pinning protects the Android app only.
- finc does not encrypt the disk. The database is not encrypted at rest; use full-disk encryption if the machine can be
  stolen.
- Anyone signed in can use "Lock everything", including a thief; the worst it does is lock the owner out until they are
  home.

## Hardening your own installation

- Use a long master password and keep it in a password manager; keep the Android signing keystore and the backup pin
  key outside `data/`.
- Forward only the one HTTPS port, never 7733.
- Set up the alarm bot, so security alerts arrive even while the vault is locked.
- Put backups on another disk, and run `finc backup verify` now and then.
- Update to the latest `main` regularly.
