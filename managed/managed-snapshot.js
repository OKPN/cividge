// The canonical in-memory managed-list projection is updated here. This is
// presentation state, not LinkBinding or ObjectLifecycle authority.

export function removeManagedItems(contents, provider, keySet, purgeOriginAlso) {
  if (!Array.isArray(contents)) return contents;
  return contents.filter(item => {
    if (item.storageProvider !== provider) return true;
    const k1 = item.Key || item.name;
    const k2 = item.rawKey;
    const k3 = item.s3Key;
    if (purgeOriginAlso) {
      return !keySet.has(k1) && !keySet.has(k2) && !keySet.has(k3);
    }
    return !keySet.has(k2 || k1);
  });
}

export function removeCommittedLink(contents, paletteFiles, linkKey) {
  const keep = item => item.entryKind !== "link" || (item.rawKey || item.Key) !== linkKey;
  return {
    keep,
    contents: (contents || []).filter(keep),
    paletteFiles: paletteFiles.filter(file => {
      try {
        const url = new URL(file.url);
        return `${url.hostname.toLowerCase()}:${decodeURIComponent(url.pathname.slice(1))}` !== linkKey;
      } catch (_) { return true; }
    }),
  };
}

export function managedEntryIdentity(item) {
  if (item.entryKind !== "link" && item.entryKind !== "local") throw new Error("Managed entry kind is required");
  return item.rawKey || (item.metadata?.d ? `${item.metadata.d}:${item.Key}` : (item.Key || item.name));
}

export function upsertManagedEntry(contents, provider, item, targetKey) {
  const existingIdx = contents.findIndex(existing => {
    const existingRawKey = existing.rawKey || (existing.metadata?.d ? `${existing.metadata.d}:${existing.Key}` : (existing.Key || existing.name));
    return existing.storageProvider === provider && existingRawKey === targetKey;
  });
  if (existingIdx >= 0) {
    contents[existingIdx] = { ...contents[existingIdx], ...item, storageProvider: provider };
  } else {
    contents.unshift({ ...item, storageProvider: provider });
  }
  return true;
}
