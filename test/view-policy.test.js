import test from "node:test";
import assert from "node:assert/strict";
import { canonicalFilenamePolicy, canonicalConversionMode, conversionModeToMime, isConversionModeEnabled, filterManagedContents, requireConvertedBlob, fetchManagedFiles } from "../view-policy.js";

test("All, R2 and Filebase are filters over the same managed rows", () => {
  const rows = [
    { rawKey: "a.example:one.webp", storageProvider: "r2" },
    { rawKey: "b.example:two.webp", storageProvider: "filebase" },
  ];
  assert.equal(filterManagedContents(rows, "all"), rows);
  assert.deepEqual(filterManagedContents(rows, "r2"), [rows[0]]);
  assert.deepEqual(filterManagedContents(rows, "filebase"), [rows[1]]);
  assert.equal(rows.length, 2);
});

test("passthrough and output formats have one conversion mode", () => {
  assert.equal(isConversionModeEnabled("passthrough"), false);
  for (const mode of ["webp", "jxl", "jpeg"]) {
    assert.equal(isConversionModeEnabled(mode), true);
  }
  assert.equal(canonicalConversionMode("image/png"), "webp");
  assert.equal(canonicalConversionMode("image/jxl"), "webp");
  assert.equal(conversionModeToMime("passthrough"), null);
  assert.equal(conversionModeToMime("webp"), "image/webp");
  assert.equal(conversionModeToMime("jxl"), "image/jxl");
  assert.equal(conversionModeToMime("jpeg"), "image/jpeg");
});

test("empty filename input normalizes to the sole non-renaming policy", () => {
  assert.equal(canonicalFilenamePolicy(""), "{original}");
  assert.equal(canonicalFilenamePolicy("  "), "{original}");
  assert.equal(canonicalFilenamePolicy("{original}_{num:2}"), "{original}_{num:2}");
});

test("failed conversion cannot silently retain original bytes under a new extension", () => {
  const original = new Blob(["png"], { type: "image/png" });
  assert.throws(() => requireConvertedBlob(original, "image/webp"), /image\/webp/);
  assert.throws(() => requireConvertedBlob(null, "image/webp"), /image\/webp/);
  assert.equal(requireConvertedBlob(new Blob(["webp"], { type: "image/webp" }), "image/webp").type, "image/webp");
});

test("failed managed-list fetch is not an empty observation", async () => {
  const previousSnapshot = [{ rawKey: "public.example:kept.webp", storageProvider: "r2" }];
  await assert.rejects(fetchManagedFiles(async () => { throw new Error("network down"); }, "/api", {}), /network down/);
  await assert.rejects(fetchManagedFiles(async () => ({ ok: false, status: 503 }), "/api", {}), /503/);
  await assert.rejects(fetchManagedFiles(async () => ({ ok: true, json: async () => ({ files: null }) }), "/api", {}), /応答形式/);
  assert.deepEqual(previousSnapshot, [{ rawKey: "public.example:kept.webp", storageProvider: "r2" }]);
  assert.deepEqual(await fetchManagedFiles(async () => ({ ok: true, json: async () => ({ files: [] }) }), "/api", {}), []);
});
