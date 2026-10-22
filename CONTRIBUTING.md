# Contributing

Thanks for helping. Bug reports, fixes and features are all welcome.

## Getting started

```sh
git clone https://github.com/ChoqueCastroLD/paseo-seamless-claude-accounts.git
cd paseo-seamless-claude-accounts
npm install
npm run check   # typecheck, lint, format check and tests
```

To try a change in Paseo, install your checkout once with
`paseo plugin install "$PWD"`, then run `paseo plugin reload seamless-claude-accounts` after each
edit. `paseo plugin logs seamless-claude-accounts` shows the daemon side output.

## Guidelines

- Keep the switch seamless: no change may restart, reload or copy a chat.
- Never write a credential file without `writeAtomic`, and never log or return a token.
- Daemon code lives in `server/`, app code in `client/`, and contracts shared by both in
  `shared/`. Shared code imports neither Node nor React Native.
- UI uses React Native primitives and `theme.colors` only, so it works on desktop, web and mobile
  in every theme.
- Every user-facing string goes in both dictionaries in `client/i18n.ts`. The test suite checks
  that they match.
- Add tests for behavior changes. Tests use temporary home directories and the fake `claude` in
  `tests/fixtures`; they must never touch the real `~/.claude`.

## Pull requests

1. Branch from `main`.
2. Run `npm run check`.
3. Run `npm run format` if the format check fails.
4. Describe the change and how you verified it, and add an entry under _Unreleased_ in
   `CHANGELOG.md`.
