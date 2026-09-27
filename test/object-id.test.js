import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { objectIdFromFinalBytes } from "../object-id.js";

test("final bytes produce one provider-independent ObjectId", async () => {
  const original = new TextEncoder().encode("same final bytes");
  const expected = `sha256:${createHash("sha256").update(original).digest("hex")}`;
  assert.equal(await objectIdFromFinalBytes(original), expected);
  assert.equal(await objectIdFromFinalBytes(original.buffer), expected);
  assert.notEqual(await objectIdFromFinalBytes(new TextEncoder().encode("different final bytes")), expected);
});
