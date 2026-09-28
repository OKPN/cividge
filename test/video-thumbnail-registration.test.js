import test from "node:test";
import assert from "node:assert/strict";
import { createVideoThumbnailRegistration } from "../upload/video-thumbnail.js";

test("derived preview failure is reported without throwing into the committed main upload", async () => {
  const failures = [];
  const queue = createVideoThumbnailRegistration({
    hasAdminAccess: () => true,
    getCustomKvWorkerUrl: () => "https://worker.example",
    getAdminApiToken: () => "token",
    captureFrame: async () => { throw new Error("preview unavailable"); },
    onFailure: error => failures.push(error.message),
  });
  assert.doesNotThrow(() => queue(new Blob(["video"]), "video.mp4", "sha256:test"));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(failures, ["preview unavailable"]);
});

test("generated preview is cached by ObjectId; cache failure does not prevent Worker registration", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls.push("worker"); return new Response(null, { status: 200 }); };
  try {
    const queue = createVideoThumbnailRegistration({ hasAdminAccess: () => true,
      getCustomKvWorkerUrl: () => "https://worker.example", getAdminApiToken: () => "token",
      captureFrame: async () => new Blob(["preview"], { type: "image/webp" }),
      cachePreview: async objectId => { calls.push(objectId); throw new Error("cache unavailable"); },
    });
    queue(new Blob(["video"]), "video.mp4", `sha256:${"a".repeat(64)}`);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, [`sha256:${"a".repeat(64)}`, "worker"]);
  } finally { globalThis.fetch = originalFetch; }
});
