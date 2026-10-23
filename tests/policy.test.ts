import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allows, plan, prioritized, promote, resolve, type Rules } from "../server/policy.ts";

const rules = (overrides: Partial<Rules> = {}): Rules => ({
  order: ["work", "home", "spare"],
  allowed: { work: ["acme"] },
  ...overrides,
});
const ok = (id: string, available = true) => ({ id, ready: true, available });
const all = [ok("work"), ok("home"), ok("spare")];

describe("policy", () => {
  it("orders by the saved priority, then by name", () => {
    assert.deepEqual(prioritized(["zed", "spare", "home", "abe"], ["home", "spare"]), ["home", "spare", "abe", "zed"]);
  });

  it("limits an account to its projects", () => {
    assert.ok(allows(rules(), "work", "acme"));
    assert.ok(!allows(rules(), "work", "other"));
    assert.ok(!allows(rules(), "work", null));
    assert.ok(allows(rules(), "home", null));
  });

  it("gives each project the first allowed account with allowance left", () => {
    assert.equal(resolve("acme", all, rules(), null), "work");
    assert.equal(resolve("other", all, rules(), null), "home");
    assert.equal(resolve(null, all, rules(), null), "home");
    assert.equal(resolve("acme", [ok("work", false), ok("home"), ok("spare")], rules(), "work"), "home");
  });

  it("stays put when nothing it may use has allowance left", () => {
    const empty = [ok("work", false), ok("home", false), ok("spare", false)];
    assert.equal(resolve("acme", empty, rules(), "home"), "home");
    assert.equal(resolve("acme", empty, rules(), null), "work");
  });

  it("leaves an account it may no longer use", () => {
    assert.equal(resolve("other", [ok("work", false), ok("home", false)], rules(), "work"), "home");
  });

  it("keeps the current account while it lasts when sticky", () => {
    assert.equal(resolve("other", all, rules(), "spare", true), "spare");
    assert.equal(resolve("other", [ok("home"), ok("spare", false)], rules(), "spare", true), "home");
  });

  it("never picks an account that is not ready", () => {
    assert.equal(resolve(null, [{ id: "home", ready: false, available: true }, ok("spare")], rules(), null), "spare");
  });

  it("plans every project and the default together", () => {
    assert.deepEqual(plan(["acme", "other"], all, rules(), { default: "home", projects: {} }), {
      default: "home",
      projects: { acme: "work", other: "home" },
    });
  });

  it("puts an account first without losing the rest", () => {
    assert.deepEqual(promote(["home", "spare"], ["home", "spare", "work"], "work"), ["work", "home", "spare"]);
  });
});
