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

test("R2 FIFO skips Kubo pin for video/audio by default and deletes link + object directly", async () => {
  const deletedLinks = [];
  const releases = [];
  const kuboPins = [];
  const capacity = createStorageCapacityExecution({
    getSetting: key => (key === "r2StorageLimit" ? "1" : (key === "kuboAutoPinR2" ? "false" : null)),
    checkKuboOnline: async () => { throw new Error("Kubo should not be contacted for video-only R2 FIFO"); },
    getAppLanguage: () => "ja", getKuboPinnedCids: async () => new Set(),
    formatBytes: value => String(value), getStoredIpfsCid: () => null,
    getManagedContents: () => [
      { rawKey: "media.example:clip.mp4", Key: "clip.mp4", s3Key: "objects/QmVideo1", metadata: { g: 2 } },
    ],
    getObjectRefForUi: async () => "sha256:video1",
    activeKuboPins: new Set(), ensureAuthoritativeKuboPin: async () => { kuboPins.push("fb"); },
    deleteKvCid: async (linkKey, gen) => { deletedLinks.push([linkKey, gen]); },
    requestAuthorizedRelease: async (objectRef, reason, placement = null) => { releases.push([objectRef, reason, placement]); },
    loadLedgerFromLocalStorage: () => [], calculateFilebaseCid: async () => "QmVideo1",
    kuboPlacementApplication: { acquire: async () => { kuboPins.push("r2"); } },
    addFileToKubo: async () => { kuboPins.push("add"); },
    storeIpfsCid() {}, storeR2Hash() {}, deleteR2Hash() {},
  });
  const s3 = { send: async () => ({ Contents: [{ Key: "objects/QmVideo1", Size: 900 * 1024 * 1024, LastModified: new Date(0) }] }) };
  await capacity.ensureStorageCapacityR2(s3, "r2", 200 * 1024 * 1024);
  assert.deepEqual(kuboPins, []);
  assert.deepEqual(deletedLinks, [["media.example:clip.mp4", 2]]);
  assert.deepEqual(releases, [["sha256:video1", "fifo", null]]);
});

test("R2 FIFO still pins video to Kubo when kuboSkipMediaPin is explicitly false", async () => {
  const kuboPins = [];
  const releases = [];
  const capacity = createStorageCapacityExecution({
    getSetting: key => (key === "r2StorageLimit" ? "1" : (key === "kuboSkipMediaPin" ? "false" : null)),
    checkKuboOnline: async () => ({ online: true }),
    getAppLanguage: () => "ja", getKuboPinnedCids: async () => new Set(),
    formatBytes: value => String(value), getStoredIpfsCid: () => null,
    getManagedContents: () => [
      { rawKey: "media.example:clip.mp4", Key: "clip.mp4", s3Key: "objects/QmVideo1" },
    ],
    getObjectRefForUi: async () => "sha256:video1",
    activeKuboPins: new Set(), ensureAuthoritativeKuboPin: async () => {},
    deleteKvCid: async () => { throw new Error("should not delete link when kuboSkipMediaPin is false"); },
    requestAuthorizedRelease: async (objectRef, reason, placement = null) => { releases.push([objectRef, reason, placement]); },
    loadLedgerFromLocalStorage: () => [], calculateFilebaseCid: async () => "QmVideo1",
    kuboPlacementApplication: { acquire: async ({ performAcquire }) => { await performAcquire(); kuboPins.push("r2"); } },
    addFileToKubo: async () => { kuboPins.push("add"); },
    storeIpfsCid() {}, storeR2Hash() {}, deleteR2Hash() {},
  });
  const s3 = {
    send: async (cmd) => {
      if (cmd.constructor.name === "ListObjectsV2Command") {
        return { Contents: [{ Key: "objects/QmVideo1", Size: 900 * 1024 * 1024, LastModified: new Date(0) }] };
      }
      return { Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } };
    },
  };
  await capacity.ensureStorageCapacityR2(s3, "r2", 200 * 1024 * 1024);
  assert.deepEqual(kuboPins, ["add", "r2"]);
  assert.deepEqual(releases, [["sha256:video1", "fifo", "r2"]]);
});

