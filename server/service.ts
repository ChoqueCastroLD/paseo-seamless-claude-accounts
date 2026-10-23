import { basename, dirname, join } from "node:path";
import type { Account, ErrorCode, HistoryEntry, SwitchReason } from "../shared/contracts.ts";
import { slug } from "../shared/names.ts";
import { peak } from "../shared/usage.ts";
import { LoginError, LoginFlow } from "./login.ts";
import { plan, prioritized, promote, type Candidate, type Placement } from "./policy.ts";
import { forget, renameIn, RulesStore } from "./state.ts";
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
    const projects: Record<string, string> = {};
    for (const [project, dir] of await this.store.pointers()) {
      const id = this.#accountOfDir(dir, defaultAccount);
      if (id !== null) projects[project] = id;
    }
    for (const id of new Set(Object.values(projects))) {
      if (id !== defaultAccount) await this.store.sync(this.store.accountSeat(id), id);
    }
    return { placement: { default: defaultAccount, projects }, profiles: await this.store.profiles() };
  }

  async list(options: { refresh?: boolean; now?: number } = {}): Promise<{
    accounts: Account[];
    target: string;
    history: HistoryEntry[];
  }> {
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
    for (const [project, id] of Object.entries(placement.projects)) {
      usedBy.set(id, [...(usedBy.get(id) ?? []), project]);
    }
    const accounts = await Promise.all(
      profiles.map(async (profile): Promise<Account> => {
        const login = profile.login;
        const key = keyOf(profile);
        const usage = login === null ? null : await this.usage.read(key, login, { now, force: options.refresh });
        const until = this.#exhausted.get(key) ?? null;
        const active = profile.id === placement.default;
        const projects = usedBy.get(profile.id) ?? [];
        return {
          id: profile.id,
          email: profile.identity?.email ?? "",
          name: profile.identity?.name ?? "",
          plan: profile.identity?.plan ?? "",
          organization: profile.identity?.organization ?? "",
          status:
            login === null
              ? "no-login"
              : !active && projects.length === 0 && login.refreshExpiresAt !== null && login.refreshExpiresAt <= now
                ? "relogin"
                : "ready",
          active,
          usedBy: active ? [] : projects,
          priority: ranking.indexOf(profile.id) + 1,
          allowed: rules.allowed[profile.id] ?? [],
          usage,
          tokenExpiresAt: iso(login?.expiresAt ?? null),
          loginExpiresAt: iso(login?.refreshExpiresAt ?? null),
          exhaustedUntil: until !== null && until > now ? iso(until) : null,
        };
      }),
    );
    accounts.sort((a, b) => a.priority - b.priority);
    return { accounts, target: this.store.liveCredentials, history: [...this.#history] };
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

  // Projects leaving `~/.claude` move first and those arriving move last, so no chat ever reads a
  // config dir whose login is mid-change.
  #apply(reason: SwitchReason, options: { below?: Thresholds; sticky?: boolean; include?: string } = {}) {
    return this.#exclusive(async () => {
      const listing = await this.list();
      const { placement: current } = await this.#current();
      const rules = await this.rules.read();
      const projects = [...new Set([...Object.keys(current.projects), ...(options.include ? [options.include] : [])])];
      const next = plan(projects, this.#candidates(listing.accounts, options.below), rules, current, options.sticky);
      const oldDefault = current.default;
      const newDefault = next.default ?? oldDefault;
      const live = new Set(Object.values(current.projects).filter((id) => id !== oldDefault));

      for (const [project, id] of Object.entries(next.projects)) {
        if (id === newDefault) continue;
        if (!live.has(id)) {
          await this.store.install(id, this.store.accountSeat(id), null);
          live.add(id);
        }
        await this.store.point(project, this.store.accountSeat(id).dir);
      }
      if (newDefault !== null && newDefault !== oldDefault) await this.store.install(newDefault);
      await this.store.linkDefaultSettings();
      for (const [project, id] of Object.entries(next.projects)) {
        if (id === newDefault) await this.store.point(project, this.store.paths.live);
      }

      const after: Placement = { default: newDefault, projects: next.projects };
      await this.#record(reason, current, after);
      return after;
    });
  }

  async #record(reason: SwitchReason, before: Placement, after: Placement): Promise<void> {
    const moves = new Map<string, HistoryEntry>();
    const note = (from: string | null, to: string | null, project: string | null) => {
      if (to === null || from === to) return;
      const key = `${from ?? ""}>${to}`;
      const entry = moves.get(key) ?? {
        at: new Date().toISOString(),
        from: from ?? "",
        to,
        reason,
        resumed: 0,
        everywhere: false,
        projects: [],
      };
      if (project === null) entry.everywhere = true;
      else entry.projects.push(project);
      moves.set(key, entry);
    };
    note(before.default, after.default, null);
    for (const [project, id] of Object.entries(after.projects)) {
      note(before.projects[project] ?? before.default, id, project);
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

  // "Use" puts the account first, so it serves every project it is allowed in.
  async use(id: string): Promise<{ ok: true; email: string } | Failure> {
    try {
      const listing = await this.list();
      const account = listing.accounts.find((candidate) => candidate.id === id);
      if (account === undefined) throw new StoreError("unknown-account", `no profile named ${id}`);
      if (account.status === "no-login") throw new StoreError("no-login", `${id} has no stored login`);
      const ids = listing.accounts.map((candidate) => candidate.id);
      await this.rules.update((rules) => void (rules.order = promote(rules.order, ids, id)));
      await this.#apply("manual");
      return { ok: true, email: account.email };
    } catch (error) {
      return failure(error);
    }
  }

  async reorder(ids: string[]): Promise<void> {
    await this.rules.update((rules) => void (rules.order = [...new Set(ids)]));
    await this.#apply("manual");
  }

  // A limited account moves to the front: it competes nowhere else, so its projects spend it first.
  async assignProjects(id: string, projects: string[]): Promise<{ ok: true } | Failure> {
    try {
      const listing = await this.list();
      if (!listing.accounts.some((account) => account.id === id)) {
        throw new StoreError("unknown-account", `no profile named ${id}`);
      }
      const ids = listing.accounts.map((account) => account.id);
      const next = [...new Set(projects)].sort();
      await this.rules.update((rules) => {
        rules.allowed = Object.fromEntries(Object.entries(rules.allowed).filter(([entry]) => entry !== id));
        if (next.length > 0) {
          rules.allowed[id] = next;
          rules.order = promote(rules.order, ids, id);
        }
      });
      await this.#apply("manual");
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  }

  async rename(id: string, name: string): Promise<{ ok: true; id: string } | Failure> {
    try {
      const { placement } = await this.#current();
      const next = await this.store.rename(id, name);
      if (next !== id) {
        await this.rules.update((rules) => renameIn(rules, id, next));
        await this.store.renameAccountDir(id, next);
        for (const [project, owner] of Object.entries(placement.projects)) {
          if (owner === id && id !== placement.default) {
            await this.store.point(project, this.store.accountSeat(next).dir);
          }
        }
      }
      return { ok: true, id: next };
    } catch (error) {
      return failure(error);
    }
  }

  async remove(id: string): Promise<{ ok: true; trash: string } | Failure> {
    try {
      const { placement } = await this.#current();
      if (Object.values(placement.projects).includes(id)) {
        throw new StoreError("active-account", `${id} is in use`);
      }
      const trash = await this.store.remove(id);
      await this.rules.update((rules) => forget(rules, id));
      return { ok: true, trash };
    } catch (error) {
      return failure(error);
    }
  }

  async laneFor(project: string | null): Promise<string | null> {
    if (project === null) return null;
    const { placement } = await this.#current();
    if (placement.default === null) return null;
    if (placement.projects[project] === undefined) {
      await this.#apply("manual", { include: project, sticky: true });
    }
    return this.store.pointer(project);
  }

  async openSession<Request extends { provider: string; env: Record<string, string> }>(
    request: Request,
    project: string | null,
  ): Promise<Request | undefined> {
    if (request.provider !== "claude" || request.env.CLAUDE_CONFIG_DIR !== undefined) return undefined;
    const lane = await this.laneFor(project);
    if (lane === null) return undefined;
    return { ...request, env: { ...request.env, CLAUDE_CONFIG_DIR: lane } };
  }

  async placement(): Promise<Placement> {
    return (await this.#current()).placement;
  }

  async accountFor(project: string | null): Promise<string | null> {
    const { placement } = await this.#current();
    return (project === null ? null : placement.projects[project]) ?? placement.default;
  }

  async markExhausted(id: string, now = Date.now()): Promise<void> {
    const profile = (await this.store.profiles()).find((candidate) => candidate.id === id);
    if (profile === undefined) return;
    const key = keyOf(profile);
    const until =
      profile.login === null ? null : fullUntil(await this.usage.read(key, profile.login, { now, force: true }));
    this.#exhausted.set(key, until === null ? now + DEFAULT_EXHAUSTION_MS : Date.parse(until));
  }

  async failover(
    project: string | null,
    sticky: boolean,
    now = Date.now(),
  ): Promise<{ from: string | null; to: string | null; nextReset: string | null }> {
    const from = await this.accountFor(project);
    if (from !== null) await this.markExhausted(from, now);
    const placement = await this.#apply("limit", { sticky });
    const to = (project === null ? null : placement.projects[project]) ?? placement.default;
    if (to !== null && to !== from) return { from, to, nextReset: null };
    const { accounts } = await this.list({ now });
    const resets = accounts
      .flatMap((account) => [account.exhaustedUntil, fullUntil(account.usage)])
      .filter((value): value is string => value !== null && Date.parse(value) > now)
      .sort();
    return { from, to: null, nextReset: resets[0] ?? null };
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
      const { placement } = await this.#current();
      // Two logins of one account would invalidate each other's refresh token.
      if (placement.default === id || Object.values(placement.projects).includes(id)) {
        throw new StoreError("active-account", `${id} is the account in use`);
      }
      const existing = (await this.store.profiles()).find((profile) => profile.id === id);
      const dir = await this.store.prepare(id);
      if (existing === undefined) this.#fresh.add(dir);
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
