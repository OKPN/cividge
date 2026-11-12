import test from "node:test";
import assert from "node:assert/strict";
import { createStorageCapacityExecution } from "../storage/capacity-execution.js";

test("normal-capacity upload performs one provider listing and no lifecycle release", async () => {
  const calls = [];
  const capacity = createStorageCapacityExecution({
    getSetting: () => null, checkKuboOnline: async () => { throw new Error("Kubo should not be checked"); },
    getAppLanguage: () => "en", getKuboPinnedCids: async () => new Set(),
    formatBytes: value => String(value), getStoredIpfsCid: () => null,
    getManagedContents: () => [], getObjectRefForUi: async () => "object",
    activeKuboPins: new Set(), ensureAuthoritativeKuboPin: async () => {},
    requestAuthorizedRelease: async () => { throw new Error("release should not run"); },
    loadLedgerFromLocalStorage: () => [], calculateFilebaseCid: async () => null,
    kuboPlacementApplication: {}, addFileToKubo: async () => {},
    storeIpfsCid() {}, storeR2Hash() {}, deleteR2Hash() {},
  });
  const s3 = { send: async command => {
    calls.push(command.input.Bucket);
    return { Contents: [{ Key: "existing", Size: 1 }] };
  } };
  await capacity.ensureStorageCapacityFilebase(s3, "filebase", 1);
  await capacity.ensureStorageCapacityR2(s3, "r2", 1);
  assert.deepEqual(calls, ["filebase", "r2"]);
});

test("R2 FIFO with Kubo auto-pin off warns instead of silently skipping releases", async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  let releases = 0;
  try {
    const capacity = createStorageCapacityExecution({
      getSetting: key => key === "kuboAutoPinR2" ? "false" : (key === "r2StorageLimit" ? "1" : null),
      checkKuboOnline: async () => { throw new Error("Kubo should not be checked when auto-pin is off"); },
      getAppLanguage: () => "ja", getKuboPinnedCids: async () => new Set(),
      formatBytes: value => String(value), getStoredIpfsCid: () => null,
      getManagedContents: () => [], getObjectRefForUi: async () => "object",
      activeKuboPins: new Set(), ensureAuthoritativeKuboPin: async () => {},
      requestAuthorizedRelease: async () => { releases++; },
      loadLedgerFromLocalStorage: () => [], calculateFilebaseCid: async () => null,
      kuboPlacementApplication: {}, addFileToKubo: async () => {},
      storeIpfsCid() {}, storeR2Hash() {}, deleteR2Hash() {},
    });
    const s3 = { send: async () => ({ Contents: [{ Key: "old-1", Size: 900 * 1024 * 1024, LastModified: new Date(0) }] }) };
    await capacity.ensureStorageCapacityR2(s3, "r2", 200 * 1024 * 1024);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(releases, 0);
  assert.ok(warnings.some(line => line.includes("kuboAutoPinR2")), `expected an explicit warning, got: ${warnings.join(" | ")}`);
});
