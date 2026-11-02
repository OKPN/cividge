// Deliberately contains no retry threshold or automatic retirement policy.
// Gateway availability is an observation only; only explicit user actions can
// hide a row in the browser or mutate its Link/Placement lifecycle.
export const DRIFT_AVAILABILITY = Object.freeze({
  AVAILABLE: "AVAILABLE",
  NOT_FOUND_FROM_CHECKED_GATEWAYS: "NOT_FOUND_FROM_CHECKED_GATEWAYS",
  UNAVAILABLE: "UNAVAILABLE",
});

export function classifyDriftCandidates(items) {
  const rows = items || [];
  const identity = item => {
    const metadata = item?.metadata || {};
    const cid = item?.cid || item?.contentCid || metadata.contentCid || metadata.c_cid || "";
    const linkKey = item?.rawKey || item?.Key || "";
    return cid && linkKey ? `${cid}|${linkKey}` : "";
  };
  const hasPresentPlacement = item => {
    const metadata = item?.metadata || {};
    const rpcPresent = (metadata.backend || metadata.b) === "filebase_rpc" && !metadata.unpinned;
    const kuboPresent = item?.isKuboPinned || item?.kuboStatus === "pinned" || metadata.kuboStatus === "pinned";
    return Boolean(item?.isFromS3 || rpcPresent || kuboPresent);
  };
  const byIdentity = new Map();
  for (const item of rows) {
    const key = identity(item);
    if (key && !byIdentity.has(key)) byIdentity.set(key, item);
  }
  return [...byIdentity.entries()].filter(([key]) => {
    const [cid] = key.split("|");
    return !rows.some(row => identity(row) === key && hasPresentPlacement(row)) && Boolean(cid);
  }).map(([, item]) => item);
}
