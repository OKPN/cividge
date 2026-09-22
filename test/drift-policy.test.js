import assert from "node:assert/strict";
import test from "node:test";
import { isDriftRetired, observeDrift } from "../drift-policy.js";

test("drift policy retires only after three consecutive failures", () => {
  const cooldown = 100;
  let state = observeDrift(null, false, 100, cooldown);
  assert.equal(state.count, 1);
  assert.equal(isDriftRetired(state), false);
  state = observeDrift(state, false, 201, cooldown);
  assert.equal(state.count, 2);
  assert.equal(isDriftRetired(state), false);
  state = observeDrift(state, false, 302, cooldown);
  assert.equal(state.count, 3);
  assert.equal(isDriftRetired(state), true);
});

test("successful availability observation resets failure confidence", () => {
  const failed = observeDrift({ count: 2, lastChecked: 100, status: "OBSERVED" }, true, 200, 100);
  assert.equal(failed.count, 0);
  assert.equal(failed.status, "OBSERVED");
});

test("retirement policy never emits a physical deletion authorization", () => {
  const state = observeDrift({ count: 2, lastChecked: 100, status: "OBSERVED" }, false, 201, 100);
  assert.equal(state.status, "RETIRED");
  assert.equal("delete" in state, false);
  assert.equal("release" in state, false);
});
