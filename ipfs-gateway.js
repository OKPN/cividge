// Browser-side HTTP CID retrieval. These endpoints are peers, not Placements.
const REGIONS = new Set(["global", "apac", "eu", "na"]);

export function normalizeGatewayEndpoint(value, region = "global") {
  const parsed = new URL(String(value || "").trim());
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("A public Gateway must be an HTTPS URL without credentials or query");
  }
  if (parsed.hostname === "ipfs.filebase.io") {
    throw new Error("Filebase provider retrieval is not a Public Gateway endpoint");
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  if (!path.endsWith("/ipfs")) throw new Error("Gateway URL must end in /ipfs");
  if (!REGIONS.has(region)) throw new Error("Unknown Gateway region");
  return { url: `${parsed.origin}${path}`, region, enabled: true };
}

export function normalizeGatewaySettings(input) {
  const endpoints = [];
  const seen = new Set();
  for (const raw of Array.isArray(input?.endpoints) ? input.endpoints : []) {
    try {
      const endpoint = normalizeGatewayEndpoint(raw.url, raw.region);
      if (seen.has(endpoint.url)) continue;
      endpoint.enabled = raw.enabled !== false;
      endpoints.push(endpoint);
      seen.add(endpoint.url);
    } catch (_) {}
  }
  return {
    mode: input?.mode === "manual" ? "manual" : "auto",
    selectedUrl: String(input?.selectedUrl || ""),
    endpoints,
  };
}

function preferredRegion(timeZone) {
  if (/^(Asia|Australia|Pacific)\//.test(timeZone)) return "apac";
  if (/^(Europe|Africa)\//.test(timeZone)) return "eu";
  if (/^America\//.test(timeZone)) return "na";
  return "global";
}

export function selectGatewayEndpoint(settings, timeZone = "") {
  const normalized = normalizeGatewaySettings(settings);
  const candidates = normalized.endpoints.filter(endpoint => endpoint.enabled);
  if (normalized.mode === "manual") {
    return candidates.find(endpoint => endpoint.url === normalized.selectedUrl) || null;
  }
  const region = preferredRegion(timeZone);
  return candidates.find(endpoint => endpoint.region === region)
    || candidates.find(endpoint => endpoint.region === "global")
    || candidates[0]
    || null;
}

export function gatewayRetrievalUrl(endpoint, cid) {
  if (!endpoint || !/^(Qm[1-9A-HJ-NP-Za-km-z]+|baf[a-z2-7]+)$/i.test(String(cid || ""))) {
    throw new Error("A selected Gateway and valid CID are required");
  }
  return `${normalizeGatewayEndpoint(endpoint.url, endpoint.region).url}/${encodeURIComponent(cid)}`;
}
