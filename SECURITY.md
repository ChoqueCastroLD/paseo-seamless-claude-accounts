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
- The only outbound request is `GET https://api.anthropic.com/api/oauth/usage`, made with each
  account's own access token.
- Credential and settings files are written atomically with mode `0600`; profile directories are
  created with mode `0700`.
- Refresh tokens are never redeemed by the plugin. Claude Code renews them, and the plugin copies
  the renewed login into its profile.

Paseo plugins are trusted, unsandboxed code. Review the source before installing it.
