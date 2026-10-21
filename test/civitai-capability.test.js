import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  POST_INTENT_FORMAT_CAPABILITIES,
  canUseCivitaiPostIntent,
  projectedFinalUploadMedia,
  detectCivitaiMediaExtension,
  projectCivitaiDirectUrl,
} from "../ui/civitai-capability.js";
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

test("canonical Civitai extension is derived from binary magic bytes or Content-Type and projected onto the URL", () => {
  const webpHeader = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
  const pngHeader = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]);
  const jpegHeader = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]);
  const mp4Header = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6F, 0x6D]);

  assert.equal(detectCivitaiMediaExtension(webpHeader, "image/jpeg"), "webp");
  assert.equal(detectCivitaiMediaExtension(pngHeader, "image/jpeg"), "png");
  assert.equal(detectCivitaiMediaExtension(jpegHeader, "image/webp"), "jpeg");
  assert.equal(detectCivitaiMediaExtension(mp4Header, "application/octet-stream"), "mp4");
  assert.equal(detectCivitaiMediaExtension(new Uint8Array(0), "image/webp; charset=binary"), "webp");

  const apiUrl = "https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/5940d4d8-ab20-4449-80c6-6574e1e40f33/original=true/5940d4d8-ab20-4449-80c6-6574e1e40f33.jpeg";
  assert.equal(
    projectCivitaiDirectUrl(apiUrl, "webp"),
    "https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/5940d4d8-ab20-4449-80c6-6574e1e40f33/original=true/5940d4d8-ab20-4449-80c6-6574e1e40f33.webp",
  );
  assert.equal(projectCivitaiDirectUrl("https://example.com/file.jpeg", "webp"), "https://example.com/file.jpeg");
});
