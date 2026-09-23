import assert from "node:assert/strict";
import test from "node:test";
import { GLOBAL_UPLOAD_LIMIT_BYTES, exceedsUploadLimit } from "../upload-limit.js";

test("all frontend upload checks use an inclusive decimal 80 MB limit", () => {
  assert.equal(GLOBAL_UPLOAD_LIMIT_BYTES, 80_000_000);
  assert.equal(exceedsUploadLimit(80_000_000), false);
  assert.equal(exceedsUploadLimit(80_000_001), true);
});
