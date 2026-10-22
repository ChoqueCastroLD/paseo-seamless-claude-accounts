import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** One Claude Code login found on the machine, with the allowance it has left. */
const accountSchema = z.object({
  id: z.string(),
  email: z.string(),
  plan: z.string(),
  /** Percent of the 5-hour window used, or null when it could not be read. */
  fiveHour: z.number().nullable(),
  /** Percent of the 7-day window used. */
  week: z.number().nullable(),
  /** Whether this is the login `~/.claude/.credentials.json` currently holds. */
  active: z.boolean(),
});

export const listAccounts = defineRpc({
  name: "seamless-claude.list",
  input: z.object({}),
  output: z.object({
    accounts: z.array(accountSchema),
    /** Address of the login in use, or empty when the account cache is missing. */
    email: z.string(),
    /** The file a switch rewrites, shown so the swap is not a black box. */
    target: z.string(),
  }),
});

export const useAccount = defineRpc({
  name: "seamless-claude.use",
  input: z.object({ id: z.string() }),
  output: z.object({
    ok: z.boolean(),
    email: z.string(),
    error: z.string(),
  }),
});
