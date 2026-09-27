import test from "node:test";
import assert from "node:assert/strict";
import { canonicalFilenamePolicy, canonicalConversionMode, isConversionModeEnabled, filterManagedContents } from "../view-policy.js";

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
  for (const mode of ["image/webp", "image/jxl", "image/jpeg"]) {
    assert.equal(isConversionModeEnabled(mode), true);
  }
  assert.equal(canonicalConversionMode("image/png"), "image/webp");
});

test("empty filename input and prior original-name token normalize to one policy", () => {
  assert.equal(canonicalFilenamePolicy(""), "{original}");
  assert.equal(canonicalFilenamePolicy("  "), "{original}");
  assert.equal(canonicalFilenamePolicy("{name}"), "{original}");
  assert.equal(canonicalFilenamePolicy("{original}_{num:2}"), "{original}_{num:2}");
});
