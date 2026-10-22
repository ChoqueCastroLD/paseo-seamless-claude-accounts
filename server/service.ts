import { join } from "node:path";
import type { Account, ErrorCode, HistoryEntry, SwitchReason } from "../shared/contracts.ts";
import { slug } from "../shared/names.ts";
import { peak } from "../shared/usage.ts";
import { LoginError, LoginFlow } from "./login.ts";
import {
  choose,
  dedicated,
  eligible,
  laneProjects,
  outranks,
  prioritized,
  seatOf,
  type Candidate,
  type Placement,
} from "./policy.ts";
import { forget, renameIn, StateStore, type State } from "./state.ts";
import { DEFAULT_SEAT, Store, StoreError, type Profile } from "./store.ts";
import { fullUntil, UsageReader, type Usage } from "./usage.ts";

const HISTORY_SIZE = 20;
const DEFAULT_EXHAUSTION_MS = 60 * 60_000;

export type Failure = { ok: false; error: ErrorCode; detail: string };

export interface Thresholds {
  session: number;
  week: number;
}

export interface Listing {
  accounts: Account[];
  target: string;
  history: HistoryEntry[];
  seats: Record<string, string | null>;
}

class ServiceError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function failure(error: unknown): Failure {
  if (error instanceof StoreError || error instanceof LoginError || error instanceof ServiceError) {
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
  readonly state: StateStore;
  #history: HistoryEntry[] = [];
  #exhausted = new Map<string, number>();
  #fresh = new Set<string>();
  #logins = new Map<string, string>();

  constructor(options: { store: Store; usage: UsageReader; binary: string; loginArgs?: string[] }) {
    this.store = options.store;
    this.usage = options.usage;
    this.state = new StateStore(join(options.store.paths.data, "state.json"));
    this.login = new LoginFlow({
      binary: options.binary,
      args: options.loginArgs,
      onAbandon: (dir) => void this.#discardFresh(dir),
    });
  }

  async #discardFresh(dir: string): Promise<void> {
    if (!this.#fresh.delete(dir)) return;
    await this.store.discard(dir);
  }

  async #placement(): Promise<{ state: State; placement: Placement; profiles: Profile[] }> {
    let state = await this.state.read();
    const owner = await this.store.sync();
    for (const [project, id] of Object.entries(state.seats)) {
      if (id !== null) await this.store.sync(this.store.laneSeat(project), id);
    }
    const profiles = await this.store.profiles();
    if (state.order.length === 0 && owner !== null) {
      // Start from the account already in use, so nothing switches until the user reorders.
      const rest = profiles.map((profile) => profile.id).filter((id) => id !== owner.id);
      state = await this.state.update((next) => void (next.order = [owner.id, ...rest.sort()]));
    }
    const placement = {
      order: state.order,
      projects: state.projects,
      live: { [DEFAULT_SEAT]: owner?.id ?? null, ...state.seats },
    };
    return { state, placement, profiles };
  }

