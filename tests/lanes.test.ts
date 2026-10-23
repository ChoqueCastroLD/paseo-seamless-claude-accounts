import assert from "node:assert/strict";
import { lstat, mkdir, readFile, readlink, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseLogin } from "../server/store.ts";
import { addProfile, fixture, service, setLive, type Fixture } from "./helpers.ts";

describe("accounts per project", () => {
  let f: Fixture;
  beforeEach(async () => (f = await fixture()));
  afterEach(() => f.cleanup());

  const data = () => join(f.home, ".local", "share", "seamless-claude-accounts");
  const link = (project: string) => join(data(), "lanes", project);
  const accountDir = (id: string) => join(data(), "accounts", id);
  const tokenThrough = async (project: string) =>
    parseLogin(await readFile(join(link(project), ".credentials.json"), "utf8"))?.accessToken;

  async function setup(usage: Parameters<typeof service>[1] = {}) {
    await mkdir(join(f.home, ".claude", "projects"), { recursive: true });
    await addProfile(f.home, "home", { email: "h@x.io" });
    await addProfile(f.home, "spare", { email: "s@x.io" });
    await addProfile(f.home, "work", { email: "w@x.io" });
    await setLive(f.home, { email: "h@x.io" });
    const { service: s } = service(f, usage);
    await s.rules.update((rules) => void (rules.order = ["home", "spare", "work"]));
    return s;
  }

  it("opens every project's chats through a link to their account", async () => {
    const s = await setup();
    const dir = await s.laneFor("prj_other");
    assert.equal(dir, link("prj_other"));
    assert.equal(await readlink(link("prj_other")), join(f.home, ".claude"));
    assert.equal(await tokenThrough("prj_other"), "at-h@x.io");
    assert.equal(await readlink(join(f.home, ".claude", ".claude.json")), join(f.home, ".claude.json"));
    assert.equal(await s.laneFor(null), null);
  });

  it("moves a project's open chats when its account is limited to it", async () => {
    const s = await setup();
    await s.laneFor("prj_acme");
    await s.laneFor("prj_other");
    assert.deepEqual(await s.assignProjects("work", ["prj_acme"]), { ok: true });
    assert.equal(await readlink(link("prj_acme")), accountDir("work"));
    assert.equal(await tokenThrough("prj_acme"), "at-w@x.io");
    assert.equal(await tokenThrough("prj_other"), "at-h@x.io");
    const { accounts } = await s.list();
    const work = accounts.find((account) => account.id === "work");
    assert.deepEqual([work?.priority, work?.allowed, work?.usedBy], [1, ["prj_acme"], ["prj_acme"]]);
    assert.equal(accounts.find((account) => account.active)?.id, "home");
  });

  it("gives an account's dir everything in ~/.claude except its login and lock", async () => {
    const s = await setup();
    await writeFile(join(f.home, ".claude", ".oauth_refresh.lock"), "");
    await s.laneFor("prj_acme");
    await s.assignProjects("work", ["prj_acme"]);
    assert.equal(await readlink(join(accountDir("work"), "projects")), join(f.home, ".claude", "projects"));
    assert.ok((await lstat(join(accountDir("work"), ".credentials.json"))).isFile());
    assert.ok((await lstat(join(accountDir("work"), ".claude.json"))).isFile());
    assert.equal(await lstat(join(accountDir("work"), ".oauth_refresh.lock")).catch(() => null), null);
    assert.equal((await stat(accountDir("work"))).mode & 0o777, 0o700);
    const settings = JSON.parse(await readFile(join(accountDir("work"), ".claude.json"), "utf8"));
    assert.equal(settings.oauthAccount.emailAddress, "w@x.io");
  });

  it("falls back to the shared accounts when a project's own account runs out, then returns", async () => {
    const usage = { "at-w@x.io": { five: 10, week: 10 } };
    const s = await setup(usage);
    await s.laneFor("prj_acme");
    await s.assignProjects("work", ["prj_acme"]);
    usage["at-w@x.io"].five = 100;
    const moved = await s.failover("prj_acme", false);
    assert.deepEqual([moved.from, moved.to], ["work", "home"]);
    assert.equal(await readlink(link("prj_acme")), join(f.home, ".claude"));
    assert.equal(await tokenThrough("prj_acme"), "at-h@x.io");
  });

  it("moves every project off an account that runs out, outside projects included", async () => {
    const usage = { "at-h@x.io": { five: 10, week: 10 } };
    const s = await setup(usage);
    await s.laneFor("prj_a");
    await s.laneFor("prj_b");
    usage["at-h@x.io"].five = 100;
    const moved = await s.failover("prj_a", false);
    assert.deepEqual([moved.from, moved.to], ["home", "spare"]);
    const { accounts } = await s.list();
    assert.equal(accounts.find((account) => account.active)?.id, "spare");
    assert.equal(await tokenThrough("prj_a"), "at-s@x.io");
    assert.equal(await tokenThrough("prj_b"), "at-s@x.io");
    assert.equal(await readlink(link("prj_b")), join(f.home, ".claude"));
  });

  it("never keeps one account in two credential files", async () => {
    const { realpath } = await import("node:fs/promises");
    const usage = { "at-h@x.io": { five: 10, week: 10 }, "at-w@x.io": { five: 10, week: 10 } };
    const s = await setup(usage);
    const projects = ["prj_acme", "prj_a", "prj_b"];
    for (const project of projects) await s.laneFor(project);
    const check = async () => {
      const dirs = new Map<string, Set<string>>();
      for (const dir of [join(f.home, ".claude"), ...projects.map(link)]) {
        const real = await realpath(dir);
        const token = parseLogin(await readFile(join(real, ".credentials.json"), "utf8"))?.accessToken ?? "";
        dirs.set(token, (dirs.get(token) ?? new Set()).add(real));
      }
      for (const [token, found] of dirs) assert.equal(found.size, 1, `${token} lives in ${[...found].join(", ")}`);
    };
    await s.assignProjects("work", ["prj_acme"]);
    await check();
    await s.use("spare");
    await check();
    usage["at-h@x.io"].five = 100;
    await s.failover("prj_a", false);
    await check();
    await s.assignProjects("work", []);
    await s.use("work");
    await check();
  });

  it("puts a used account first and moves every project allowed to use it", async () => {
    const s = await setup();
    await s.laneFor("prj_a");
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
    assert.equal(await tokenThrough("prj_a"), "at-s@x.io");
    assert.equal(history[0]?.from, "home");
    assert.equal(history[0]?.everywhere, true);
  });

  it("keeps the renewed login of an account's dir in its profile", async () => {
    const s = await setup();
    await s.laneFor("prj_acme");
    await s.assignProjects("work", ["prj_acme"]);
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
    await s.laneFor("prj_acme");
    await s.assignProjects("work", ["prj_acme"]);
    assert.deepEqual(await s.rename("work", "acme"), { ok: true, id: "acme" });
    assert.equal(await readlink(link("prj_acme")), accountDir("acme"));
    assert.equal(await tokenThrough("prj_acme"), "at-w@x.io");
    const { accounts } = await s.list();
    assert.deepEqual(accounts.find((account) => account.id === "acme")?.allowed, ["prj_acme"]);
    const removed = await s.remove("acme");
    assert.equal(!removed.ok && removed.error, "active-account");
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

describe("session opening", () => {
  let f: Fixture;
  beforeEach(async () => (f = await fixture()));
  afterEach(() => f.cleanup());

  const request = (env: Record<string, string> = {}, provider = "claude") => ({ provider, env, agentId: "a" });

  it("points Claude chats at their project's link and leaves the rest alone", async () => {
    await addProfile(f.home, "home", { email: "h@x.io" });
    await setLive(f.home, { email: "h@x.io" });
    const { service: s } = service(f);
    const opened = await s.openSession(request({ KEEP: "1" }), "prj_a");
    assert.equal(opened?.env.CLAUDE_CONFIG_DIR, join(f.home, ".local/share/seamless-claude-accounts/lanes/prj_a"));
    assert.equal(opened?.env.KEEP, "1");
    assert.equal(await s.openSession(request(), null), undefined);
    assert.equal(await s.openSession(request({}, "codex"), "prj_a"), undefined);
    assert.equal(await s.openSession(request({ CLAUDE_CONFIG_DIR: "/custom" }), "prj_a"), undefined);
  });
});
