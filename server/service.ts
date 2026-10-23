import { basename, dirname, join } from "node:path";
import type { Account, ErrorCode, HistoryEntry, SwitchReason } from "../shared/contracts.ts";
import { slug } from "../shared/names.ts";
import { peak, settle } from "../shared/usage.ts";
import { LoginError, LoginFlow } from "./login.ts";
import {
  allowEverywhere,
  allows,
  plan,
  prioritized,
  projectsOf,
  promote,
  setProjects,
  without,
  type Candidate,
  type Placement,
} from "./policy.ts";
import { forget, migrate, renameIn, RulesStore } from "./state.ts";
import { Store, StoreError, type Profile } from "./store.ts";
import { fullUntil, UsageReader, type Usage } from "./usage.ts";

const HISTORY_SIZE = 20;
const DEFAULT_EXHAUSTION_MS = 60 * 60_000;

export type Failure = { ok: false; error: ErrorCode; detail: string };

export interface Thresholds {
  session: number;
  week: number;
}

function failure(error: unknown): Failure {
  if (error instanceof StoreError || error instanceof LoginError) {
    return { ok: false, error: error.code, detail: error.message };
  }
  return { ok: false, error: "io", detail: error instanceof Error ? error.message : String(error) };
}

function keyOf(profile: Profile): string {
  return profile.identity?.key ?? `dir:${profile.id}`;
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

export function crossed(usage: Usage, limits: Thresholds): "session" | "week" | null {
  if (usage.fiveHour !== null && usage.fiveHour.percent >= limits.session) return "session";
  if (usage.week !== null && usage.week.percent >= limits.week) return "week";
  return null;
}

export function cacheFile(home: string): string {
  return join(home, ".cache", "seamless-claude-accounts", "usage.json");
}

export interface AgentSummary {
  id: string;
  provider: string;
  workspaceId?: string | null;
  status: string;
  archivedAt?: string | null;
  pendingPermissions?: readonly unknown[] | null;
}

export interface Failed {
  from: string | null;
  to: string | null;
  nextReset: string | null;
}

interface ApplyOptions {
  below?: Thresholds;
  sticky?: boolean;
  include?: string;
}

interface Listing {
  accounts: Account[];
  target: string;
  history: HistoryEntry[];
  placement: Placement;
}

export class AccountService {
  readonly store: Store;
  readonly usage: UsageReader;
  readonly login: LoginFlow;
  readonly rules: RulesStore;
  #history: HistoryEntry[] = [];
  #exhausted = new Map<string, number>();
  #fresh = new Set<string>();
  #logins = new Map<string, string>();
  #queue: Promise<unknown> = Promise.resolve();
  #projects: string[] = [];

  constructor(options: { store: Store; usage: UsageReader; binary: string; loginArgs?: string[] }) {
    this.store = options.store;
    this.usage = options.usage;
    this.rules = new RulesStore(join(options.store.paths.data, "state.json"));
    this.login = new LoginFlow({
      binary: options.binary,
      args: options.loginArgs,
      onAbandon: (dir) => void this.#discardFresh(dir),
    });
  }

  #exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #discardFresh(dir: string): Promise<void> {
    if (!this.#fresh.delete(dir)) return;
    await this.store.discard(dir);
  }

  #accountOfDir(dir: string, defaultAccount: string | null): string | null {
    if (dir === this.store.paths.live) return defaultAccount;
    return dirname(dir) === dirname(this.store.accountSeat("x").dir) ? basename(dir) : null;
  }

  #dirOf(id: string | null, defaultAccount: string | null): string {
    return id === null || id === defaultAccount ? this.store.paths.live : this.store.accountSeat(id).dir;
  }

  // Saves every live login into its profile and converts 1.2 project lanes into links.
  async #current(): Promise<{ placement: Placement; profiles: Profile[] }> {
    const owner = await this.store.sync();
    const defaultAccount = owner?.id ?? null;
    for (const legacy of await this.store.legacyLanes()) {
      const saved = await this.store.sync(legacy);
      if (saved !== null && saved.id !== defaultAccount) {
        await this.store.install(saved.id, this.store.accountSeat(saved.id), null);
      }
      await this.store.point(legacy.id, this.#dirOf(saved?.id ?? null, defaultAccount));
    }
    const scopes: Record<string, string> = {};
    for (const [scope, dir] of await this.store.pointers()) {
      const id = this.#accountOfDir(dir, defaultAccount);
      if (id !== null) scopes[scope] = id;
    }
    for (const id of new Set(Object.values(scopes))) {
      if (id !== defaultAccount) await this.store.sync(this.store.accountSeat(id), id);
    }
    return { placement: { default: defaultAccount, scopes }, profiles: await this.store.profiles() };
  }

  async list(options: { refresh?: boolean; now?: number } = {}): Promise<{
    accounts: Account[];
    target: string;
    history: HistoryEntry[];
  }> {
    const listing = await this.#exclusive(() => this.#listNow(options));
    return { accounts: listing.accounts, target: listing.target, history: listing.history };
  }

  async #listNow(options: { refresh?: boolean; now?: number } = {}): Promise<Listing> {
    const now = options.now ?? Date.now();
    const { placement, profiles } = await this.#current();
    let rules = await this.rules.read();
    if (rules.order.length === 0 && placement.default !== null) {
      // Start from the account already in use, so nothing switches until the user reorders.
      const first = placement.default;
      rules = await this.rules.update((next) => {
        next.order = [first, ...profiles.map((profile) => profile.id).filter((id) => id !== first)];
      });
    }
    const ranking = prioritized(
      profiles.map((profile) => profile.id),
      rules.order,
    );
    const usedBy = new Map<string, string[]>();
    for (const [scope, id] of Object.entries(placement.scopes)) {
      usedBy.set(id, [...(usedBy.get(id) ?? []), scope]);
    }
    const accounts = await Promise.all(
      profiles.map(async (profile): Promise<Account> => {
        const login = profile.login;
        const key = keyOf(profile);
        const reading = login === null ? null : await this.usage.read(key, login, { now, force: options.refresh });
        const usage = settle(reading, now);
        const until = this.#exhausted.get(key) ?? null;
        const active = profile.id === placement.default;
        const scopes = usedBy.get(profile.id) ?? [];
        const allowed = projectsOf(rules, profile.id, this.#projects);
        return {
          id: profile.id,
          email: profile.identity?.email ?? "",
          name: profile.identity?.name ?? "",
          plan: profile.identity?.plan ?? "",
          organization: profile.identity?.organization ?? "",
          status:
            login === null
              ? "no-login"
              : !active && scopes.length === 0 && login.refreshExpiresAt !== null && login.refreshExpiresAt <= now
                ? "relogin"
                : "ready",
          active,
          usedBy: active ? [] : scopes,
          priority: ranking.indexOf(profile.id) + 1,
          allowed,
          everywhere: allowed.length === this.#projects.length,
          usage,
          tokenExpiresAt: iso(login?.expiresAt ?? null),
          loginExpiresAt: iso(login?.refreshExpiresAt ?? null),
          exhaustedUntil: until !== null && until > now ? iso(until) : null,
        };
      }),
    );
    accounts.sort((a, b) => a.priority - b.priority);
    return { accounts, target: this.store.liveCredentials, history: [...this.#history], placement };
  }

  #candidates(accounts: Account[], below?: Thresholds): Candidate[] {
    return accounts.map((account) => ({
      id: account.id,
      ready: account.status === "ready",
      available:
        account.exhaustedUntil === null &&
        (below === undefined
          ? (peak(account.usage) ?? 0) < 100
          : account.usage !== null && crossed(account.usage, below) === null),
    }));
  }

  #apply(reason: SwitchReason, options: ApplyOptions = {}) {
    return this.#exclusive(() => this.#applyNow(reason, options));
  }

  // Workspaces leaving `~/.claude` move first and those arriving move last, so no chat ever reads a
  // config dir whose login is mid-change.
  async #applyNow(reason: SwitchReason, options: ApplyOptions): Promise<Placement> {
    const listing = await this.#listNow();
    const current = listing.placement;
    const rules = await this.rules.read();
    const scopes = [...new Set([...Object.keys(current.scopes), ...(options.include ? [options.include] : [])])];
    const next = plan(scopes, this.#candidates(listing.accounts, options.below), rules, current, options.sticky);
    const oldDefault = current.default;
    const newDefault = next.default ?? oldDefault;
    const live = new Set(Object.values(current.scopes).filter((id) => id !== oldDefault));
    const installed = new Set<string>();

    for (const [scope, id] of Object.entries(next.scopes)) {
      if (id === newDefault) continue;
      if (!live.has(id) && !installed.has(id)) {
        await this.store.install(id, this.store.accountSeat(id), null);
        installed.add(id);
      }
      await this.store.point(scope, this.store.accountSeat(id).dir);
    }
    if (newDefault !== null && newDefault !== oldDefault) await this.store.install(newDefault);
    await this.store.linkDefaultSettings();
    for (const [scope, id] of Object.entries(next.scopes)) {
      if (id === newDefault) await this.store.point(scope, this.store.paths.live);
    }

    // A chat may have renewed its token in the dir its account just left; carry the newest login
    // to the dir the account uses now.
    const used = new Set(Object.values(next.scopes).filter((id) => id !== newDefault));
    for (const id of live) {
      if (used.has(id)) continue;
      await this.store.sync(this.store.accountSeat(id), id);
      if (id === newDefault) await this.store.adopt(this.store.defaultSeat, id);
    }
    // The old default's profile was only brought up to date by installing the new default.
    for (const id of installed) await this.store.adopt(this.store.accountSeat(id), id);

    const after: Placement = { default: newDefault, scopes: next.scopes };
    await this.#record(reason, current, after);
    return after;
  }

  async #record(reason: SwitchReason, before: Placement, after: Placement): Promise<void> {
    const moves = new Map<string, HistoryEntry>();
    const note = (from: string | null, to: string | null, scope: string | null) => {
      if (to === null || from === to) return;
      const key = `${from ?? ""}>${to}`;
      const entry = moves.get(key) ?? {
        at: new Date().toISOString(),
        from: from ?? "",
        to,
        reason,
        resumed: 0,
        everywhere: false,
        scopes: [],
      };
      if (scope === null) entry.everywhere = true;
      else entry.scopes.push(scope);
      moves.set(key, entry);
    };
    note(before.default, after.default, null);
    for (const [scope, id] of Object.entries(after.scopes)) {
      note(before.scopes[scope] ?? before.default, id, scope);
    }
    if (moves.size === 0) return;
    const profiles = await this.store.profiles();
    for (const entry of moves.values()) {
      this.#history = [entry, ...this.#history].slice(0, HISTORY_SIZE);
      const target = profiles.find((candidate) => candidate.id === entry.to);
      if (target !== undefined) this.usage.invalidate(keyOf(target));
    }
  }

  noteResumed(to: string, count: number): void {
    const entry = this.#history.find((candidate) => candidate.to === to);
    if (entry !== undefined) entry.resumed += count;
  }

  // Sticky placement keeps workspaces on an account while it lasts; it follows "go back to
  // higher-priority accounts" being off. Editing who may use what never reshuffles other workspaces.
  #sticky = false;

  setReturnToPriority(on: boolean): void {
    this.#sticky = !on;
  }

  // "Use" puts the account first, so it serves every workspace it is allowed in. `placed` says
  // whether anything uses it right now: it may be used up, need a sign-in, or be limited elsewhere.
  async use(id: string): Promise<{ ok: true; email: string; placed: boolean } | Failure> {
    try {
      const listing = await this.list();
      const account = listing.accounts.find((candidate) => candidate.id === id);
      if (account === undefined) throw new StoreError("unknown-account", `no profile named ${id}`);
      if (account.status === "no-login") throw new StoreError("no-login", `${id} has no stored login`);
      const ids = listing.accounts.map((candidate) => candidate.id);
      await this.rules.update((rules) => void (rules.order = promote(rules.order, ids, id)));
      const after = await this.#apply("manual");
      const placed = after.default === id || Object.values(after.scopes).includes(id);
      return { ok: true, email: account.email, placed };
    } catch (error) {
      return failure(error);
    }
  }

  async reorder(ids: string[]): Promise<void> {
    await this.rules.update((rules) => void (rules.order = [...new Set(ids)]));
    await this.#apply("manual");
  }

  /** Records the projects and workspaces Paseo knows, and converts 1.2 and 1.3 rules once. */
  async know(projects: string[], workspaces: Record<string, string>): Promise<void> {
    if (projects.length > 0) this.#projects = [...projects].sort();
    const rules = await this.rules.read();
    const changed = Object.entries(workspaces).some(([id, project]) => rules.projectOf[id] !== project);
    const convertible = Object.keys(rules.legacyAllowed).length > 0 && this.#projects.length > 0;
    if (!changed && !convertible) return;
    await this.rules.update((next) => {
      next.projectOf = { ...next.projectOf, ...workspaces };
      migrate(next, this.#projects);
    });
  }

  get knowsProjects(): boolean {
    return this.#projects.length > 0;
  }

  /**
   * Which projects may use an account. `everywhere` clears every exclusion, including projects the
   * caller has not seen; otherwise only the projects in `known` are decided.
   */
  async assignProjects(
    id: string,
    projects: string[],
    options: { everywhere: boolean; known: string[] },
  ): Promise<{ ok: true } | Failure> {
    try {
      const listing = await this.list();
      if (!listing.accounts.some((account) => account.id === id)) {
        throw new StoreError("unknown-account", `no profile named ${id}`);
      }
      await this.rules.update((rules) =>
        options.everywhere ? allowEverywhere(rules, id) : setProjects(rules, id, projects, options.known),
      );
      await this.#apply("manual", { sticky: this.#sticky });
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  }

  /** The accounts one workspace may use, or `null` to follow its project. */
  async assignWorkspace(workspace: string, accounts: string[] | null): Promise<{ ok: true } | Failure> {
    try {
      await this.rules.update((rules) => {
        const rest = without(rules.workspaces, workspace);
        rules.workspaces = accounts === null || accounts.length === 0 ? rest : { ...rest, [workspace]: [...accounts] };
      });
      await this.#apply("manual", { include: workspace, sticky: this.#sticky });
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  }

  rename(id: string, name: string): Promise<{ ok: true; id: string } | Failure> {
    return this.#exclusive(async () => {
      try {
        const { placement } = await this.#current();
        const next = await this.store.rename(id, name);
        if (next !== id) {
          await this.rules.update((rules) => renameIn(rules, id, next));
          await this.store.renameAccountDir(id, next);
          for (const [scope, owner] of Object.entries(placement.scopes)) {
            if (owner === id && id !== placement.default) {
              await this.store.point(scope, this.store.accountSeat(next).dir);
            }
          }
        }
        return { ok: true as const, id: next };
      } catch (error) {
        return failure(error);
      }
    });
  }

  remove(id: string): Promise<{ ok: true; trash: string } | Failure> {
    return this.#exclusive(async () => {
      try {
        const { placement } = await this.#current();
        if (placement.default === id || Object.values(placement.scopes).includes(id)) {
          throw new StoreError("active-account", `${id} is in use`);
        }
        const trash = await this.store.remove(id);
        await this.rules.update((rules) => forget(rules, id));
        return { ok: true as const, trash };
      } catch (error) {
        return failure(error);
      }
    });
  }

  async laneFor(workspace: string | null): Promise<string | null> {
    if (workspace === null) return null;
    return this.#exclusive(async () => {
      const { placement } = await this.#current();
      if (placement.default === null) return null;
      if (placement.scopes[workspace] !== undefined) return this.store.pointer(workspace);
      const next = await this.#applyNow("manual", { include: workspace, sticky: true });
      return next.scopes[workspace] === undefined ? null : this.store.pointer(workspace);
    });
  }

  async openSession<
    Request extends { agentId: string; provider: string; workspaceId: string | null; env: Record<string, string> },
  >(request: Request, project: string | null): Promise<Request | undefined> {
    if (request.provider !== "claude" || request.env.CLAUDE_CONFIG_DIR !== undefined) return undefined;
    if (request.workspaceId !== null && project !== null) await this.know([], { [request.workspaceId]: project });
    // Without its project the workspace's rules are unknown; it is adopted once they are known.
    if (request.workspaceId !== null && (await this.rules.read()).projectOf[request.workspaceId] === undefined) {
      return undefined;
    }
    const lane = await this.laneFor(request.workspaceId);
    if (lane === null || request.workspaceId === null) return undefined;
    const scope = request.workspaceId;
    await this.rules.update((rules) => void (rules.opened = { ...rules.opened, [request.agentId]: scope }));
    return { ...request, env: { ...request.env, CLAUDE_CONFIG_DIR: lane } };
  }

  // Chats this plugin did not open since it started were opened by 1.3 through their project's
  // link when that exists.
  async scopeOfAgent(agentId: string, workspace: string | null, project: string | null): Promise<string | null> {
    const known = (await this.rules.read()).opened[agentId];
    if (known !== undefined) return known;
    const placement = await this.placement();
    if (project !== null && placement.scopes[project] !== undefined) return project;
    return workspace !== null && placement.scopes[workspace] !== undefined ? workspace : null;
  }

  placement(): Promise<Placement> {
    return this.#exclusive(async () => (await this.#current()).placement);
  }

  /**
   * Idle Claude chats whose session did not open through a workspace link: opened before 1.3, or
   * through a 1.3 project link. Reopening them once lets every later switch reach them.
   */
  async adoptable(agents: AgentSummary[]): Promise<string[]> {
    const { opened, projectOf } = await this.rules.read();
    return agents
      .filter((agent) => agent.provider === "claude" && agent.archivedAt == null)
      .filter((agent) => agent.workspaceId != null && projectOf[agent.workspaceId] !== undefined)
      .filter((agent) => agent.status === "idle" && (agent.pendingPermissions?.length ?? 0) === 0)
      .filter((agent) => opened[agent.id] === undefined)
      .map((agent) => agent.id);
  }

  /** The agents recorded as opened through a link, to compare against the daemon's full list. */
  async openedAgents(): Promise<string[]> {
    return Object.keys((await this.rules.read()).opened);
  }

  /** Drops records of `candidates` (read before listing the daemon's agents) that no longer exist. */
  async forgetAgents(candidates: string[], existing: Set<string>): Promise<void> {
    const gone = new Set(candidates.filter((id) => !existing.has(id)));
    if (gone.size === 0) return;
    await this.rules.update((rules) => {
      rules.opened = Object.fromEntries(Object.entries(rules.opened).filter(([id]) => !gone.has(id)));
    });
  }

  async markExhausted(id: string, now = Date.now()): Promise<void> {
    const profile = (await this.store.profiles()).find((candidate) => candidate.id === id);
    if (profile === undefined) return;
    const key = keyOf(profile);
    const until =
      profile.login === null ? null : fullUntil(await this.usage.read(key, profile.login, { now, force: true }));
    // A reading from an earlier window can name a reset already past; then the reset is unknown.
    const reset = until === null ? Number.NaN : Date.parse(until);
    this.#exhausted.set(key, reset > now ? reset : now + DEFAULT_EXHAUSTION_MS);
  }

  /**
   * Moves every workspace off the account a chat ran out on, as one step so no other switch can
   * land in between. `settled` sees the account the chat is on now and may answer for a switch
   * made a moment ago, in which case nothing changes.
   */
  failover(
    scope: string | null,
    sticky: boolean,
    options: { now?: number; settled?: (current: string | null) => Failed | null } = {},
  ): Promise<Failed & { before: Placement; after: Placement }> {
    const now = options.now ?? Date.now();
    return this.#exclusive(async () => {
      const on = (placement: Placement) => (scope === null ? undefined : placement.scopes[scope]) ?? placement.default;
      const before = (await this.#current()).placement;
      const from = on(before);
      const earlier = options.settled?.(from) ?? null;
      if (earlier !== null) return { ...earlier, before, after: before };
      if (from !== null) await this.markExhausted(from, now);
      const after = await this.#applyNow("limit", { sticky });
      const to = on(after);
      if (to !== null && to !== from) return { from, to, nextReset: null, before, after };
      const rules = await this.rules.read();
      const { accounts } = await this.#listNow({ now });
      const permitted = accounts.filter((account) => allows(rules, account.id, scope));
      const resets = (permitted.length > 0 ? permitted : accounts)
        .filter((account) => account.status === "ready")
        .flatMap((account) => [account.exhaustedUntil, fullUntil(account.usage)])
        .filter((value): value is string => value !== null && Date.parse(value) > now)
        .sort();
      return { from, to: null, nextReset: resets[0] ?? null, before, after };
    });
  }

  async rebalance(options: { below?: Thresholds; returnToPriority: boolean }): Promise<boolean> {
    const before = this.#history[0];
    await this.#apply(options.returnToPriority ? "priority" : "threshold", {
      below: options.below,
      sticky: !options.returnToPriority,
    });
    return this.#history[0] !== before;
  }

  async startLogin(name: string): Promise<{ ok: true; session: string; url: string; id: string } | Failure> {
    const id = slug(name);
    if (id === null) return failure(new StoreError("invalid-name", `invalid profile name: ${name}`));
    try {
      const placement = await this.placement();
      // Two logins of one account would invalidate each other's refresh token.
      if (placement.default === id || Object.values(placement.scopes).includes(id)) {
        throw new StoreError("active-account", `${id} is the account in use`);
      }
      const { dir, created } = await this.store.prepare(id);
      if (created) this.#fresh.add(dir);
      try {
        const { session, url } = await this.login.start(dir);
        this.#logins.set(session, dir);
        return { ok: true, session, url, id };
      } catch (error) {
        await this.#discardFresh(dir);
        throw error;
      }
    } catch (error) {
      return failure(error);
    }
  }

  async finishLogin(session: string, code: string): Promise<{ ok: true; id: string; email: string } | Failure> {
    const dir = this.#logins.get(session) ?? null;
    this.#logins.delete(session);
    try {
      await this.login.finish(session, code);
      const profiles = await this.store.profiles();
      const profile = profiles.find((candidate) => candidate.dir === dir);
      if (profile?.login == null) throw new LoginError("login-failed", "claude finished but stored no login");
      const twin = profiles.find(
        (candidate) =>
          candidate !== profile && candidate.identity !== null && candidate.identity.key === profile.identity?.key,
      );
      if (twin !== undefined && dir !== null && this.#fresh.has(dir)) {
        // The same account under a second name would split its tokens in two.
        await this.#discardFresh(dir);
        return { ok: false, error: "login-duplicate", detail: twin.id };
      }
      if (dir !== null) this.#fresh.delete(dir);
      return { ok: true, id: profile.id, email: profile.identity?.email ?? "" };
    } catch (error) {
      if (dir !== null) await this.#discardFresh(dir);
      return failure(error);
    }
  }

  async cancelLogin(session: string): Promise<void> {
    this.#logins.delete(session);
    const dir = this.login.cancel(session);
    if (dir !== null) await this.#discardFresh(dir);
  }

  dispose(): void {
    this.login.dispose();
  }
}
