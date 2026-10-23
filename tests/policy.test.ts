import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  allowEverywhere,
  allows,
  plan,
  prioritized,
  projectsOf,
  promote,
  resolve,
  setProjects,
  type Rules,
} from "../server/policy.ts";
import { migrate, parseRules } from "../server/state.ts";

const rules = (overrides: Partial<Rules> = {}): Rules => ({
  order: ["work", "home", "spare"],
  excluded: { other: ["work"] },
  workspaces: {},
  projectOf: { ws_acme: "acme", ws_other: "other" },
  ...overrides,
});
const ok = (id: string, available = true) => ({ id, ready: true, available });
const all = [ok("work"), ok("home"), ok("spare")];

describe("policy", () => {
  it("orders by the saved priority, then by name", () => {
    assert.deepEqual(prioritized(["zed", "spare", "home", "abe"], ["home", "spare"]), ["home", "spare", "abe", "zed"]);
  });

  it("lets every account serve a project unless it is excluded there", () => {
    assert.ok(allows(rules(), "work", "ws_acme"));
    assert.ok(!allows(rules(), "work", "ws_other"));
    assert.ok(allows(rules(), "work", "ws_new"));
    assert.ok(!allows(rules(), "work", null));
    assert.ok(allows(rules(), "home", null));
  });

  it("lets a workspace choose its own accounts over its project's", () => {
    const chosen = rules({ workspaces: { ws_acme: ["spare"] } });
    assert.ok(allows(chosen, "spare", "ws_acme"));
    assert.ok(!allows(chosen, "work", "ws_acme"));
  });

  it("gives each workspace the first permitted account with allowance left", () => {
    assert.equal(resolve("ws_acme", all, rules(), null), "work");
    assert.equal(resolve("ws_other", all, rules(), null), "home");
    assert.equal(resolve("ws_acme", [ok("work", false), ok("home"), ok("spare")], rules(), "work"), "home");
  });

  it("never leaves a workspace without an account", () => {
    const none = rules({ workspaces: { ws_acme: [] } });
    assert.equal(resolve("ws_acme", all, none, null), "work");
  });

  it("stays put when nothing has allowance left, and keeps the current one when sticky", () => {
    const empty = [ok("work", false), ok("home", false), ok("spare", false)];
    assert.equal(resolve("ws_acme", empty, rules(), "home"), "home");
    assert.equal(resolve("ws_other", all, rules(), "spare", true), "spare");
  });

  it("keeps accounts limited somewhere away from chats outside projects", () => {
    assert.equal(resolve(null, all, rules(), null), "home");
    assert.equal(resolve(null, [ok("work")], rules(), null), "work");
  });

  it("never hands a workspace to an excluded account when its own accounts need a new sign-in", () => {
    const chosen = rules({ workspaces: { ws_acme: ["work"] } });
    const signedOut = [{ id: "work", ready: false, available: true }, ok("home")];
    assert.equal(resolve("ws_acme", signedOut, chosen, "work"), null);
  });

  it("honors 1.2 and 1.3 limits until they are converted", () => {
    const legacy = rules({ excluded: {}, legacyAllowed: { work: ["acme"] } });
    assert.ok(allows(legacy, "work", "ws_acme"));
    assert.ok(!allows(legacy, "work", "ws_other"));
    assert.ok(!allows(legacy, "work", null));
  });

  it("plans every workspace and the default together", () => {
    assert.deepEqual(plan(["ws_acme", "ws_other"], all, rules(), { default: "home", scopes: {} }), {
      default: "home",
      scopes: { ws_acme: "work", ws_other: "home" },
    });
  });

  it("edits an account's projects as exclusions and drops empty ones", () => {
    const edited = rules();
    setProjects(edited, "spare", ["acme"], ["acme", "other"]);
    assert.deepEqual(edited.excluded, { other: ["spare", "work"] });
    assert.deepEqual(projectsOf(edited, "spare", ["acme", "other"]), ["acme"]);
    setProjects(edited, "work", ["acme", "other"], ["acme", "other"]);
    setProjects(edited, "spare", ["acme", "other"], ["acme", "other"]);
    assert.deepEqual(edited.excluded, {});
  });

  it("lets an account into every project, including ones nobody has seen yet", () => {
    const edited = rules({ excluded: { other: ["work"], unseen: ["work", "spare"] } });
    allowEverywhere(edited, "work");
    assert.deepEqual(edited.excluded, { unseen: ["spare"] });
  });

  it("puts an account first without losing the rest", () => {
    assert.deepEqual(promote(["home", "spare"], ["home", "spare", "work"], "work"), ["work", "home", "spare"]);
  });
});

describe("rules from 1.2 and 1.3", () => {
  it("become exclusions once the projects are known, and not before", () => {
    const stored = parseRules(JSON.stringify({ order: ["a"], allowed: { a: ["p1"], b: ["p1", "p2"] } }));
    assert.equal(migrate(stored, []), false);
    assert.deepEqual(stored.legacyAllowed, { a: ["p1"], b: ["p1", "p2"] });
    assert.equal(migrate(stored, ["p1", "p2", "p3"]), true);
    assert.deepEqual(stored.excluded, { p2: ["a"], p3: ["a", "b"] });
    assert.deepEqual(stored.legacyAllowed, {});
  });
});
