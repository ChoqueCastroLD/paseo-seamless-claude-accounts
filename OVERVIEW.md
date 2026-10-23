# Seamless Claude Accounts

Switch the Claude Code account behind every open chat in one click, without restarting any of
them. When a chat hits its usage limit, the plugin can move to another account and resume the
chat for you.

## How it works

Each account is a `~/.claude-<name>` profile directory, the kind `CLAUDE_CONFIG_DIR=... claude
login` creates. Claude chats in a workspace open through a link to their account's config dir,
which shares history, settings, skills and plugins with `~/.claude` and keeps only its own login.
Switching repoints that link, so open chats keep their history and use the new account from
their next message. Configuration and history are never touched. The only cost is Anthropic's
prompt cache, which belongs to one account, so the first message after a switch is processed
uncached once. That is why the plugin moves a busy chat only when it must and returns to a
higher-priority account after the workspace has been quiet for an hour.

Before any login is replaced, it is saved back into its own profile, including any token Claude
Code renewed while it was in use, so switching back never needs a new sign-in. A live login with
no profile gets one automatically.

## Priority, projects and workspaces

Accounts are numbered. Each workspace uses the first account it may use that has allowance left,
moves to the next when it runs out, and moves back when an earlier one frees up. Every account is
allowed everywhere by default. An account can be limited to selected projects from its card, and a
single workspace can pick its own accounts from the **Claude accounts** button in its header. New
workspaces follow their project, so quick creation and agents that create workspaces need nothing
extra. Every change reaches open chats at once, without restarting them: each workspace's chats
read their config dir through a link that the plugin repoints.

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
- Priority order, per-project accounts from each account's menu, and per-workspace accounts from
  the workspace header.
- Automatic switching when a chat hits its limit, with an optional resume prompt sent to the
  chats that stopped. A note in each chat records what happened.
- Optional switching before the limit, at a percentage of the 5-hour window or of the 7-day
  window, whichever is reached first.
- English and Spanish.

## Data and permissions

Tokens stay on the daemon machine; the app only receives addresses, plan names and percentages.
The plugin reads and writes `~/.claude/.credentials.json`, `~/.claude.json`, the `~/.claude-*`
profiles and its own directory `~/.local/share/seamless-claude-accounts`, all with owner-only
permissions. Usage, and whose a login is when its token changes, are read from
`api.anthropic.com` with each account's own token. Removed profiles are moved to
`~/.local/share/seamless-claude-accounts/trash`, never deleted.

Claude chats opened before the plugin was installed have no workspace link. Each one is reopened
once, the first time it is idle, so Paseo resumes the same conversation through its link.
