import assert from "node:assert/strict";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { AccountService } from "../server/service.ts";
import { UsageReader } from "../server/usage.ts";
import { addProfile, fixture, service, setLive, type Fixture } from "./helpers.ts";

describe("AccountService.list", () => {
  let f: Fixture;
  beforeEach(async () => (f = await fixture()));
  afterEach(() => f.cleanup());

  it("lists each account once, in priority order, with where it is live", async () => {
    await addProfile(f.home, "busy", { email: "b@x.io" });
    await addProfile(f.home, "idle", { email: "i@x.io" });
    await addProfile(f.home, "me", { email: "m@x.io" });
    await setLive(f.home, { email: "m@x.io" });
    const { service: s } = service(f, {
      "at-b@x.io": { five: 80, week: 10 },
      "at-i@x.io": { five: 5, week: 5 },
      "at-m@x.io": { five: 50, week: 50 },
    });
    await s.reorder(["idle", "me"]);
    const { accounts, target } = await s.list();
    assert.deepEqual(
      accounts.map((account) => [account.id, account.priority, account.active, account.seat]),
      [
        ["idle", 1, false, null],
        ["me", 2, true, "default"],
        ["busy", 3, false, null],
      ],
    );
    assert.equal(target, join(f.home, ".claude", ".credentials.json"));
    assert.equal(accounts[0]?.usage?.fiveHour?.percent, 5);
    assert.equal(accounts[1]?.plan, "claude_max");
  });

  it("creates the profile for a live login that had none", async () => {
    await setLive(f.home, { email: "solo@x.io" });
    const { accounts } = await service(f).service.list();
    assert.deepEqual(
      accounts.map((account) => [account.id, account.email, account.active]),
      [["solo", "solo@x.io", true]],
    );
  });

  it("flags logins that need signing in again", async () => {
    await addProfile(f.home, "old", { email: "o@x.io", refreshExpiresAt: 1 });
    await mkdir(join(f.home, ".claude-new"));
    await writeFile(join(f.home, ".claude-new", ".claude.json"), "{}");
    await setLive(f.home, { email: "m@x.io" });
    const { accounts } = await service(f).service.list();
    const status = Object.fromEntries(accounts.map((account) => [account.id, account.status]));
    assert.deepEqual(status, { m: "ready", old: "relogin", new: "no-login" });
  });
});

describe("AccountService.use", () => {
  let f: Fixture;
  beforeEach(async () => (f = await fixture()));
  afterEach(() => f.cleanup());

  it("switches and records it in the history", async () => {
    await addProfile(f.home, "work", { email: "w@x.io" });
    await setLive(f.home, { email: "h@x.io" });
    const { service: s } = service(f);
    assert.deepEqual(await s.use("work"), { ok: true, email: "w@x.io" });
    const { accounts, history } = await s.list();
    assert.equal(accounts.find((account) => account.active)?.id, "work");
    assert.equal(history.length, 1);
    assert.deepEqual(
      { ...history[0], at: "" },
      { at: "", seat: "default", from: "h", to: "work", reason: "manual", resumed: 0 },
    );
  });

  it("reports failures as codes", async () => {
    await setLive(f.home, { email: "h@x.io" });
    const result = await service(f).service.use("ghost");
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.error, "unknown-account");
  });
});

describe("AccountService.pickNext", () => {
  let f: Fixture;
  beforeEach(async () => (f = await fixture()));
  afterEach(() => f.cleanup());

  it("picks the first account in priority order that still has allowance", async () => {
    await addProfile(f.home, "a", { email: "a@x.io" });
    await addProfile(f.home, "b", { email: "b@x.io" });
    await addProfile(f.home, "full", { email: "f@x.io" });
    await setLive(f.home, { email: "m@x.io" });
    const { service: s } = service(f, {
      "at-a@x.io": { five: 60, week: 10 },
      "at-b@x.io": { five: 20, week: 30 },
      "at-f@x.io": { five: 100, week: 1 },
    });
    await s.reorder(["full", "a", "b"]);
    assert.equal((await s.pickNext()).id, "a");
    assert.equal((await s.pickNext("default", { below: { session: 50, week: 50 } })).id, "b");
    assert.equal((await s.pickNext("default", { below: { session: 10, week: 50 } })).id, null);
  });

  it("skips an account marked as used up and reports when one frees up", async () => {
    await addProfile(f.home, "a", { email: "a@x.io" });
    await setLive(f.home, { email: "m@x.io" });
    const { service: s } = service(f, { "at-m@x.io": { five: 100, week: 50 }, "at-a@x.io": { five: 100, week: 50 } });
    const live = await s.current("default");
    await s.markExhausted(live!.id);
    const next = await s.pickNext();
    assert.equal(next.id, null);
    assert.equal(next.nextReset, "2030-01-01T05:00:00.000Z");
  });
});

