import test from "node:test";
import assert from "node:assert/strict";
import { selectFilebaseFifoCandidates, selectR2FifoCandidates } from "../storage/fifo-policy.js";

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
