import test from "node:test";
import assert from "node:assert/strict";
import { insertFilenamePatternToken } from "../ui/filename-pattern-input.js";

test("helper token replaces an empty draft without adding original", () => {
  assert.deepEqual(insertFilenamePatternToken("", "{random:6}", 0, 0),
    { value: "{random:6}", cursor: 10 });
  assert.deepEqual(insertFilenamePatternToken("   ", "{num:2}", 3, 3),
    { value: "{num:2}", cursor: 7 });
});

test("helper token replaces only the no-rename sentinel", () => {
  assert.deepEqual(insertFilenamePatternToken("{original}", "{random:6}", 10, 10),
    { value: "{random:6}", cursor: 10 });
  assert.deepEqual(insertFilenamePatternToken("{original}", "{original}", 10, 10),
    { value: "{original}", cursor: 10 });
});

test("custom rules still insert at the caret or replace a selection", () => {
  assert.deepEqual(insertFilenamePatternToken("prefix_", "{random:6}", 7, 7),
    { value: "prefix_{random:6}", cursor: 17 });
  assert.deepEqual(insertFilenamePatternToken("prefix_{num:2}", "{random:6}", 7, 14),
    { value: "prefix_{random:6}", cursor: 17 });
});
