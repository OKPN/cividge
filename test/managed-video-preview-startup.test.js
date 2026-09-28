import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createManagedController } from "../managed/managed-controller.js";
import { loadDisplayCache, loadLedgerFromLocalStorage, saveLedgerToLocalStorage } from "../managed/managed-cache.js";
import { createVideoPreviewCache, VIDEO_PREVIEW_CACHE_NAME } from "../media/video-preview-cache.js";
import { showManagedVideoPreview } from "../media/managed-video-preview.js";

const X = `sha256:${"a".repeat(64)}`;
const Y = `sha256:${"b".repeat(64)}`;
const origin = "https://cividge.pages.dev";

function browserFixture(fetcher = async () => { throw new Error("offline"); }) {
  const values = new Map();
  const entries = new Map();
  const previous = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
  const cacheStorage = { open: async () => ({
    match: async key => entries.get(key)?.clone(),
    put: async (key, value) => { entries.set(key, value.clone()); },
    delete: async key => entries.delete(key),
  }) };
  const createCache = () => createVideoPreviewCache({ cacheStorage, fetcher, origin });
  const createController = () => createManagedController({
    loadDisplayCache, loadLedgerFromLocalStorage, saveLedgerToLocalStorage,
    setLocalEntryRetired: () => {},
  });
  const restore = () => { globalThis.localStorage = previous; };
  return { createCache, createController, restore, entries };
}

function card(objectId) {
  const link = { image: null, replaceChildren(image) { this.image = image; } };
  const article = { isConnected: true, dataset: { objectid: objectId }, querySelector: selector => selector === ".thumb-link" ? link : null };
  const documentRef = { createElement: tag => ({ tagName: tag.toUpperCase(), addEventListener() {} }) };
  const urlApi = { createObjectURL: () => "blob:preview", revokeObjectURL() {} };
  return { article, link, documentRef, urlApi };
}

async function renderRestoredVideo(controller, cache) {
  // This is the startup path: seed the previous managed projection, select its
  // visible row, then call the same presenter as app.js's card renderer.
  controller.seedLocalDisplay();
  const [row] = controller.visiblePage();
  const host = row.rawKey.slice(0, row.rawKey.indexOf(":"));
  const publicUrl = `https://${host}/${encodeURIComponent(row.Key)}`;
  const target = card(row.objectId);
  await showManagedVideoPreview(target.article, row.objectId, publicUrl, cache, target);
  return { row, target };
}

test("startup/reload/reopen renders a cached video thumbnail without managed Refresh", async () => {
  const fixture = browserFixture();
  try {
    saveLedgerToLocalStorage("r2", [{ Key: "video.mp4", rawKey: "media.example:video.mp4",
      storageProvider: "r2", entryKind: "link", objectId: X }]);
    await fixture.createCache().write(X, new Blob(["preview"], { type: "image/webp" }));
    for (let visit = 0; visit < 3; visit++) {
      const controller = fixture.createController();
      const { row, target } = await renderRestoredVideo(controller, fixture.createCache());
      assert.equal(row.isCached, true);
      assert.equal(row.objectId, X);
      assert.equal(target.link.image?.tagName, "IMG");
      assert.equal(controller.isRefreshing(), false);
    }
  } finally { fixture.restore(); }
});

test("startup cache miss fetches only preview, failure keeps row, other ObjectId cannot reuse image", async () => {
  const requests = [];
  const fixture = browserFixture(async url => {
    requests.push(url);
    return new Response(new Blob(["preview"], { type: "image/webp" }), { headers: { "Content-Type": "image/webp" } });
  });
  try {
    saveLedgerToLocalStorage("filebase", [{ Key: "video.mp4", rawKey: "media.example:video.mp4",
      storageProvider: "filebase", entryKind: "link", objectId: Y }]);
    await fixture.createCache().write(X, new Blob(["old"], { type: "image/webp" }));
    const { row, target } = await renderRestoredVideo(fixture.createController(), fixture.createCache());
    assert.equal(row.objectId, Y);
    assert.equal(target.link.image?.tagName, "IMG");
    assert.deepEqual(requests, ["https://media.example/video.mp4?preview=1"]);
    const failed = browserFixture();
    try {
      saveLedgerToLocalStorage("filebase", [{ Key: "video.mp4", rawKey: "media.example:video.mp4",
        storageProvider: "filebase", entryKind: "link", objectId: Y }]);
      const { row: visible, target: placeholder } = await renderRestoredVideo(failed.createController(), failed.createCache());
      assert.equal(visible.Key, "video.mp4");
      assert.equal(placeholder.link.image, null);
    } finally { failed.restore(); }
  } finally { fixture.restore(); }
});

test("service worker activation preserves the preview cache", async () => {
  const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  const handlers = new Map();
  const deleted = [];
  runInNewContext(source, {
    self: { addEventListener: (name, handler) => handlers.set(name, handler) },
    caches: { keys: async () => ["file-publisher-v2", VIDEO_PREVIEW_CACHE_NAME, "old-static-cache"],
      delete: async name => { deleted.push(name); return true; } },
    console,
  });
  let activation;
  handlers.get("activate")({ waitUntil: promise => { activation = promise; } });
  await activation;
  assert.deepEqual(deleted, ["old-static-cache"]);
});

test("startup and explicit Refresh converge on the same managed video presenter", () => {
  const source = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const startup = source.slice(source.indexOf("async function fetchAndRenderR2Files("), source.indexOf("async function fetchManagedProviderContents("));
  const renderer = source.slice(source.indexOf("function renderCurrentStoragePage()"), source.indexOf("// --- 🌊 IPFS漂流ファイル"));
  assert.match(startup, /seedLocalDisplay\(\)/);
  assert.match(startup, /if \(!forceRefresh\)\s*\{\s*renderCurrentStoragePage\(\)/);
  assert.match(startup, /adoptObservation\(groups, fetchGeneration\)/);
  assert.match(renderer, /r2FileList\.append\(article\)/);
  assert.match(renderer, /article\.dataset\.objectid = knownObjectId;\s*void showVideoPreview\(article, knownObjectId\)/);
  assert.doesNotMatch(renderer, /isCached[^\n]*showVideoPreview/);
});