test("Filebase FIFO skips Kubo pin for audio/video while still pinning images", async () => {
  const deletedLinks = [];
  const releases = [];
  const pinnedCids = [];
  const capacity = createStorageCapacityExecution({
    getSetting: key => (key === "filebaseStorageLimit" ? "1" : null),
    checkKuboOnline: async () => ({ online: true }),
    getAppLanguage: () => "ja", getKuboPinnedCids: async () => new Set(),
    formatBytes: value => String(value), getStoredIpfsCid: () => null,
    getManagedContents: () => [
      { rawKey: "media.example:song.m4a", Key: "song.m4a", s3Key: "objects/QmAudio", cid: "QmAudio" },
      { rawKey: "media.example:pic.webp", Key: "pic.webp", s3Key: "objects/QmImg", cid: "QmImg" },
    ],
    getObjectRefForUi: async (_p, key) => `sha256:${key}`,
    activeKuboPins: new Set(),
    ensureAuthoritativeKuboPin: async (_ref, cid) => { pinnedCids.push(cid); },
    deleteKvCid: async (linkKey) => { deletedLinks.push(linkKey); },
    requestAuthorizedRelease: async (objectRef, reason, placement = null) => { releases.push([objectRef, reason, placement]); },
    loadLedgerFromLocalStorage: () => [], calculateFilebaseCid: async () => null,
    kuboPlacementApplication: {}, addFileToKubo: async () => {},
    storeIpfsCid() {}, storeR2Hash() {}, deleteR2Hash() {},
  });
  const s3 = {
    send: async () => ({
      Contents: [
        { Key: "objects/QmAudio", Size: 500 * 1024 * 1024, LastModified: new Date(0) },
        { Key: "objects/QmImg", Size: 500 * 1024 * 1024, LastModified: new Date(1000) },
      ],
    }),
  };
  await capacity.ensureStorageCapacityFilebase(s3, "filebase", 100 * 1024 * 1024);
  assert.deepEqual(pinnedCids, ["QmImg"]);
  assert.deepEqual(deletedLinks, ["media.example:song.m4a"]);
  assert.deepEqual(releases, [
    ["sha256:objects/QmAudio", "fifo", null],
    ["sha256:objects/QmImg", "fifo", "filebase"],
  ]);
});

test("FIFO releases expired files first without contacting Kubo", async () => {
  const deletedLinks = [];
  const releases = [];
  const capacity = createStorageCapacityExecution({
    getSetting: key => (key === "filebaseStorageLimit" || key === "r2StorageLimit" ? "1" : null),
    checkKuboOnline: async () => { throw new Error("Kubo should not be contacted for expired-only FIFO"); },
    getAppLanguage: () => "ja", getKuboPinnedCids: async () => new Set(),
    formatBytes: value => String(value), getStoredIpfsCid: () => null,
    getManagedContents: () => [
      { rawKey: "img.example:expired.webp", Key: "expired.webp", s3Key: "objects/QmExpired", cid: "QmExpired", expiresAt: Date.now() - 10_000 },
      { rawKey: "img.example:live.webp", Key: "live.webp", s3Key: "objects/QmLive", cid: "QmLive" },
    ],
    getObjectRefForUi: async (_p, key) => `sha256:${key}`,
    activeKuboPins: new Set(),
    ensureAuthoritativeKuboPin: async () => { throw new Error("should not pin expired item"); },
    deleteKvCid: async (linkKey) => { deletedLinks.push(linkKey); },
    requestAuthorizedRelease: async (objectRef, reason, placement = null) => { releases.push([objectRef, reason, placement]); },
    loadLedgerFromLocalStorage: () => [], calculateFilebaseCid: async () => null,
    kuboPlacementApplication: { acquire: async () => { throw new Error("should not pin expired item"); } },
    addFileToKubo: async () => {},
    storeIpfsCid() {}, storeR2Hash() {}, deleteR2Hash() {},
  });
  const s3 = {
    send: async () => ({
      Contents: [
        { Key: "objects/QmLive", Size: 400 * 1024, LastModified: new Date(0) },
        { Key: "objects/QmExpired", Size: 500 * 1024, LastModified: new Date(100_000) },
      ],
    }),
  };
  await capacity.ensureStorageCapacityFilebase(s3, "filebase", 1);
  await capacity.ensureStorageCapacityR2(s3, "r2", 1);
  assert.deepEqual(deletedLinks, ["img.example:expired.webp", "img.example:expired.webp"]);
  assert.deepEqual(releases, [
    ["sha256:objects/QmExpired", "fifo", null],
    ["sha256:objects/QmExpired", "fifo", null],
  ]);
});
