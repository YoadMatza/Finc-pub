# Contributing to finc

Thanks for helping. finc handles people's bank logins and their whole financial history, so a few rules here are
stricter than in most projects. Please read **Privacy and security rules** before your first change, and follow our
[Code of Conduct](CODE_OF_CONDUCT.md) everywhere in the project.

## Ways to help

- **Bug reports:** open an issue with what you did, what you expected, what happened, and the output of
  `finc health` and `finc --version`. **Never paste real transactions, balances, account or card numbers, IDs, bank
  page dumps or screenshots with real data.** Describe the shape instead ("a refund row with a negative amount and no
  memo"), or make up values.
- **Security problems:** do **not** open a public issue. Follow [SECURITY.md](SECURITY.md): GitHub's private vulnerability
  reporting (the repository's Security tab → *Report a vulnerability*).
- **A new bank or card:** connectors build on [israeli-bank-scrapers](https://github.com/eshaham/israeli-bank-scrapers).
  Open an issue first: we need to agree on the data shape, and on how you will test it without real data.
- **Translations and wording:** the app is Hebrew and English. Both must say the same thing.
- **Docs:** fixes to the README and [docs/getting-started.md](docs/getting-started.md) are always welcome.

For anything bigger than a bug fix, open an issue first and describe the change, so no one spends a weekend on
something that cannot be merged.

## Setting up

Follow [docs/getting-started.md](docs/getting-started.md) sections 1–2. In short:

```bash
npm install -g pnpm@10.34.9
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

You do **not** need bank accounts to develop: the tests and fixtures are synthetic. For the UI:

```bash
pnpm --filter @finc/web dev
```

Vite serves on :5173 and forwards `/api` to a worker on :7733 (`.\finc worker`, or the Docker worker).

## The layout in one minute

| Path | What lives there |
|---|---|
| `packages/core` | Everything that does not touch the outside world: the schema and migrations (`drizzle/`), the vault, ingest and dedupe, the engine (merchants, instalments, settlements, refunds, categories, recurring), the hub's numbers, AI prompts and the egress guard. Pure and well tested. |
| `apps/worker` | The `finc` CLI, the scheduler, the HTTP API (Hono), bank connectors, alerts, backups. |
| `apps/web` | The React app (Vite, Tailwind), its translations (`src/i18n.tsx`), and the Android shell (`android/`, Capacitor). |
| `fixtures/` | Synthetic sample data. |
| `design/` | Architecture and product design. Read `design/04-architecture.md` before changing the engine or the security model. |

Numbers are computed once, in `packages/core`, and both the CLI (`finc month`) and the hub show the same result. Put
new money logic there with tests, not in the web app.

## Privacy and security rules

These are not style preferences; a change that breaks one will not be merged.

1. **No real data in the repository, ever.** Not in tests, fixtures, docs, comments, commit messages or screenshots:
   no real names, amounts that belong to a real person, account or card numbers (not even the last 4 digits), ID
   numbers, addresses, host names, IPs or bank page dumps. Use obviously fictional values (`Client Alpha`,
   `Employer Ltd`, `0000`, `example.test`, `192.0.2.x`). If you derive a test from a real case, change every value.
2. **Secrets only in the vault.** Never read a password, token or API key from an environment variable, a config file
   or the command line. Add a vault entry (`finc vault set <name>`) and read it from the unlocked vault.
3. **Nothing leaves the machine except what is documented.** Today that is: merchant names, amounts and dates to the
   user's chosen AI provider (through `modelName` / `guardEgress` in `packages/core/src/ai/model-names.ts`), ticker
   symbols to Yahoo and Finnhub, a company's SEC number to SEC EDGAR, and alert text to Telegram. Never raw bank
   descriptions, account numbers or error text. A new outgoing call needs a strong reason, a note in the README's
   Privacy section, and a test that the guard holds.
4. **Errors are cleaned before they are logged or sent.** Do not put raw scraper or provider error text into Telegram,
   the API's responses or the AI. Use the existing error kinds.
5. **One writer.** Code must never open the live database from outside the worker while it runs. Commands go through
   the worker (`worker-client`), and the guards in `apps/worker/src/cli/guard.ts` must keep working.
6. **No investment advice.** finc shows facts and the user's own rules. It never says buy, sell or hold, and never
   ranks holdings as good or bad.
7. **Security-sensitive changes** (auth, pairing, passkeys, the vault, the egress guard, the Android token storage,
   Caddy or Docker exposure) need a test for the attack they prevent, and a sentence in the pull request about what an
   attacker could do before and after.

## Making a change

- **Tests.** Every change to `packages/core` and the worker comes with Vitest tests. Run `pnpm test` and
  `pnpm typecheck` before you push. Tests must not depend on today's date: pass a fixed date (most functions take a
  `today` or `now`).
- **TypeScript.** Strict mode with `noUncheckedIndexedAccess`; no `any` to get past the compiler. Follow the style of
  the file you are in: two spaces, single quotes, semicolons, lines up to about 120 characters.
- **Comments.** Explain *why*, briefly. No personal names or real cases.
- **Database changes.** Edit the schema in `packages/core`, then generate a migration with
  `pnpm --filter @finc/core db:generate` and commit the new file in `packages/core/drizzle/`. Never edit a migration that
  has been released. Migrations run on the worker's start, so they must work on an existing database.
- **Both languages.** Every new string goes into both `he` and `en` in `apps/web/src/i18n.tsx` (TypeScript enforces the
  keys). Hebrew screens are right to left: keep amounts, dates and Latin names readable (the `.num` class and the helpers
  in `apps/web/src/bidi.ts`).
- **Money.** Amounts are integers in agorot (minor units). Do not use floating point for money.
- **UI wording.** Plain, short, descriptive. Say what happened and what the user can do; do not tell them what to do
  with their money.
- **Dependencies.** Add one only when it clearly pays for itself; versions are pinned exactly (`save-exact`). Anything
  that runs install scripts needs a reason in the pull request.

## Pull requests

- One topic per pull request, small enough to review in one sitting.
- Commit messages: a short summary line saying what changed, optionally with a prefix (`docs:`, `test:`, `chat:`),
  then a body with the why when it is not obvious.
- In the description: what changed and why, how you tested it, and anything about privacy or security (see rule 7).
  Screenshots of the UI are welcome, with made-up data only.
- CI-equivalent checks you should run locally: `pnpm -r build`, `pnpm typecheck`, `pnpm test`.
- By contributing you agree that your contribution is licensed under the project's [MIT License](LICENSE).

## Releasing (maintainers)

The version is the same in every `package.json`; the Android app also has a `versionCode` in
`apps/web/android/app/build.gradle`. Bump both together, rebuild the Docker image and the APK, and note the change in
the README.
