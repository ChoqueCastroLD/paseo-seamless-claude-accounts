import assert from "node:assert/strict";
import { lstat, mkdir, readFile, readlink, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseLogin } from "../server/store.ts";
import { addProfile, fixture, service, setLive, type Fixture } from "./helpers.ts";

describe("accounts per workspace", () => {
  let f: Fixture;
  beforeEach(async () => (f = await fixture()));
  afterEach(() => f.cleanup());

  const data = () => join(f.home, ".local", "share", "seamless-claude-accounts");
  const link = (scope: string) => join(data(), "lanes", scope);
  const accountDir = (id: string) => join(data(), "accounts", id);
  const tokenThrough = async (scope: string) =>
    parseLogin(await readFile(join(link(scope), ".credentials.json"), "utf8"))?.accessToken;
  const workspaces = { ws_acme: "prj_acme", ws_acme2: "prj_acme", ws_other: "prj_other" };

  async function setup(usage: Parameters<typeof service>[1] = {}) {
    await mkdir(join(f.home, ".claude", "projects"), { recursive: true });
    await addProfile(f.home, "home", { email: "h@x.io" });
    await addProfile(f.home, "spare", { email: "s@x.io" });
    await addProfile(f.home, "work", { email: "w@x.io" });
    await setLive(f.home, { email: "h@x.io" });
    const { service: s } = service(f, usage);
    await s.rules.update((rules) => void (rules.order = ["home", "spare", "work"]));
    await s.know(["prj_acme", "prj_other"], workspaces);
    return s;
  }

  it("opens a new workspace through a link, with every account allowed", async () => {
    const s = await setup();
    assert.equal(await s.laneFor("ws_other"), link("ws_other"));
    assert.equal(await readlink(link("ws_other")), join(f.home, ".claude"));
    assert.equal(await tokenThrough("ws_other"), "at-h@x.io");
    assert.equal(await readlink(join(f.home, ".claude", ".claude.json")), join(f.home, ".claude.json"));
    const { accounts } = await s.list();
    assert.ok(accounts.every((account) => account.everywhere));
    assert.equal(await s.laneFor(null), null);
  });

  it("moves open chats when an account is limited to a project", async () => {
    const s = await setup();
    await s.laneFor("ws_acme");
    await s.laneFor("ws_other");
    await s.rules.update((rules) => void (rules.order = ["work", "home", "spare"]));
    assert.deepEqual(
      await s.assignProjects("work", ["prj_acme"], { everywhere: false, known: ["prj_acme", "prj_other"] }),
      { ok: true },
    );
    assert.equal(await readlink(link("ws_acme")), accountDir("work"));
    assert.equal(await tokenThrough("ws_acme"), "at-w@x.io");
    assert.equal(await tokenThrough("ws_other"), "at-h@x.io");
    assert.equal(await readlink(link("ws_other")), join(f.home, ".claude"));
    const { accounts } = await s.list();
    const work = accounts.find((account) => account.id === "work");
    assert.deepEqual([work?.allowed, work?.everywhere], [["prj_acme"], false]);
  });

  it("lets a workspace choose its accounts and moves its open chats at once", async () => {
    const s = await setup();
    await s.laneFor("ws_acme");
    await s.laneFor("ws_acme2");
    assert.deepEqual(await s.assignWorkspace("ws_acme", ["spare"]), { ok: true });
    assert.equal(await tokenThrough("ws_acme"), "at-s@x.io");
    assert.equal(await tokenThrough("ws_acme2"), "at-h@x.io");
    assert.deepEqual(await s.assignWorkspace("ws_acme", null), { ok: true });
    assert.equal(await tokenThrough("ws_acme"), "at-h@x.io");
  });

  it("starts a quickly created workspace with its project's rules", async () => {
    const s = await setup();
    await s.rules.update((rules) => void (rules.order = ["work", "home", "spare"]));
    await s.assignProjects("work", ["prj_acme"], { everywhere: false, known: ["prj_acme", "prj_other"] });
    await s.know(["prj_acme", "prj_other"], { ws_new: "prj_acme" });
    await s.laneFor("ws_new");
    assert.equal(await tokenThrough("ws_new"), "at-w@x.io");
  });

  it("lets a project created later use every account", async () => {
    const s = await setup();
    await s.assignProjects("work", ["prj_acme"], { everywhere: false, known: ["prj_acme", "prj_other"] });
    await s.know(["prj_acme", "prj_other", "prj_new"], { ws_fresh: "prj_new" });
    const { accounts } = await s.list();
    assert.ok(accounts.find((account) => account.id === "work")?.allowed.includes("prj_new"));
  });

  it("gives an account's dir everything in ~/.claude except its login and lock", async () => {
    const s = await setup();
    await writeFile(join(f.home, ".claude", ".oauth_refresh.lock"), "");
    await s.laneFor("ws_acme");
    await s.assignWorkspace("ws_acme", ["work"]);
    assert.equal(await readlink(join(accountDir("work"), "projects")), join(f.home, ".claude", "projects"));
    assert.ok((await lstat(join(accountDir("work"), ".credentials.json"))).isFile());
    assert.ok((await lstat(join(accountDir("work"), ".claude.json"))).isFile());
    assert.equal(await lstat(join(accountDir("work"), ".oauth_refresh.lock")).catch(() => null), null);
    assert.equal((await stat(accountDir("work"))).mode & 0o777, 0o700);
    const settings = JSON.parse(await readFile(join(accountDir("work"), ".claude.json"), "utf8"));
    assert.equal(settings.oauthAccount.emailAddress, "w@x.io");
  });

  it("moves every workspace off an account that runs out, outside workspaces included", async () => {
    const usage = { "at-h@x.io": { five: 10, week: 10 } };
    const s = await setup(usage);
    await s.laneFor("ws_acme");
    await s.laneFor("ws_other");
    usage["at-h@x.io"].five = 100;
    const moved = await s.failover("ws_acme", false);
    assert.deepEqual([moved.from, moved.to], ["home", "spare"]);
    const { accounts } = await s.list();
    assert.equal(accounts.find((account) => account.active)?.id, "spare");
    assert.equal(await tokenThrough("ws_acme"), "at-s@x.io");
    assert.equal(await tokenThrough("ws_other"), "at-s@x.io");
  });

  it("never keeps one account in two credential files", async () => {
    const { realpath } = await import("node:fs/promises");
    const usage = { "at-h@x.io": { five: 10, week: 10 }, "at-w@x.io": { five: 10, week: 10 } };
    const s = await setup(usage);
    const scopes = ["ws_acme", "ws_acme2", "ws_other"];
    for (const scope of scopes) await s.laneFor(scope);
    const check = async () => {
      const dirs = new Map<string, Set<string>>();
      for (const dir of [join(f.home, ".claude"), ...scopes.map(link)]) {
        const real = await realpath(dir);
        const token = parseLogin(await readFile(join(real, ".credentials.json"), "utf8"))?.accessToken ?? "";
        dirs.set(token, (dirs.get(token) ?? new Set()).add(real));
      }
      for (const [token, found] of dirs) assert.equal(found.size, 1, `${token} lives in ${[...found].join(", ")}`);
    };
    await s.rules.update((rules) => void (rules.order = ["work", "home", "spare"]));
    await s.assignProjects("work", ["prj_acme"], { everywhere: false, known: ["prj_acme", "prj_other"] });
    await check();
    await s.assignWorkspace("ws_acme2", ["spare"]);
    await check();
    await s.use("spare");
    await check();
    usage["at-h@x.io"].five = 100;
    await s.failover("ws_other", false);
    await check();
    await s.assignProjects("work", [], { everywhere: true, known: [] });
    await s.use("work");
    await check();
  });

  it("puts a used account first and moves every workspace allowed to use it", async () => {
    const s = await setup();
    await s.laneFor("ws_acme");
    assert.deepEqual(await s.use("spare"), { ok: true, email: "s@x.io" });
    const { accounts, history } = await s.list();
    assert.deepEqual(
      accounts.map((account) => [account.id, account.priority, account.active]),
      [
        ["spare", 1, true],
        ["home", 2, false],
        ["work", 3, false],
      ],
    );
    assert.equal(await tokenThrough("ws_acme"), "at-s@x.io");
    assert.equal(history[0]?.from, "home");
    assert.equal(history[0]?.everywhere, true);
  });

  it("keeps the renewed login of an account's dir in its profile", async () => {
    const s = await setup();
    await s.laneFor("ws_acme");
    await s.assignWorkspace("ws_acme", ["work"]);
    const renewed = JSON.stringify({
      claudeAiOauth: { accessToken: "renewed", refreshToken: "r2", expiresAt: Date.now() + 9_000_000 },
    });
    await writeFile(join(accountDir("work"), ".credentials.json"), renewed);
    await s.list();
    const profile = parseLogin(await readFile(join(f.home, ".claude-work", ".credentials.json"), "utf8"));
    assert.equal(profile?.accessToken, "renewed");
  });

  it("follows renames and refuses to remove an account in use", async () => {
    const s = await setup();
    await s.laneFor("ws_acme");
    await s.assignWorkspace("ws_acme", ["work"]);
    await s.assignProjects("work", ["prj_acme"], { everywhere: false, known: ["prj_acme", "prj_other"] });
    assert.deepEqual(await s.rename("work", "acme"), { ok: true, id: "acme" });
    assert.equal(await readlink(link("ws_acme")), accountDir("acme"));
    assert.equal(await tokenThrough("ws_acme"), "at-w@x.io");
    const rules = await s.rules.read();
    assert.deepEqual(rules.workspaces.ws_acme, ["acme"]);
    assert.deepEqual(rules.excluded.prj_other, ["acme"]);
    const removed = await s.remove("acme");
    assert.equal(!removed.ok && removed.error, "active-account");
  });

  it("keeps chats opened by 1.3 on their project link working under the project's rules", async () => {
    const s = await setup();
    await s.laneFor("prj_other");
    await s.rules.update((rules) => void (rules.order = ["work", "home", "spare"]));
    await s.assignProjects("work", ["prj_acme"], { everywhere: false, known: ["prj_acme", "prj_other"] });
    assert.equal(await tokenThrough("prj_other"), "at-h@x.io");
  });

  it("converts a 1.2 project lane into a link without losing its login", async () => {
    const s = await setup();
    const legacy = join(data(), "lanes", "prj_old");
    await mkdir(legacy, { recursive: true });
    const renewed = JSON.stringify({
      claudeAiOauth: { accessToken: "lane-renewed", refreshToken: "r9", expiresAt: Date.now() + 9_000_000 },
    });
    await writeFile(join(legacy, ".credentials.json"), renewed);
    await writeFile(
      join(legacy, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "w@x.io", accountUuid: "uuid-w@x.io", organizationUuid: "org" } }),
    );
    await s.list();
    assert.equal(await readlink(link("prj_old")), accountDir("work"));
    assert.equal(await tokenThrough("prj_old"), "lane-renewed");
    const profile = parseLogin(await readFile(join(f.home, ".claude-work", ".credentials.json"), "utf8"));
    assert.equal(profile?.accessToken, "lane-renewed");
  });
});

