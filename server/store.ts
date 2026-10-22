import { randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { PROFILE_NAME, slug } from "../shared/names.ts";

export interface StorePaths {
  home: string;
  live: string;
  liveSettings: string;
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

export interface Login {
  accessToken: string;
  refreshToken: string;
  expiresAt: number | null;
  refreshExpiresAt: number | null;
}

export interface Identity {
  email: string;
  name: string;
  plan: string;
  organization: string;
  key: string;
}

export interface Profile {
  id: string;
  dir: string;
  login: Login | null;
  identity: Identity | null;
}

export type StoreErrorCode =
  "unknown-account" | "no-login" | "invalid-login" | "invalid-name" | "name-taken" | "active-account";

export class StoreError extends Error {
  readonly code: StoreErrorCode;

  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

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
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
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

export async function writeAtomic(path: string, body: string, mode = 0o600): Promise<void> {
  const previous = await stat(path).then(
    (info) => info.mode & 0o777,
    () => mode,
  );
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

async function writeAccountBlock(path: string, block: unknown): Promise<void> {
  const raw = await readText(path);
  let settings: Record<string, unknown> = {};
  if (raw !== null) {
    try {
      settings = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
  }
  settings.oauthAccount = block;
  await writeAtomic(path, `${JSON.stringify(settings, null, 2)}\n`);
}

export class Store {
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

  async #read(
    dir: string,
    settingsPath: string,
  ): Promise<{ raw: string | null; login: Login | null; identity: Identity | null; block: unknown }> {
    const raw = await readText(join(dir, ".credentials.json"));
    const block = (await readJson(settingsPath))?.oauthAccount;
    return { raw, login: raw === null ? null : parseLogin(raw), identity: parseIdentity(block), block };
  }

  async live(): Promise<{ raw: string | null; login: Login | null; identity: Identity | null; block: unknown }> {
    return this.#read(this.paths.live, this.paths.liveSettings);
  }

  async profiles(): Promise<Profile[]> {
    const names = await readdir(this.paths.home).catch(() => [] as string[]);
    const profiles: Profile[] = [];
    for (const name of names.sort()) {
      const id = PROFILE_DIR.exec(name)?.[1]?.toLowerCase();
      if (id === undefined) continue;
      const dir = join(this.paths.home, name);
      if (dir === this.paths.live) continue;
      const hasLogin = await exists(join(dir, ".credentials.json"));
      if (!hasLogin && !(await exists(join(dir, ".claude.json")))) continue;
      const read = await this.#read(dir, join(dir, ".claude.json"));
      profiles.push({ id, dir, login: read.login, identity: read.identity });
    }
    return profiles;
  }

  // Claude Code renews tokens in the live file only and each renewal retires the previous refresh
  // token, so the owning profile must be kept current or it will need a new login.
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

    // Only copy forward: a profile signed in again may hold a newer login than the live one.
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
      // Without this Claude Code keeps showing the previous account's address.
      const block = (await readJson(join(profile.dir, ".claude.json")))?.oauthAccount;
      if (block !== undefined) await writeAccountBlock(this.paths.liveSettings, block);

      if ((await readText(this.liveCredentials)) !== raw) {
        // Claude Code renewed the old token mid-switch and its write won.
        throw new StoreError("invalid-login", "the live login changed while switching; try again");
      }
      return { profile, changed: true, from };
    });
  }

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

  remove(id: string): Promise<string> {
    return this.#exclusive(async () => {
      const active = await this.#sync();
      if (active?.id === id) throw new StoreError("active-account", `${id} is the account in use`);
      const profile = (await this.profiles()).find((candidate) => candidate.id === id);
      if (profile === undefined) throw new StoreError("unknown-account", `no profile named ${id}`);
      await mkdir(this.paths.trash, { recursive: true, mode: 0o700 });
      const target = join(
        this.paths.trash,
        `${basename(profile.dir)}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
      );
      await rename(profile.dir, target);
      return target;
    });
  }

  prepare(name: string): Promise<string> {
    return this.#exclusive(async () => {
      const id = name.trim().toLowerCase();
      if (!PROFILE_NAME.test(id)) throw new StoreError("invalid-name", `invalid profile name: ${name}`);
      const dir = profileDir(this.paths, id);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      return dir;
    });
  }

  discard(dir: string): Promise<void> {
    return this.#exclusive(async () => {
      if (dirname(dir) !== this.paths.home || !PROFILE_DIR.test(basename(dir))) return;
      await rm(dir, { recursive: true, force: true });
    });
  }
}
