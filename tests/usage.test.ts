import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fullUntil, IdentityReader, parseUsage, UsageReader } from "../server/usage.ts";
import { peak, settle } from "../shared/usage.ts";
import { fixture, usageFetch, type Fixture } from "./helpers.ts";

const login = (token: string, expiresAt: number | null = null) => ({
  accessToken: token,
  refreshToken: "r",
  expiresAt,
  refreshExpiresAt: null,
});

describe("parseUsage", () => {
  it("reads both windows and clamps percents", () => {
    const usage = parseUsage(
      { five_hour: { utilization: 130, resets_at: "2030-01-01T05:00:00Z" }, seven_day: { utilization: "12.5" } },
      0,
    );
    assert.deepEqual(usage, {
      fiveHour: { percent: 100, resetsAt: "2030-01-01T05:00:00.000Z" },
      week: { percent: 12.5, resetsAt: null },
      fetchedAt: "1970-01-01T00:00:00.000Z",
    });
  });

  it("returns null when neither window is present", () => {
    assert.equal(parseUsage({ five_hour: null }, 0), null);
    assert.equal(parseUsage("nope", 0), null);
  });

  it("finds the binding window and when a full one frees up", () => {
    const usage = parseUsage(
      {
        five_hour: { utilization: 100, resets_at: "2030-01-01T05:00:00Z" },
        seven_day: { utilization: 40, resets_at: "2030-01-07T00:00:00Z" },
      },
      0,
    );
    assert.equal(peak(usage), 100);
    assert.equal(fullUntil(usage), "2030-01-01T05:00:00.000Z");
    assert.equal(fullUntil(parseUsage({ five_hour: { utilization: 50 } }, 0)), null);
    assert.equal(peak(null), null);
  });
});

describe("settle", () => {
  it("empties windows that have reset since the reading", () => {
    const usage = {
      fiveHour: { percent: 100, resetsAt: "2026-01-01T05:00:00.000Z" },
      week: { percent: 40, resetsAt: "2026-01-07T00:00:00.000Z" },
      fetchedAt: "2026-01-01T00:00:00.000Z",
    };
    const later = settle(usage, Date.parse("2026-01-02T00:00:00Z"));
    assert.deepEqual([later.fiveHour?.percent, later.fiveHour?.resetsAt, later.week?.percent], [0, null, 40]);
    assert.equal(settle(null, 0), null);
  });
});

describe("UsageReader", () => {
  let f: Fixture;
  beforeEach(async () => (f = await fixture()));
  afterEach(() => f.cleanup());

  const reader = (fake: typeof fetch) =>
    new UsageReader({ cacheFile: join(f.home, "cache", "usage.json"), version: Promise.resolve("9.9.9"), fetch: fake });

  it("sends the headers the endpoint requires", async () => {
    let headers: Record<string, string> = {};
    const fake = (async (_url: unknown, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ five_hour: { utilization: 1 } }));
    }) as typeof fetch;
    await reader(fake).read("k", login("tok"));
    assert.equal(headers.Authorization, "Bearer tok");
    assert.equal(headers["anthropic-beta"], "oauth-2025-04-20");
    assert.equal(headers["User-Agent"], "claude-code/9.9.9");
  });

  it("reuses a fresh reading and asks again when forced", async () => {
    const { fetch: fake, calls } = usageFetch({ tok: { five: 10, week: 20 } });
    const usage = reader(fake);
    await usage.read("k", login("tok"), { now: 1_000_000 });
    await usage.read("k", login("tok"), { now: 1_030_000 });
    assert.equal(calls.length, 1);
    await usage.read("k", login("tok"), { now: 1_030_000, force: true });
    assert.equal(calls.length, 2);
    await usage.read("k", login("tok"), { now: 1_100_000 });
    assert.equal(calls.length, 3);
  });

  it("backs off after a refusal, keeping the last good reading", async () => {
    const answers = { tok: { five: 10, week: 20 } as { five: number; week: number; status?: number } };
    const { fetch: fake, calls } = usageFetch(answers);
    const usage = reader(fake);
    await usage.read("k", login("tok"), { now: 0 });
    answers.tok.status = 429;
    const kept = await usage.read("k", login("tok"), { now: 120_000, force: true });
    assert.equal(kept?.fiveHour?.percent, 10);
    await usage.read("k", login("tok"), { now: 240_000, force: true });
    assert.equal(calls.length, 2);
  });

  it("does not spend a request on an expired token", async () => {
    const { fetch: fake, calls } = usageFetch({});
    assert.equal(await reader(fake).read("k", login("tok", 500), { now: 1_000 }), null);
    assert.equal(calls.length, 0);
  });

  it("survives a failing fetch", async () => {
    const fake = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    assert.equal(await reader(fake).read("k", login("tok")), null);
  });

  it("remembers readings across restarts in an owner-only file", async () => {
    const { fetch: fake } = usageFetch({ tok: { five: 33, week: 44 } });
    await reader(fake).read("k", login("tok"));
    const file = join(f.home, "cache", "usage.json");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.ok(!(await readFile(file, "utf8")).includes("tok"), "the cache must not hold tokens");
    const restarted = reader(usageFetch({}).fetch);
    assert.equal((await restarted.known("k"))?.week?.percent, 44);
  });
});

describe("IdentityReader", () => {
  it("names the account and organization of a token, caches it, and admits failure", async () => {
    let calls = 0;
    const answer = (status: number, body: unknown) =>
      (async () => {
        calls += 1;
        return new Response(JSON.stringify(body), { status });
      }) as typeof fetch;
    const ok = new IdentityReader({
      version: Promise.resolve("2.1.0"),
      fetch: answer(200, { account: { uuid: "u1", email: "a@x.io" }, organization: { uuid: "o1" } }),
    });
    assert.deepEqual(await ok.whoIs("token", 0), { key: "u1/o1", email: "a@x.io" });
    assert.deepEqual(await ok.whoIs("token", 1_000), { key: "u1/o1", email: "a@x.io" });
    assert.equal(calls, 1);
    const refused = new IdentityReader({ version: Promise.resolve("2.1.0"), fetch: answer(401, {}) });
    assert.equal(await refused.whoIs("token"), null);
    const offline = new IdentityReader({
      version: Promise.resolve("2.1.0"),
      fetch: (async () => {
        throw new Error("offline");
      }) as typeof fetch,
    });
    assert.equal(await offline.whoIs("token"), null);
  });
});
