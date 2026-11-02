import assert from "node:assert/strict";
import test from "node:test";

import { localizeLifecycleError } from "../ui/i18n.js";

const releaseBlocked = "A linked Object needs another PRESENT placement before source release";

test("linked-object placement release guard is shown in the selected UI language", () => {
  assert.match(localizeLifecycleError(releaseBlocked, "ja"), /公開リンクが残っている/);
  assert.match(localizeLifecycleError(releaseBlocked, "en"), /public link remains/);
});

test("unrecognized lifecycle errors remain unchanged for diagnostics", () => {
  const message = "Unexpected lifecycle failure";
  assert.equal(localizeLifecycleError(message, "ja"), message);
});
