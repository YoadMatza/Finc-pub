## What and why

<!-- What changes, and the problem it solves. Link the issue: "Closes #…" -->

## How it was tested

<!-- Tests added or changed, and anything you checked by hand. -->

## Privacy and security

<!-- Does this send anything new off the machine, touch auth, pairing, passkeys, the vault, backups, the egress guard,
     the Android app or the Docker/Caddy setup? If so: what could an attacker do before and after. Otherwise "none". -->

## Checklist

- [ ] `pnpm -r build`, `pnpm typecheck` and `pnpm test` pass
- [ ] No real data anywhere: tests, fixtures, docs, comments, screenshots and commit messages use made-up values only
- [ ] No secrets read from environment variables or files (vault only)
- [ ] New strings are in both Hebrew and English (`apps/web/src/i18n.tsx`)
- [ ] Database changes come with a generated migration in `packages/core/drizzle/`
- [ ] Docs updated (README, `docs/getting-started.md`) if behaviour or setup changed
