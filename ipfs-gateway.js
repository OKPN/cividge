// Frontend bootstrap catalog and editor validation. The Worker KV config is
// the runtime source of truth; this module never retrieves a CID.
export const GATEWAY_REGION_LABELS = Object.freeze({
  global: ["地域共通 (Global)", "Global"],
  apac: ["アジア・太平洋 (APAC)", "Asia-Pacific (APAC)"],
  eu: ["欧州 (EU)", "Europe (EU)"],
  na: ["北米 (NA)", "North America (NA)"],
  latam: ["中南米・カリブ (LATAM)", "Latin America & Caribbean (LATAM)"],
});
const REGIONS = new Set(Object.keys(GATEWAY_REGION_LABELS));

export function gatewayRegionLabel(region, language = "ja") {
  return GATEWAY_REGION_LABELS[region]?.[language === "en" ? 1 : 0] || region;
}

export const DEFAULT_PUBLIC_GATEWAYS = Object.freeze([
  { url: "https://apac.orbitor.dev/ipfs", region: "apac", enabled: true },
  { url: "https://dget.top/ipfs", region: "global", enabled: true },
  { url: "https://ipfs.orbitor.dev/ipfs", region: "na", enabled: true },
  { url: "https://eu.orbitor.dev/ipfs", region: "eu", enabled: true },
  { url: "https://latam.orbitor.dev/ipfs", region: "latam", enabled: true },
]);

export function normalizeGatewayEndpoint(value, region = "global") {
  const parsed = new URL(String(value || "").trim());
  if (parsed.protocol !== "https:" || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash ||
      parsed.hostname === "localhost" || parsed.hostname.endsWith(".local") || parsed.hostname.endsWith(".internal") ||
      parsed.hostname.includes(":") || /^\d+(?:\.\d+){3}$/.test(parsed.hostname)) {
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
  for (const raw of Array.isArray(input?.endpoints) ? input.endpoints : DEFAULT_PUBLIC_GATEWAYS) {
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
