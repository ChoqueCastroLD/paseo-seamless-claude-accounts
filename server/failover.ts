import type { PluginHandlerContext, PluginTurnOutcome } from "@getpaseo/plugin/server";
import { switchRow, type Preferences, type SwitchRow } from "../shared/contracts.ts";
import { crossed, type AccountService } from "./service.ts";

/**
 * The notice Claude Code shows in place of an answer when an account runs out: "You've hit your
 * session limit · resets 11:30pm". Anchored and short so an answer that merely talks about
 * limits never counts.
 */
const LIMIT_NOTICE = /^\s*(?:you'?ve|you have) (?:hit|reached) your (?:[\w-]+ )?limit\b|^\s*(?:claude ai )?usage limit reached\b/i;
const NOTICE_MAX_LENGTH = 300;

/** A switch this recent already answers every chat that hit the limit just before it. */
const SETTLE_MS = 90_000;
/** A chat is sent the continue prompt at most this often, so a loop cannot burn every account. */
const RESUME_EVERY_MS = 3 * 60_000;

export function isLimitNotice(text: string): boolean {
  return text.length <= NOTICE_MAX_LENGTH && LIMIT_NOTICE.test(text);
}

type PaseoApi = PluginHandlerContext["paseo"];
type Outcome = PluginTurnOutcome;
type Item = { type: string; text?: string; message?: string };

/** Whether a turn ended because the account ran out: the failure, or the turn's last reply, says so. */
export function hitLimit(outcome: Outcome, items: readonly Item[]): boolean {
  if (outcome.kind === "canceled") return false;
  if (outcome.kind === "failed" && isLimitNotice(outcome.error.message)) return true;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
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
  #lastSwitch: { at: number; from: string; to: string | null; nextReset: string | null } | null = null;
  #resumedAt = new Map<string, number>();
  /** Switches run one at a time: the first chat to hit the limit switches, the rest follow. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(service: AccountService, preferences: () => Promise<Preferences>) {
    this.#service = service;
    this.#preferences = preferences;
  }

  /** Called for every ended turn. Does nothing unless a Claude chat stopped at its limit. */
  async onTurnEnded(event: { agent: { id: string; provider: string }; outcome: Outcome }, paseo: PaseoApi): Promise<void> {
    if (event.agent.provider !== "claude") return;
    const prefs = await this.#preferences();
    if (!prefs.autoSwitch) return;
    const agent = paseo.agents.ref(event.agent.id);
    const page = await agent.timeline.refetch({ direction: "tail", limit: 8 });
    if (!hitLimit(event.outcome, page.entries.map((entry: { item: unknown }) => entry.item as Item))) return;

    const decision = await this.#switchAfterLimit();
    const now = Date.now();
    const recently = this.#resumedAt.get(event.agent.id);
    const resume = decision.to !== null && prefs.autoContinue && (recently === undefined || now - recently > RESUME_EVERY_MS);

    const row: SwitchRow = { from: decision.from, to: decision.to, reason: "limit", nextReset: decision.nextReset };
    await agent.timeline.append({ type: "plugin", id: `account-switch-${now}`, kind: switchRow.kind, version: switchRow.version, data: row });
    if (!resume) return;
    this.#resumedAt.set(event.agent.id, now);
    await agent.send(prefs.continuePrompt);
    if (decision.to !== null) this.#service.noteResumed(decision.to, 1);
  }

  #switchAfterLimit(): Promise<{ from: string; to: string | null; nextReset: string | null }> {
    const run = this.#queue.then(async () => {
      const now = Date.now();
      const live = await this.#service.live();
      const last = this.#lastSwitch;
      if (last !== null && now - last.at < SETTLE_MS) {
        // This chat ran out on the account a moment ago switched away from.
        return { from: last.from, to: last.to === live?.id ? last.to : null, nextReset: last.nextReset };
      }
      if (live !== null) await this.#service.markExhausted(live.key, now);
      const next = await this.#service.pickNext({ now });
      const to = next.id !== null && (await this.#service.use(next.id, "limit")).ok ? next.id : null;
      const from = live?.id ?? "";
      this.#lastSwitch = { at: now, from, to, nextReset: next.nextReset };
      return { from, to, nextReset: next.nextReset };
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Switches ahead of the limit when the active account reaches either threshold, whichever
   * comes first. Returns the account moved to, or null.
   */
  async checkThresholds(): Promise<string | null> {
    const prefs = await this.#preferences();
    if (!prefs.preemptive) return null;
    const limits = { session: prefs.sessionThreshold, week: prefs.weekThreshold };
    const { accounts } = await this.#service.list();
    const active = accounts.find((account) => account.active);
    if (active?.usage == null || crossed(active.usage, limits) === null) return null;
    const next = await this.#service.pickNext({ below: limits });
    if (next.id === null || !(await this.#service.use(next.id, "threshold")).ok) return null;
    return next.id;
  }
}
