import assert from "node:assert/strict";
import test from "node:test";
import { classifyDriftCandidates, DRIFT_AVAILABILITY } from "../drift-policy.js";

test("IPFS gateway outcomes are observation labels and never retirement states", () => {
  assert.deepEqual(Object.values(DRIFT_AVAILABILITY), ["AVAILABLE", "NOT_FOUND_FROM_CHECKED_GATEWAYS", "UNAVAILABLE"]);
  assert.equal("RETIRED" in DRIFT_AVAILABILITY, false);
});

test("only objects without a managed storage observation are drift candidates", () => {
  const cid = "Qm" + "a".repeat(44);
  const link = "host.example:file.webp";
  const drift = { cid, rawKey: link, isFromS3: false };
  assert.equal(classifyDriftCandidates([drift]).length, 1);
  assert.equal(classifyDriftCandidates([drift, { cid, rawKey: link, isFromS3: true }]).length, 0);
  assert.equal(classifyDriftCandidates([{ ...drift, metadata: { kuboStatus: "pinned" } }]).length, 0);
  assert.equal(classifyDriftCandidates([{ ...drift, metadata: { backend: "filebase_rpc" } }]).length, 0);
});
