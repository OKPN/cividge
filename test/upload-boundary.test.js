import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const orchestrator = readFileSync(new URL("../upload/upload-orchestrator.js", import.meta.url), "utf8");

test("upload feature owns reservation, PUT sequencing, and placement reporting", () => {
  assert.doesNotMatch(app, /new PutObjectCommand\s*\(/);
  const wrapper = app.slice(app.indexOf("async function uploadImage("), app.indexOf("// --- 一括アップロード共通処理 ---"));
  assert.match(wrapper, /executeUpload\(/);
  assert.doesNotMatch(wrapper, /linkBindingRequest\s*\(|lifecycleRequest\s*\(|registerKvCid\s*\(|\.send\s*\(/);
  assert.match(orchestrator, /prepareManagedUpload\(/);
  assert.match(orchestrator, /putUploadObject\(/);
  assert.match(orchestrator, /action: "reportPlacement"/);
});

test("upload orchestrator never acquires DOM elements or owns localStorage", () => {
  assert.doesNotMatch(orchestrator, /\bdocument\b|\bwindow\b|\blocalStorage\b|\.querySelector\s*\(/);
});
