export const DRIFT_RETENTION_STATES = new Set(["OBSERVED", "RETIRED"]);

// Availability is an observation. Three consecutive failures retire a Link
// from this browser's managed list; they never authorize lifecycle or physical
// deletion.
export function observeDrift(previous, isAvailable, now, cooldownMs, threshold = 3) {
  const state = previous && typeof previous === "object"
    ? { count: Number(previous.count || 0), lastChecked: Number(previous.lastChecked || 0), status: previous.status || "OBSERVED" }
    : { count: 0, lastChecked: 0, status: "OBSERVED" };

  if (isAvailable) return { count: 0, lastChecked: now, status: "OBSERVED", reset: true };
  if (state.count > 0 && now - state.lastChecked < cooldownMs) return { ...state, skipped: true };

  const count = state.count + 1;
  return {
    count,
    lastChecked: now,
    status: count >= threshold ? "RETIRED" : "OBSERVED",
  };
}

export function isDriftRetired(value) {
  return value?.status === "RETIRED";
}