describe("AccountService login", () => {
  let f: Fixture;
  beforeEach(async () => (f = await fixture()));
  afterEach(() => f.cleanup());

  it("adds an account from the link and the pasted code", async () => {
    await setLive(f.home, { email: "m@x.io" });
    const { service: s } = service(f);
    const started = await s.startLogin("Trabajo");
    assert.ok(started.ok);
    assert.equal(started.id, "trabajo");
    assert.match(started.url, /^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
    const finished = await s.finishLogin(started.session, "good-t@x.io");
    assert.deepEqual(finished, { ok: true, id: "trabajo", email: "t@x.io" });
    assert.equal((await stat(join(f.home, ".claude-trabajo"))).mode & 0o777, 0o700);
    assert.equal((await s.list()).accounts.find((account) => account.active)?.id, "m");
  });

  it("removes the new directory when the code is rejected", async () => {
    await setLive(f.home, { email: "m@x.io" });
    const { service: s } = service(f);
    const started = await s.startLogin("nope");
    assert.ok(started.ok);
    const finished = await s.finishLogin(started.session, "wrong");
    assert.equal(!finished.ok && finished.error, "login-failed");
    assert.match(!finished.ok ? finished.detail : "", /400/);
    assert.ok(!(await readdir(f.home)).includes(".claude-nope"));
  });

  it("refuses a second profile for an account that already has one", async () => {
    await addProfile(f.home, "work", { email: "w@x.io" });
    await setLive(f.home, { email: "m@x.io" });
    const { service: s } = service(f);
    const started = await s.startLogin("again");
    assert.ok(started.ok);
    const finished = await s.finishLogin(started.session, "good-w@x.io");
    assert.deepEqual(finished, { ok: false, error: "login-duplicate", detail: "work" });
    assert.ok(!(await readdir(f.home)).includes(".claude-again"));
  });

  it("signs an existing profile in again without deleting it on failure", async () => {
    await addProfile(f.home, "work", { email: "w@x.io", refreshExpiresAt: 1 });
    await setLive(f.home, { email: "m@x.io" });
    const { service: s } = service(f);
    const started = await s.startLogin("work");
    assert.ok(started.ok);
    await s.finishLogin(started.session, "wrong");
    assert.ok((await readdir(f.home)).includes(".claude-work"));
  });

  it("will not sign in the live profile again", async () => {
    await setLive(f.home, { email: "m@x.io" });
    const { service: s } = service(f);
    await s.list();
    const started = await s.startLogin("m");
    assert.equal(!started.ok && started.error, "active-account");
  });

  it("cancels a login and cleans up", async () => {
    await setLive(f.home, { email: "m@x.io" });
    const { service: s } = service(f);
    const started = await s.startLogin("later");
    assert.ok(started.ok);
    await s.cancelLogin(started.session);
    assert.ok(!(await readdir(f.home)).includes(".claude-later"));
    const finished = await s.finishLogin(started.session, "good-l@x.io");
    assert.equal(!finished.ok && finished.error, "login-expired");
  });

  it("explains a missing claude binary", async () => {
    await setLive(f.home, { email: "m@x.io" });
    const s = new AccountService({
      store: f.store,
      usage: new UsageReader({ cacheFile: join(f.home, "u.json"), version: Promise.resolve("2.1.0") }),
      binary: join(f.home, "no-such-claude"),
    });
    const started = await s.startLogin("x");
    assert.equal(!started.ok && started.error, "claude-missing");
  });
});

describe("AccountService order", () => {
  let f: Fixture;
  beforeEach(async () => (f = await fixture()));
  afterEach(() => f.cleanup());

  it("starts the priority order with the account already in use", async () => {
    await addProfile(f.home, "alpha", { email: "a@x.io" });
    await addProfile(f.home, "zulu", { email: "z@x.io" });
    await setLive(f.home, { email: "z@x.io" });
    const { accounts } = await service(f).service.list();
    assert.deepEqual(
      accounts.map((account) => [account.id, account.priority]),
      [
        ["zulu", 1],
        ["alpha", 2],
      ],
    );
  });
});