  async list(options: { refresh?: boolean; now?: number } = {}): Promise<Listing> {
    const now = options.now ?? Date.now();
    const { state, placement, profiles } = await this.#placement();
    const ranking = prioritized(
      profiles.map((profile) => profile.id),
      state.order,
    );
    const accounts = await Promise.all(
      profiles.map(async (profile): Promise<Account> => {
        const seat = seatOf(placement, profile.id);
        const login = profile.login;
        const key = keyOf(profile);
        const usage = login === null ? null : await this.usage.read(key, login, { now, force: options.refresh });
        const until = this.#exhausted.get(key) ?? null;
        return {
          id: profile.id,
          email: profile.identity?.email ?? "",
          name: profile.identity?.name ?? "",
          plan: profile.identity?.plan ?? "",
          organization: profile.identity?.organization ?? "",
          status:
            login === null
              ? "no-login"
              : seat === null && login.refreshExpiresAt !== null && login.refreshExpiresAt <= now
                ? "relogin"
                : "ready",
          active: seat === DEFAULT_SEAT,
          seat,
          priority: ranking.indexOf(profile.id) + 1,
          projects: state.projects[profile.id] ?? [],
          usage,
          tokenExpiresAt: iso(login?.expiresAt ?? null),
          loginExpiresAt: iso(login?.refreshExpiresAt ?? null),
          exhaustedUntil: until !== null && until > now ? iso(until) : null,
        };
      }),
    );
    accounts.sort((a, b) => a.priority - b.priority);
    return {
      accounts,
      target: this.store.liveCredentials,
      history: [...this.#history],
      seats: Object.fromEntries(Object.entries(placement.live).filter(([seat]) => seat !== DEFAULT_SEAT)),
    };
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

  async #placementFrom(listing: Listing): Promise<Placement> {
    const state = await this.state.read();
    const live = listing.accounts.find((account) => account.active)?.id ?? null;
    return { order: state.order, projects: state.projects, live: { [DEFAULT_SEAT]: live, ...listing.seats } };
  }

  async #install(id: string, seat: string, reason: SwitchReason, owner: string | null): Promise<Profile> {
    const target = seat === DEFAULT_SEAT ? this.store.defaultSeat : this.store.laneSeat(seat);
    const { profile, changed, from } = await this.store.install(id, target, owner);
    if (seat !== DEFAULT_SEAT) await this.state.update((state) => void (state.seats[seat] = id));
    if (changed) {
      this.#record({ at: new Date().toISOString(), seat, from: from?.id ?? "", to: id, reason, resumed: 0 });
      this.usage.invalidate(keyOf(profile));
    }
    return profile;
  }

  async use(
    id: string,
    options: { seat?: string; reason?: SwitchReason } = {},
  ): Promise<{ ok: true; email: string } | Failure> {
    try {
      const listing = await this.list();
      const placement = await this.#placementFrom(listing);
      const account = listing.accounts.find((candidate) => candidate.id === id);
      if (account === undefined) throw new StoreError("unknown-account", `no profile named ${id}`);
      const seat =
        options.seat ??
        (dedicated(placement, id) ? (account.seat ?? placement.projects[id]?.[0] ?? DEFAULT_SEAT) : DEFAULT_SEAT);
      const ids = listing.accounts.map((candidate) => candidate.id);
      if (!eligible(seat, ids, placement).includes(id)) {
        throw new ServiceError("not-allowed", `${id} is not allowed in ${seat}`);
      }
      const elsewhere = seatOf(placement, id);
      if (elsewhere !== null && elsewhere !== seat) {
        const others = this.#candidates(listing.accounts).filter((candidate) => candidate.id !== id);
        const replacement = choose(elsewhere, others, placement);
        if (replacement === null) throw new ServiceError("busy-elsewhere", elsewhere);
        await this.#install(replacement, elsewhere, options.reason ?? "manual", id);
        placement.live[elsewhere] = replacement;
      }
      const profile = await this.#install(id, seat, options.reason ?? "manual", placement.live[seat] ?? null);
      return { ok: true, email: profile.identity?.email ?? "" };
    } catch (error) {
      return failure(error);
    }
  }

