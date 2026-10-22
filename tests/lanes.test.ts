import assert from "node:assert/strict";
import { lstat, readFile, readlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseLogin } from "../server/store.ts";
import { addProfile, fixture, service, setLive, type Fixture } from "./helpers.ts";

describe("project lanes", () => {
  let f: Fixture;
  beforeEach(async () => (f = await fixture()));
  afterEach(() => f.cleanup());

  async function setup(usage: Parameters<typeof service>[1] = {}) {
    await addProfile(f.home, "home", { email: "l@x.io" });
    await addProfile(f.home, "spare", { email: "c@x.io" });
    await addProfile(f.home, "work", { email: "w@x.io" });
    await setLive(f.home, { email: "l@x.io" });
    const { service: s } = service(f, usage);
    await s.reorder(["home", "spare", "work"]);
    return s;
  }

  const lane = (project: string) => join(f.home, ".local", "share", "seamless-claude-accounts", "lanes", project);
  const laneToken = async (project: string) =>
    parseLogin(await readFile(join(lane(project), ".credentials.json"), "utf8"))?.accessToken;

  it("opens chats of a project with dedicated accounts in their own lane", async () => {
    const s = await setup();
    assert.deepEqual(await s.assignProjects("work", ["prj_res"]), { ok: true });
    assert.equal(await s.laneFor("prj_other"), null);
    assert.equal(await s.laneFor(null), null);
    const dir = await s.laneFor("prj_res");
    assert.equal(dir, lane("prj_res"));
    assert.equal(await laneToken("prj_res"), "at-w@x.io");
    assert.equal((await stat(lane("prj_res"))).mode & 0o777, 0o700);
    assert.equal((await stat(join(lane("prj_res"), ".credentials.json"))).mode & 0o777, 0o600);
    const { accounts, seats } = await s.list();
    assert.deepEqual(seats, { prj_res: "work" });
    assert.equal(accounts.find((account) => account.id === "work")?.seat, "prj_res");
    assert.deepEqual(accounts.find((account) => account.id === "work")?.projects, ["prj_res"]);
  });

  it("shares history and settings with the default config dir but not the login", async () => {
    const s = await setup();
    await s.assignProjects("work", ["prj_res"]);
    await s.laneFor("prj_res");
    assert.ok((await lstat(join(lane("prj_res"), ".credentials.json"))).isFile());
    assert.ok((await lstat(join(lane("prj_res"), ".claude.json"))).isFile());
    const settings = JSON.parse(await readFile(join(lane("prj_res"), ".claude.json"), "utf8"));
    assert.equal(settings.oauthAccount.emailAddress, "w@x.io");
    assert.equal(settings.theme, "dark");
    const live = JSON.parse(await readFile(join(f.home, ".claude.json"), "utf8"));
    assert.equal(live.oauthAccount.emailAddress, "l@x.io");
  });

  it("links every entry of the default config dir into the lane", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(f.home, ".claude", "projects"), { recursive: true });
    const s = await setup();
    await s.assignProjects("work", ["prj_res"]);
    await s.laneFor("prj_res");
    assert.equal(await readlink(join(lane("prj_res"), "projects")), join(f.home, ".claude", "projects"));
  });

  it("falls back to a shared account that is not live elsewhere when the dedicated one runs out", async () => {
    const usage = { "at-w@x.io": { five: 10, week: 10 }, "at-c@x.io": { five: 5, week: 5 } };
    const s = await setup(usage);
    await s.assignProjects("work", ["prj_res"]);
    assert.equal(await s.laneFor("prj_res"), lane("prj_res"));
    assert.equal(await laneToken("prj_res"), "at-w@x.io");
    await s.attach("agent-1", "prj_res");
    usage["at-w@x.io"].five = 100;
    await s.markExhausted("work");
    const next = await s.pickNext("prj_res");
    assert.equal(next.id, "spare");
    assert.deepEqual(await s.use("spare", { seat: "prj_res" }), { ok: true, email: "c@x.io" });
    assert.equal(await laneToken("prj_res"), "at-c@x.io");
    const { accounts } = await s.list();
    assert.equal(accounts.find((account) => account.active)?.id, "home");
  });

  it("never lets a dedicated account into other projects", async () => {
    const s = await setup();
    await s.assignProjects("work", ["prj_res"]);
    const result = await s.use("work", { seat: "default" });
    assert.equal(!result.ok && result.error, "not-allowed");
  });

  it("moves an account out of another seat when it is chosen here", async () => {
    const s = await setup();
    await s.assignProjects("work", ["prj_res"]);
    await s.laneFor("prj_res");
    await s.attach("agent-1", "prj_res");
    await s.use("spare", { seat: "prj_res" });
    assert.deepEqual(await s.use("spare"), { ok: true, email: "c@x.io" });
    const { accounts, seats } = await s.list();
    assert.equal(accounts.find((account) => account.active)?.id, "spare");
    assert.equal(seats.prj_res, "work");
  });

  it("refuses to take an account from a seat that has nothing else", async () => {
    await addProfile(f.home, "work", { email: "w@x.io" });
    await setLive(f.home, { email: "l@x.io" });
    const { service: s } = service(f);
    await s.assignProjects("work", ["prj_res"]);
    await s.laneFor("prj_res");
    await s.attach("agent-1", "prj_res");
    await s.assignProjects("work", []);
    const result = await s.use("work");
    assert.equal(!result.ok && result.error, "busy-elsewhere");
  });

  it("moves a newly dedicated account out of the shared seat", async () => {
    const s = await setup();
    await s.assignProjects("home", ["prj_res"]);
    const { accounts } = await s.list();
    assert.equal(accounts.find((account) => account.active)?.id, "spare");
  });

  it("frees a shared account when the project's last chat closes", async () => {
    const s = await setup();
    await s.assignProjects("work", ["prj_res"]);
    await s.laneFor("prj_res");
    await s.attach("agent-1", "prj_res");
    await s.use("spare", { seat: "prj_res" });
    assert.equal((await s.list()).seats.prj_res, "spare");
    await s.detach(["agent-1"]);
    const { seats } = await s.list();
    assert.equal(seats.prj_res, "work");
  });

  it("keeps the rotated lane token in the profile", async () => {
    const { writeFile } = await import("node:fs/promises");
    const s = await setup();
    await s.assignProjects("work", ["prj_res"]);
    await s.laneFor("prj_res");
    const rotated = JSON.stringify({
      claudeAiOauth: { accessToken: "renewed", refreshToken: "r2", expiresAt: Date.now() + 9_000_000 },
    });
    await writeFile(join(lane("prj_res"), ".credentials.json"), rotated);
    await s.list();
    const profile = parseLogin(await readFile(join(f.home, ".claude-work", ".credentials.json"), "utf8"));
    assert.equal(profile?.accessToken, "renewed");
  });

  it("follows renames and removals", async () => {
    const s = await setup();
    await s.assignProjects("work", ["prj_res"]);
    await s.laneFor("prj_res");
    await s.reorder(["work", "home", "spare"]);
    assert.deepEqual(await s.rename("work", "acme"), { ok: true, id: "acme" });
    const { accounts, seats } = await s.list();
    assert.deepEqual(seats, { prj_res: "acme" });
    assert.deepEqual(
      accounts.map((account) => [account.id, account.priority]),
      [
        ["acme", 1],
        ["home", 2],
        ["spare", 3],
      ],
    );
    const removed = await s.remove("acme");
    assert.equal(!removed.ok && removed.error, "active-account");
  });
});