describe("chats opened by 1.3", () => {
  let f: Fixture;
  beforeEach(async () => (f = await fixture()));
  afterEach(() => f.cleanup());

  it("hit their limit on their project's account, not on their workspace's", async () => {
    await addProfile(f.home, "home", { email: "h@x.io" });
    await addProfile(f.home, "spare", { email: "s@x.io" });
    await setLive(f.home, { email: "h@x.io" });
    const { service: s } = service(f);
    await s.know(["prj_a"], { ws_a: "prj_a" });
    await s.laneFor("prj_a");
    await s.laneFor("ws_a");
    await s.assignWorkspace("ws_a", ["spare"]);
    assert.equal(await s.scopeOfAgent("old-chat", "ws_a", "prj_a"), "prj_a");
    const moved = await s.failover("prj_a", false);
    assert.equal(moved.from, "home");
  });
});

describe("session opening", () => {
  let f: Fixture;
  beforeEach(async () => (f = await fixture()));
  afterEach(() => f.cleanup());

  const request = (env: Record<string, string> = {}, provider = "claude", workspaceId: string | null = "ws_a") => ({
    provider,
    env,
    workspaceId,
    agentId: "a",
  });

  it("points Claude chats at their workspace's link and leaves the rest alone", async () => {
    await addProfile(f.home, "home", { email: "h@x.io" });
    await setLive(f.home, { email: "h@x.io" });
    const { service: s } = service(f);
    const opened = await s.openSession(request({ KEEP: "1" }), "prj_a");
    assert.equal(opened?.env.CLAUDE_CONFIG_DIR, join(f.home, ".local/share/seamless-claude-accounts/lanes/ws_a"));
    assert.equal(opened?.env.KEEP, "1");
    assert.equal((await s.rules.read()).projectOf.ws_a, "prj_a");
    assert.equal(await s.openSession(request({}, "claude", null), null), undefined);
    assert.equal(await s.openSession(request({}, "codex"), "prj_a"), undefined);
    assert.equal(await s.openSession(request({ CLAUDE_CONFIG_DIR: "/custom" }), "prj_a"), undefined);
  });
});

describe("token renewals during a switch", () => {
  let f: Fixture;
  beforeEach(async () => (f = await fixture()));
  afterEach(() => f.cleanup());

  it("carry a login renewed in the dir an account just left to the dir it uses now", async () => {
    await addProfile(f.home, "home", { email: "h@x.io" });
    await addProfile(f.home, "work", { email: "w@x.io" });
    await setLive(f.home, { email: "h@x.io" });
    const { service: s } = service(f);
    await s.know(["prj_a"], { ws_a: "prj_a" });
    await s.laneFor("ws_a");
    await s.assignWorkspace("ws_a", ["work"]);
    const dir = join(f.home, ".local/share/seamless-claude-accounts/accounts/work");
    const renewed = JSON.stringify({
      claudeAiOauth: { accessToken: "renewed-in-old-dir", refreshToken: "r3", expiresAt: Date.now() + 9_000_000 },
    });
    await writeFile(join(dir, ".credentials.json"), renewed);
    await s.use("work");
    const live = parseLogin(await readFile(join(f.home, ".claude", ".credentials.json"), "utf8"));
    assert.equal(live?.accessToken, "renewed-in-old-dir");
  });
});
