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
