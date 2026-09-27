import assert from "node:assert/strict";
import test from "node:test";
import { isVideoThumbnailParentKey, isWorkerDerivedR2Key } from "../media-utils.js";

test("only the reserved Worker R2 namespace is an internal preview artifact", () => {
  assert.equal(isWorkerDerivedR2Key("derived/thumbnails/abc.webp"), true);
  assert.equal(isWorkerDerivedR2Key("foo.thumb.webp"), false);
  assert.equal(isWorkerDerivedR2Key("objects/foo.thumb.webp"), false);
  assert.equal(isVideoThumbnailParentKey("video.mp4"), true);
  assert.equal(isVideoThumbnailParentKey("foo.thumb.webp"), false);
});
