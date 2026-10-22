import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { choose, eligible, laneProjects, outranks, prioritized, type Placement } from "../server/policy.ts";

const placement = (overrides: Partial<Placement> = {}): Placement => ({
  order: ["home", "spare", "work"],
  projects: { work: ["acme"] },
  live: { default: "home" },
  ...overrides,
});
const ready = (id: string, available = true) => ({ id, ready: true, available });

describe("policy", () => {
  it("orders by the saved priority, then by name", () => {
    assert.deepEqual(prioritized(["zed", "spare", "home", "abe"], ["home", "spare"]), ["home", "spare", "abe", "zed"]);
  });

  it("gives a project its dedicated accounts first, then the shared ones", () => {
    const ids = ["home", "spare", "work"];
    assert.deepEqual(eligible("acme", ids, placement()), ["work", "home", "spare"]);
    assert.deepEqual(eligible("default", ids, placement()), ["home", "spare"]);
    assert.deepEqual(eligible("other", ids, placement()), ["home", "spare"]);
  });

  it("only gives lanes to projects that have dedicated accounts", () => {
    assert.deepEqual(laneProjects(placement({ projects: { a: ["p2", "p1"], b: ["p1"], c: [] } })), ["p1", "p2"]);
  });

  it("chooses the best available account that is not live elsewhere", () => {
    const candidates = [ready("home"), ready("spare"), ready("work")];
    assert.equal(choose("acme", candidates, placement()), "work");
    assert.equal(choose("acme", [ready("home"), ready("spare"), ready("work", false)], placement()), "spare");
    assert.equal(choose("default", candidates, placement()), "home");
    assert.equal(choose("acme", [ready("home"), ready("spare", false), ready("work", false)], placement()), null);
  });

  it("never picks an account that is not ready", () => {
    assert.equal(
      choose("default", [{ id: "home", ready: false, available: true }, ready("spare")], placement()),
      "spare",
    );
  });

  it("ranks accounts within a seat", () => {
    const ids = ["home", "spare", "work"];
    assert.ok(outranks("acme", "work", "home", ids, placement()));
    assert.ok(!outranks("acme", "spare", "home", ids, placement()));
    assert.ok(outranks("default", "home", null, ids, placement()));
  });
});
