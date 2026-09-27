import test from "node:test";
import assert from "node:assert/strict";
import { removeManagedItems, removeCommittedLink, managedEntryIdentity, upsertManagedEntry } from "../managed/managed-snapshot.js";

test("managed snapshot update keeps one peer and removes only the committed Link", () => {
  const x = { entryKind: "link", rawKey: "host.example:a.webp", Key: "a.webp", storageProvider: "r2", objectRef: "sha256:x" };
  const peer = { entryKind: "link", rawKey: "host.example:b.webp", Key: "b.webp", storageProvider: "r2", objectRef: "sha256:x" };
  const palette = [
    { url: "https://host.example/a.webp" },
    { url: "https://host.example/b.webp" },
  ];
  const result = removeCommittedLink([x, peer], palette, x.rawKey);
  assert.deepEqual(result.contents, [peer]);
  assert.deepEqual(result.paletteFiles, [palette[1]]);
});

test("managed snapshot upsert retains array identity and the peer Link", () => {
  const peer = { entryKind: "link", rawKey: "host.example:a.webp", Key: "a.webp", storageProvider: "r2" };
  const rows = [peer];
  const added = { entryKind: "link", rawKey: "host.example:b.webp", Key: "b.webp" };
  upsertManagedEntry(rows, "r2", added, managedEntryIdentity(added));
  assert.equal(rows.length, 2);
  assert.equal(rows[1], peer);
  assert.equal(rows[0].storageProvider, "r2");
  assert.throws(() => managedEntryIdentity({ entryKind: "placement", Key: "x" }), /Managed entry kind/);
});

test("provider-specific local removal does not remove the other provider", () => {
  const r2 = { Key: "same", storageProvider: "r2" };
  const filebase = { Key: "same", storageProvider: "filebase" };
  assert.deepEqual(removeManagedItems([r2, filebase], "r2", new Set(["same"]), false), [filebase]);
});

test("acknowledged TTL update replaces only its managed row", () => {
  const peer = { entryKind: "link", rawKey: "host.example:peer.webp", storageProvider: "r2", expiresAt: 100 };
  const target = { entryKind: "link", rawKey: "host.example:target.webp", storageProvider: "r2", expiresAt: 100 };
  const rows = [peer, target];
  upsertManagedEntry(rows, "r2", { ...target, expiresAt: 700 }, target.rawKey);
  assert.equal(rows.find(row => row.rawKey === target.rawKey).expiresAt, 700);
  assert.equal(rows.find(row => row.rawKey === peer.rawKey).expiresAt, 100);
});
