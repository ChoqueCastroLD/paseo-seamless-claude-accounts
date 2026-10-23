import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { preferences, type Preferences } from "../shared/contracts.ts";
import { Failover, hitLimit, isLimitNotice } from "../server/failover.ts";
import { addProfile, fixture, service, setLive, type Fixture } from "./helpers.ts";

describe("isLimitNotice", () => {
  it("matches the notices Claude Code shows in place of an answer", () => {
    for (const text of [
      "You've hit your session limit · resets 11:30pm (Europe/Berlin)",
      "You've hit your weekly limit · resets Oct 28, 9am",
      "You've hit your limit · resets 3pm",
      "You have reached your Opus limit",
      "Claude AI usage limit reached|1791754200",
    ]) {
      assert.ok(isLimitNotice(text), text);
    }
  });

  it("ignores answers that only talk about limits", () => {
    for (const text of [
      "I added a check so that when you've hit your limit the UI says so.",
      "Rate limits are 50 requests per minute.",
      `You've hit your session limit ${"x".repeat(400)}`,
    ]) {
      assert.ok(!isLimitNotice(text), text);
    }
  });
});

describe("hitLimit", () => {
  const notice = { type: "assistant_message", text: "You've hit your session limit · resets 1am" };

  it("reads a failed turn's message", () => {
    assert.ok(hitLimit({ kind: "failed", error: { message: "You've hit your weekly limit" } }, []));
    assert.ok(!hitLimit({ kind: "failed", error: { message: "network down" } }, []));
  });

  it("reads the turn's last reply and nothing before the user's message", () => {
    assert.ok(hitLimit({ kind: "completed" }, [{ type: "user_message", text: "go" }, notice]));
    assert.ok(!hitLimit({ kind: "completed" }, [notice, { type: "user_message", text: "go" }]));
    assert.ok(
      !hitLimit({ kind: "completed" }, [
        { type: "user_message", text: "go" },
        notice,
        { type: "assistant_message", text: "done" },
      ]),
    );
    assert.ok(hitLimit({ kind: "completed" }, [{ type: "error", message: "You've hit your limit" }]));
  });

  it("never fires on a canceled turn", () => {
    assert.ok(!hitLimit({ kind: "canceled", reason: "user" }, [notice]));
  });
});

function fakePaseo(timelines: Record<string, Array<{ type: string; text?: string }>>) {
  const sent: Array<[string, string]> = [];
  const rows: Array<[string, Record<string, unknown>]> = [];
  const paseo = {
    agents: {
      ref: (id: string) => ({
        timeline: {
          refetch: async () => ({ entries: (timelines[id] ?? []).map((item) => ({ item })) }),
          append: async (item: { data: Record<string, unknown> }) => {
            rows.push([id, item.data]);
            return { seq: 1, epoch: "e" };
          },
        },
        send: async (text: string) => {
          sent.push([id, text]);
        },
      }),
    },
  };
  return { paseo: paseo as never, sent, rows };
}

const limited = [
  { type: "user_message", text: "build it" },
  { type: "assistant_message", text: "You've hit your session limit · resets 1am" },
];
const turn = (id: string, provider = "claude") => ({
  agent: { id, provider, workspaceId: null },
  outcome: { kind: "completed" } as const,
});

