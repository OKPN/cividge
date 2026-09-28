import { KUBO_PLACEMENT_STATE } from "../kubo-placement.js";

// ==========================================
// 🗃️ Managed-list / UI projection cache (authorityではない)
// v3はKubo Placementのclosed stateを保持する。旧schemaは推測migrationせずdropする。
// ==========================================
// A fresh lifecycle/KV authority must not import a prior browser observation.
// Settings and credentials stay in their existing keys.
const STORAGE_LEDGER_KEY_PREFIX = "cividge_managed_projection_v5_";
const RETIRED_LOCAL_ENTRY_KEY_PREFIX = "cividge_retired_local_entries_v1_";

export function localEntryIdentity(item) {
  return String(item?.s3Key || item?.Key || item?.name || "");
}

export function getRetiredLocalEntries(provider) {
  try {
    const entries = JSON.parse(localStorage.getItem(`${RETIRED_LOCAL_ENTRY_KEY_PREFIX}${provider}`) || "[]");
    return new Set(Array.isArray(entries) ? entries : []);
  } catch (_) {
    return new Set();
  }
}

export function setLocalEntryRetired(provider, item, retired) {
  const identity = localEntryIdentity(item);
  if (!identity) return;
  const entries = getRetiredLocalEntries(provider);
  if (retired) entries.add(identity);
  else entries.delete(identity);
  localStorage.setItem(`${RETIRED_LOCAL_ENTRY_KEY_PREFIX}${provider}`, JSON.stringify([...entries]));
}

export function saveLedgerToLocalStorage(provider, contents) {
  if (!provider || !Array.isArray(contents)) return;
  try {
    if (contents.some(item => item.entryKind !== "link" && item.entryKind !== "local")) {
      throw new Error("Managed entry kind is required");
    }
    const tuples = contents.map(item => [
      item.Key || item.name || "",
      item.contentCid || item.cid || item.metadata?.cid || item.metadata?.c || "",
      item.Size || item.size || 0,
      item.LastModified ? Math.floor(new Date(item.LastModified).getTime() / 1000) : (item.updated ? Math.floor(new Date(item.updated).getTime() / 1000) : 0),
      item.s3Key || item.Key || "",
      item.uploadedProvider || item.backend || provider,
      item.isFromS3 ? 1 : 0,
      item.rawKey || item.Key || "",
      item.metadata?.allowedHost || item.metadata?.d || "",
      item.metadata?.kuboPlacementState || item.kuboPlacementState ||
        (item.metadata?.kuboStatus === "pinned" ? KUBO_PLACEMENT_STATE.PRESENT : KUBO_PLACEMENT_STATE.ABSENT),
      item.entryKind,
    ]);
    localStorage.setItem(`${STORAGE_LEDGER_KEY_PREFIX}${provider}`, JSON.stringify(tuples));
  } catch (e) {
    console.warn("saveLedgerToLocalStorage error:", e);
  }
}

export function loadLedgerFromLocalStorage(provider) {
  if (!provider) return [];
  try {
    const raw = localStorage.getItem(`${STORAGE_LEDGER_KEY_PREFIX}${provider}`);
    if (!raw) return [];
    const tuples = JSON.parse(raw);
    if (!Array.isArray(tuples)) return [];
    return tuples.filter(t => t[10] === "link" || t[10] === "local").map(t => {
      const name = t[0] || "";
      const cid = t[1] || undefined;
      const size = t[2] || 0;
      const dateIso = t[3] ? new Date(t[3] * 1000).toISOString() : new Date().toISOString();
      const s3Key = t[4] || name;
      const backend = t[5] || provider;
      const isFromS3 = t[6] === 1;
      const rawKey = t[7] || s3Key || name;
      const allowedHost = t[8] || (rawKey.includes(":") ? rawKey.split(":")[0] : "");
      const kuboPlacementState = Object.values(KUBO_PLACEMENT_STATE).includes(t[9])
        ? t[9]
        : KUBO_PLACEMENT_STATE.ABSENT;
      const entryKind = t[10] === "link" ? "link" : "local";
      return {
        Key: name,
        name,
        cid,
        contentCid: cid,
        Size: size,
        size,
        LastModified: dateIso,
        updated: dateIso,
        s3Key,
        rawKey,
        uploadedProvider: backend,
        backend,
        isFromS3,
        entryKind,
        metadata: {
          kuboStatus: kuboPlacementState === KUBO_PLACEMENT_STATE.PRESENT ? "pinned" : "not_pinned",
          kuboPlacementState,
          cid: cid || undefined,
          allowedHost: allowedHost || undefined,
          d: allowedHost || undefined,
          s3Key,
          backend
        },
        storageProvider: provider,
        isCached: true
      };
    });
  } catch (e) {
    console.warn("loadLedgerFromLocalStorage error:", e);
    return [];
  }
}

export function loadDisplayCache(provider) {
  // Persisted Link rows are observations, not proof that the current binding
  // generation is still active. Only an authoritative list may show them.
  return loadLedgerFromLocalStorage(provider).filter(item => item.entryKind === "local");
}

