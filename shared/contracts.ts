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
  // Serves the chats outside projects and every project that has no better account.
  active: z.boolean(),
  // Workspaces (or, for chats opened by 1.3, projects) served by this account when it is not active.
  usedBy: z.array(z.string()),
  priority: z.number().int(),
  // Known projects that may use the account.
  allowed: z.array(z.string()),
  everywhere: z.boolean(),
  usage: usageSchema.nullable(),
  tokenExpiresAt: z.string().nullable(),
  loginExpiresAt: z.string().nullable(),
  exhaustedUntil: z.string().nullable(),
});
export type Account = z.infer<typeof accountSchema>;

export const switchReason = z.enum(["manual", "limit", "threshold", "priority"]);
export type SwitchReason = z.infer<typeof switchReason>;

const historyEntrySchema = z.object({
  at: z.string(),
  everywhere: z.boolean(),
  scopes: z.array(z.string()),
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
    projects: z.array(z.object({ id: z.string(), name: z.string() })),
    workspaces: z.array(z.object({ id: z.string(), name: z.string(), projectId: z.string() })),
    // Workspace id to the accounts it may use, for workspaces that do not follow their project.
    choices: z.record(z.string(), z.array(z.string())),
    // Project id to the accounts it may not use.
    excluded: z.record(z.string(), z.array(z.string())),
  }),
});

export const switchAccount = defineRpc({
  name: "seamless-claude.use",
  input: z.object({ id: z.string() }),
  output: z.discriminatedUnion("ok", [
    // `placed` is false when nothing can use the account right now: used up, signed out or limited.
    z.object({ ok: z.literal(true), email: z.string(), placed: z.boolean() }),
    failure,
  ]),
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

export const reorderAccounts = defineRpc({
  name: "seamless-claude.reorder",
  input: z.object({ ids: z.array(z.string()) }),
  output: z.object({}),
});

export const assignProjects = defineRpc({
  name: "seamless-claude.projects",
  // `everywhere` lets every project use the account, including projects created later. Otherwise
  // `projects` may use it out of `known`, the projects the person deciding could see.
  input: z.object({
    id: z.string(),
    projects: z.array(z.string()),
    known: z.array(z.string()),
    everywhere: z.boolean(),
  }),
  output: z.discriminatedUnion("ok", [z.object({ ok: z.literal(true) }), failure]),
});

export const assignWorkspace = defineRpc({
  name: "seamless-claude.workspace",
  // `null` makes the workspace follow its project again.
  input: z.object({ workspaceId: z.string(), accounts: z.array(z.string()).nullable() }),
  output: z.discriminatedUnion("ok", [z.object({ ok: z.literal(true) }), failure]),
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
    returnToPriority: z.boolean().default(true),
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
