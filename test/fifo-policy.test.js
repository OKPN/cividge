import test from "node:test";
import assert from "node:assert/strict";
import { collectExpiredStorageKeys, selectFilebaseFifoCandidates, selectR2FifoCandidates } from "../storage/fifo-policy.js";

test("Filebase FIFO selects preserved CID first and never selects protected keys", () => {
  const files = [
    { Key: "old", Size: 20, LastModified: "2020-01-01" },
    { Key: "new-pinned", Size: 20, LastModified: "2022-01-01" },
    { Key: "pinned_keep", Size: 20, LastModified: "2019-01-01" },
  ];
  const cid = key => key === "new-pinned" ? "cid" : null;
  const plan = selectFilebaseFifoCandidates(files, 60, 10, 60, true, new Set(["cid"]), cid);
  assert.deepEqual(plan.candidates, ["new-pinned", "old"]);
  assert.equal(plan.freedBytes, 40);
});

test("R2 FIFO excludes parent-owned thumbnails and protected keys", () => {
  const files = [
    { Key: "derived/thumbnails/x.webp", Size: 20, LastModified: "2019-01-01" },
    { Key: "pinned_keep", Size: 20, LastModified: "2019-01-01" },
    { Key: "old", Size: 20, LastModified: "2020-01-01" },
    { Key: "new", Size: 20, LastModified: "2021-01-01" },
  ];
  assert.deepEqual(selectR2FifoCandidates(files, 80, 0, 80).map(item => item.Key), ["old", "new"]);
});

test("collectExpiredStorageKeys marks only keys whose all links have expired", () => {
  const now = 1_700_000_000_000;
  const expired = collectExpiredStorageKeys([
    { s3Key: "only-expired", expiresAt: now - 1000 },
    { s3Key: "shared-still-live", expiresAt: now - 1000 },
    { s3Key: "shared-still-live", expiresAt: now + 60_000 },
    { s3Key: "no-expiry" },
    { s3Key: "expired-short-sec", metadata: { e: Math.floor((now - 5000) / 1000) } },
  ], now);
  assert.deepEqual([...expired].sort(), ["expired-short-sec", "only-expired"]);
});

test("FIFO prioritizes expired keys ahead of Kubo-pinned and older live files", () => {
  const expiredKeys = new Set(["new-expired"]);
  const filebaseFiles = [
    { Key: "old-live", Size: 20, LastModified: "2020-01-01" },
    { Key: "kubo-pinned-live", Size: 20, LastModified: "2021-01-01" },
    { Key: "new-expired", Size: 20, LastModified: "2025-01-01" },
  ];
  const fbPlan = selectFilebaseFifoCandidates(
    filebaseFiles, 60, 0, 60, true, new Set(["cid-kubo"]), k => (k === "kubo-pinned-live" ? "cid-kubo" : null), expiredKeys
  );
  assert.deepEqual(fbPlan.candidates, ["new-expired"]);

  const fbPlanTwo = selectFilebaseFifoCandidates(
    filebaseFiles, 60, 10, 60, true, new Set(["cid-kubo"]), k => (k === "kubo-pinned-live" ? "cid-kubo" : null), expiredKeys
  );
  assert.deepEqual(fbPlanTwo.candidates, ["new-expired", "kubo-pinned-live"]);

  const r2Plan = selectR2FifoCandidates(filebaseFiles, 60, 10, 60, expiredKeys);
  assert.deepEqual(r2Plan.map(item => item.Key), ["new-expired", "old-live"]);
});
