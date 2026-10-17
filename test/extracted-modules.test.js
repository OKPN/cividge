import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createFilenameTools } from "../upload/filename-policy.js";
import { createWorkerClient } from "../api/worker-client.js";
import { localEntryIdentity, loadDisplayCache, loadLedgerFromLocalStorage, saveLedgerToLocalStorage } from "../managed/managed-cache.js";
import { detectComfyMetadata } from "../media/metadata.js";
import { applyFastStartToMp4 } from "../media/mp4-faststart.js";
import { createR2Content } from "../storage/r2-content.js";
import { createFilebaseContent } from "../storage/filebase-content.js";
import { recordUploadedWorkflow } from "../upload/workflow-cache.js";

test("extracted filename policy keeps passthrough and conversion names", () => {
  const original = createFilenameTools({ isConversionEnabled: () => false, getFilenamePolicy: () => "{original}" });
  const converted = createFilenameTools({ isConversionEnabled: () => true, getFilenamePolicy: () => "copy-{original}" });
  assert.equal(original.createOutputName("my photo.png", "image/webp"), "my_photo.png");
  assert.equal(converted.createOutputName("my photo.png", "image/webp"), "copy-my_photo.webp");
  assert.ok([...original.truncateFilename("x".repeat(120) + ".png")].length <= 100);
});

test("extracted Worker client keeps endpoints, authorization, and error code", async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/api/link-binding")) return new Response(JSON.stringify({ error: "conflict", code: "LINK_OBJECT_CONFLICT", attempt: "a" }), { status: 409 });
    return new Response(JSON.stringify({ ok: true, config: { mode: "auto" } }), { status: 200 });
  };
  try {
    const client = createWorkerClient({
      hasAdminAccess: () => true,
      getLifecycleApiEndpoint: () => "https://worker.example/api/lifecycle",
      getCustomKvWorkerUrl: () => "https://worker.example",
      getAdminApiToken: () => "test-token",
    });
    assert.deepEqual(await client.lifecycleRequest({ action: "inspect" }), { ok: true, config: { mode: "auto" } });
    assert.equal(calls[0].url, "https://worker.example/api/lifecycle");
    assert.equal(calls[0].options.headers.Authorization, "Bearer test-token");
    await assert.rejects(client.linkBindingRequest({ action: "inspect" }), error => error.code === "LINK_OBJECT_CONFLICT" && error.attempt === "a");
    assert.deepEqual(await client.gatewayConfigRequest("GET"), { mode: "auto" });
    assert.equal(calls[2].url, "https://worker.example/api/gateway-config");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("extracted managed cache restores Link and local observations without making them authority", () => {
  const previousStorage = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  try {
    saveLedgerToLocalStorage("r2", [
      { entryKind: "link", Key: "a.webp", rawKey: "host.example:a.webp", Size: 10, ttl: 604800, expiresAt: 1900000000000,
        s3Key: null, passwordHash: "do-not-persist-this-hash", metadata: { backend: "filebase_rpc", bucket: "private-bucket", unpinned: true, mime: "image/webp" } },
      { entryKind: "local", Key: "local.webp", rawKey: "local.webp", Size: 20 },
    ]);
    assert.equal(loadLedgerFromLocalStorage("r2").length, 2);
    assert.deepEqual(loadDisplayCache("r2").map(item => item.entryKind), ["link", "local"]);
    assert.equal(loadDisplayCache("r2")[0].isCached, true);
    assert.equal(loadDisplayCache("r2")[0].expiresAt, 1900000000000);
    assert.equal(loadDisplayCache("r2")[0].metadata.ttl, 604800);
    assert.equal(loadDisplayCache("r2")[0].s3Key, null);
    assert.equal(loadDisplayCache("r2")[0].metadata.backend, "filebase_rpc");
    assert.equal(loadDisplayCache("r2")[0].metadata.unpinned, true);
    assert.equal(loadDisplayCache("r2")[0].isPasswordProtected, true);
    assert.equal(loadDisplayCache("r2")[0].metadata.mime, "image/webp");
    assert.doesNotMatch([...values.values()].join(""), /do-not-persist-this-hash/);
  } finally {
    globalThis.localStorage = previousStorage;
  }
});

test("managed refresh uses the same exported identity as the local retirement cache", () => {
  assert.equal(localEntryIdentity({ s3Key: "physical-key", Key: "display-name" }), "physical-key");
  assert.equal(localEntryIdentity({ Key: "display-name" }), "display-name");
  const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  assert.match(appSource, /import \{[^}]*\blocalEntryIdentity\b[^}]*\} from "\.\/managed\/managed-cache\.js"/s);
});

test("extracted media operations retain empty metadata and non-MP4 passthrough", async () => {
  const file = new File(["plain bytes"], "plain.txt", { type: "text/plain" });
  assert.equal((await detectComfyMetadata(file)).type, "none");
  const blob = new Blob(["plain bytes"], { type: "video/mp4" });
  assert.equal(await applyFastStartToMp4(blob), blob);
});

test("passthrough upload carries detected workflow metadata into the managed-list badge cache", () => {
  const previousStorage = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  try {
    const converterSource = readFileSync(new URL("../upload/conversion.js", import.meta.url), "utf8");
    assert.match(converterSource, /isNonImage: !isImage,\s*metaStatus: file\.metaStatus,/);
    const result = {
      name: "2qoubh.png",
      metaStatus: { hasWorkflow: true, hasPrompt: true, type: "comfy_workflow" },
    };
    recordUploadedWorkflow(result, false);

    assert.deepEqual(JSON.parse(values.get("comfyWfMap")), { "2qoubh.png": true });
  } finally {
    globalThis.localStorage = previousStorage;
  }
});

test("provider-specific content lookup keeps the managed cache fast path", async () => {
  const r2 = createR2Content({
    getStoredIpfsCid: () => null,
    getManagedContents: () => [{ Key: "r2-key", s3Key: "r2-key", contentCid: "known-hash", Size: 12, isFromS3: true }],
  });
  const filebase = createFilebaseContent({
    isValidIpfsCid: cid => cid === "known-cid",
    getStoredIpfsCid: () => null,
    storeIpfsCid: () => {},
    getManagedContents: () => [{ Key: "filebase-key", s3Key: "filebase-key", cid: "known-cid", Size: 12, isFromS3: true }],
  });
  const noNetwork = { send: () => { throw new Error("storage should not be queried"); } };
  assert.deepEqual(await r2.findR2ObjectByHash(noNetwork, "bucket", "known-hash", 12), { key: "r2-key", hash: "known-hash", size: 12 });
  assert.deepEqual(await filebase.findFilebaseObjectByCid(noNetwork, "bucket", "known-cid"), { key: "filebase-key", cid: "known-cid", size: 12 });
  assert.equal(filebase.getIpfsCidFromS3Response({ Metadata: { cid: "known-cid" } }), "known-cid");
});
