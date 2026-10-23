import assert from "node:assert/strict";
import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseIdentity, parseLogin, pathsFor, StoreError, writeAtomic } from "../server/store.ts";
import { slug } from "../shared/names.ts";
import { accountBlock, addProfile, credentials, fixture, readJson, setLive, type Fixture } from "./helpers.ts";

describe("parsing", () => {
  it("reads the OAuth login and ignores everything else", () => {
    const login = parseLogin(credentials({ email: "a@x.io", expiresAt: 5, refreshExpiresAt: 9 }));
    assert.deepEqual(login, { accessToken: "at-a@x.io", refreshToken: "rt-a@x.io", expiresAt: 5, refreshExpiresAt: 9 });
  });

  it("rejects files without a claude.ai token", () => {
    assert.equal(parseLogin("not json"), null);
    assert.equal(parseLogin(JSON.stringify({ claudeAiOauth: { accessToken: "" } })), null);
    assert.equal(parseLogin(JSON.stringify({ apiKey: "sk-ant" })), null);
  });

  it("accepts a refresh expiry stored as a string", () => {
    const raw = JSON.stringify({ claudeAiOauth: { accessToken: "t", refreshTokenExpiresAt: "1795000000000" } });
    assert.equal(parseLogin(raw)?.refreshExpiresAt, 1795000000000);
  });

  it("keys an identity by account and organization, falling back to the email", () => {
    assert.equal(parseIdentity(accountBlock("a@x.io"))?.key, "uuid-a@x.io/org");
    assert.equal(parseIdentity({ emailAddress: "A@X.io" })?.key, "email:a@x.io");
    assert.equal(parseIdentity({}), null);
    assert.equal(parseIdentity(null), null);
  });

  it("turns free text into a safe profile name", () => {
    assert.equal(slug("Trabajo Señor"), "trabajo-senor");
    assert.equal(slug("../../etc"), "etc");
    assert.equal(slug("///"), null);
    assert.equal(slug("-a-"), "a");
  });

  it("finds the live login under CLAUDE_CONFIG_DIR when it is set", () => {
    assert.deepEqual(pathsFor("/h"), {
      home: "/h",
      live: "/h/.claude",
      liveSettings: "/h/.claude.json",
      data: "/h/.local/share/seamless-claude-accounts",
    });
    const custom = pathsFor("/h", { CLAUDE_CONFIG_DIR: "/srv/claude" });
    assert.equal(custom.live, "/srv/claude");
    assert.equal(custom.liveSettings, "/srv/claude/.claude.json");
  });
});

describe("writeAtomic", () => {
  let f: Fixture;
  beforeEach(async () => (f = await fixture()));
  afterEach(() => f.cleanup());

  it("writes owner-only and leaves no temporary file", async () => {
    const path = join(f.home, "secret.json");
    await writeAtomic(path, "{}");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(f.home), ["secret.json"]);
  });

  it("never loosens the mode of the file it replaces", async () => {
    const path = join(f.home, "settings.json");
    await writeFile(path, "{}", { mode: 0o644 });
    await writeAtomic(path, '{"a":1}');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await chmod(path, 0o400);
    await writeAtomic(path, "{}");
    assert.equal((await stat(path)).mode & 0o777, 0o400);
  });
});

