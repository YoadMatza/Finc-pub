# Changelog

All notable changes to finc are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/) (before 1.0, a minor version may change behaviour).

## [Unreleased]

### Added
- `finc.sh`, the CLI launcher for Linux and macOS.
- Getting-started guide (`docs/getting-started.md`), CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, SUPPORT, issue and pull
  request templates, CI (build, typecheck, test) and Dependabot.
- MIT license.
- `docs/external-services.md`: every outside service, API and key, with what each one is sent.

### Changed
- `docker-compose.yml` puts backups in `./backups` unless `FINC_BACKUP_HOST_DIR` is set.
- Dependencies: TypeScript 7, better-sqlite3 13 (ships its own binaries, so no C++ build tools are needed any more),
  react-router 8, @hono/node-server 2, and minor updates of hono, @inquirer/prompts and @simplewebauthn/server.
- CI actions: checkout 7, setup-node 7, pnpm/action-setup 6.
- The hub builds with Vite 8 and @vitejs/plugin-react 6.
- The worker image runs Node 26 and installs pnpm with npm (Node 25+ has no corepack). CI tests Node 24 and 26.

### Fixed
- `finc backup nas setup` could hand out an unreadable SSH key (about 1 in 256; an ssh2 bug), now checked and remade.

## [0.8.13] - 2026-11-14

First public release. What finc does at this version:

- **Sources:** Bank Beinleumi (FIBI, including securities and foreign-currency accounts), Isracard and Max through
  israeli-bank-scrapers; RiseUp history import; CSV / XLSX statement import.
- **Engine:** cross-source dedupe, merchants, instalments, card-bill settlement links, refunds, categories with rules and
  optional AI help, recurring streams (fixed expenses, subscriptions, fixed income), a month-end forecast.
- **Hub (web, Hebrew and English) and Android app:** Now (left to spend, regular vs extra income, a monthly spending
  limit, "paid back to me"), Transactions with a review inbox, Recurring, Categories, Trends with net worth, Events,
  Accounts with holdings and live prices, stock facts and the owner's own stock rules, and "Ask my money" chat.
- **Alerts:** Telegram money, sync, limit and security alerts, a separate alarm bot, one-time-code relay, lockdown.
- **Security:** encrypted vault, PIN at home only, paired-device tokens and passkeys from outside, certificate pinning
  in the Android app, security log, request limits, egress guard.
- **Operations:** Docker deployment (worker, Caddy, DuckDNS), nightly encrypted and verified backups, off-machine copies
  over SFTP.

Earlier milestones, in short:

- 0.8.7 – 0.8.13: the chat answers first, with fixed local lookups; a fixed-question quality check (`finc chat-eval`);
  chat model choice and suggested follow-up questions.
- 0.8.3 – 0.8.6: both incomes on the Now screen, a monthly spending limit with alerts, "paid back to me".
- 0.7.8 – 0.8.2: live stock and dollar prices, stock facts from price history and SEC filings, the owner's own stock
  rules, analysts' ratings and earnings dates (Finnhub, optional).
- 0.7.x and earlier: the hub and Android app, remote access, passkeys, alerts, backups and the security hardening
  described in SECURITY.md.

[Unreleased]: https://github.com/YoadMatza/Finc-pub/compare/feb025a...HEAD
[0.8.13]: https://github.com/YoadMatza/Finc-pub/commit/feb025a
