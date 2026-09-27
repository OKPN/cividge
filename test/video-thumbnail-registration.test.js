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
