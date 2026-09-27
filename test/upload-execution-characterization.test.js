import test from "node:test";
import assert from "node:assert/strict";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { createUploadOrchestrator } from "../upload/upload-orchestrator.js";

function harness({ provider = "r2", noPut = false, noOp = false, failAt = null } = {}) {
  const events = [];
  const plan = { linkKey: "test.pages.dev:one.webp", baseDomain: "https://test.pages.dev",
    objectRef: "sha256:test", storageKey: "objects/QmContent", contentCid: "QmContent",
    attemptId: "attempt", attemptGeneration: 1, claim: noPut ? null : { claimId: "claim", generation: 1 },
    noPut, noOp, linkAlreadyBound: noOp };
  const s3 = { send: async command => {
    assert.ok(command instanceof PutObjectCommand);
    events.push("PUT");
    if (failAt === "PUT") throw new Error("PUT failed");
    return { $metadata: { httpHeaders: { "x-amz-meta-cid": failAt === "cidMismatch" ? "QmDifferent" : "QmContent" } } };
  } };
  const uploadImage = createUploadOrchestrator({
    getS3Client: () => s3, getBucketName: () => "bucket", hasAdminAccess: () => true,
    calculateFilebaseCid: async () => "QmContent",
    prepareManagedUpload: async () => {
      events.push("reserve");
      if (failAt === "reserve" || failAt === "linkConflict") throw new Error(failAt === "linkConflict" ? "Link conflict" : "reserve failed");
      return plan;
    },
    linkBindingRequest: async payload => { events.push(payload.action); },
    lifecycleRequest: async payload => {
      events.push(payload.outcome === "retryable" ? "reportRetryable" : payload.action);
      if (failAt === "reportPlacement" && payload.action === "reportPlacement") throw new Error("report failed");
    },
    registerKvCid: async () => {
      events.push("completeLink");
      if (failAt === "completeLink") throw new Error("complete failed");
    },
    findFilebaseObjectByCid: async () => null, findR2ObjectByHash: async () => null,
    ensureStorageCapacityFilebase: async () => events.push("capacity"),
    ensureStorageCapacityR2: async () => events.push("capacity"),
    safeDeleteS3Objects: async () => { events.push("physicalCleanup"); },
    getSelectedR2Domain: () => "https://test.pages.dev",
    buildKvKey: (_, name) => `test.pages.dev:${name}`,
    getSelectedDeliveryUrl: result => result.proxyUrl,
    getKvDeliveryBaseDomain: () => "https://worker.example",
    checkKuboPinned: async () => false, isValidIpfsCid: () => true,
    setFileStoredDomain() {}, addOrUpdateLocalLedgerItem() {}, markCivitaiTemporaryTransfer() {},
    storeIpfsCid() {}, storeR2Hash() {}, extractCleanHost: () => "test.pages.dev",
    isConversionEnabled: () => false, recordWorkflow() {},
    onFileState() {}, onError: message => events.push(`alert:${message}`),
    onUploadLimit: async () => {}, onPublicUrl() {},
    queueVideoThumbnail: () => events.push("preview"),
    readImageDimensions: async () => null,
    onDiagnostic: () => {},
  });
  const result = { name: "one.webp", blob: new Blob(["bytes"], { type: "image/webp" }) };
  const uploadOptions = { password: "", requestedTtl: 0, cachePolicy: "BOARD",
    origin: "https://test.pages.dev", formatLimitError: size => `limit ${size}` };
  return { events, result, upload: () => uploadImage(result, provider, null, uploadOptions) };
}

test("managed R2 upload reserves before PUT, reports placement before Link completion, then previews", async () => {
  const run = harness();
  assert.equal(await run.upload(), true, run.events.join(","));
  assert.match(run.result.objectId, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(run.events.filter(x => ["reserve", "PUT", "markPhysical", "reportPlacement", "completeLink", "preview"].includes(x)),
    ["reserve", "PUT", "markPhysical", "reportPlacement", "completeLink", "preview"]);
});

test("same Link/Object no-op performs no PUT or Link completion", async () => {
  const run = harness({ noPut: true, noOp: true });
  assert.equal(await run.upload(), true);
  assert.deepEqual(run.events, ["reserve", "preview"]);
});

test("managed Filebase upload follows the same reserve, PUT, report, complete order", async () => {
  const run = harness({ provider: "filebase" });
  assert.equal(await run.upload(), true, run.events.join(","));
  assert.deepEqual(run.events.filter(x => ["reserve", "PUT", "markPhysical", "reportPlacement", "completeLink", "preview"].includes(x)),
    ["reserve", "PUT", "markPhysical", "reportPlacement", "completeLink", "preview"]);
});

test("a different Object at the same Link conflicts before physical PUT", async () => {
  const run = harness({ failAt: "linkConflict" });
  assert.equal(await run.upload(), false);
  assert.equal(run.events.includes("PUT"), false);
});

for (const failure of ["reserve", "PUT", "reportPlacement", "completeLink"]) {
  test(`${failure} failure leaves the result unsuccessful without later stages`, async () => {
    const run = harness({ failAt: failure });
    assert.equal(await run.upload(), false);
    assert.ok(run.events.some(event => event.startsWith("alert:")));
    assert.equal(run.events.includes("preview"), false);
    if (failure === "reserve") assert.equal(run.events.includes("PUT"), false);
    if (failure === "PUT") assert.equal(run.events.includes("reportPlacement"), false);
    if (failure === "reportPlacement") assert.equal(run.events.includes("completeLink"), false);
  });
}

test("Filebase CID mismatch aborts the reserved Link and never completes it", async () => {
  const run = harness({ provider: "filebase", failAt: "cidMismatch" });
  assert.equal(await run.upload(), false);
  assert.deepEqual(run.events.filter(x => ["PUT", "physicalCleanup", "reportRetryable", "abort", "completeLink", "preview"].includes(x)),
    ["PUT", "physicalCleanup", "reportRetryable", "abort"]);
});
