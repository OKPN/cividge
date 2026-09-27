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

export function requireConvertedBlob(blob, mimeType) {
  if (!blob || blob.type !== mimeType) {
    throw new Error(`要求形式 ${mimeType} の変換結果を得られませんでした`);
  }
  return blob;
}

export async function fetchManagedFiles(fetcher, endpoint, headers) {
  const res = await fetcher(endpoint, { headers });
  if (!res.ok) throw new Error(`KV台帳の取得に失敗しました (${res.status})`);
  const data = await res.json();
  if (!Array.isArray(data.files)) throw new Error("KV台帳の応答形式が不正です");
  return data.files;
}
