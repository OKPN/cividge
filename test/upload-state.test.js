import test from "node:test";
import assert from "node:assert/strict";
import { createUploadState } from "../upload/upload-state.js";

test("upload queue preserves file/result alignment through add, convert and remove", () => {
  const upload = createUploadState();
  const files = [{ name: "a.webp" }, { name: "b.webp" }];
  upload.addFiles(files);
  upload.beginConversion();
  assert.deepEqual(upload.getResults(), [null, null]);
  upload.setResult(0, { blob: new Blob(["a"]) });
  upload.setResult(1, { blob: new Blob(["b"]) });
  upload.completeConversion("webp_85_{original}_a|b");
  assert.equal(upload.isConversionCacheValid("webp_85_{original}_a|b"), true);
  upload.removeAt(0);
  assert.deepEqual(upload.getFiles(), [files[1]]);
  assert.equal(upload.getResults().length, 1);
  assert.equal(upload.isConversionCacheValid("webp_85_{original}_a|b"), false);
});

test("failed conversion and new inputs invalidate cached results without persistence", () => {
  const upload = createUploadState();
  upload.addFiles([{ name: "first.webp" }]);
  upload.beginConversion();
  upload.setResult(0, { blob: new Blob(["x"]) });
  upload.completeConversion("signature");
  upload.invalidateConversion();
  assert.equal(upload.isConversionCacheValid("signature"), false);
  upload.clearResults();
  assert.deepEqual(upload.getResults(), []);
  upload.clear();
  assert.deepEqual(upload.getFiles(), []);
});
