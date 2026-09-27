import test from "node:test";
import assert from "node:assert/strict";
import { observeMissingFilebaseCids } from "../managed/filebase-cid-observation.js";

const validCid = value => typeof value === "string" && value.startsWith("Qm");

test("refresh observes only unresolved Filebase physical keys, once per key", async () => {
  const rows = [
    { storageProvider: "filebase", isFromS3: true, s3Key: "same", rawKey: "h:a" },
    { storageProvider: "filebase", isFromS3: true, s3Key: "same", rawKey: "h:b" },
    { storageProvider: "filebase", isFromS3: true, s3Key: "known", cid: "QmKnown" },
    { storageProvider: "filebase", isFromS3: false, s3Key: "absent" },
    { storageProvider: "r2", isFromS3: true, s3Key: "r2" },
  ];
  const calls = [];
  assert.equal(await observeMissingFilebaseCids(rows, {
    cachedCid: () => null, validCid, isCurrent: () => true,
    headCid: async key => { calls.push(key); return "QmObserved"; },
  }), true);
  assert.deepEqual(calls, ["same"]);
  assert.equal(rows[0].cid, "QmObserved");
  assert.equal(rows[1].cid, "QmObserved");
  assert.equal(rows[2].cid, "QmKnown");
});

test("stale provider observation cannot modify the pending snapshot", async () => {
  const row = { storageProvider: "filebase", isFromS3: true, s3Key: "same" };
  assert.equal(await observeMissingFilebaseCids([row], {
    cachedCid: () => null, validCid, headCid: async () => "QmOld",
    isCurrent: () => false,
  }), false);
  assert.equal(row.cid, undefined);
});