describe("Store", () => {
  let f: Fixture;
  beforeEach(async () => (f = await fixture()));
  afterEach(() => f.cleanup());

  it("discovers profiles and ignores what is not one", async () => {
    await addProfile(f.home, "work", { email: "w@x.io" });
    await mkdir(join(f.home, ".claude-empty"));
    await mkdir(join(f.home, ".claude-pending"));
    await writeFile(join(f.home, ".claude-pending", ".claude.json"), "{}");
    await mkdir(join(f.home, ".claude-bad name"));
    await writeFile(join(f.home, ".claude-bad name", ".credentials.json"), "{}");
    await setLive(f.home, { email: "w@x.io" });

    const profiles = await f.store.profiles();
    assert.deepEqual(
      profiles.map((profile) => [profile.id, profile.login !== null, profile.identity?.email ?? null]),
      [
        ["pending", false, null],
        ["work", true, "w@x.io"],
      ],
    );
  });

  it("saves a live login that has no profile before anything can replace it", async () => {
    await setLive(f.home, { email: "jane.doe@x.io" });
    const owner = await f.store.sync();
    assert.equal(owner?.id, "jane-doe");
    const saved = await readFile(join(f.home, ".claude-jane-doe", ".credentials.json"), "utf8");
    assert.equal(saved, await readFile(join(f.home, ".claude", ".credentials.json"), "utf8"));
    assert.equal((await stat(join(f.home, ".claude-jane-doe"))).mode & 0o777, 0o700);
    assert.equal(
      (await readJson(join(f.home, ".claude-jane-doe", ".claude.json"))).oauthAccount.emailAddress,
      "jane.doe@x.io",
    );
  });

  it("does not take a name that is already in use", async () => {
    await addProfile(f.home, "luis", { email: "other@x.io" });
    await setLive(f.home, { email: "luis@x.io" });
    assert.equal((await f.store.sync())?.id, "luis-2");
  });

  it("copies a token Claude Code renewed back into the profile", async () => {
    await addProfile(f.home, "work", { email: "w@x.io", token: "old", refresh: "old-r", expiresAt: 1_000 });
    await setLive(f.home, { email: "w@x.io", token: "new", refresh: "new-r", expiresAt: 2_000 });
    await f.store.sync();
    const stored = parseLogin(await readFile(join(f.home, ".claude-work", ".credentials.json"), "utf8"));
    assert.equal(stored?.refreshToken, "new-r");
  });

  it("never overwrites a newer login in the profile with an older live one", async () => {
    await addProfile(f.home, "work", { email: "w@x.io", token: "fresh", expiresAt: 9_000 });
    await setLive(f.home, { email: "w@x.io", token: "stale", expiresAt: 1_000 });
    await f.store.sync();
    const stored = parseLogin(await readFile(join(f.home, ".claude-work", ".credentials.json"), "utf8"));
    assert.equal(stored?.accessToken, "fresh");
  });

  it("recognizes the owner by refresh token when the account block is missing", async () => {
    await addProfile(f.home, "work", { email: "w@x.io", refresh: "shared" });
    await mkdir(join(f.home, ".claude"), { recursive: true });
    await writeFile(join(f.home, ".claude", ".credentials.json"), credentials({ email: "w@x.io", refresh: "shared" }));
    assert.equal((await f.store.sync())?.id, "work");
    assert.equal((await f.store.profiles()).length, 1);
  });

  it("switches by replacing the credential file and moving the account block", async () => {
    await addProfile(f.home, "home", { email: "h@x.io" });
    await addProfile(f.home, "work", { email: "w@x.io" });
    await setLive(f.home, { email: "h@x.io" }, { theme: "dark", projects: { a: 1 } });

    const result = await f.store.install("work");
    assert.equal(result.changed, true);
    assert.equal(result.from?.id, "home");
    const live = await readFile(join(f.home, ".claude", ".credentials.json"), "utf8");
    assert.equal(live, await readFile(join(f.home, ".claude-work", ".credentials.json"), "utf8"));
    assert.equal((await stat(join(f.home, ".claude", ".credentials.json"))).mode & 0o777, 0o600);
    const settings = await readJson(join(f.home, ".claude.json"));
    assert.equal(settings.oauthAccount.emailAddress, "w@x.io");
    assert.equal(settings.theme, "dark");
    assert.deepEqual(settings.projects, { a: 1 });
  });

  it("switching back restores the first login exactly, including renewals made while live", async () => {
    await addProfile(f.home, "home", { email: "h@x.io", expiresAt: 1_000 });
    await addProfile(f.home, "work", { email: "w@x.io" });
    await setLive(f.home, { email: "h@x.io", token: "renewed", expiresAt: 5_000 });
    await f.store.install("work");
    await f.store.install("home");
    const live = parseLogin(await readFile(join(f.home, ".claude", ".credentials.json"), "utf8"));
    assert.equal(live?.accessToken, "renewed");
  });

  it("reports no change when asked for the account already live", async () => {
    await addProfile(f.home, "home", { email: "h@x.io" });
    await setLive(f.home, { email: "h@x.io" });
    assert.equal((await f.store.install("home")).changed, false);
  });

  it("refuses unknown, empty and malformed profiles", async () => {
    await setLive(f.home, { email: "h@x.io" });
    await mkdir(join(f.home, ".claude-pending"));
    await writeFile(join(f.home, ".claude-pending", ".claude.json"), "{}");
    await mkdir(join(f.home, ".claude-broken"));
    await writeFile(join(f.home, ".claude-broken", ".credentials.json"), "{oops");
    const code = (id: string) =>
      f.store.install(id).then(
        () => "ok",
        (error: StoreError) => error.code,
      );
    assert.equal(await code("nobody"), "unknown-account");
    assert.equal(await code("pending"), "no-login");
    assert.equal(await code("broken"), "invalid-login");
    const live = parseLogin(await readFile(join(f.home, ".claude", ".credentials.json"), "utf8"));
    assert.equal(live?.accessToken, "at-h@x.io");
  });

  it("leaves a settings file that is not JSON alone", async () => {
    await addProfile(f.home, "work", { email: "w@x.io" });
    await setLive(f.home, { email: "h@x.io" });
    await writeFile(join(f.home, ".claude.json"), "{corrupt");
    await f.store.install("work");
    assert.equal(await readFile(join(f.home, ".claude.json"), "utf8"), "{corrupt");
  });

  it("serializes concurrent switches", async () => {
    await addProfile(f.home, "a", { email: "a@x.io" });
    await addProfile(f.home, "b", { email: "b@x.io" });
    await setLive(f.home, { email: "a@x.io" });
    await Promise.all([f.store.install("b"), f.store.install("a"), f.store.install("b")]);
    const settings = await readJson(join(f.home, ".claude.json"));
    assert.equal(settings.oauthAccount.emailAddress, "b@x.io");
    assert.equal(
      parseLogin(await readFile(join(f.home, ".claude", ".credentials.json"), "utf8"))?.accessToken,
      "at-b@x.io",
    );
  });

  it("renames a profile and validates the new name", async () => {
    await addProfile(f.home, "work", { email: "w@x.io" });
    await addProfile(f.home, "home", { email: "h@x.io" });
    assert.equal(await f.store.rename("work", "Office"), "office");
    assert.deepEqual(
      (await f.store.profiles()).map((profile) => profile.id),
      ["home", "office"],
    );
    await assert.rejects(f.store.rename("office", "home"), { code: "name-taken" });
    await assert.rejects(f.store.rename("office", "../x"), { code: "invalid-name" });
    await assert.rejects(f.store.rename("nobody", "x"), { code: "unknown-account" });
  });

  it("moves a removed profile to the trash and refuses the live one", async () => {
    await addProfile(f.home, "home", { email: "h@x.io" });
    await addProfile(f.home, "work", { email: "w@x.io" });
    await setLive(f.home, { email: "h@x.io" });
    await assert.rejects(f.store.remove("home"), { code: "active-account" });
    const trash = await f.store.remove("work");
    assert.ok(trash.startsWith(join(f.home, ".local", "share", "seamless-claude-accounts", "trash", ".claude-work-")));
    assert.equal((await readJson(join(trash, ".claude.json"))).oauthAccount.emailAddress, "w@x.io");
    assert.deepEqual(
      (await f.store.profiles()).map((profile) => profile.id),
      ["home"],
    );
  });

  it("only discards profile directories in the home", async () => {
    const outside = join(f.home, "keep");
    await mkdir(outside);
    await f.store.discard(outside);
    await f.store.discard(join(f.home, ".claude"));
    assert.ok((await stat(outside)).isDirectory());
  });
});
