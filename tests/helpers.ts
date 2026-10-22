import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AccountService } from "../server/service.ts";
import { pathsFor, Store } from "../server/store.ts";
import { UsageReader } from "../server/usage.ts";

export interface Fixture {
  home: string;
  store: Store;
  cleanup(): Promise<void>;
}

export async function fixture(): Promise<Fixture> {
  const home = await mkdtemp(join(tmpdir(), "seamless-claude-"));
  return { home, store: new Store(pathsFor(home)), cleanup: () => rm(home, { recursive: true, force: true }) };
}

export interface LoginSpec {
  email: string;
  token?: string;
  refresh?: string;
  expiresAt?: number;
  refreshExpiresAt?: number;
}

export function credentials(spec: LoginSpec): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: spec.token ?? `at-${spec.email}`,
      refreshToken: spec.refresh ?? `rt-${spec.email}`,
      expiresAt: spec.expiresAt ?? Date.now() + 3_600_000,
      ...(spec.refreshExpiresAt === undefined ? {} : { refreshTokenExpiresAt: spec.refreshExpiresAt }),
      subscriptionType: "max",
    },
  });
}

export function accountBlock(email: string) {
  return {
    emailAddress: email,
    accountUuid: `uuid-${email}`,
    organizationUuid: "org",
    organizationType: "claude_max",
    displayName: email.split("@")[0],
  };
}

export async function addProfile(home: string, id: string, spec: LoginSpec): Promise<string> {
  const dir = join(home, `.claude-${id}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".credentials.json"), credentials(spec), { mode: 0o600 });
  await writeFile(
    join(dir, ".claude.json"),
    JSON.stringify({ projects: { keep: true }, oauthAccount: accountBlock(spec.email) }),
  );
  return dir;
}

export async function setLive(
  home: string,
  spec: LoginSpec,
  settings: Record<string, unknown> = { theme: "dark" },
): Promise<void> {
  await mkdir(join(home, ".claude"), { recursive: true });
  await writeFile(join(home, ".claude", ".credentials.json"), credentials(spec), { mode: 0o600 });
  await writeFile(join(home, ".claude.json"), JSON.stringify({ ...settings, oauthAccount: accountBlock(spec.email) }));
}

export async function readJson(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
}

export function usageFetch(byToken: Record<string, { five: number; week: number; status?: number }>) {
  const calls: string[] = [];
  const fake = (async (_url: string | URL | Request, init?: RequestInit) => {
    const token = String((init?.headers as Record<string, string>).Authorization).replace("Bearer ", "");
    calls.push(token);
    const entry = byToken[token];
    if (entry === undefined) return new Response("{}", { status: 401 });
    const body = {
      five_hour: { utilization: entry.five, resets_at: "2030-01-01T05:00:00Z" },
      seven_day: { utilization: entry.week, resets_at: "2030-01-07T00:00:00Z" },
    };
    return new Response(JSON.stringify(body), { status: entry.status ?? 200 });
  }) as typeof fetch;
  return { fetch: fake, calls };
}

const FAKE_CLAUDE = fileURLToPath(import.meta.resolve("./fixtures/fake-claude.mjs"));

export function service(f: Fixture, byToken: Parameters<typeof usageFetch>[0] = {}) {
  const usage = usageFetch(byToken);
  return {
    calls: usage.calls,
    service: new AccountService({
      store: f.store,
      usage: new UsageReader({
        cacheFile: join(f.home, ".cache", "usage.json"),
        version: Promise.resolve("2.1.0"),
        fetch: usage.fetch,
      }),
      binary: process.execPath,
      loginArgs: [FAKE_CLAUDE],
    }),
  };
}