  #record(entry: HistoryEntry): void {
    this.#history = [entry, ...this.#history].slice(0, HISTORY_SIZE);
  }

  noteResumed(seat: string, to: string, count: number): void {
    const entry = this.#history.find((candidate) => candidate.seat === seat && candidate.to === to);
    if (entry !== undefined) entry.resumed += count;
  }

  async reorder(ids: string[]): Promise<void> {
    await this.state.update((state) => {
      state.order = [...new Set(ids)];
    });
  }

  async assignProjects(id: string, projects: string[]): Promise<{ ok: true } | Failure> {
    try {
      const listing = await this.list();
      if (!listing.accounts.some((account) => account.id === id)) {
        throw new StoreError("unknown-account", `no profile named ${id}`);
      }
      const next = [...new Set(projects)].sort();
      await this.state.update((state) => {
        state.projects = Object.fromEntries(Object.entries(state.projects).filter(([entry]) => entry !== id));
        if (next.length > 0) state.projects[id] = next;
      });
      // A newly dedicated account cannot stay in the shared seat.
      const account = listing.accounts.find((candidate) => candidate.id === id);
      if (next.length > 0 && account?.active) {
        const placement = await this.#placementFrom(listing);
        placement.projects[id] = next;
        const others = this.#candidates(listing.accounts).filter((candidate) => candidate.id !== id);
        const replacement = choose(DEFAULT_SEAT, others, placement);
        if (replacement !== null) await this.#install(replacement, DEFAULT_SEAT, "manual", null);
      }
      await this.reconcile();
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  }

  async rename(id: string, name: string): Promise<{ ok: true; id: string } | Failure> {
    try {
      const next = await this.store.rename(id, name);
      await this.state.update((state) => renameIn(state, id, next));
      return { ok: true, id: next };
    } catch (error) {
      return failure(error);
    }
  }

  async remove(id: string): Promise<{ ok: true; trash: string } | Failure> {
    try {
      const state = await this.state.read();
      if (Object.values(state.seats).includes(id)) throw new StoreError("active-account", `${id} is in use`);
      const trash = await this.store.remove(id);
      await this.state.update((next) => forget(next, id));
      return { ok: true, trash };
    } catch (error) {
      return failure(error);
    }
  }

  async reconcile(): Promise<void> {
    const listing = await this.list();
    const placement = await this.#placementFrom(listing);
    const state = await this.state.read();
    const lanes = new Set(laneProjects(placement));
    const attached = new Set(Object.values(state.agents));
    const candidates = this.#candidates(listing.accounts);

    for (const [project, owner] of Object.entries(state.seats)) {
      const inUse = attached.has(project);
      const keeps = owner !== null && (inUse || placement.projects[owner]?.includes(project));
      if (owner !== null && !keeps) {
        await this.store.release(this.store.laneSeat(project), owner);
        placement.live[project] = null;
      }
      if (!lanes.has(project) && !inUse) {
        await this.state.update((next) => {
          next.seats = Object.fromEntries(Object.entries(next.seats).filter(([entry]) => entry !== project));
        });
        placement.live[project] = null;
      } else if (!keeps) {
        await this.state.update((next) => void (next.seats[project] = null));
      }
    }

    for (const project of lanes) {
      if (placement.live[project]) continue;
      const own = choose(project, candidates, placement);
      if (own !== null && placement.projects[own]?.includes(project)) {
        await this.#install(own, project, "manual", null);
        placement.live[project] = own;
      }
    }
  }

  async laneFor(project: string | null): Promise<string | null> {
    if (project === null) return null;
    const listing = await this.list();
    const placement = await this.#placementFrom(listing);
    if (!laneProjects(placement).includes(project)) return null;
    if (!placement.live[project]) {
      const next = choose(project, this.#candidates(listing.accounts), placement);
      if (next === null) return null;
      await this.#install(next, project, "manual", null);
    }
    return this.store.laneSeat(project).dir;
  }

  async openSession<Request extends { agentId: string; provider: string; env: Record<string, string> }>(
    request: Request,
    project: string | null,
  ): Promise<Request | undefined> {
    if (request.provider !== "claude" || request.env.CLAUDE_CONFIG_DIR !== undefined) return undefined;
    const lane = await this.laneFor(project);
    if (lane === null || project === null) return undefined;
    await this.attach(request.agentId, project);
    return { ...request, env: { ...request.env, CLAUDE_CONFIG_DIR: lane } };
  }

  async attach(agentId: string, project: string): Promise<void> {
    await this.state.update((state) => void (state.agents[agentId] = project));
  }

  async detach(agentIds: string[]): Promise<void> {
    const state = await this.state.read();
    if (!agentIds.some((id) => state.agents[id] !== undefined)) return;
    await this.state.update((next) => {
      next.agents = Object.fromEntries(Object.entries(next.agents).filter(([id]) => !agentIds.includes(id)));
    });
    await this.reconcile();
  }

  async prune(known: Set<string>): Promise<void> {
    const state = await this.state.read();
    await this.detach(Object.keys(state.agents).filter((id) => !known.has(id)));
  }

  async seatOfAgent(agentId: string): Promise<string> {
    return (await this.state.read()).agents[agentId] ?? DEFAULT_SEAT;
  }

  async current(seat: string): Promise<{ id: string; key: string } | null> {
    const { placement, profiles } = await this.#placement();
    const profile = profiles.find((candidate) => candidate.id === placement.live[seat]);
    return profile === undefined ? null : { id: profile.id, key: keyOf(profile) };
  }

  async markExhausted(id: string, now = Date.now()): Promise<void> {
    const profile = (await this.store.profiles()).find((candidate) => candidate.id === id);
    if (profile === undefined) return;
    const key = keyOf(profile);
    const until =
      profile.login === null ? null : fullUntil(await this.usage.read(key, profile.login, { now, force: true }));
    this.#exhausted.set(key, until === null ? now + DEFAULT_EXHAUSTION_MS : Date.parse(until));
  }

  async pickNext(
    seat: string = DEFAULT_SEAT,
    options: { below?: Thresholds; now?: number } = {},
  ): Promise<{ id: string | null; nextReset: string | null }> {
    const now = options.now ?? Date.now();
    const listing = await this.list({ now });
    const placement = await this.#placementFrom(listing);
    const current = placement.live[seat] ?? null;
    const candidates = this.#candidates(listing.accounts, options.below).filter((c) => c.id !== current);
    const ids = new Set(
      eligible(
        seat,
        listing.accounts.map((account) => account.id),
        placement,
      ),
    );
    const resets = listing.accounts
      .filter((account) => ids.has(account.id))
      .flatMap((account) => [account.exhaustedUntil, fullUntil(account.usage)])
      .filter((value): value is string => value !== null && Date.parse(value) > now)
      .sort();
    return { id: choose(seat, candidates, placement), nextReset: resets[0] ?? null };
  }

  async rebalance(options: { below?: Thresholds; returnToPriority: boolean }): Promise<string[]> {
    const listing = await this.list();
    const placement = await this.#placementFrom(listing);
    const state = await this.state.read();
    const attached = new Set(Object.values(state.agents));
    const ids = listing.accounts.map((account) => account.id);
    const changed: string[] = [];
    const seats = [DEFAULT_SEAT, ...Object.keys(listing.seats).filter((seat) => attached.has(seat))];
    for (const seat of seats) {
      const current = placement.live[seat] ?? null;
      const candidates = this.#candidates(listing.accounts, options.below);
      const best = choose(seat, candidates, placement);
      if (best === null || best === current) continue;
      const unfit = current !== null && !candidates.find((candidate) => candidate.id === current)?.available;
      const better = options.returnToPriority && outranks(seat, best, current, ids, placement);
      if (!unfit && !better) continue;
      await this.#install(best, seat, unfit ? "threshold" : "priority", current);
      placement.live[seat] = best;
      changed.push(seat);
    }
    return changed;
  }

  async startLogin(name: string): Promise<{ ok: true; session: string; url: string; id: string } | Failure> {
    const id = slug(name);
    if (id === null) return failure(new StoreError("invalid-name", `invalid profile name: ${name}`));
    try {
      const { placement } = await this.#placement();
      // Two logins of one account would invalidate each other's refresh token.
      if (seatOf(placement, id) !== null) throw new StoreError("active-account", `${id} is the account in use`);
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
