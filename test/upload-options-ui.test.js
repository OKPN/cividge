import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canonicalConversionMode, canonicalFilenamePolicy, isConversionModeEnabled } from "../view-policy.js";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("conversion and filename checkboxes project only canonical settings", () => {
  assert.match(html, /id="enableConvertCheck"/);
  assert.match(html, /id="enableRenameCheck"/);
  assert.match(app, /enableConvertCheck\.checked = isConversionEnabled\(\)/);
  assert.match(app, /enableRenameCheck\.checked = canonical !== "\{original\}"/);
  assert.match(app, /commitConversionMode\(enableConvertCheck\.checked \? lastUiConversionMode : "passthrough"\)/);
  assert.match(app, /commitFilenamePolicy\(enableRenameCheck\.checked \? lastUiFilenamePolicy : "\{original\}"\)/);
  assert.doesNotMatch(app, /localStorage\.(?:getItem|setItem)\("(?:enableConvert|enableRename|convertEnabled|renameEnabled)"/);
  assert.equal(isConversionModeEnabled("passthrough"), false);
  assert.equal(isConversionModeEnabled(canonicalConversionMode("webp")), true);
  assert.equal(canonicalFilenamePolicy(""), "{original}");
});
