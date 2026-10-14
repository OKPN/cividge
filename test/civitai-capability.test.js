import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { POST_INTENT_FORMAT_CAPABILITIES, canUseCivitaiPostIntent, projectedFinalUploadMedia } from "../ui/civitai-capability.js";
import { runInNewContext } from "node:vm";

test("JXL integration is prepared but off; enabling the single capability uses the normal path", () => {
  assert.deepEqual(POST_INTENT_FORMAT_CAPABILITIES.jxl, { mime: "image/jxl", enabled: false });
  assert.equal(canUseCivitaiPostIntent({ name: "image.jxl", mimeType: "image/jxl" }), false);
  // Exercise the future switch without exposing a runtime or persisted override.
  const source = readFileSync(new URL("../ui/civitai-capability.js", import.meta.url), "utf8")
    .replace(/^import[^\n]*\n/gm, "")
    .replace(/export /g, "")
    .replace('jxl: Object.freeze({ mime: "image/jxl", enabled: false })',
      'jxl: Object.freeze({ mime: "image/jxl", enabled: true })');
  const enabled = runInNewContext(`${source}\ncanUseCivitaiPostIntent`);
  assert.equal(enabled({ name: "image.JXL", mimeType: "image/jxl" }), true);
  assert.equal(enabled({ name: "image.jxl", mimeType: "image/jpeg" }), false);
  assert.equal(enabled({ name: "image.webp", mimeType: "image/webp" }), true);
});

test("Post Intent format capability is derived from final media properties", () => {
  for (const name of ["a.jpg", "a.jpeg", "a.png", "a.webp", "a.mp4", "a.webm"]) {
    assert.equal(canUseCivitaiPostIntent({ name }), true, name);
  }
  for (const name of ["a.jxl", "a.gif", "a.avif", "a.mov", "a.pdf", "a.thumb.webp.txt", "a.constructor"]) {
    assert.equal(canUseCivitaiPostIntent({ name }), false, name);
  }
  assert.equal(canUseCivitaiPostIntent({ name: "a.JPG", mimeType: "image/jpeg" }), true);
  assert.equal(canUseCivitaiPostIntent({ name: "a.jpg", mimeType: "image/jxl" }), false);
  assert.equal(canUseCivitaiPostIntent({ name: "a.mp4", mimeType: "video/webm" }), false);
});

test("upload card predicts conversion output and uses actual result once produced", () => {
  const input = { name: "source.jxl", type: "image/jxl" };
  assert.equal(canUseCivitaiPostIntent(projectedFinalUploadMedia(input, null, "webp")), true);
  assert.equal(canUseCivitaiPostIntent(projectedFinalUploadMedia(input, null, "passthrough")), false);
  assert.equal(canUseCivitaiPostIntent(projectedFinalUploadMedia({ name: "source.png", type: "image/png" }, null, "jxl")), false);
  assert.equal(canUseCivitaiPostIntent(projectedFinalUploadMedia({ name: "video.mov", type: "video/quicktime" }, null, "webp")), false);
  assert.equal(canUseCivitaiPostIntent(projectedFinalUploadMedia(input,
    { name: "published.webp", blob: { type: "image/webp" } }, "jxl")), true);
  assert.equal(canUseCivitaiPostIntent(projectedFinalUploadMedia(input,
    { name: "published.jxl", blob: { type: "image/jxl" } }, "webp")), false);
});

test("upload and managed cards share one Civitai capability without separate format lists", () => {
  const source = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  assert.match(source, /canUseCivitaiPostIntent\(projectedFinalUploadMedia\(/);
  assert.match(source, /const canUseCivitai = canUseCivitaiPostIntent\(\{ name: itemDisplayName/);
  assert.doesNotMatch(source, /\["jpg", "jpeg", "png", "webp", "mp4", "webm"\]/);
  assert.equal((source.match(/\$\{canUseCivitai \? `<button type="button" class="ghost-button civitai-(?:post|r2-post)-btn"/g) || []).length, 4);
});
