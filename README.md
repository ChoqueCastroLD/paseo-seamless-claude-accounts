<div align="center">

# Seamless Claude Accounts for Paseo

**Switch the Claude Code account behind every open chat in one click, and fail over to another account automatically when one hits its limit. No restarts. No lost conversations.**

[![CI](https://github.com/ChoqueCastroLD/paseo-seamless-claude-accounts/actions/workflows/ci.yml/badge.svg)](https://github.com/ChoqueCastroLD/paseo-seamless-claude-accounts/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Paseo](https://img.shields.io/badge/paseo-%E2%89%A50.12-6f42c1)](https://paseo.sh)
[![Platforms](https://img.shields.io/badge/platforms-Linux%20%7C%20macOS*-lightgrey)](#requirements)

</div>

---

## Table of contents

- [Why](#why)
- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Usage](#usage)
- [Priority and projects](#priority-and-projects)
- [Automatic switching](#automatic-switching)
- [How it works](#how-it-works)
- [Security](#security)
- [Limitations](#limitations)
- [Development](#development)
- [Acknowledgements](#acknowledgements)
- [License](#license)

## Why

When a Claude account runs out of its 5-hour or weekly allowance, every chat on it stops. The
usual fixes cost you context: log out and back in, restart each chat under another
`CLAUDE_CONFIG_DIR`, or hand the work over to a fresh session.

This plugin does what `claude login` does, from inside Paseo: it replaces the one credential
file Claude Code reads. Running sessions pick the new account up on their next request, with
their history intact. When a chat hits its limit, the plugin can do that for you and tell the
chat to carry on.

## Features

- **One-click switching.** Every open chat moves to the chosen account immediately. Nothing is
  restarted, copied or reloaded.
- **Priority order.** Number your accounts. The first one with allowance left is spent first,
  and when a higher one frees up again the plugin goes back to it.
- **Accounts per project.** Keep a work account for the work project only. Its chats use that
  account first and the others after it runs out; no other project ever touches it. Open chats
  follow every change immediately.
- **Automatic failover.** When a chat stops with _"You've hit your session limit"_, the plugin
  moves to the account with the most allowance left and resumes every chat that stopped.
- **Preemptive thresholds.** Optionally switch before the limit, when the 5-hour window reaches
  one percentage or the 7-day window reaches another, whichever comes first.
- **Live usage meters.** Each account shows its 5-hour and 7-day usage and when each window
  resets. The last reading of an idle account is kept, so you still see where it stood.
- **Add accounts without a terminal.** The daemon runs `claude auth login`; you open the link,
  paste the code, done. Expired sign-ins are renewed the same way.
- **Tokens never go stale.** Claude Code rotates refresh tokens while an account is live. The
  plugin saves them back into that account's profile, so switching back never needs a new login.
- **No account is ever lost.** A live login without a profile is saved into one before anything
  replaces it.
- **Everywhere in Paseo.** A sidebar row with the active account and its 5-hour session usage, a full screen,
  a settings page, `⌘K` entries for every account, and `/account <name>` (or `/cuenta`) in the
  composer. Each automatic switch leaves a note in the chats it touched.
- **English and Spanish**, following the device language or a setting.
- **Desktop, web and mobile.** Built from React Native primitives and the host theme.

## Requirements

|             |                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------- |
| Paseo       | 0.12.0 or later, with plugins enabled (**Settings → Plugins**)                                                  |
| Claude Code | Signed in with a Claude subscription (Pro, Max, Team or Enterprise)                                             |
| Daemon OS   | Linux. macOS works when Claude Code stores its login in `~/.claude/.credentials.json` rather than the Keychain. |
| Node.js     | 22.18 or later to run the test suite                                                                            |

API keys, Bedrock and Vertex logins are not accounts this plugin can switch.

## Installation

From the Git repository:

```sh
paseo plugin add git:ChoqueCastroLD/paseo-seamless-claude-accounts
```

From a local checkout:

```sh
git clone https://github.com/ChoqueCastroLD/paseo-seamless-claude-accounts.git
paseo plugin install "$PWD/paseo-seamless-claude-accounts"
```

Check that it is running:

```sh
paseo plugin ls
```

## Usage

Open **Claude accounts** from the sidebar, from `⌘K` / `Ctrl+K`, or type `/account` in the
composer.

| Action                        | Where                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| Switch account                | **Use first** on a card, `⌘K` → _Use: you@example.com_, or `/account work`           |
| Add an account                | **Add account**, name the profile, open the link, paste the code                     |
| Renew an expired sign-in      | **Sign in again** on the card                                                        |
| Change the priority order     | **⋯** on a card → **Move up** / **Move down**                                        |
| Limit an account to projects  | **⋯** on a card → **Where to use it…**                                               |
| Rename or remove a profile    | **⋯** on a card                                                                      |
| Configure automatic switching | **Settings → Plugins → Seamless Claude Accounts**, or the summary card on the screen |

`/account` without an argument reports the active account. The argument matches a profile name
or the start of an email address.

Profiles you already have are found automatically: any `~/.claude-<name>` directory created with

```sh
CLAUDE_CONFIG_DIR=~/.claude-work claude login
```

shows up as the account `work`.

## Priority and projects

Accounts are numbered. Every project uses the first account in the list that it may use and that
still has allowance left; when that account runs out, its projects move to the next one, and when
an earlier account frees up they move back. **Use first** on a card puts that account at the top.
The order starts with the account already in use, so installing the plugin changes nothing.

An account can be limited to **selected projects**. Only those projects use it, and it moves to the
top of the list so they spend it first; every other project skips it. With a company account
limited to the company project, company chats spend it first and fall back to your other accounts
when it runs out, while every other project never touches it.

Every change applies to open chats at once, without restarting them. Each project's chats use a
link as their config dir, and switching the project's account repoints the link; Claude Code reads
through it again on its next request.

## Automatic switching

| Setting                             | Default         | Effect                                                                                                                            |
| ----------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Switch when a chat hits its limit   | On              | Moves that chat's project to the next account in priority order. Accounts that hit a limit are skipped until their window resets. |
| Resume the chats that stopped       | On              | Sends the resume prompt to each chat that stopped at the limit, at most once every 3 minutes per chat.                            |
| Resume prompt                       | `continue`      | The message sent to resume a chat.                                                                                                |
| Switch before the limit             | Off             | Checks the active account on a timer.                                                                                             |
| 5-hour window threshold             | 90%             | Switches when the session window reaches this. _Only at the limit_ turns it off.                                                  |
| 7-day window threshold              | 95%             | Switches when the weekly window reaches this. _Only at the limit_ turns it off.                                                   |
| Go back to higher-priority accounts | On              | Switches back to an account earlier in the list once it frees up.                                                                 |
| Check usage every                   | 3 minutes       | How often the thresholds and the priority order are checked.                                                                      |
| Language                            | Device language | English or Spanish.                                                                                                               |

A preemptive switch only lands on an account that is below both thresholds, so two accounts
never trade places on every check. When every account is used up, the chat gets a note saying
when the first one frees up, and nothing is sent.

Limit detection reads the notice Claude Code prints in place of an answer. It only matches a
short message that ends the turn, so a reply that merely talks about limits never triggers it.

## How it works

```text
~/.claude-work/.credentials.json     one profile per account
              │
              │  atomic copy on switch
              ▼
~/.claude/.credentials.json          the file every Claude Code session reads
              │
              │  read again on the next request
              ▼
every open chat, history intact
```

1. **Profiles** are directories named `~/.claude-<name>`, each with its own
   `.credentials.json` and `.claude.json`, exactly what `CLAUDE_CONFIG_DIR=… claude login`
   leaves behind.
2. **Before a switch**, the live login is saved back into the profile that owns it, matched by
   account and organization. A token is only copied forward in time, never over a newer one.
3. **The switch** writes the chosen profile's credentials over `~/.claude/.credentials.json`
   with a temporary file and a rename, so no reader sees half a file, then moves its
   `oauthAccount` block into `~/.claude.json` so Claude Code shows the right address.
4. **Usage** comes from the same endpoint Claude Code's `/usage` reads, with each account's own
   token. Readings are cached for a minute and a refusal backs off for ten.
5. **Failover** listens to Paseo's `agent.turn_ended` hook. The first chat to hit a limit
   switches; chats that hit it in the same moment follow that switch instead of starting another.

6. **Projects** open their Claude chats with `CLAUDE_CONFIG_DIR` set to a link under
   `~/.local/share/seamless-claude-accounts/lanes/`, through a Paseo `agent.session_open` hook.
   The link points at the config dir of the project's account: `~/.claude` for the account in
   use everywhere else, or `~/.local/share/seamless-claude-accounts/accounts/<name>`, which links
   to every entry of `~/.claude` (history, settings, plugins) except the login and the refresh
   lock. Switching a project repoints its link in one rename.
7. **One account, one login file.** All chats on an account share one credential file and one
   refresh lock, as Claude Code expects, so a token renewal in one chat never invalidates
   another.

`CLAUDE_CONFIG_DIR` set on the daemon is respected: that directory is then the live one. A chat
started with its own `CLAUDE_CONFIG_DIR` is left alone.

## Security

- Tokens never leave the daemon machine. The app receives addresses, plan names and
  percentages, never credentials. The only network request is the usage endpoint at
  `api.anthropic.com`, with each account's own token.
- Every file written is owner-only: credentials and settings `0600`, new profiles `0700`. A
  replaced file never ends up with a looser mode than it had.
- Writes are atomic and serialized. Profile names are validated on the daemon before they touch
  the file system.
- **Remove** moves a profile to `~/.local/share/seamless-claude-accounts/trash`. Nothing is
  deleted.
- The plugin never redeems refresh tokens itself. Claude Code renews them; the plugin only copies
  the result.

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Limitations

- **Accounts follow projects, not single chats.** Every chat in a project uses that project's
  account.
- **Chats opened before version 1.3** follow the account in `~/.claude` until they restart once;
  from then on they follow their project.
- **A rare race with token renewal.** If Claude Code renews the old token in the same instant,
  its write can win. The plugin detects this and reports it; switching again fixes it.
- **macOS Keychain logins are not supported.** The plugin reads and writes the credential file.
- **Paseo's Usage panel can show a stale duplicate card after a switch** on Paseo 0.12. The daemon
  remembers which account each running agent was on and does not look again until that agent's
  session reopens, so the old account's card keeps reading the shared login file. This also
  happens with plain `claude auth login`, and is tracked upstream in
  [getpaseo/paseo#6457](https://github.com/getpaseo/paseo/issues/6457) with a fix in
  [#6460](https://github.com/getpaseo/paseo/pull/6460). The plugin's own screen is not affected.
- **Auto-resume replays nothing.** The resume prompt is a new message; attachments and tool
  effects of the stopped turn are not repeated.

## Development

```sh
npm install
npm run check        # typecheck + tests
paseo plugin reload seamless-claude-accounts
paseo plugin logs seamless-claude-accounts
```

| Path                          | Runs in           | Contents                                                                          |
| ----------------------------- | ----------------- | --------------------------------------------------------------------------------- |
| `index.server.ts`, `server/`  | Daemon subprocess | Profile store, usage reader, login flow, failover                                 |
| `index.client.tsx`, `client/` | Paseo app         | Screen, settings, sidebar, dialogs, timeline note, strings                        |
| `shared/`                     | Both              | RPC contracts, settings schema, name and usage helpers                            |
| `tests/`                      | Node test runner  | Unit and integration tests against temporary home directories and a fake `claude` |

The tests never touch your real `~/.claude`. They run with Node's built-in test runner and type
stripping, so there are no test dependencies.

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## Acknowledgements

This project started as a fork of
[kostilal/paseo-claude-accounts](https://github.com/kostilal/paseo-claude-accounts), which
switches accounts by giving each one its own config directory. That design restarts chats on
every switch; this plugin was rewritten around the single credential file instead and shares no
source code with it. The idea, and the details of the usage endpoint, are owed to that project.

## License

[MIT](LICENSE)
