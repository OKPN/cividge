// UI projections only. These values do not authorize Link or Placement changes.
const CONVERSION_MODES = new Set(["passthrough", "webp", "jxl", "jpeg"]);
const CONVERSION_MIME = Object.freeze({ webp: "image/webp", jxl: "image/jxl", jpeg: "image/jpeg" });

export function canonicalConversionMode(input) {
  return CONVERSION_MODES.has(input) ? input : "webp";
}

export function conversionModeToMime(mode) {
  return CONVERSION_MIME[canonicalConversionMode(mode)] || null;
}

export function canonicalFilenamePolicy(input) {
  return String(input || "").trim() || "{original}";
}

export function isConversionModeEnabled(mode) {
  return canonicalConversionMode(mode) !== "passthrough";
}

export function filterManagedContents(contents, view) {
  return view === "all" ? contents : contents.filter(item => item.storageProvider === view);
}
