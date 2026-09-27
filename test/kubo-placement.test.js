import assert from "node:assert/strict";
import test from "node:test";

import { createKuboPlacementApplication, KUBO_PLACEMENT_STATE } from "../kubo-placement.js";
const objectId = "sha256:" + "a".repeat(64);

test("Kubo acquisition rejoins an authoritative PINNING claim and reports PRESENT", async () => {
  const calls = [];
  const lifecycleRequest = async body => {
    calls.push(body);
    if (body.action === "requestPlacementAcquire") {
      return {
        lifecycle: {
          placements: {
            kubo: {
              state: "PINNING",
              claim: { claimId: "existing", generation: 4, operation: "acquire" },
            },
          },
        },
      };
    }
    if (body.action === "reportPlacement") return { lifecycle: { placements: { kubo: { state: "PRESENT" } } } };
    throw new Error(`Unexpected action: ${body.action}`);
  };
  const states = [];
  const application = createKuboPlacementApplication({
    lifecycleRequest,
    checkPinned: async () => true,
    requestPin: async () => { throw new Error("already pinned content must not request pin again"); },
    sleep: async () => {},
  });

  const result = await application.acquire({
    objectRef: objectId,
    cid: "bafy-test",
    onState: state => states.push(state),
  });

  assert.equal(result.resumed, true);
  assert.deepEqual(states, [
    KUBO_PLACEMENT_STATE.PIN_REQUESTED,
    KUBO_PLACEMENT_STATE.PINNING,
    KUBO_PLACEMENT_STATE.PRESENT,
  ]);
  assert.equal(calls.some(call => call.action === "claimPlacement"), false);
  assert.deepEqual(calls.at(-1), {
    action: "reportPlacement",
    objectRef: objectId,
    placement: "kubo",
    claimId: "existing",
    generation: 4,
    operation: "acquire",
    outcome: "present",
  });
});

test("Kubo acquisition failure returns authority to RETRYABLE", async () => {
  const reports = [];
  const application = createKuboPlacementApplication({
    lifecycleRequest: async body => {
      if (body.action === "requestPlacementAcquire") {
        return { lifecycle: { placements: { kubo: { state: "PIN_REQUESTED" } } } };
      }
      if (body.action === "claimPlacement") {
        return {
          claim: { claimId: "new", generation: 2, operation: "acquire" },
          lifecycle: { placements: { kubo: { state: "PINNING" } } },
        };
      }
      if (body.action === "reportPlacement") {
        reports.push(body);
        return { lifecycle: { placements: { kubo: { state: "PIN_REQUESTED" } } } };
      }
      throw new Error(`Unexpected action: ${body.action}`);
    },
    checkPinned: async () => false,
    requestPin: async () => ({ success: false, error: "offline" }),
    sleep: async () => {},
  });

  const states = [];
  await assert.rejects(() => application.acquire({
    objectRef: objectId,
    cid: "bafy-retry",
    onState: state => states.push(state),
  }), /offline/);
  assert.equal(reports.at(-1).outcome, "retryable");
  assert.equal(states.at(-1), KUBO_PLACEMENT_STATE.RETRYABLE);
});

test("R2 import uses the same acquisition protocol and rejects a different CID", async () => {
  const cidV0 = "QmA" + "a".repeat(43);
  const reports = [];
  let pinned = false;
  const application = createKuboPlacementApplication({
    lifecycleRequest: async body => {
      if (body.action === "requestPlacementAcquire") {
        return { lifecycle: { placements: { kubo: { state: "PIN_REQUESTED" } } } };
      }
      if (body.action === "claimPlacement") {
        return { claim: { claimId: "r2-import", generation: 1 }, lifecycle: { placements: { kubo: { state: "PINNING" } } } };
      }
      if (body.action === "reportPlacement") {
        reports.push(body);
        return { lifecycle: { placements: { kubo: { state: body.outcome === "present" ? "PRESENT" : "RETRYABLE" } } } };
      }
      throw new Error(`Unexpected action: ${body.action}`);
    },
    checkPinned: async () => pinned,
    requestPin: async () => { throw new Error("R2 import must use its supplied actuator"); },
    pollIntervalMs: 1,
    sleep: async () => {},
  });

  await application.acquire({
    objectRef: objectId,
    cid: cidV0,
    performAcquire: async () => { pinned = true; return { success: true, cid: cidV0 }; },
  });
  assert.equal(reports.at(-1).outcome, "present");

  pinned = false;
  await assert.rejects(() => application.acquire({
    objectRef: objectId,
    cid: cidV0,
    performAcquire: async () => ({ success: true, cid: "Qma" + "a".repeat(43) }),
  }), /different content CID/);
  assert.equal(reports.at(-1).outcome, "retryable");
});
