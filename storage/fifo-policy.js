import { isWorkerDerivedR2Key } from "../media-utils.js";

// Candidate selection only. ObjectLifecycle remains the release authority.
export function selectFilebaseFifoCandidates(contents, currentTotalBytes, requiredBytes, limitBytes, isKuboPrioritizePinned, kuboPinnedSet, getStoredIpfsCid) {
  const eligibleFiles = contents.filter(item => {
    if (item.Key?.startsWith("pinned_")) return false;
    return true;
  }).sort((a, b) => {
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

export function selectR2FifoCandidates(contents, totalBytes, requiredBytes, limitBytes) {
  const candidates = contents
    .filter(item => !item.Key?.startsWith("pinned_") && !isWorkerDerivedR2Key(item.Key))
    .sort((a, b) => new Date(a.LastModified || 0) - new Date(b.LastModified || 0));
  const itemsToDelete = [];
  for (const item of candidates) {
    itemsToDelete.push(item);
    totalBytes -= item.Size || 0;
    if (totalBytes + requiredBytes <= limitBytes * 0.70) break;
  }
  return itemsToDelete;
}
