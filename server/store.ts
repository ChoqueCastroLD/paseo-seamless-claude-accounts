import { randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { PROFILE_NAME, slug } from "../shared/names.ts";

/**
 * Claude Code logins kept as `~/.claude-<id>` profiles, and the one live login they are copied
 * into. Switching rewrites the live credential file, exactly as `claude login` does, so every
 * open session picks the new account on its next request without restarting.
 *
 * Every login always has a profile: the live one is saved back into its own before anything
 * replaces it. That is what keeps a token Claude Code rotated while it was live from being lost,
 * and what makes switching back one click without a new login.
 */

export interface StorePaths {
  home: string;
  /** Directory whose `.credentials.json` Claude Code reads. `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
  live: string;
  /** File holding the live `oauthAccount` block: `~/.claude.json`, or inside a custom config dir. */
  liveSettings: string;
  /** Where removed profiles are moved. */
  trash: string;
}

export function pathsFor(home: string, env: Record<string, string | undefined> = {}): StorePaths {
  const custom = env.CLAUDE_CONFIG_DIR;
  const live = custom === undefined || custom === "" ? join(home, ".claude") : custom;
  return {
    home,
    live,
    liveSettings: live === join(home, ".claude") ? join(home, ".claude.json") : join(live, ".claude.json"),
    trash: join(home, ".local", "share", "seamless-claude-accounts", "trash"),
  };
}

/** The OAuth part of `.credentials.json`. Only the fields this plugin reasons about. */
export interface Login {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms, or null when the file does not say. */
  expiresAt: number | null;
  refreshExpiresAt: number | null;
}

/** Who a login belongs to, from the `oauthAccount` block Claude Code caches beside it. */
export interface Identity {
  email: string;
  name: string;
  plan: string;
  organization: string;
  /** Account and organization uuids: one person can sit in several organizations. */
  key: string;
}

export interface Profile {
  id: string;
  dir: string;
  login: Login | null;
  identity: Identity | null;
}

export type StoreErrorCode = "unknown-account" | "no-login" | "invalid-login" | "invalid-name" | "name-taken" | "active-account";

export class StoreError extends Error {
  readonly code: StoreErrorCode;

  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** A profile directory: `.claude-` then a name. `.claude.json` and `.claude` itself are not. */
const PROFILE_DIR = /^\.claude-([a-z0-9][a-z0-9_-]{0,47})$/i;
export function profileDir(paths: StorePaths, id: string): string {
  return join(paths.home, `.claude-${id}`);
}

export function parseLogin(raw: string): Login | null {
  try {
    const oauth = (JSON.parse(raw) as { claudeAiOauth?: Record<string, unknown> }).claudeAiOauth;
    if (typeof oauth?.accessToken !== "string" || oauth.accessToken === "") return null;
    return {
      accessToken: oauth.accessToken,
      refreshToken: typeof oauth.refreshToken === "string" ? oauth.refreshToken : "",
      expiresAt: epoch(oauth.expiresAt),
      refreshExpiresAt: epoch(oauth.refreshTokenExpiresAt),
    };
  } catch {
    return null;
  }
}

function epoch(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

export function parseIdentity(block: unknown): Identity | null {
  if (typeof block !== "object" || block === null) return null;
  const account = block as Record<string, unknown>;
  const text = (key: string) => (typeof account[key] === "string" ? (account[key] as string) : "");
  const email = text("emailAddress");
  const user = text("accountUuid");
  if (email === "" && user === "") return null;
  return {
    email,
    name: text("displayName") || text("fullName"),
    plan: text("organizationType"),
    organization: text("organizationName"),
    key: user === "" ? `email:${email.toLowerCase()}` : `${user}/${text("organizationUuid")}`,
  };
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  const raw = await readText(path);
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Replaces a file so no reader ever sees half of it. Keeps the mode of the file it replaces,
 * never looser than `mode`, because these files hold tokens.
 */
export async function writeAtomic(path: string, body: string, mode = 0o600): Promise<void> {
  const previous = await stat(path).then((info) => info.mode & 0o777, () => mode);
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(temp, body, { mode: previous & mode, flag: "wx" });
    await chmod(temp, previous & mode);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** Rewrites only the `oauthAccount` key of a settings file, keeping everything else as it was. */
async function writeAccountBlock(path: string, block: unknown): Promise<void> {
  const raw = await readText(path);
  let settings: Record<string, unknown> = {};
  if (raw !== null) {
    try {
      settings = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Not ours to repair. The login switched; only the displayed address stays stale.
      return;
    }
  }
  settings.oauthAccount = block;
  await writeAtomic(path, `${JSON.stringify(settings, null, 2)}\n`);
}

export class Store {
  /** Every mutation runs alone, so two quick clicks cannot interleave their writes. */
  #queue: Promise<unknown> = Promise.resolve();
  readonly paths: StorePaths;

  constructor(paths: StorePaths) {
    this.paths = paths;
  }

  get liveCredentials(): string {
    return join(this.paths.live, ".credentials.json");
  }

  #exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #read(dir: string, settingsPath: string): Promise<{ raw: string | null; login: Login | null; identity: Identity | null; block: unknown }> {
    const raw = await readText(join(dir, ".credentials.json"));
    const block = (await readJson(settingsPath))?.oauthAccount;
    return { raw, login: raw === null ? null : parseLogin(raw), identity: parseIdentity(block), block };
  }

  async live(): Promise<{ raw: string | null; login: Login | null; identity: Identity | null; block: unknown }> {
    return this.#read(this.paths.live, this.paths.liveSettings);
  }

  /**
   * Every `~/.claude-<id>` directory that is a Claude Code config dir: it holds a login, or the
   * `.claude.json` a login in progress leaves behind.
   */
  async profiles(): Promise<Profile[]> {
    const names = await readdir(this.paths.home).catch(() => [] as string[]);
    const profiles: Profile[] = [];
    for (const name of names.sort()) {
      const match = PROFILE_DIR.exec(name);
      if (match === null) continue;
      const dir = join(this.paths.home, name);
      if (dir === this.paths.live) continue;
      const hasLogin = await exists(join(dir, ".credentials.json"));
      if (!hasLogin && !(await exists(join(dir, ".claude.json")))) continue;
      const read = await this.#read(dir, join(dir, ".claude.json"));
      profiles.push({ id: match[1]!.toLowerCase(), dir, login: read.login, identity: read.identity });
    }
    return profiles;
  }

  /**
   * Saves the live login into its profile. Claude Code renews tokens in the live file only, and
   * a renewal retires the previous refresh token, so a profile that is not kept in step goes
   * stale and needs a new login. Creates the profile when the live login has none.
   */
  sync(): Promise<Profile | null> {
    return this.#exclusive(() => this.#sync());
  }

  async #sync(): Promise<Profile | null> {
    const live = await this.live();
    const login = live.login;
    if (live.raw === null || login === null) return null;
    const profiles = await this.profiles();
    const owner =
      profiles.find((profile) => live.identity !== null && profile.identity?.key === live.identity.key) ??
      profiles.find((profile) => profile.login !== null && profile.login.refreshToken === login.refreshToken);

    if (owner === undefined) {
      const id = await this.#freeName(live.identity?.email.split("@")[0] ?? "", profiles);
      const dir = profileDir(this.paths, id);
      await mkdir(dir, { mode: 0o700, recursive: true });
      await writeAtomic(join(dir, ".credentials.json"), live.raw);
      if (live.block !== undefined) await writeAccountBlock(join(dir, ".claude.json"), live.block);
      return { id, dir, login, identity: live.identity };
    }

    // Copy only forward in time: a profile someone logged into again holds a newer login than
    // the live one, and must not be overwritten with the older.
    const stored = owner.login;
    const newer = stored === null || (login.expiresAt ?? 0) >= (stored.expiresAt ?? 0);
    if (newer && (stored?.accessToken !== login.accessToken || stored?.refreshToken !== login.refreshToken)) {
      await writeAtomic(join(owner.dir, ".credentials.json"), live.raw);
    }
    if (live.block !== undefined && owner.identity === null) {
      await writeAccountBlock(join(owner.dir, ".claude.json"), live.block);
    }
    return { ...owner, login: newer ? login : stored, identity: owner.identity ?? live.identity };
  }

  async #freeName(base: string, profiles: Profile[]): Promise<string> {
    const root = slug(base) ?? "account";
    const taken = new Set(profiles.map((profile) => profile.id));
    for (let n = 1; ; n += 1) {
      const name = n === 1 ? root : `${root}-${n}`;
      if (!taken.has(name) && !(await exists(profileDir(this.paths, name)))) return name;
    }
  }

  /**
   * Makes a profile the live login. The current live login is saved into its own profile first,
   * then the credential file is replaced in one rename. Returns the identity now live.
   */
  use(id: string): Promise<{ profile: Profile; changed: boolean; from: Profile | null }> {
    return this.#exclusive(async () => {
      const from = await this.#sync();
      const profile = (await this.profiles()).find((candidate) => candidate.id === id);
      if (profile === undefined) throw new StoreError("unknown-account", `no profile named ${id}`);
      if (from?.id === profile.id) return { profile, changed: false, from };

      const raw = await readText(join(profile.dir, ".credentials.json"));
      if (raw === null) throw new StoreError("no-login", `${id} has no stored login`);
      if (parseLogin(raw) === null) throw new StoreError("invalid-login", `${id} holds no Claude login`);

      await mkdir(this.paths.live, { recursive: true });
      await writeAtomic(this.liveCredentials, raw);
      // The account block only names who is signed in, but a stale one shows the previous
      // address everywhere Claude Code prints it, so it moves with the token.
      const block = (await readJson(join(profile.dir, ".claude.json")))?.oauthAccount;
      if (block !== undefined) await writeAccountBlock(this.paths.liveSettings, block);

      if ((await readText(this.liveCredentials)) !== raw) {
        // Claude Code renewed the old token between our rename and this read. Its write wins
        // the race, so say so instead of reporting a switch that did not stick.
        throw new StoreError("invalid-login", "the live login changed while switching; try again");
      }
      return { profile, changed: true, from };
    });
  }

  /** Renames `~/.claude-<id>`. The live login is unaffected: it lives in its own file. */
  rename(id: string, name: string): Promise<string> {
    return this.#exclusive(async () => {
      const next = name.trim().toLowerCase();
      if (!PROFILE_NAME.test(next)) throw new StoreError("invalid-name", `invalid profile name: ${name}`);
      const profile = (await this.profiles()).find((candidate) => candidate.id === id);
      if (profile === undefined) throw new StoreError("unknown-account", `no profile named ${id}`);
      if (next === id) return id;
      const target = profileDir(this.paths, next);
      if (await exists(target)) throw new StoreError("name-taken", `${target} already exists`);
      await rename(profile.dir, target);
      return next;
    });
  }

  /** Moves a profile out of `~` into the trash. Refuses the live account: it would come back. */
  remove(id: string): Promise<string> {
    return this.#exclusive(async () => {
      const active = await this.#sync();
      if (active?.id === id) throw new StoreError("active-account", `${id} is the account in use`);
      const profile = (await this.profiles()).find((candidate) => candidate.id === id);
      if (profile === undefined) throw new StoreError("unknown-account", `no profile named ${id}`);
      await mkdir(this.paths.trash, { recursive: true, mode: 0o700 });
      const target = join(this.paths.trash, `${basename(profile.dir)}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
      await rename(profile.dir, target);
      return target;
    });
  }

  /** A fresh, empty profile directory for a login in progress. Reuses one that has no login. */
  prepare(name: string): Promise<string> {
    return this.#exclusive(async () => {
      const id = name.trim().toLowerCase();
      if (!PROFILE_NAME.test(id)) throw new StoreError("invalid-name", `invalid profile name: ${name}`);
      const dir = profileDir(this.paths, id);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      return dir;
    });
  }

  /** Deletes a directory `prepare` made for a login that never completed or duplicated another. */
  discard(dir: string): Promise<void> {
    return this.#exclusive(async () => {
      if (dirname(dir) !== this.paths.home || !PROFILE_DIR.test(basename(dir))) return;
      await rm(dir, { recursive: true, force: true });
    });
  }
}
