import { chmod, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const HOME = homedir();

/** The login Claude Code actually uses. Swapping this one file is the whole switch: every
 *  running session reads it again on its next request, which is why `claude login` needs no
 *  restart and neither does this. */
const LIVE_DIR = join(HOME, ".claude");
const LIVE_CREDENTIALS = join(LIVE_DIR, ".credentials.json");
const LIVE_SETTINGS = join(HOME, ".claude.json");

/** How the live directory is named in the UI. */
const LIVE_ID = "principal";

/** A `~/.claude*` sibling holding its own login, e.g. `~/.claude-capichan`. */
const PROFILE_NAME = /^\.claude[-_.].+/;

const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const USAGE_TIMEOUT_MS = 8_000;
const USAGE_FRESH_FOR_MS = 60_000;

/** What one login contributes to the screen. */
export interface AccountView {
  id: string;
  email: string;
  plan: string;
  /** Percent of the 5-hour window used, or null when it could not be read. */
  fiveHour: number | null;
  /** Percent of the 7-day window used. */
  week: number | null;
  active: boolean;
}

interface Credential {
  token: string;
  expiresAt: number | null;
}

interface Meter {
  fiveHour: number | null;
  week: number | null;
}

const EMPTY: Meter = { fiveHour: null, week: null };
const usageCache = new Map<string, { at: number; meter: Meter }>();

/** A profile's id is its suffix without the `.claude-` prefix: `~/.claude-capichan` -> `capichan`. */
function idOf(dir: string): string {
  return dir === LIVE_DIR ? LIVE_ID : basename(dir).replace(/^\.claude[-_.]/, "");
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** The OAuth blob, or null when the directory holds no claude.ai token. */
async function readCredential(dir: string): Promise<Credential | null> {
  let raw: string;
  try {
    raw = await readFile(join(dir, ".credentials.json"), "utf8");
  } catch {
    return null;
  }
  try {
    const oauth = (JSON.parse(raw) as { claudeAiOauth?: Record<string, unknown> }).claudeAiOauth;
    const token = oauth?.accessToken;
    if (typeof token !== "string" || token === "") return null;
    const expiresAt = typeof oauth?.expiresAt === "number" ? oauth.expiresAt : null;
    return { token, expiresAt };
  } catch {
    return null;
  }
}

/** Who a directory is logged in as, from the account block Claude Code caches there. Empties
 *  when the cache is missing: the screen then shows the account as unidentified rather than
 *  spending a request to learn its address. */
async function readIdentity(dir: string): Promise<{ email: string; plan: string }> {
  try {
    // The live login's account block lives at the home root; a profile keeps its own inside.
    const path = dir === LIVE_DIR ? LIVE_SETTINGS : join(dir, ".claude.json");
    const account = (JSON.parse(await readFile(path, "utf8")) as { oauthAccount?: Record<string, unknown> }).oauthAccount;
    return {
      email: typeof account?.emailAddress === "string" ? account.emailAddress : "",
      plan: typeof account?.organizationType === "string" ? account.organizationType : "",
    };
  } catch {
    return { email: "", plan: "" };
  }
}

/** How much of each window a login has used. Never throws: an unreadable meter is nulls. */
async function readUsage(dir: string, credential: Credential, now: number): Promise<Meter> {
  const cached = usageCache.get(dir);
  if (cached !== undefined && now - cached.at < USAGE_FRESH_FOR_MS) return cached.meter;

  /** Remembers a reading that cost nothing, so polling does not repeat it. */
  const remember = (meter: Meter): Meter => {
    usageCache.set(dir, { at: now, meter });
    return meter;
  };

  if (credential.expiresAt !== null && credential.expiresAt <= now) return remember(EMPTY);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), USAGE_TIMEOUT_MS);
  try {
    const response = await fetch(USAGE_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${credential.token}`,
        "anthropic-beta": "oauth-2025-04-20",
        // The endpoint checks who is calling; anything else is refused.
        "User-Agent": "claude-code/2.1.308",
      },
      signal: controller.signal,
    });
    if (response.status !== 200) {
      // A rate-limited endpoint earns a wait, not another question.
      return remember(EMPTY);
    }
    const body = (await response.json()) as Record<string, unknown>;
    return remember({
      fiveHour: utilization(body.five_hour),
      week: utilization(body.seven_day),
    });
  } catch {
    return remember(EMPTY);
  } finally {
    clearTimeout(timer);
  }
}

/** The percent an allowance window reports, or null when the window is not in the answer. */
function utilization(value: unknown): number | null {
  if (typeof value !== "object" || value === null) return null;
  const percent = (value as Record<string, unknown>).utilization;
  return typeof percent === "number" ? percent : null;
}

/** Every login on the machine: the live one plus each `~/.claude-*` profile holding a token. */
async function profileDirs(): Promise<string[]> {
  const dirs = [LIVE_DIR];
  for (const name of (await readdir(HOME).catch(() => [] as string[])).sort()) {
    if (!PROFILE_NAME.test(name)) continue;
    const dir = join(HOME, name);
    if (await isFile(join(dir, ".credentials.json"))) dirs.push(dir);
  }
  return dirs;
}

export async function listAccounts(): Promise<{ accounts: AccountView[]; email: string; target: string }> {
  const now = Date.now();
  const active = await readIdentity(LIVE_DIR);
  const accounts: AccountView[] = [];
  for (const dir of await profileDirs()) {
    const credential = await readCredential(dir);
    // A directory with no claude.ai token is not an account yet.
    if (credential === null) continue;
    const identity = await readIdentity(dir);
    accounts.push({
      id: idOf(dir),
      email: identity.email === "" ? "(sin identificar)" : identity.email,
      plan: identity.plan,
      ...(await readUsage(dir, credential, now)),
      active: dir === LIVE_DIR,
    });
  }
  // A profile holding the same login as the live one is that same account: listing it twice
  // would offer a switch that changes nothing.
  return {
    accounts: accounts.filter((account) => account.active || active.email === "" || account.email !== active.email),
    email: active.email,
    target: LIVE_CREDENTIALS,
  };
}

/** Writes a file so a reader never sees a half-written credential. */
async function writeAtomic(path: string, body: string): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, body, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
}

/**
 * Points `~/.claude` at another login. This is exactly what `claude login` does, so the switch
 * is immediate: no session is restarted, nothing is copied and no chat is reopened. The profile
 * directory keeps its own copy, which is what makes switching back one click.
 */
export async function useAccount(id: string): Promise<{ ok: boolean; email: string; error: string }> {
  const dirs = await profileDirs();
  const source = dirs.find((dir) => idOf(dir) === id);
  if (source === undefined) return { ok: false, email: "", error: `unknown account: ${id}` };

  const credential = await readFile(join(source, ".credentials.json"), "utf8").catch(() => "");
  if (credential === "") return { ok: false, email: "", error: "this account has no stored login" };
  try {
    JSON.parse(credential);
  } catch {
    return { ok: false, email: "", error: "the stored login is not valid JSON" };
  }

  await writeAtomic(LIVE_CREDENTIALS, credential);

  // The account block only names the signed-in address, but a stale one shows the previous
  // account, so it moves with the token.
  const identity = await readIdentity(source);
  const block = await readAccountBlock(source);
  if (block !== null) {
    const settings = await readFile(LIVE_SETTINGS, "utf8").catch(() => "{}");
    try {
      const parsed = JSON.parse(settings) as Record<string, unknown>;
      parsed.oauthAccount = block;
      await writeFile(LIVE_SETTINGS, `${JSON.stringify(parsed, null, 2)}\n`);
    } catch {
      // A settings file that is not JSON is left alone: the login still switched.
    }
  }

  // The live token changed, so its cached allowance is now another account's.
  usageCache.delete(LIVE_DIR);
  return { ok: true, email: identity.email, error: "" };
}

/** The account block a profile caches, or null when it has none to copy. */
async function readAccountBlock(dir: string): Promise<unknown | null> {
  try {
    const account = (JSON.parse(await readFile(join(dir, ".claude.json"), "utf8")) as { oauthAccount?: unknown })
      .oauthAccount;
    return account ?? null;
  } catch {
    return null;
  }
}
