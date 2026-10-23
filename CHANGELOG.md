# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.2.1] - 2026-10-23

### Changed

- The sidebar shows the active account's 5-hour session usage instead of the fuller of its two
  windows, which read as session usage while showing the weekly figure.

## [1.2.0] - 2026-10-23

### Added

- Priority order: accounts are numbered and spent in order, with **Move up** and **Move down** in
  each account's menu. The order starts with the account already in use.
- Go back to higher-priority accounts once they free up (setting, on by default).
- Accounts per project: limit an account to selected projects. Their chats use it first and the
  shared accounts after it runs out; other projects never use it. Each such project gets its own
  config directory that shares history and settings and keeps only the login apart.
- History entries name the project a switch happened in.

### Changed

- Automatic switching picks the next account in priority order instead of the one with the most
  allowance left, and works per project.
- An account is never live in two places at once.

## [1.1.0] - 2026-10-22

### Changed

- Mobile-first account screen: 44 px touch targets, a full-width switch button and an actions
  sheet on compact layouts, stacked dialog buttons, and 16 px inputs.
- Relative times ("resets in 2 h") update on their own.
- The sidebar row shows the profile name, so long addresses no longer push out the icon.
- The switch RPC contract is named `switchAccount` so it is not mistaken for a React hook.

### Added

- ESLint (TypeScript strict and React hooks rules), Prettier and EditorConfig, enforced in CI.
- Issue and pull request templates, and Dependabot.

## [1.0.0] - 2026-10-22

### Added

- Automatic failover: when a Claude chat stops at its usage limit, switch to the account with the
  most allowance left and resume the chats that stopped with a configurable prompt.
- Preemptive switching at separate thresholds for the 5-hour and 7-day windows, whichever is
  reached first, checked on a configurable interval.
- In-app sign-in for new accounts and expired profiles through `claude auth login`.
- Rename and remove profiles. Removed profiles go to a trash directory.
- Settings page, recent switch history, reset times on each meter, sign-in expiry warnings.
- Command Center entry per account, `/account` and `/cuenta` slash commands, a sidebar row with
  the active account and its usage, and a timeline note for every automatic switch.
- English and Spanish interface.
- Test suite with the Node test runner, and continuous integration.

### Changed

- The live login is saved back into its profile before every switch and every five minutes, so
  refresh tokens rotated by Claude Code are never lost.
- A live login without a profile is saved into a new one instead of being shown as a separate
  "main" account.
- Accounts are matched by account and organization ID instead of email address.
- `~/.claude.json` is now written atomically and keeps its file mode.
- Usage readings are kept across restarts, and a refused request backs off for ten minutes.

### Fixed

- Switching away from an account and back could fail with an expired login, because the profile
  kept a refresh token Claude Code had already rotated.

## [0.1.0] - 2026-10-22

- First release: switch accounts by rewriting the live credential file.

[1.2.1]: https://github.com/ChoqueCastroLD/paseo-seamless-claude-accounts/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/ChoqueCastroLD/paseo-seamless-claude-accounts/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/ChoqueCastroLD/paseo-seamless-claude-accounts/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/ChoqueCastroLD/paseo-seamless-claude-accounts/compare/f57c1e4...v1.0.0
[0.1.0]: https://github.com/ChoqueCastroLD/paseo-seamless-claude-accounts/commit/f57c1e4
