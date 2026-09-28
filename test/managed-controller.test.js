import test from "node:test";
import assert from "node:assert/strict";
import { createManagedController } from "../managed/managed-controller.js";
import { loadDisplayCache, loadLedgerFromLocalStorage, saveLedgerToLocalStorage } from "../managed/managed-cache.js";
import { readFileSync } from "node:fs";

function controller(initialCache = []) {
  const saved = new Map();
  const managed = createManagedController({
    loadDisplayCache: provider => initialCache.filter(item => item.storageProvider === provider),
    loadLedgerFromLocalStorage: provider => saved.get(provider) || [],
    saveLedgerToLocalStorage: (provider, rows) => saved.set(provider, rows),
    setLocalEntryRetired: () => {},
  });
  return { managed, saved };
}

test("one canonical managed snapshot serves all placement filters", () => {
  const { managed } = controller();
  const generation = managed.beginObservation();
  const r2 = { entryKind: "link", rawKey: "a.example:r2.webp", storageProvider: "r2", LastModified: "2022-01-01" };
  const filebase = { entryKind: "link", rawKey: "b.example:fb.webp", storageProvider: "filebase", LastModified: "2021-01-01" };
  assert.equal(managed.adoptObservation([[r2], [filebase]], generation), true);
  assert.deepEqual(managed.visible(), [r2, filebase]);
  managed.selectView("r2");
  assert.deepEqual(managed.visible(), [r2]);
  managed.selectView("filebase");
  assert.deepEqual(managed.visible(), [filebase]);
});

test("view changes and pagination are owned by the managed controller", () => {
  const { managed } = controller();
  const rows = [0, 1, 2, 3, 4].map(i => ({ entryKind: "link", rawKey: `a.example:${i}.webp`, storageProvider: "r2" }));
  managed.adoptObservation([rows, []], managed.beginObservation());
  managed.setPerPage(2);
  assert.deepEqual(managed.visiblePage(), rows.slice(0, 2));
  managed.nextPage(5);
  assert.equal(managed.getPage(), 2);
  assert.deepEqual(managed.visiblePage(), rows.slice(2, 4));
  managed.clampPage(2);
  assert.equal(managed.getPage(), 1);
  managed.selectView("filebase");
  assert.equal(managed.getActiveProvider(), "filebase");
  assert.equal(managed.getPage(), 1);
  managed.selectView("all");
  assert.equal(managed.getActiveProvider(), "filebase");
  assert.equal(managed.getView(), "all");
});

test("stale refresh cannot resurrect a committed delete or old TTL", () => {
  const { managed, saved } = controller();
  const old = { entryKind: "link", rawKey: "a.example:one.webp", storageProvider: "r2", expiresAt: 100 };
  const first = managed.beginObservation();
  managed.adoptObservation([[old], []], first);
  const stale = managed.beginObservation();
  managed.upsert("r2", { ...old, expiresAt: 700 });
  assert.equal(managed.adoptObservation([[old], []], stale), false);
  assert.equal(managed.getContents()[0].expiresAt, 700);
  assert.equal(saved.get("r2")[0].expiresAt, 700);
  const staleDelete = managed.beginObservation();
  managed.applyCommittedDelete(old.rawKey, []);
  assert.equal(managed.adoptObservation([[old], []], staleDelete), false);
  assert.deepEqual(managed.getContents(), []);
  assert.deepEqual(saved.get("r2"), []);
});

test("failed observation leaves last snapshot unchanged", () => {
  const { managed, saved } = controller();
  const local = { entryKind: "local", rawKey: "local.webp", storageProvider: "r2" };
  const generation = managed.beginObservation();
  managed.adoptObservation([[local], []], generation);
  const failedGeneration = managed.beginObservation({ refresh: true });
  assert.equal(managed.isRefreshing(), true);
  managed.finishObservation(failedGeneration);
  assert.equal(managed.isRefreshing(), false);
  assert.deepEqual(managed.getContents(), [local]);
  assert.deepEqual(saved.get("r2"), [local]);
});

test("reload restores cached Links without network; acknowledged delete and TTL survive reload", () => {
  const previousStorage = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  try {
    const makeController = () => createManagedController({
      loadDisplayCache, loadLedgerFromLocalStorage, saveLedgerToLocalStorage,
      setLocalEntryRetired: () => {},
    });
    const a = { entryKind: "link", Key: "a.webp", rawKey: "host.example:a.webp", storageProvider: "r2", expiresAt: 100, ttl: 100 };
    const b = { entryKind: "link", Key: "b.webp", rawKey: "host.example:b.webp", storageProvider: "r2", expiresAt: 100, ttl: 100 };
    const first = makeController();
    first.adoptObservation([[a, b], []], first.beginObservation());
    const reloaded = makeController();
    assert.equal(reloaded.seedLocalDisplay().length, 2);
    assert.ok(reloaded.getContents().every(row => row.isCached));
    reloaded.applyCommittedDelete(a.rawKey, []);
    const afterDelete = makeController();
    assert.deepEqual(afterDelete.seedLocalDisplay().map(row => row.rawKey), [b.rawKey]);
    afterDelete.upsert("r2", { ...afterDelete.getContents()[0], expiresAt: 700, ttl: 600, metadata: { expiresAt: 700, ttl: 600 } });
    const afterTtl = makeController();
    assert.deepEqual(afterTtl.seedLocalDisplay().map(row => [row.rawKey, row.expiresAt, row.ttl]), [[b.rawKey, 700, 600]]);
  } finally {
    globalThis.localStorage = previousStorage;
  }
});

test("successful empty refresh clears cache; failed and stale refreshes preserve the newer snapshot", () => {
  const { managed, saved } = controller();
  const row = { entryKind: "link", rawKey: "host.example:a.webp", storageProvider: "r2" };
  managed.adoptObservation([[row], []], managed.beginObservation());
  const failed = managed.beginObservation({ refresh: true });
  managed.finishObservation(failed);
  assert.deepEqual(managed.getContents(), [row]);
  assert.deepEqual(saved.get("r2"), [row]);
  const stale = managed.beginObservation({ refresh: true });
  const current = managed.beginObservation({ refresh: true });
  assert.equal(managed.adoptObservation([[], []], current), true);
  assert.deepEqual(managed.getContents(), []);
  assert.deepEqual(saved.get("r2"), []);
  assert.deepEqual(saved.get("filebase"), []);
  assert.equal(managed.adoptObservation([[row], []], stale), false);
  assert.deepEqual(managed.getContents(), []);
  assert.deepEqual(saved.get("r2"), []);
});

test("startup and tab switches do not observe Filebase or KV", () => {
  const source = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const start = source.indexOf("async function fetchAndRenderR2Files(");
  const end = source.indexOf("  try {", start);
  const startup = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(startup, /fetchKvFiles\s*\(|observeMissingFilebaseCids\s*\(|\.send\s*\(/);
});

