// CID is normally projected by KV or the local cache. Only unresolved,
// physically present Filebase keys require a provider HEAD observation.
// The caller owns the refresh generation and commits this result atomically
// with the rest of the managed snapshot.
export async function observeMissingFilebaseCids(rows, { cachedCid, validCid, headCid, isCurrent, onResolved = () => {} }) {
  const unresolved = new Map();
  for (const row of rows) {
    if (row.storageProvider !== "filebase" || !row.isFromS3) continue;
    const key = row.s3Key || row.Key;
    if (!key || validCid(row.cid || row.metadata?.cid || cachedCid(key))) continue;
    if (!unresolved.has(key)) unresolved.set(key, []);
    unresolved.get(key).push(row);
  }

  // A refresh reads each missing physical key at most once. The provider has
  // no bulk metadata API; known CID values never generate a HEAD request.
  const observations = await Promise.all([...unresolved.keys()].map(async key => {
    try {
      const cid = await headCid(key);
      return { key, cid: validCid(cid) ? cid.trim() : null };
    } catch {
      return { key, cid: null };
    }
  }));
  if (!isCurrent()) return false;
  for (const { key, cid } of observations) {
    if (!cid) continue;
    for (const row of unresolved.get(key)) row.cid = cid;
    onResolved(key, cid, unresolved.get(key));
  }
  return true;
}
