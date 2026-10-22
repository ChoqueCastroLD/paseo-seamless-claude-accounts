import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

const windowSchema = z.object({
  percent: z.number(),
  resetsAt: z.string().nullable(),
});

const usageSchema = z.object({
  fiveHour: windowSchema.nullable(),
  week: windowSchema.nullable(),
  fetchedAt: z.string(),
});

export const accountStatus = z.enum(["ready", "no-login", "relogin"]);

export const accountSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  plan: z.string(),
  organization: z.string(),
  status: accountStatus,
  active: z.boolean(),
  usage: usageSchema.nullable(),
  tokenExpiresAt: z.string().nullable(),
  loginExpiresAt: z.string().nullable(),
  exhaustedUntil: z.string().nullable(),
});
export type Account = z.infer<typeof accountSchema>;

export const switchReason = z.enum(["manual", "limit", "threshold"]);

const historyEntrySchema = z.object({
  at: z.string(),
  from: z.string(),
  to: z.string(),
  reason: switchReason,
  resumed: z.number(),
});
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

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
    refresh: z.boolean().default(false),
  }),
  output: z.object({
    accounts: z.array(accountSchema),
    target: z.string(),
    history: z.array(historyEntrySchema),
  }),
});

export const switchAccount = defineRpc({
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
  output: z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), trash: z.string() }), failure]),
});

export const startLogin = defineRpc({
  name: "seamless-claude.login-start",
  input: z.object({
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
    autoSwitch: z.boolean().default(true),
    autoContinue: z.boolean().default(true),
    continuePrompt: z.string().min(1).max(500).default("continue"),
    preemptive: z.boolean().default(false),
    sessionThreshold: z.number().int().min(10).max(100).default(90),
    weekThreshold: z.number().int().min(10).max(100).default(95),
    checkMinutes: z.number().int().min(1).max(60).default(3),
    language: z.enum(languages).default("auto"),
  }),
});
export type Preferences = z.infer<typeof preferences.schema>;

export const switchRow = {
  kind: "account-switch",
  version: 1,
  schema: z.object({
    from: z.string(),
    to: z.string().nullable(),
    reason: switchReason,
    nextReset: z.string().nullable(),
  }),
} as const;
export type SwitchRow = z.infer<typeof switchRow.schema>;
