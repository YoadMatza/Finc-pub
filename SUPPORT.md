# Getting help

finc is a volunteer project; there is no paid support. Here is where to look:

1. **Setting up or using finc:** [docs/getting-started.md](docs/getting-started.md) walks through build, configuration,
   the first sync and daily use, and ends with a troubleshooting table. The [README](README.md) describes every
   feature in detail.
2. **Something broken:** open a [bug report](https://github.com/YoadMatza/Finc-pub/issues/new/choose). Search the
   existing issues first.
3. **An idea, or a bank that is not supported yet:** open a feature request or a "Support a new bank or card" issue.
4. **A security problem:** never in a public issue; follow [SECURITY.md](SECURITY.md).

When you ask, include your version (`finc --version`), how you run finc (Docker on Windows, Docker on Linux, or
`finc worker`) and the output of `finc health`, with anything personal removed.

**Never post real financial data** (transactions, balances, account or card numbers, ID numbers, bank page dumps or
screenshots of them), and never share your master password, tokens or API keys. No maintainer will ever ask for them.

finc shows facts about your money; it does not give financial or investment advice, and neither do its maintainers.
