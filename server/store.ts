import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { PROFILE_NAME, slug } from "../shared/names.ts";

export interface StorePaths {
  home: string;
  live: string;
  liveSettings: string;
  data: string;
}

export function pathsFor(home: string, env: Record<string, string | undefined> = {}): StorePaths {
  const custom = env.CLAUDE_CONFIG_DIR;
  const live = custom === undefined || custom === "" ? join(home, ".claude") : custom;
  return {
    home,
    live,
    liveSettings: live === join(home, ".claude") ? join(home, ".claude.json") : join(live, ".claude.json"),
    data: join(home, ".local", "share", "seamless-claude-accounts"),
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

export const DEFAULT_SEAT = "default";

export interface Seat {
  id: string;
  dir: string;
  settings: string;
}

// The login and the refresh lock stay private: every chat on one account must share both.
function isPrivate(name: string): boolean {
  return name === ".credentials.json" || name === ".claude.json" || name.includes(".lock") || name.endsWith(".tmp");
}

function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
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

// A settings file that is not JSON is left as it is.
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

export function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Who owns the default config dir's login: the profile whose token was last seen there. When the
// token changes, Anthropic is asked whose it is; settings files can lag behind a login.
interface Lineage {
  owner: string;
  refresh: string;
}

/** Whose a token is, from Anthropic: the account and organization key, and the address. */
export interface WhoIs {
  key: string;
  email: string;
}

// The same account as Anthropic reports, also for blocks that lack the organization or the uuid.
function sameAccount(identity: Identity | null, known: WhoIs): boolean {
  if (identity === null) return false;
  if (identity.key === known.key) return true;
  if (identity.key.endsWith("/") && known.key.startsWith(identity.key)) return true;
  return identity.key.startsWith("email:") && identity.email.toLowerCase() === known.email.toLowerCase();
}

export class Store {
  #queue: Promise<unknown> = Promise.resolve();
  readonly paths: StorePaths;
  readonly #whoIs: (accessToken: string) => Promise<WhoIs | null>;

  constructor(paths: StorePaths, options: { whoIs?: (accessToken: string) => Promise<WhoIs | null> } = {}) {
    this.paths = paths;
    this.#whoIs = options.whoIs ?? (async () => null);
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

  get defaultSeat(): Seat {
    return { id: DEFAULT_SEAT, dir: this.paths.live, settings: this.paths.liveSettings };
  }

  accountSeat(id: string): Seat {
    const dir = join(this.paths.data, "accounts", safeName(id));
    return { id, dir, settings: join(dir, ".claude.json") };
  }

  pointer(project: string): string {
    return join(this.paths.data, "lanes", safeName(project));
  }

  async pointers(): Promise<Map<string, string>> {
    const root = join(this.paths.data, "lanes");
    const targets = new Map<string, string>();
    for (const name of await readdir(root).catch(() => [] as string[])) {
      if (name.startsWith(".")) continue;
      const target = await readlink(join(root, name)).catch(() => null);
      if (target !== null) targets.set(name, target);
    }
    return targets;
  }

  // One rename, so open chats follow the link on their next request and never see it missing.
  point(project: string, dir: string): Promise<void> {
    return this.#exclusive(async () => {
      const path = this.pointer(project);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      if ((await readlink(path).catch(() => null)) === dir) return;
      const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}`);
      await symlink(dir, temp);
      const existing = await lstat(path).catch(() => null);
      if (existing?.isDirectory()) {
        // A 1.2 lane: a real directory chats already opened with. Its login is saved by the caller.
        await mkdir(join(this.paths.data, "trash"), { recursive: true, mode: 0o700 });
        await rename(path, join(this.paths.data, "trash", `lane-${basename(path)}-${Date.now()}`));
      }
      await rename(temp, path);
    });
  }

  async legacyLanes(): Promise<Seat[]> {
    const root = join(this.paths.data, "lanes");
    const seats: Seat[] = [];
    for (const name of await readdir(root).catch(() => [] as string[])) {
      const dir = join(root, name);
      if ((await lstat(dir).catch(() => null))?.isDirectory()) {
        seats.push({ id: name, dir, settings: join(dir, ".claude.json") });
      }
    }
    return seats;
  }

  // A chat whose config dir is `~/.claude` reads `~/.claude/.claude.json`, not `~/.claude.json`.
  async linkDefaultSettings(): Promise<void> {
    const inside = join(this.paths.live, ".claude.json");
    if (inside === this.paths.liveSettings || (await lstat(inside).catch(() => null)) !== null) return;
    await mkdir(this.paths.live, { recursive: true });
    await symlink(this.paths.liveSettings, inside);
  }

  /** Gives a seat its account's profile login when the profile holds a newer one. */
  adopt(seat: Seat, id: string): Promise<void> {
    return this.#exclusive(async () => {
      const profile = (await this.profiles()).find((candidate) => candidate.id === id);
      const raw = profile === undefined ? null : await readText(join(profile.dir, ".credentials.json"));
      const stored = raw === null ? null : parseLogin(raw);
      const live = parseLogin((await readText(join(seat.dir, ".credentials.json"))) ?? "");
      if (raw === null || stored === null || live === null) return;
      if ((stored.expiresAt ?? 0) > (live.expiresAt ?? 0)) await writeAtomic(join(seat.dir, ".credentials.json"), raw);
    });
  }

  // A login nobody can place is about to be replaced: keep a copy so it can never be lost.
  async #keepUnknownLogin(seat: Seat): Promise<void> {
    const raw = await readText(join(seat.dir, ".credentials.json"));
    if (raw === null || parseLogin(raw) === null) return;
    const trash = join(this.paths.data, "trash");
    await mkdir(trash, { recursive: true, mode: 0o700 });
    await writeAtomic(join(trash, `login-${safeName(seat.id)}-${Date.now()}.json`), raw);
  }

  renameAccountDir(from: string, to: string): Promise<void> {
    return this.#exclusive(async () => {
      const source = this.accountSeat(from).dir;
      if ((await lstat(source).catch(() => null)) === null) return;
      await rename(source, this.accountSeat(to).dir);
    });
  }

  // Claude Code renews tokens in the live file only and each renewal retires the previous refresh
  // token, so the owning profile must be kept current or it will need a new login.
  sync(seat: Seat = this.defaultSeat, owner?: string | null): Promise<Profile | null> {
    return this.#exclusive(() => this.#sync(seat, owner));
  }

  get #lineageFile(): string {
    return join(this.paths.data, "default-seat.json");
  }

  async #lineage(): Promise<Lineage | null> {
    const value = await readJson(this.#lineageFile);
    if (typeof value?.owner !== "string" || typeof value.refresh !== "string") return null;
    return { owner: value.owner, refresh: value.refresh };
  }

  async #recordLineage(owner: string, login: Login): Promise<void> {
    const refresh = fingerprint(login.refreshToken);
    const current = await this.#lineage();
    if (current?.owner === owner && current.refresh === refresh) return;
    await this.#writeLineage({ owner, refresh });
  }

  async #writeLineage(lineage: Lineage): Promise<void> {
    await mkdir(this.paths.data, { recursive: true, mode: 0o700 });
    await writeAtomic(this.#lineageFile, `${JSON.stringify(lineage)}\n`);
  }

  /**
   * The profile a seat's login belongs to. `undefined` means unknown, and then nothing is copied:
   * a guess could write one account's tokens into another's profile.
   */
  async #ownerOf(
    seat: Seat,
    live: { login: Login; identity: Identity | null },
    profiles: Profile[],
  ): Promise<{ owner: Profile | undefined; key: string | null; email: string }> {
    if (seat.id === DEFAULT_SEAT) {
      const lineage = await this.#lineage();
      const recorded = profiles.find((profile) => profile.id === lineage?.owner);
      if (recorded !== undefined && lineage?.refresh === fingerprint(live.login.refreshToken)) {
        return { owner: recorded, key: recorded.identity?.key ?? null, email: "" };
      }
    }
    const byToken = profiles.find((profile) => profile.login?.refreshToken === live.login.refreshToken);
    if (byToken !== undefined) return { owner: byToken, key: byToken.identity?.key ?? null, email: "" };
    const expired = live.login.expiresAt !== null && live.login.expiresAt <= Date.now();
    const known = expired ? null : await this.#whoIs(live.login.accessToken);
    if (known !== null) {
      const owner =
        profiles.find((profile) => profile.identity?.key === known.key) ??
        profiles.find((profile) => sameAccount(profile.identity, known));
      return { owner, key: known.key, email: known.email };
    }
    // Anthropic cannot be asked (offline, or the token expired): the account block is the record.
    // A switch never leaves it naming another account, so it can be trusted here, including for an
    // account signed in by hand that has no profile yet.
    if (live.identity === null) return { owner: undefined, key: null, email: "" };
    const byIdentity = profiles.find((profile) => profile.identity?.key === live.identity?.key);
    return { owner: byIdentity, key: live.identity.key, email: live.identity.email };
  }

  async #sync(seat: Seat, ownerId?: string | null): Promise<Profile | null> {
    const live = await this.#read(seat.dir, seat.settings);
    const login = live.login;
    if (live.raw === null || login === null) return null;
    const profiles = await this.profiles();
    if (ownerId !== undefined) {
      const owner = profiles.find((profile) => profile.id === ownerId);
      return owner === undefined ? null : this.#copyForward(owner, live.raw, login);
    }

    const { owner, key, email } = await this.#ownerOf(seat, { login, identity: live.identity }, profiles);
    if (owner === undefined) {
      // A login with no profile yet, signed in by hand: keep it, named after its account.
      if (key === null) return null;
      // The account block names who signed in; when the settings name someone else, build one from
      // what Anthropic reported so the profile is recognized next time.
      const [accountUuid = "", organizationUuid = ""] = key.split("/");
      const block = live.identity?.key === key ? live.block : { accountUuid, organizationUuid, emailAddress: email };
      const name = (live.identity?.key === key ? live.identity.email : email).split("@")[0] ?? "";
      const id = await this.#freeName(name, profiles);
      const dir = profileDir(this.paths, id);
      await mkdir(dir, { mode: 0o700, recursive: true });
      await writeAtomic(join(dir, ".credentials.json"), live.raw);
      await writeAccountBlock(join(dir, ".claude.json"), block);
      if (seat.id === DEFAULT_SEAT) await this.#recordLineage(id, login);
      return { id, dir, login, identity: parseIdentity(block) };
    }

    const synced = await this.#copyForward(owner, live.raw, login);
    if (owner.identity === null && live.block !== undefined && live.identity !== null) {
      // Only an identity Anthropic confirms for this token is copied into the profile.
      const expired = login.expiresAt !== null && login.expiresAt <= Date.now();
      const known = expired ? null : ((await this.#whoIs(login.accessToken))?.key ?? null);
      if (known === live.identity.key) await writeAccountBlock(join(owner.dir, ".claude.json"), live.block);
    }
    if (seat.id === DEFAULT_SEAT) {
      await this.#recordLineage(owner.id, login);
      // Settings can name a previous account; show the one actually signed in. Only a different
      // account counts, not a block that merely carries more or fewer fields for the same one.
      const account = (identity: Identity | null) => identity?.key.split("/")[0] ?? null;
      if (owner.identity !== null && account(live.identity) !== account(owner.identity)) {
        const block = (await readJson(join(owner.dir, ".claude.json")))?.oauthAccount;
        if (block !== undefined) await writeAccountBlock(seat.settings, block);
      }
    }
    return synced;
  }

  // Only copy forward: a profile signed in again may hold a newer login than the live one.
  async #copyForward(owner: Profile, raw: string, login: Login): Promise<Profile> {
    const stored = owner.login;
    const newer = stored === null || (login.expiresAt ?? 0) >= (stored.expiresAt ?? 0);
    if (newer && (stored?.accessToken !== login.accessToken || stored?.refreshToken !== login.refreshToken)) {
      await writeAtomic(join(owner.dir, ".credentials.json"), raw);
    }
    return { ...owner, login: newer ? login : stored };
  }

  async #prepareLane(seat: Seat): Promise<void> {
    await mkdir(seat.dir, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.paths.live).catch(() => [] as string[])) {
      if (isPrivate(name)) continue;
      const link = join(seat.dir, name);
      if (
        await lstat(link).then(
          () => true,
          () => false,
        )
      )
        continue;
      await symlink(join(this.paths.live, name), link);
    }
    if (!(await exists(seat.settings))) {
      if (await exists(this.paths.liveSettings)) await copyFile(this.paths.liveSettings, seat.settings);
      else await writeFile(seat.settings, "{}\n");
      await chmod(seat.settings, 0o600);
    }
  }

  async #freeName(base: string, profiles: Profile[]): Promise<string> {
    const root = slug(base) ?? "account";
    const taken = new Set(profiles.map((profile) => profile.id));
    for (let n = 1; ; n += 1) {
      const name = n === 1 ? root : `${root}-${n}`;
      if (!taken.has(name) && !(await exists(profileDir(this.paths, name)))) return name;
    }
  }

  install(
    id: string,
    seat: Seat = this.defaultSeat,
    owner?: string | null,
  ): Promise<{ profile: Profile; changed: boolean; from: Profile | null }> {
    return this.#exclusive(async () => {
      const lane = seat.id !== DEFAULT_SEAT;
      const from = await this.#sync(seat, lane ? (owner ?? null) : undefined);
      if (!lane && from === null) await this.#keepUnknownLogin(seat);
      const profile = (await this.profiles()).find((candidate) => candidate.id === id);
      if (profile === undefined) throw new StoreError("unknown-account", `no profile named ${id}`);
      if (from?.id === profile.id) return { profile, changed: false, from };

      const raw = await readText(join(profile.dir, ".credentials.json"));
      if (raw === null) throw new StoreError("no-login", `${id} has no stored login`);
      if (parseLogin(raw) === null) throw new StoreError("invalid-login", `${id} holds no Claude login`);

      if (lane) await this.#prepareLane(seat);
      else await mkdir(seat.dir, { recursive: true });
      const credentials = join(seat.dir, ".credentials.json");
      const previous = (await readJson(seat.settings))?.oauthAccount;
      const previousInside = (await readJson(join(seat.dir, ".claude.json")))?.oauthAccount;
      await writeAtomic(credentials, raw);
      // Without this Claude Code keeps showing the previous account's address.
      const block = (await readJson(join(profile.dir, ".claude.json")))?.oauthAccount;
      const inside = join(seat.dir, ".claude.json");
      const insideIsOwn = inside !== seat.settings && (await lstat(inside).catch(() => null))?.isFile() === true;
      if (block !== undefined) {
        await writeAccountBlock(seat.settings, block);
        if (insideIsOwn) await writeAccountBlock(inside, block);
      }
      if ((await readText(credentials)) !== raw) {
        // Claude Code renewed the old token mid-switch and its write won: the old account stays,
        // so its account block goes back too and keeps naming the login actually there.
        if (block !== undefined) {
          if (previous !== undefined) await writeAccountBlock(seat.settings, previous);
          if (insideIsOwn && previousInside !== undefined) await writeAccountBlock(inside, previousInside);
        }
        throw new StoreError("invalid-login", "the live login changed while switching; try again");
      }
      const login = parseLogin(raw);
      if (!lane && login !== null) await this.#recordLineage(id, login);
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
      const lineage = await this.#lineage();
      if (lineage?.owner === id) await this.#writeLineage({ owner: next, refresh: lineage.refresh });
      return next;
    });
  }

  remove(id: string): Promise<string> {
    return this.#exclusive(async () => {
      const active = await this.#sync(this.defaultSeat);
      if (active?.id === id) throw new StoreError("active-account", `${id} is the account in use`);
      const profile = (await this.profiles()).find((candidate) => candidate.id === id);
      if (profile === undefined) throw new StoreError("unknown-account", `no profile named ${id}`);
      const trash = join(this.paths.data, "trash");
      await mkdir(trash, { recursive: true, mode: 0o700 });
      const target = join(trash, `${basename(profile.dir)}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
      await rename(profile.dir, target);
      return target;
    });
  }

  /** A profile directory for a login in progress; `created` says whether it is new. */
  prepare(name: string): Promise<{ dir: string; created: boolean }> {
    return this.#exclusive(async () => {
      const id = name.trim().toLowerCase();
      if (!PROFILE_NAME.test(id)) throw new StoreError("invalid-name", `invalid profile name: ${name}`);
      const dir = profileDir(this.paths, id);
      // A directory left empty by an earlier attempt counts as new; one holding anything does not.
      const created = (await readdir(dir).catch(() => [] as string[])).length === 0;
      await mkdir(dir, { recursive: true, mode: 0o700 });
      return { dir, created };
    });
  }

  discard(dir: string): Promise<void> {
    return this.#exclusive(async () => {
      if (dirname(dir) !== this.paths.home || !PROFILE_DIR.test(basename(dir))) return;
      await rm(dir, { recursive: true, force: true });
    });
  }
}