describe("Failover", () => {
  let f: Fixture;
  let prefs: Preferences;
  beforeEach(async () => {
    f = await fixture();
    prefs = preferences.schema.parse({});
  });
  afterEach(() => f.cleanup());

  async function setup(byToken: Parameters<typeof service>[1]) {
    await addProfile(f.home, "me", { email: "m@x.io" });
    await addProfile(f.home, "spare", { email: "s@x.io" });
    await addProfile(f.home, "busy", { email: "b@x.io" });
    await setLive(f.home, { email: "m@x.io" });
    const { service: s } = service(f, byToken);
    await s.rules.update((rules) => void (rules.order = ["me", "spare", "busy"]));
    return {
      s,
      failover: new Failover(
        s,
        async () => prefs,
        async () => null,
      ),
    };
  }

  const activeId = async (s: Awaited<ReturnType<typeof setup>>["s"]) =>
    (await s.list()).accounts.find((account) => account.active)?.id;

  it("moves to the next account in priority order and resumes the chat", async () => {
    const { s, failover } = await setup({
      "at-m@x.io": { five: 100, week: 40 },
      "at-s@x.io": { five: 10, week: 10 },
      "at-b@x.io": { five: 70, week: 10 },
    });
    const { paseo, sent, rows } = fakePaseo({ a1: limited });
    await failover.onTurnEnded(turn("a1"), paseo);
    assert.equal(await activeId(s), "spare");
    assert.deepEqual(sent, [["a1", "continue"]]);
    assert.deepEqual(rows, [["a1", { from: "me", to: "spare", reason: "limit", nextReset: null }]]);
    const { history } = await s.list();
    assert.equal(history[0]?.reason, "limit");
    assert.equal(history[0]?.resumed, 1);
  });

  it("switches once when many chats hit the limit together", async () => {
    const { s, failover } = await setup({
      "at-m@x.io": { five: 100, week: 40 },
      "at-s@x.io": { five: 10, week: 10 },
      "at-b@x.io": { five: 70, week: 10 },
    });
    const { paseo, sent } = fakePaseo({ a1: limited, a2: limited, a3: limited });
    await Promise.all(["a1", "a2", "a3"].map((id) => failover.onTurnEnded(turn(id), paseo)));
    assert.equal(await activeId(s), "spare");
    assert.equal((await s.list()).history.length, 1);
    assert.deepEqual(sent.map(([id]) => id).sort(), ["a1", "a2", "a3"]);
  });

  it("leaves a note and does not resume when every account is used up", async () => {
    const { s, failover } = await setup({
      "at-m@x.io": { five: 100, week: 40 },
      "at-s@x.io": { five: 100, week: 10 },
      "at-b@x.io": { five: 30, week: 100 },
    });
    const { paseo, sent, rows } = fakePaseo({ a1: limited });
    await failover.onTurnEnded(turn("a1"), paseo);
    assert.equal(await activeId(s), "me");
    assert.deepEqual(sent, []);
    assert.equal(rows[0]?.[1].to, null);
    assert.equal(rows[0]?.[1].nextReset, "2030-01-01T05:00:00.000Z");
  });

  it("does nothing for other providers, ordinary turns, or when turned off", async () => {
    const { s, failover } = await setup({ "at-s@x.io": { five: 10, week: 10 } });
    const { paseo, sent, rows } = fakePaseo({
      a1: limited,
      ok: [
        { type: "user_message", text: "hi" },
        { type: "assistant_message", text: "hello" },
      ],
    });
    await failover.onTurnEnded(turn("a1", "codex"), paseo);
    await failover.onTurnEnded(turn("ok"), paseo);
    prefs = { ...prefs, autoSwitch: false };
    await failover.onTurnEnded(turn("a1"), paseo);
    assert.equal(await activeId(s), "me");
    assert.deepEqual([sent, rows], [[], []]);
  });

  it("switches without sending anything when auto-continue is off", async () => {
    const { s, failover } = await setup({ "at-m@x.io": { five: 100, week: 40 }, "at-s@x.io": { five: 10, week: 10 } });
    prefs = { ...prefs, autoContinue: false, continuePrompt: "sigue" };
    const { paseo, sent, rows } = fakePaseo({ a1: limited });
    await failover.onTurnEnded(turn("a1"), paseo);
    assert.equal(await activeId(s), "spare");
    assert.deepEqual(sent, []);
    assert.equal(rows.length, 1);
  });

  it("uses the configured continue prompt", async () => {
    const { failover } = await setup({ "at-m@x.io": { five: 100, week: 40 }, "at-s@x.io": { five: 10, week: 10 } });
    prefs = { ...prefs, continuePrompt: "sigue donde lo dejaste" };
    const { paseo, sent } = fakePaseo({ a1: limited });
    await failover.onTurnEnded(turn("a1"), paseo);
    assert.deepEqual(sent, [["a1", "sigue donde lo dejaste"]]);
  });
});

describe("Failover thresholds", () => {
  let f: Fixture;
  let prefs: Preferences;
  beforeEach(async () => {
    f = await fixture();
    prefs = { ...preferences.schema.parse({}), preemptive: true, sessionThreshold: 80, weekThreshold: 90 };
  });
  afterEach(() => f.cleanup());

  async function run(byToken: Parameters<typeof service>[1], order = ["me", "spare"]) {
    await addProfile(f.home, "me", { email: "m@x.io" });
    await addProfile(f.home, "spare", { email: "s@x.io" });
    await setLive(f.home, { email: "m@x.io" });
    const { service: s } = service(f, byToken);
    await s.rules.update((rules) => void (rules.order = order));
    await new Failover(
      s,
      async () => prefs,
      async () => null,
    ).rebalance();
    return (await s.list()).accounts.find((account) => account.active)?.id;
  }

  it("switches when the session window crosses its threshold", async () => {
    assert.equal(await run({ "at-m@x.io": { five: 85, week: 10 }, "at-s@x.io": { five: 5, week: 5 } }), "spare");
  });

  it("switches when the weekly window crosses its threshold first", async () => {
    assert.equal(await run({ "at-m@x.io": { five: 5, week: 92 }, "at-s@x.io": { five: 5, week: 5 } }), "spare");
  });

  it("stays below both thresholds", async () => {
    assert.equal(await run({ "at-m@x.io": { five: 79, week: 89 }, "at-s@x.io": { five: 5, week: 5 } }), "me");
  });

  it("never moves to an account that is past a threshold itself", async () => {
    assert.equal(await run({ "at-m@x.io": { five: 95, week: 10 }, "at-s@x.io": { five: 5, week: 91 } }), "me");
  });

  it("returns to a higher-priority account once it frees up", async () => {
    prefs = { ...prefs, preemptive: false };
    const usage = { "at-m@x.io": { five: 10, week: 10 }, "at-s@x.io": { five: 5, week: 5 } };
    assert.equal(await run(usage, ["spare", "me"]), "spare");
  });

  it("keeps the current account when returning to priority is off", async () => {
    prefs = { ...prefs, preemptive: false, returnToPriority: false };
    const usage = { "at-m@x.io": { five: 10, week: 10 }, "at-s@x.io": { five: 5, week: 5 } };
    assert.equal(await run(usage, ["spare", "me"]), "me");
  });

  it("does nothing when thresholds and priority are off", async () => {
    prefs = { ...prefs, preemptive: false, returnToPriority: false };
    assert.equal(await run({ "at-m@x.io": { five: 100, week: 100 }, "at-s@x.io": { five: 5, week: 5 } }), "me");
  });
});