describe("session opening", () => {
  let f: Fixture;
  beforeEach(async () => (f = await fixture()));
  afterEach(() => f.cleanup());

  const request = (env: Record<string, string> = {}, provider = "claude") => ({
    agentId: "agent-9",
    workspaceId: "wks_1",
    provider,
    cwd: "/w",
    reason: "create" as const,
    purpose: "interactive" as const,
    env,
  });

  async function setup() {
    await addProfile(f.home, "home", { email: "l@x.io" });
    await addProfile(f.home, "work", { email: "w@x.io" });
    await setLive(f.home, { email: "l@x.io" });
    const { service: s } = service(f);
    await s.assignProjects("work", ["prj_res"]);
    return s;
  }

  it("points Claude chats of a project with its own accounts at the project's lane", async () => {
    const s = await setup();
    const opened = await s.openSession(request({ KEEP: "1" }), "prj_res");
    assert.equal(opened?.env.CLAUDE_CONFIG_DIR, join(f.home, ".local/share/seamless-claude-accounts/lanes/prj_res"));
    assert.equal(opened?.env.KEEP, "1");
    assert.equal(await s.seatOfAgent("agent-9"), "prj_res");
  });

  it("leaves other projects, other providers and explicit config dirs alone", async () => {
    const s = await setup();
    assert.equal(await s.openSession(request(), "prj_other"), undefined);
    assert.equal(await s.openSession(request(), null), undefined);
    assert.equal(await s.openSession(request({}, "codex"), "prj_res"), undefined);
    assert.equal(await s.openSession(request({ CLAUDE_CONFIG_DIR: "/custom" }), "prj_res"), undefined);
    assert.equal(await s.seatOfAgent("agent-9"), "default");
  });
});
