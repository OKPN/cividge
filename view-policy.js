// UI projections only. These values do not authorize Link or Placement changes.
const CONVERSION_MODES = new Set(["passthrough", "image/webp", "image/jxl", "image/jpeg"]);

export function canonicalConversionMode(input) {
  return CONVERSION_MODES.has(input) ? input : "image/webp";
}

export function canonicalFilenamePolicy(input) {
  return String(input || "").trim().replaceAll("{name}", "{original}") || "{original}";
}

export function isConversionModeEnabled(mode) {
  return canonicalConversionMode(mode) !== "passthrough";
}

export function filterManagedContents(contents, view) {
  return view === "all" ? contents : contents.filter(item => item.storageProvider === view);
}
