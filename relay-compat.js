// The probe tests one selected Pages host, not merely any reachable Worker.
export function matchesSelectedRelayProbe(selectedUrl, response) {
  if (!response?.ok || !(response.headers?.get("content-type") || "").toLowerCase().includes("image/webp")) return false;
  let selected;
  let final;
  try {
    selected = new URL(selectedUrl);
    final = new URL(response.url);
  } catch (_) { return false; }
  const host = selected.hostname.toLowerCase();
  if (!host.endsWith(".pages.dev")) return true; // Direct custom-domain mode has no Pages relay identity.
  const match = /^\/r\/([^/]+)\/404-character\.webp$/.exec(final.pathname);
  if (!match || final.hostname.toLowerCase() === host) return false;
  const relayId = decodeURIComponent(match[1]).toLowerCase();
  const firstLabel = host.split(".")[0];
  if (relayId !== host && relayId !== firstLabel) return false;
  return response.headers.get("x-cividge-relay-host")?.toLowerCase() === host;
}
