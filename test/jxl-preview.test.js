import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { attachJxlPreviewFallback } from "../media/jxl-preview.js";

function image({ complete = false, naturalWidth = 0 } = {}) {
  const events = new EventTarget();
  return Object.assign(events, { src: "https://media.example/image.jxl", isConnected: true, complete, naturalWidth });
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test("native JXL success does not load the fallback decoder", async () => {
  const img = image({ complete: true, naturalWidth: 32 });
  let calls = 0;
  attachJxlPreviewFallback(img, { decodePreview: async () => { calls++; } });
  img.dispatchEvent(new Event("load"));
  await settle();
  assert.equal(calls, 0);
});

test("unsupported browser renders a presentation Blob on image failure", async () => {
  const img = image();
  let calls = 0;
  attachJxlPreviewFallback(img, { decodePreview: async url => {
    assert.equal(url, "https://media.example/image.jxl");
    calls++;
    return new Blob(["preview"], { type: "image/png" });
  } });
  img.dispatchEvent(new Event("error"));
  await settle();
  assert.match(img.src, /^blob:/);
  img.dispatchEvent(new Event("load"));
  assert.equal(calls, 1);
});

test("cached native failure on startup also invokes fallback without Refresh", async () => {
  const img = image({ complete: true });
  attachJxlPreviewFallback(img, { decodePreview: async () => new Blob(["preview"]) });
  await settle();
  assert.match(img.src, /^blob:/);
  img.dispatchEvent(new Event("load"));
});

test("decode failure keeps row intact and affects preview only", async () => {
  const img = image();
  let failures = 0;
  attachJxlPreviewFallback(img, { decodePreview: async () => { throw new Error("offline"); },
    onFailure: failed => { assert.equal(failed, img); failures++; } });
  img.dispatchEvent(new Event("error"));
  await settle();
  assert.equal(failures, 1);
  assert.equal(img.isConnected, true);
});

test("detached or reused image cannot receive a stale decoded preview", async () => {
  for (const detach of [true, false]) {
    const img = image();
    let resolve;
    attachJxlPreviewFallback(img, { decodePreview: () => new Promise(done => { resolve = done; }) });
    img.dispatchEvent(new Event("error"));
    if (detach) img.isConnected = false;
    else img.src = "https://media.example/new.jxl";
    const expected = img.src;
    resolve(new Blob(["old"]));
    await settle();
    assert.equal(img.src, expected);
  }
});

test("managed JXL preview uses shared presentation fallback, not new persistence or authority", () => {
  const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  assert.match(app, /if \(image && ext === "jxl"\) attachJxlPreviewFallback/);
  const decoder = readFileSync(new URL("../media/jxl-preview-decoder.js", import.meta.url), "utf8");
  assert.match(decoder, /@jsquash\/jxl\/decode.js/);
  assert.doesNotMatch(decoder, /localStorage|indexedDB|\/api\/|LinkBinding|registerKv/);
});
