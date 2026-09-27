import test from "node:test";
import assert from "node:assert/strict";
import { createManagedController } from "../managed/managed-controller.js";

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
  const { managed } = controller();
  const old = { entryKind: "link", rawKey: "a.example:one.webp", storageProvider: "r2", expiresAt: 100 };
  const first = managed.beginObservation();
  managed.adoptObservation([[old], []], first);
  const stale = managed.beginObservation();
  managed.upsert("r2", { ...old, expiresAt: 700 });
  assert.equal(managed.adoptObservation([[old], []], stale), false);
  assert.equal(managed.getContents()[0].expiresAt, 700);
  const staleDelete = managed.beginObservation();
  managed.applyCommittedDelete(old.rawKey, []);
  assert.equal(managed.adoptObservation([[old], []], staleDelete), false);
  assert.deepEqual(managed.getContents(), []);
});

test("failed observation leaves last snapshot unchanged", () => {
  const { managed } = controller();
  const local = { entryKind: "local", rawKey: "local.webp", storageProvider: "r2" };
  const generation = managed.beginObservation();
  managed.adoptObservation([[local], []], generation);
  const failedGeneration = managed.beginObservation({ refresh: true });
  assert.equal(managed.isRefreshing(), true);
  managed.finishObservation(failedGeneration);
  assert.equal(managed.isRefreshing(), false);
  assert.deepEqual(managed.getContents(), [local]);
});

test("first-display CID hydration is once-only and generation-bound", () => {
  const { managed } = controller();
  const row = { entryKind: "link", rawKey: "a.example:one.webp", storageProvider: "filebase", isFromS3: true };
  managed.adoptObservation([[], [row]], managed.beginObservation());
  assert.equal(managed.beginLocalCidHydration(), true);
  assert.equal(managed.beginLocalCidHydration(), false);
  const oldGeneration = managed.beginObservation();
  managed.beginObservation();
  assert.equal(managed.applyCidObservation([{ ...row, cid: "QmOld" }], oldGeneration), false);
  assert.equal(managed.getContents()[0].cid, undefined);
  managed.finishLocalCidHydration(false);
  assert.equal(managed.beginLocalCidHydration(), true);
});

