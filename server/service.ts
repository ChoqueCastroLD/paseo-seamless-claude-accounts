import { join } from "node:path";
import type { Account, ErrorCode, HistoryEntry } from "../shared/contracts.ts";
import { LoginError, LoginFlow } from "./login.ts";
import { slug } from "../shared/names.ts";
import { parseIdentity, Store, StoreError, type Profile } from "./store.ts";
import { peak } from "../shared/usage.ts";
import { fullUntil, UsageReader, type Usage } from "./usage.ts";

const HISTORY_SIZE = 20;
/** How long an account that hit a limit is skipped when its reset time is unknown. */
const DEFAULT_EXHAUSTION_MS = 60 * 60_000;

export type Failure = { ok: false; error: ErrorCode; detail: string };

function failure(error: unknown): Failure {
  if (error instanceof StoreError || error instanceof LoginError) {
    return { ok: false, error: error.code, detail: error.message };
  }
  return { ok: false, error: "io", detail: error instanceof Error ? error.message : String(error) };
}

/** The cache key of an account: who it is, or where it lives while that is unknown. */
function keyOf(profile: Profile): string {
  return profile.identity?.key ?? `dir:${profile.id}`;
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

export class AccountService {
  readonly store: Store;
  readonly usage: UsageReader;
  readonly login: LoginFlow;
  #history: HistoryEntry[] = [];
  /** Account key to the instant it may be picked again after hitting a limit. */
  #exhausted = new Map<string, number>();
  /** Directories made for a login in progress, which are ours to delete if it fails. */
  #fresh = new Set<string>();
  /** Login session to the profile directory it signs in. */
  #logins = new Map<string, string>();

  constructor(options: { store: Store; usage: UsageReader; binary: string; loginArgs?: string[] }) {
    this.store = options.store;
    this.usage = options.usage;
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

  /** Every account with its allowance. Saves the live login into its profile on the way. */
  async list(options: { refresh?: boolean; now?: number } = {}): Promise<{ accounts: Account[]; target: string; history: HistoryEntry[] }> {
    const now = options.now ?? Date.now();
    const active = await this.store.sync();
    const profiles = await this.store.profiles();
    const accounts = await Promise.all(
      profiles.map(async (profile): Promise<Account> => {
        const isActive = active !== null && profile.id === active.id;
        // The active profile was just synced, so its login is the one Claude Code holds.
        const login = isActive ? active.login : profile.login;
        const identity = profile.identity ?? (isActive ? active.identity : null);
        const key = keyOf({ ...profile, identity });
        let usage: Usage | null = null;
        if (login !== null) usage = await this.usage.read(key, login, { now, force: options.refresh });
        const until = this.#exhausted.get(key) ?? null;
        return {
          id: profile.id,
          email: identity?.email ?? "",
          name: identity?.name ?? "",
          plan: identity?.plan ?? "",
          organization: identity?.organization ?? "",
          status:
            login === null ? "no-login" : !isActive && login.refreshExpiresAt !== null && login.refreshExpiresAt <= now ? "relogin" : "ready",
          active: isActive,
          usage,
          tokenExpiresAt: iso(login?.expiresAt ?? null),
          loginExpiresAt: iso(login?.refreshExpiresAt ?? null),
          exhaustedUntil: until !== null && until > now ? iso(until) : null,
        };
      }),
    );
    // Active first, then by most allowance left, so the next pick is the second card.
    accounts.sort((a, b) => Number(b.active) - Number(a.active) || rank(a, now) - rank(b, now) || a.id.localeCompare(b.id));
    return { accounts, target: this.store.liveCredentials, history: [...this.#history] };
  }

  async use(id: string, reason: HistoryEntry["reason"] = "manual", resumed = 0): Promise<{ ok: true; email: string } | Failure> {
    try {
      const { profile, changed, from } = await this.store.use(id);
      if (changed) {
        this.#record({ at: new Date().toISOString(), from: from?.id ?? "", to: profile.id, reason, resumed });
        this.usage.invalidate(keyOf(profile));
      }
      return { ok: true, email: profile.identity?.email ?? "" };
    } catch (error) {
      return failure(error);
    }
  }

  #record(entry: HistoryEntry): void {
    this.#history = [entry, ...this.#history].slice(0, HISTORY_SIZE);
  }

  /** Notes how many chats an automatic switch resumed, once they have been. */
  noteResumed(to: string, count: number): void {
    const entry = this.#history.find((candidate) => candidate.to === to && candidate.reason !== "manual");
    if (entry !== undefined) entry.resumed += count;
  }

  async rename(id: string, name: string): Promise<{ ok: true; id: string } | Failure> {
    try {
      return { ok: true, id: await this.store.rename(id, name) };
    } catch (error) {
      return failure(error);
    }
  }

  async remove(id: string): Promise<{ ok: true; trash: string } | Failure> {
    try {
      return { ok: true, trash: await this.store.remove(id) };
    } catch (error) {
      return failure(error);
    }
  }

  /**
   * Starts a login. `name` is an existing profile to sign in again, or a name for a new one.
   * Nothing touches the live login: a new account is only used once the user picks it.
   */
  async startLogin(name: string): Promise<{ ok: true; session: string; url: string; id: string } | Failure> {
    const id = slug(name);
    if (id === null) return failure(new StoreError("invalid-name", `invalid profile name: ${name}`));
    try {
      const active = await this.store.sync();
      // Signing the live profile in again would leave two logins of one account fighting over
      // the refresh token. Switch away first.
      if (active?.id === id) throw new StoreError("active-account", `${id} is the account in use`);
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
      const twin = profiles.find((candidate) => candidate !== profile && candidate.identity !== null && candidate.identity.key === profile.identity?.key);
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

  /** The account Claude Code uses right now, by key and id. */
  async live(): Promise<{ id: string; key: string } | null> {
    const profile = await this.store.sync();
    return profile === null ? null : { id: profile.id, key: keyOf(profile) };
  }

  /**
   * Marks the live account as used up. The reset instant comes from a fresh reading when the
   * endpoint answers, else a fixed wait.
   */
  async markExhausted(key: string, now = Date.now()): Promise<void> {
    const live = await this.store.live();
    let until: string | null = null;
    if (live.login !== null && parseIdentity(live.block)?.key === key) {
      until = fullUntil(await this.usage.read(key, live.login, { now, force: true }));
    }
    this.#exhausted.set(key, until === null ? now + DEFAULT_EXHAUSTION_MS : Date.parse(until));
  }

  /**
   * The account to move to: ready, not the live one, not used up, and with the most allowance
   * left. `below` additionally requires a known reading under both thresholds, so a preemptive
   * switch never lands on an account that would trip them straight away.
   */
  async pickNext(options: { below?: Thresholds; now?: number } = {}): Promise<{ id: string | null; nextReset: string | null }> {
    const now = options.now ?? Date.now();
    const { accounts } = await this.list({ now });
    const below = options.below;
    const candidates = accounts.filter((account) => {
      if (account.active || account.status !== "ready" || account.exhaustedUntil !== null) return false;
      if (below !== undefined) return account.usage !== null && crossed(account.usage, below) === null;
      const used = peak(account.usage);
      return used === null || used < 100;
    });
    const resets = accounts
      .flatMap((account) => [account.exhaustedUntil, fullUntil(account.usage)])
      .filter((value): value is string => value !== null && Date.parse(value) > now)
      .sort();
    return { id: candidates[0]?.id ?? null, nextReset: resets[0] ?? null };
  }

  dispose(): void {
    this.login.dispose();
  }
}

export interface Thresholds {
  session: number;
  week: number;
}

/** Which threshold a reading has reached, checking the 5-hour window first, or null. */
export function crossed(usage: Usage, limits: Thresholds): "session" | "week" | null {
  if (usage.fiveHour !== null && usage.fiveHour.percent >= limits.session) return "session";
  if (usage.week !== null && usage.week.percent >= limits.week) return "week";
  return null;
}

/** Lower is a better account to move to. Unknown readings sort after healthy known ones. */
function rank(account: Account, now: number): number {
  if (account.status !== "ready") return 1_000;
  if (account.exhaustedUntil !== null && Date.parse(account.exhaustedUntil) > now) return 500;
  return peak(account.usage) ?? 80;
}

export function cacheFile(home: string): string {
  return join(home, ".cache", "seamless-claude-accounts", "usage.json");
}
