import { extensions, isConvertibleImage } from "../media-utils.js";
import { conversionModeToMime } from "../view-policy.js";

// Post Intent format capability for the final public media, not an upload
// setting or a persisted property of a Link. Other Civitai constraints (such
// as video duration and remote retrieval) are decided by Civitai itself.
export const POST_INTENT_FORMAT_CAPABILITIES = Object.freeze({
  jpg: Object.freeze({ mime: "image/jpeg", enabled: true }),
  jpeg: Object.freeze({ mime: "image/jpeg", enabled: true }),
  png: Object.freeze({ mime: "image/png", enabled: true }),
  webp: Object.freeze({ mime: "image/webp", enabled: true }),
  mp4: Object.freeze({ mime: "video/mp4", enabled: true }),
  webm: Object.freeze({ mime: "video/webm", enabled: true }),
  // Prepared but disabled: enable only after Civitai Post Intent accepts and
  // successfully retrieves real JXL media. Future support is not guaranteed.
  // This is integration capability configuration, never persisted Link state.
  jxl: Object.freeze({ mime: "image/jxl", enabled: false }),
});

const CIVITAI_MIME_TO_EXTENSION = Object.freeze({
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/gif": "gif",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/webm": "webm",
});

const ALLOWED_CIVITAI_EXTENSIONS = new Set(Object.values(CIVITAI_MIME_TO_EXTENSION));

export function canUseCivitaiPostIntent({ name, mimeType = "" } = {}) {
  const extension = String(name || "").split(".").pop().toLowerCase();
  if (!Object.hasOwn(POST_INTENT_FORMAT_CAPABILITIES, extension)) return false;
  const capability = POST_INTENT_FORMAT_CAPABILITIES[extension];
  if (!capability.enabled) return false;
  const expectedMime = capability.mime;
  const actualMime = String(mimeType || "").split(";")[0].trim().toLowerCase();
  return !actualMime || actualMime === expectedMime;
}

export function projectedFinalUploadMedia(file, result, conversionMode) {
  if (result) {
    return { name: result.name, mimeType: result.mime || result.blob?.type || "" };
  }
  if (conversionMode !== "passthrough" && isConvertibleImage(file)) {
    const mimeType = conversionModeToMime(conversionMode);
    const extension = extensions[mimeType];
    return { name: `output.${extension}`, mimeType };
  }
  return { name: file?.name || "", mimeType: file?.type || "" };
}

// The canonical authority for a Civitai media item's extension is the stored
// binary entity itself (magic bytes first, Content-Type header second), not the
// uniform ".jpeg" placeholder returned by the Civitai list API.
export function detectCivitaiMediaExtension(bytes, contentType = "") {
  const view = bytes instanceof Uint8Array
    ? bytes
    : (bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : null);
  if (view && view.length >= 12) {
    if (
      view[0] === 0x52 && view[1] === 0x49 && view[2] === 0x46 && view[3] === 0x46 &&
      view[8] === 0x57 && view[9] === 0x45 && view[10] === 0x42 && view[11] === 0x50
    ) {
      return "webp";
    }
    if (
      view[0] === 0x89 && view[1] === 0x50 && view[2] === 0x4E && view[3] === 0x47 &&
      view[4] === 0x0D && view[5] === 0x0A && view[6] === 0x1A && view[7] === 0x0A
    ) {
      return "png";
    }
    if (view[4] === 0x66 && view[5] === 0x74 && view[6] === 0x79 && view[7] === 0x70) {
      const brand = String.fromCharCode(view[8], view[9], view[10], view[11]).toLowerCase();
      return brand === "avif" || brand === "avis" ? "avif" : "mp4";
    }
  }
  if (view && view.length >= 4) {
    if (view[0] === 0xFF && view[1] === 0xD8 && view[2] === 0xFF) {
      return "jpeg";
    }
    if (view[0] === 0x47 && view[1] === 0x49 && view[2] === 0x46 && view[3] === 0x38) {
      return "gif";
    }
    if (view[0] === 0x1A && view[1] === 0x45 && view[2] === 0xDF && view[3] === 0xA3) {
      return "webm";
    }
  }
  const normalizedMime = String(contentType || "").split(";")[0].trim().toLowerCase();
  return Object.hasOwn(CIVITAI_MIME_TO_EXTENSION, normalizedMime)
    ? CIVITAI_MIME_TO_EXTENSION[normalizedMime]
    : "";
}

export function projectCivitaiDirectUrl(rawUrl, extension = "") {
  const url = String(rawUrl || "").trim();
  const ext = String(extension || "").trim().toLowerCase().replace(/^\./, "");
  if (!url || !ALLOWED_CIVITAI_EXTENSIONS.has(ext)) return url;
  if (!/^https:\/\/(?:[a-z0-9-]+\.)*civitai\.com\//i.test(url)) return url;

  // blobs-b2 等の Backblaze / オブジェクトストレージ直リンの場合:
  // パスを変更すると404になるため、クエリパラメータで `?.<ext>` を付与する (INV-CIVITAI-CANONICAL-DIRECT-URL)
  if (/^https:\/\/blobs(?:-[a-z0-9-]+)?\.civitai\.com\//i.test(url)) {
    const cleanUrl = url.split("?")[0].split("#")[0];
    return `${cleanUrl}?.${ext}`;
  }

  const [withoutHash, hash = ""] = url.split("#");
  const [pathnameAndOrigin, query = ""] = withoutHash.split("?");
  const lastSlash = pathnameAndOrigin.lastIndexOf("/");
  if (lastSlash <= "https://".length) return url;
  const prefix = pathnameAndOrigin.slice(0, lastSlash + 1);
  const filename = pathnameAndOrigin.slice(lastSlash + 1);
  if (!filename) return url;
  const updatedFilename = /\.[a-z0-9]+$/i.test(filename)
    ? filename.replace(/\.[a-z0-9]+$/i, `.${ext}`)
    : `${filename}.${ext}`;
  return `${prefix}${updatedFilename}${query ? `?${query}` : ""}${hash ? `#${hash}` : ""}`;
}
