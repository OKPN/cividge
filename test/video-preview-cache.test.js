import test from "node:test";
import assert from "node:assert/strict";
import { createVideoPreviewCache } from "../media/video-preview-cache.js";
import { saveLedgerToLocalStorage, loadDisplayCache } from "../managed/managed-cache.js";

const X = `sha256:${"a".repeat(64)}`;
const Y = `sha256:${"b".repeat(64)}`;
const preview = () => new Blob(["preview"], { type: "image/webp" });

function fixture(fetcher = async () => { throw new Error("offline"); }, entries = new Map()) {
  const cacheStorage = { open: async () => ({
    match: async key => entries.get(key)?.clone(),
    put: async (key, response) => { entries.set(key, response.clone()); },
    delete: async key => entries.delete(key),
  }) };
  const cache = createVideoPreviewCache({ cacheStorage, fetcher, origin: "https://cividge.pages.dev" });
  return { cache, entries };
}

test("generated preview survives reload and an unavailable network, by ObjectId", async () => {
  const { cache, entries } = fixture();
  assert.equal(await cache.write(X, preview()), true);
  // Cache Storage is browser-shared across instances, not tied to a UI session.
  const reloaded = fixture(undefined, entries).cache;
  assert.equal(await (await reloaded.read(X)).text(), "preview");
  assert.equal(await reloaded.read(Y), null);
});

test("cache miss fetches only the individual preview and stores valid WebP", async () => {
  const requests = [];
  const { cache } = fixture(async url => {
    requests.push(url);
    return new Response(preview(), { headers: { "Content-Type": "image/webp" } });
  });
  assert.equal(await cache.read(X), null);
  assert.equal(await (await cache.fetchOnMiss(X, "https://media.example/video.mp4")).text(), "preview");
  assert.deepEqual(requests, ["https://media.example/video.mp4?preview=1"]);
  assert.equal(await (await cache.read(X)).text(), "preview");
  assert.equal(await cache.remove(X), true);
  assert.equal(await cache.read(X), null);
});

test("preview-cache failures do not prevent a successful individual preview fetch", async () => {
  const cache = createVideoPreviewCache({ cacheStorage: { open: async () => { throw new Error("cache disabled"); } },
    fetcher: async () => new Response(preview(), { headers: { "Content-Type": "image/webp" } }) });
  await assert.rejects(cache.read(X), /cache disabled/);
  assert.equal(await (await cache.fetchOnMiss(X, "https://media.example/video.mp4")).text(), "preview");
  assert.equal(await cache.fetchOnMiss("bad-id", "https://media.example/video.mp4"), null);
});

test("managed presentation snapshot retains ObjectId without storing image bytes", () => {
  const values = new Map();
  const previous = globalThis.localStorage;
  globalThis.localStorage = { getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  try {
    saveLedgerToLocalStorage("r2", [{ Key: "video.mp4", entryKind: "link", storageProvider: "r2",
      objectId: X, metadata: { oid: X } }]);
    const [row] = loadDisplayCache("r2");
    assert.equal(row.objectId, X);
    assert.equal(row.metadata.oid, X);
    assert.equal(row.isCached, true);
    assert.equal([...values.values()].some(value => value.includes("data:image")), false);
  } finally { globalThis.localStorage = previous; }
});
