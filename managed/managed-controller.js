import { filterManagedContents } from "../view-policy.js";
import { removeManagedItems, removeCommittedLink, managedEntryIdentity, upsertManagedEntry } from "./managed-snapshot.js";

// Owns the one canonical frontend managed-list projection and the generation
// that decides whether an asynchronous observation is still admissible.
// LinkBinding/ObjectLifecycle remain the authorities for domain mutations.
export function createManagedController({ loadDisplayCache, loadLedgerFromLocalStorage, saveLedgerToLocalStorage, setLocalEntryRetired, initialProvider = "r2", initialPerPage = 10 }) {
  let contents = [];
  let fetchGeneration = 0;
  let activeProvider = initialProvider === "filebase" ? "filebase" : "r2";
  let view = "all";
  let page = 1;
  let perPage = initialPerPage;
  let totalSize = 0;
  let refreshing = false;
  let localCidHydrationStarted = false;

  function getActiveProvider() { return activeProvider; }
  function getView() { return view; }
  function getPage() { return page; }
  function getPerPage() { return perPage; }
  function getTotalSize() { return totalSize; }
  function setTotalSize(value) { totalSize = value; }
  function isRefreshing() { return refreshing; }
  function selectView(nextView) {
    if (!["all", "r2", "filebase"].includes(nextView)) throw new Error("Invalid managed view");
    view = nextView;
    if (nextView !== "all") activeProvider = nextView;
    page = 1;
  }
  function resetPage() { page = 1; }
  function setPerPage(value) { perPage = value; page = 1; }
  function previousPage() { if (page > 1) page--; }
  function nextPage(visibleCount) {
    if (page < Math.max(1, Math.ceil(visibleCount / (perPage || 1)))) page++;
  }
  function clampPage(totalItems) {
    if (perPage <= 0) page = 1;
    else page = Math.max(1, Math.min(page, Math.max(1, Math.ceil(totalItems / perPage))));
    return page;
  }

  function getContents() { return contents; }
  function beginObservation({ refresh = false } = {}) { refreshing = refresh; return ++fetchGeneration; }
  function invalidateObservation() { refreshing = false; fetchGeneration++; }
  function isCurrentObservation(generation) { return generation === fetchGeneration; }
  function finishObservation(generation) {
    if (!isCurrentObservation(generation)) return false;
    refreshing = false;
    return true;
  }
  function clear() { contents = []; refreshing = false; }
  function beginLocalCidHydration() {
    if (localCidHydrationStarted) return false;
    localCidHydrationStarted = true;
    return true;
  }
  function finishLocalCidHydration(accepted) {
    if (!accepted) localCidHydrationStarted = false;
  }
  function applyCidObservation(rows, generation) {
    if (!isCurrentObservation(generation)) return false;
    const byKey = new Map(rows.filter(row => row.cid).map(row => [row.rawKey || row.Key, row.cid]));
    for (const row of contents) {
      if (row.storageProvider !== "filebase" || row.cid) continue;
      const cid = byKey.get(row.rawKey || row.Key);
      if (cid) row.cid = cid;
    }
    return true;
  }

  function seedLocalDisplay() {
    if (contents.length === 0) contents = ["r2", "filebase"].flatMap(loadDisplayCache);
    return contents;
  }

  function adoptObservation(groups, generation) {
    if (!isCurrentObservation(generation)) return false;
    refreshing = false;
    contents = groups.flat().sort((a, b) => new Date(b.LastModified || 0) - new Date(a.LastModified || 0));
    for (const provider of ["r2", "filebase"]) {
      saveLedgerToLocalStorage(provider, contents.filter(item => item.storageProvider === provider));
    }
    return true;
  }

  function removeLocalItems(provider, keysToRemove, { purgeOriginAlso = false } = {}) {
    if (!provider) return false;
    const keyList = Array.isArray(keysToRemove) ? keysToRemove : [keysToRemove];
    const keySet = new Set(keyList.filter(Boolean));
    if (keySet.size === 0) return false;
    invalidateObservation();
    contents = removeManagedItems(contents, provider, keySet, purgeOriginAlso);
    saveLedgerToLocalStorage(provider, (contents || []).filter(item => item.storageProvider === provider));
    return true;
  }

  function applyCommittedDelete(linkKey, paletteFiles) {
    invalidateObservation();
    const removed = removeCommittedLink(contents, paletteFiles, linkKey);
    for (const provider of ["r2", "filebase"]) {
      saveLedgerToLocalStorage(provider, loadLedgerFromLocalStorage(provider).filter(removed.keep));
    }
    contents = removed.contents;
    return removed.paletteFiles;
  }

  function retireLocal(provider, item) {
    if (item?.entryKind !== "local") throw new Error("Only local managed entries can be retired locally");
    setLocalEntryRetired(provider, item, true);
    return removeLocalItems(provider, [item.rawKey || item.Key]);
  }

  function upsert(provider, item) {
    if (!provider || !item) return false;
    const targetKey = managedEntryIdentity(item);
    if (!targetKey) return false;
    invalidateObservation();
    if (item.entryKind === "local") setLocalEntryRetired(provider, item, false);
    if (!Array.isArray(contents)) contents = loadLedgerFromLocalStorage(provider) || [];
    upsertManagedEntry(contents, provider, item, targetKey);
    saveLedgerToLocalStorage(provider, contents.filter(entry => entry.storageProvider === provider));
    return true;
  }

  function visible() { return filterManagedContents(contents, view); }
  function visiblePage() {
    const rows = visible();
    clampPage(rows.length);
    if (perPage <= 0) return rows;
    const start = (page - 1) * perPage;
    return rows.slice(start, start + perPage);
  }

  return { getContents, beginObservation, invalidateObservation, isCurrentObservation,
    finishObservation, isRefreshing, beginLocalCidHydration, finishLocalCidHydration, applyCidObservation,
    clear, seedLocalDisplay, adoptObservation, removeLocalItems, applyCommittedDelete,
    retireLocal, upsert, visible, visiblePage, getActiveProvider, getView, getPage, getPerPage,
    selectView, resetPage, setPerPage, previousPage, nextPage, clampPage,
    getTotalSize, setTotalSize };
}
