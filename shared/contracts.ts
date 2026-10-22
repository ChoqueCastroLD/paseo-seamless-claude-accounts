import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** One allowance window as the usage endpoint reports it. */
const windowSchema = z.object({
  /** Percent used, 0 to 100. */
  percent: z.number(),
  /** ISO instant the window resets, when the endpoint says. */
  resetsAt: z.string().nullable(),
});

const usageSchema = z.object({
  fiveHour: windowSchema.nullable(),
  week: windowSchema.nullable(),
  /** ISO instant of the reading. Older than a minute means it is the last one known. */
  fetchedAt: z.string(),
});

/**
 * Why an account cannot be switched to, or why its meter is empty. Codes, not sentences:
 * the client translates them.
 */
export const accountStatus = z.enum([
  /** Holds a login that is still in date, or that Claude Code can renew. */
  "ready",
  /** A `~/.claude-*` directory that has never finished `claude login`. */
  "no-login",
  /** The refresh token has expired too: only a new login brings it back. */
  "relogin",
]);

export const accountSchema = z.object({
  /** The profile directory suffix: `~/.claude-work` is `work`. Stable, used to switch. */
  id: z.string(),
  email: z.string(),
  name: z.string(),
  plan: z.string(),
  organization: z.string(),
  status: accountStatus,
  /** Whether this is the login Claude Code uses right now. */
  active: z.boolean(),
  usage: usageSchema.nullable(),
  /** ISO instant the access token expires. Claude Code renews it on its own while in use. */
  tokenExpiresAt: z.string().nullable(),
  /** ISO instant after which only a new login works. */
  loginExpiresAt: z.string().nullable(),
  /** ISO instant until which automatic switching skips this account, after it hit a limit. */
  exhaustedUntil: z.string().nullable(),
});
export type Account = z.infer<typeof accountSchema>;

export const switchReason = z.enum(["manual", "limit", "threshold"]);

const historyEntrySchema = z.object({
  at: z.string(),
  from: z.string(),
  to: z.string(),
  reason: switchReason,
  /** Agents sent the continue prompt after an automatic switch. */
  resumed: z.number(),
});
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

/** Failures the server reports as codes so the client can word them in the user's language. */
export const errorCode = z.enum([
  "unknown-account",
  "no-login",
  "invalid-login",
  "invalid-name",
  "name-taken",
  "active-account",
  "login-expired",
  "login-failed",
  "login-duplicate",
  "claude-missing",
  "io",
]);
export type ErrorCode = z.infer<typeof errorCode>;

const failure = z.object({ ok: z.literal(false), error: errorCode, detail: z.string() });

export const listAccounts = defineRpc({
  name: "seamless-claude.list",
  input: z.object({
    /** Skip the one-minute usage cache. The endpoint still rate-limits, so use it on demand only. */
    refresh: z.boolean().default(false),
  }),
  output: z.object({
    accounts: z.array(accountSchema),
    /** The file a switch rewrites, so the swap is not a black box. */
    target: z.string(),
    history: z.array(historyEntrySchema),
  }),
});

export const useAccount = defineRpc({
  name: "seamless-claude.use",
  input: z.object({ id: z.string() }),
  output: z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), email: z.string() }), failure]),
});

export const renameAccount = defineRpc({
  name: "seamless-claude.rename",
  input: z.object({ id: z.string(), name: z.string() }),
  output: z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), id: z.string() }), failure]),
});

export const removeAccount = defineRpc({
  name: "seamless-claude.remove",
  input: z.object({ id: z.string() }),
  output: z.discriminatedUnion("ok", [
    /** Where the profile went. Nothing is deleted, so a mistake is a `mv` away. */
    z.object({ ok: z.literal(true), trash: z.string() }),
    failure,
  ]),
});

export const startLogin = defineRpc({
  name: "seamless-claude.login-start",
  input: z.object({
    /** Profile name for a new account, or the id of a `no-login`/`relogin` profile to finish. */
    name: z.string(),
  }),
  output: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), session: z.string(), url: z.string(), id: z.string() }),
    failure,
  ]),
});

export const finishLogin = defineRpc({
  name: "seamless-claude.login-finish",
  input: z.object({ session: z.string(), code: z.string() }),
  output: z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), id: z.string(), email: z.string() }), failure]),
});

export const cancelLogin = defineRpc({
  name: "seamless-claude.login-cancel",
  input: z.object({ session: z.string() }),
  output: z.object({}),
});

export const languages = ["auto", "es", "en"] as const;

export const preferences = defineSettings({
  id: "preferences",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Switch to the account with the most allowance left when a chat hits its limit. */
    autoSwitch: z.boolean().default(true),
    /** After an automatic switch, send the chats that stopped a prompt so they carry on. */
    autoContinue: z.boolean().default(true),
    continuePrompt: z.string().min(1).max(500).default("continue"),
    /**
     * Switch before the limit: when the active account's 5-hour window reaches
     * `sessionThreshold` percent or its 7-day window reaches `weekThreshold`, whichever is first.
     */
    preemptive: z.boolean().default(false),
    /** Percent of the 5-hour window. 100 leaves that window to the limit itself. */
    sessionThreshold: z.number().int().min(10).max(100).default(90),
    /** Percent of the 7-day window. 100 leaves that window to the limit itself. */
    weekThreshold: z.number().int().min(10).max(100).default(95),
    /** How often the active account's usage is read for the thresholds. */
    checkMinutes: z.number().int().min(1).max(60).default(3),
    language: z.enum(languages).default("auto"),
  }),
});
export type Preferences = z.infer<typeof preferences.schema>;

/** Timeline row an automatic switch leaves in each chat it resumed. */
export const switchRow = {
  kind: "account-switch",
  version: 1,
  schema: z.object({
    from: z.string(),
    to: z.string().nullable(),
    reason: switchReason,
    /** When no account is left: the earliest instant one frees up. */
    nextReset: z.string().nullable(),
  }),
} as const;
export type SwitchRow = z.infer<typeof switchRow.schema>;
