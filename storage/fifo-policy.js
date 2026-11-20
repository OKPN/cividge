import { isWorkerDerivedR2Key } from "../media-utils.js";

function resolveManagedStorageKey(item) {
  return item?.s3Key || item?.metadata?.s3Key || item?.metadata?.k_s3 || item?.rawKey || item?.Key || "";
}

function resolveManagedExpiresAt(item) {
  const raw = item?.expiresAt ?? item?.metadata?.expiresAt;
  if (raw !== undefined && raw !== null && raw !== "") {
    const num = Number(raw);
    return Number.isFinite(num) ? num : 0;
  }
  const sec = Number(item?.metadata?.e || 0);
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : 0;
}

/**
 * Return storage keys whose linked management records all have an expired timestamp.
 */
export function collectExpiredStorageKeys(managedItems = [], nowMs = Date.now()) {
  const stateByKey = new Map();
  for (const item of Array.isArray(managedItems) ? managedItems : []) {
    const storageKey = resolveManagedStorageKey(item);
    if (!storageKey) continue;
    const expiresAt = resolveManagedExpiresAt(item);
    const isExpired = expiresAt > 0 && nowMs > expiresAt;
    const prev = stateByKey.get(storageKey);
    stateByKey.set(storageKey, prev === undefined ? isExpired : (prev && isExpired));
  }
  const expiredKeys = new Set();
  for (const [storageKey, allExpired] of stateByKey.entries()) {
    if (allExpired) expiredKeys.add(storageKey);
  }
  return expiredKeys;
}

// Candidate selection only. ObjectLifecycle remains the release authority.
export function selectFilebaseFifoCandidates(contents, currentTotalBytes, requiredBytes, limitBytes, isKuboPrioritizePinned, kuboPinnedSet, getStoredIpfsCid, expiredKeys = null) {
  const eligibleFiles = contents.filter(item => {
    if (item.Key?.startsWith("pinned_")) return false;
    return true;
  }).sort((a, b) => {
    if (expiredKeys && expiredKeys.size > 0) {
      const expA = expiredKeys.has(a.Key) ? 1 : 0;
      const expB = expiredKeys.has(b.Key) ? 1 : 0;
      if (expA !== expB) return expB - expA;
    }
    if (isKuboPrioritizePinned && kuboPinnedSet) {
      const cidA = getStoredIpfsCid(a.Key);
      const cidB = getStoredIpfsCid(b.Key);
      const isPinnedA = cidA ? (kuboPinnedSet.has(cidA) ? 1 : 0) : 0;
      const isPinnedB = cidB ? (kuboPinnedSet.has(cidB) ? 1 : 0) : 0;
      if (isPinnedA !== isPinnedB) return isPinnedB - isPinnedA;
    }
    return new Date(a.LastModified || 0) - new Date(b.LastModified || 0);
  });

  const candidates = [];
  let freedBytes = 0;
  let simulatedTotal = currentTotalBytes;
  for (const file of eligibleFiles) {
    candidates.push(file.Key);
    freedBytes += file.Size || 0;
    simulatedTotal -= file.Size || 0;
    if (simulatedTotal + requiredBytes <= limitBytes * 0.70) break;
  }
  return { candidates, freedBytes };
}

export function selectR2FifoCandidates(contents, totalBytes, requiredBytes, limitBytes, expiredKeys = null) {
  const candidates = contents
    .filter(item => !item.Key?.startsWith("pinned_") && !isWorkerDerivedR2Key(item.Key))
    .sort((a, b) => {
      if (expiredKeys && expiredKeys.size > 0) {
        const expA = expiredKeys.has(a.Key) ? 1 : 0;
        const expB = expiredKeys.has(b.Key) ? 1 : 0;
        if (expA !== expB) return expB - expA;
      }
      return new Date(a.LastModified || 0) - new Date(b.LastModified || 0);
    });
  const itemsToDelete = [];
  for (const item of candidates) {
    itemsToDelete.push(item);
    totalBytes -= item.Size || 0;
    if (totalBytes + requiredBytes <= limitBytes * 0.70) break;
  }
  return itemsToDelete;
}
