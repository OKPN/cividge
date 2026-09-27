import test from "node:test";
import assert from "node:assert/strict";
import { createManagedPreflight } from "../upload/managed-preflight.js";

const objectId = `sha256:${"a".repeat(64)}`;

function setup({ placement = null, reservation = "reserved", conflict = false } = {}) {
  const events = [];
  let current = placement;
  const prepare = createManagedPreflight({
    getSelectedR2Domain: () => "https://test.pages.dev",
    getCurrentOrigin: () => "https://fallback.pages.dev",
    buildKvKey: (_, filename) => `test.pages.dev:${filename}`,
    getIpfsCidFromS3Response: response => response.Metadata?.cid || null,
    linkBindingRequest: async request => {
      events.push(request.action);
      if (conflict) throw Object.assign(new Error("conflict"), { code: "LINK_CONFLICT" });
      return { result: reservation, binding: { attempt: { generation: 3 } } };
    },
    lifecycleRequest: async request => {
      events.push(request.action);
      if (request.action === "inspect") return { lifecycle: { placements: { [request.objectRef ? "filebase" : "r2"]: current, r2: current, filebase: current } } };
      if (request.action === "claimPlacement") return { claim: { claimId: "claim", generation: 1 } };
      if (request.action === "reconcilePlacementForAcquire") current = { ...current, state: request.observation === "present" ? "PRESENT" : "RELEASED" };
      return {};
    },
  });
  return { events, prepare };
}

test("a bound Link with present Placement is a no-PUT no-op", async () => {
  const { events, prepare } = setup({ placement: { state: "PRESENT", locator: { bucket: "bucket", key: "objects/QmCid" } }, reservation: "bound" });
  const plan = await prepare({ name: "same.webp" }, "r2", null, "bucket", "QmCid", objectId);
  assert.equal(plan.noPut, true);
  assert.equal(plan.noOp, true);
  assert.equal(plan.linkKey, "test.pages.dev:same.webp");
  assert.deepEqual(events, ["inspect", "reserve", "inspect"]);
});

test("different Object conflict rejects before Placement acquisition", async () => {
  const { events, prepare } = setup({ conflict: true });
  await assert.rejects(prepare({ name: "same.webp" }, "r2", null, "bucket", "QmCid", objectId), /conflict/);
  assert.deepEqual(events, ["inspect", "reserve"]);
});

test("a missing Placement is claimed only after Link reservation", async () => {
  const { events, prepare } = setup();
  const plan = await prepare({ name: "new.webp" }, "r2", null, "bucket", "QmCid", objectId);
  assert.equal(plan.noPut, false);
  assert.deepEqual(events, ["inspect", "reserve", "inspect", "requestPlacementAcquire", "inspect", "claimPlacement"]);
});
