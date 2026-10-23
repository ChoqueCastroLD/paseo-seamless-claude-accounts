import type { PluginHandlerContext, PluginTurnOutcome } from "@getpaseo/plugin/server";
import { switchRow, type Preferences, type SwitchRow } from "../shared/contracts.ts";
import type { AccountService } from "./service.ts";

// "You've hit your session limit · resets 11:30pm". Anchored and short so replies that merely
// discuss limits never match.
const LIMIT_NOTICE =
  /^\s*(?:you'?ve|you have) (?:hit|reached) your (?:[\w-]+ )?limit\b|^\s*(?:claude ai )?usage limit reached\b/i;
const NOTICE_MAX_LENGTH = 300;

// Chats hitting the limit within this window follow the switch already made.
const SETTLE_MS = 90_000;
// Caps resumes per chat so a loop cannot drain every account.
const RESUME_EVERY_MS = 3 * 60_000;

export function isLimitNotice(text: string): boolean {
  return text.length <= NOTICE_MAX_LENGTH && LIMIT_NOTICE.test(text);
}

type PaseoApi = PluginHandlerContext["paseo"];
type Outcome = PluginTurnOutcome;
type Item = { type: string; text?: string; message?: string };

export function hitLimit(outcome: Outcome, items: readonly Item[]): boolean {
  if (outcome.kind === "canceled") return false;
  if (outcome.kind === "failed" && isLimitNotice(outcome.error.message)) return true;
  for (const item of [...items].reverse()) {
    if (item.type === "user_message") return false;
    if (item.type === "assistant_message" || item.type === "error" || item.type === "notification") {
      return isLimitNotice(item.text ?? item.message ?? "");
    }
  }
  return false;
}

export class Failover {
  readonly #service: AccountService;
  readonly #preferences: () => Promise<Preferences>;
  readonly #projectOf: (workspaceId: string | null, paseo: PaseoApi) => Promise<string | null>;
  #moved = new Map<string, { at: number; from: string | null; to: string | null; nextReset: string | null }>();
  #resumedAt = new Map<string, number>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    service: AccountService,
    preferences: () => Promise<Preferences>,
    projectOf: (workspaceId: string | null, paseo: PaseoApi) => Promise<string | null>,
  ) {
    this.#service = service;
    this.#preferences = preferences;
    this.#projectOf = projectOf;
  }

  async onTurnEnded(
    event: { agent: { id: string; provider: string; workspaceId: string | null }; outcome: Outcome },
    paseo: PaseoApi,
  ): Promise<void> {
    if (event.agent.provider !== "claude") return;
    const prefs = await this.#preferences();
    if (!prefs.autoSwitch) return;
    const agent = paseo.agents.ref(event.agent.id);
    const page = await agent.timeline.refetch({ direction: "tail", limit: 8 });
    if (
      !hitLimit(
        event.outcome,
        page.entries.map((entry: { item: unknown }) => entry.item as Item),
      )
    )
      return;

    const project = await this.#projectOf(event.agent.workspaceId, paseo);
    const scope = await this.#service.scopeOfAgent(event.agent.id, event.agent.workspaceId, project);
    const decision = await this.#switchAfterLimit(scope, !prefs.returnToPriority);
    const now = Date.now();
    const recently = this.#resumedAt.get(event.agent.id);
    const resume =
      decision.to !== null && prefs.autoContinue && (recently === undefined || now - recently > RESUME_EVERY_MS);

    const row: SwitchRow = {
      from: decision.from ?? "",
      to: decision.to,
      reason: "limit",
      nextReset: decision.nextReset,
    };
    await agent.timeline.append({
      type: "plugin",
      id: `account-switch-${now}`,
      kind: switchRow.kind,
      version: switchRow.version,
      data: row,
    });
    if (!resume) return;
    this.#resumedAt.set(event.agent.id, now);
    await agent.send(prefs.continuePrompt);
    if (decision.to !== null) this.#service.noteResumed(decision.to, 1);
  }

  #switchAfterLimit(
    scope: string | null,
    sticky: boolean,
  ): Promise<{ from: string | null; to: string | null; nextReset: string | null }> {
    const run = this.#queue.then(async () => {
      const now = Date.now();
      const before = await this.#service.placement();
      const key = scope ?? "";
      const current = (scope === null ? before.default : (before.scopes[scope] ?? before.default)) ?? null;
      const last = this.#moved.get(key);
      if (last !== undefined && now - last.at < SETTLE_MS && (last.to === current || last.from === current)) {
        return { from: last.from, to: last.to, nextReset: last.nextReset };
      }
      const result = await this.#service.failover(scope, sticky, now);
      const after = await this.#service.placement();
      const note = (key: string, from: string | null, to: string | null) => {
        if (from !== to) this.#moved.set(key, { at: now, from, to, nextReset: null });
      };
      note("", before.default, after.default);
      for (const [key, id] of Object.entries(after.scopes)) note(key, before.scopes[key] ?? before.default, id);
      this.#moved.set(key, { at: now, ...result });
      return result;
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async rebalance(): Promise<boolean> {
    const prefs = await this.#preferences();
    if (!prefs.preemptive && !prefs.returnToPriority) return false;
    const below = prefs.preemptive ? { session: prefs.sessionThreshold, week: prefs.weekThreshold } : undefined;
    const run = this.#queue.then(() => this.#service.rebalance({ below, returnToPriority: prefs.returnToPriority }));
    this.#queue = run.catch(() => undefined);
    return run;
  }
}
