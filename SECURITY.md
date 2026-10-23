# Security policy

This plugin handles Claude OAuth credentials, so security reports are taken seriously.

## Supported versions

Only the latest release receives fixes.

## Reporting a vulnerability

Please do not open a public issue. Use
[GitHub private vulnerability reporting](https://github.com/ChoqueCastroLD/paseo-seamless-claude-accounts/security/advisories/new)
with a description, the affected version and steps to reproduce. You should get an answer within
a week.

## What the plugin does with credentials

- Credentials are read and written only on the daemon machine, inside the daemon user's home
  directory. They are never sent to the Paseo app, logged, or written to the usage cache.
- The plugin sends requests only to `https://api.anthropic.com`, each with the access token of the
  account concerned: `GET /api/oauth/usage` for usage, and `GET /api/oauth/profile` to identify a
  login whose token changed. Answers are cached in memory; tokens are not.
- One account's tokens are never written into another account's profile. When the owner of a
  login cannot be established, nothing is copied, and a login about to be replaced is first saved
  to `~/.local/share/seamless-claude-accounts/trash` with mode `0600`.
- Credential and settings files are written atomically with mode `0600`; profile directories are
  created with mode `0700`.
- Refresh tokens are never redeemed by the plugin. Claude Code renews them, and the plugin copies
  the renewed login into its profile.

Paseo plugins are trusted, unsandboxed code. Review the source before installing it.
