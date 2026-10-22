# Seamless Claude Accounts

Switch the Claude Code account behind every open chat in one click, without restarting any of
them. When a chat hits its usage limit, the plugin can move to another account and resume the
chat for you.

## How it works

Each account is a `~/.claude-<name>` profile directory, the kind `CLAUDE_CONFIG_DIR=... claude
login` creates. Switching copies that profile's login over `~/.claude/.credentials.json`, the
file every Claude Code session reads, the same way `claude login` does. Open chats keep their
history and use the new account from their next message. The switch applies to every Claude chat
on the daemon at once.

Before each switch the live login is saved back into its own profile, including any token Claude
Code renewed while it was in use, so switching back never needs a new sign-in. A live login with
no profile gets one automatically.

## Priority and projects

Accounts are numbered and spent in that order: when the first runs out the next takes over, and
the plugin goes back to the first once it frees up. An account can also be limited to selected
projects. Chats in those projects use it first and the shared accounts after it runs out; other
projects never use it. Such a project gets its own config directory that shares history and
settings with `~/.claude` and keeps only the login apart. New chats follow these rules at once;
chats already open follow them after they restart. An account is never live in two places at
once, because the two copies would invalidate each other's refresh token.

## Setup

Requires Paseo 0.12 or later on a Linux daemon, with Claude Code signed in to a Claude
subscription. On macOS it works only when Claude Code keeps its login in the credential file
rather than the Keychain. Existing `~/.claude-*` profiles are found automatically. To add an
account, use **Add account** on the plugin screen: the daemon runs `claude auth login`, you open
the link it gives and paste the code back.

## What you get

- A screen with each account's 5-hour and 7-day usage, reset times and sign-in status, plus
  rename, remove and sign in again.
- A sidebar row with the active account and how full it is.
- Command Center entries for every account and `/account <name>` in the composer.
- Priority order and per-project accounts, set from each account's menu.
- Automatic switching when a chat hits its limit, with an optional resume prompt sent to the
  chats that stopped. A note in each chat records what happened.
- Optional switching before the limit, at a percentage of the 5-hour window or of the 7-day
  window, whichever is reached first.
- English and Spanish.

## Data and permissions

Tokens stay on the daemon machine; the app only receives addresses, plan names and percentages.
The plugin reads and writes `~/.claude/.credentials.json`, `~/.claude.json`, the `~/.claude-*`
profiles and its own directory `~/.local/share/seamless-claude-accounts`, all with owner-only
permissions. Usage is read from `api.anthropic.com`
with each account's own token. Removed profiles are moved to
`~/.local/share/seamless-claude-accounts/trash`, never deleted.
