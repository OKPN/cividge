import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const begin = source.indexOf("function renderCurrentStoragePage() {");
const end = source.indexOf("// --- 🌊 IPFS漂流ファイル", begin);
const renderer = source.slice(begin, end);

test("managed card rendering never starts a provider or Worker observation", () => {
  assert.ok(begin > 0 && end > begin);
  assert.doesNotMatch(renderer, /\bfetch\s*\(|\.send\s*\(|\bHeadObjectCommand\b|\bGetObjectCommand\b|\blifecycleRequest\s*\(/);
  assert.doesNotMatch(renderer, /\bobserveMissingFilebaseCids\s*\(/);
});

test("cached image rows use the original public URL without a managed refresh", () => {
  assert.doesNotMatch(renderer, /item\.isCached\s*&&\s*isImage/);
  assert.match(renderer, /else if \(isImage\)\s*\{[\s\S]*?src="\$\{escapeHtml\(publicUrl\)\}"/);
  assert.match(renderer, /if \(isImage && !hasPassword\)[\s\S]*?addEventListener\("error"/);
  assert.match(renderer, /event\.currentTarget\.replaceWith\(fallback\)/);
});

test("tab and page projection paths do not start a network observation", () => {
  const begin = source.indexOf("function selectManagedStorageView(view) {");
  const end = source.indexOf('reloadR2FilesButton?.addEventListener("click"', begin);
  assert.ok(begin > 0 && end > begin);
  assert.doesNotMatch(source.slice(begin, end), /\bfetch\s*\(|\bfetchAndRenderR2Files\s*\(|\.send\s*\(/);
});
