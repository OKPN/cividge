import { extensions, isConvertibleImage } from "../media-utils.js";
import { conversionModeToMime } from "../view-policy.js";

// Post Intent format capability for the final public media, not an upload
// setting or a persisted property of a Link. Other Civitai constraints (such
// as video duration and remote retrieval) are decided by Civitai itself.
const POST_INTENT_MIME_BY_EXTENSION = Object.freeze({
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  mp4: "video/mp4",
  webm: "video/webm",
});

export function canUseCivitaiPostIntent({ name, mimeType = "" } = {}) {
  const extension = String(name || "").split(".").pop().toLowerCase();
  if (!Object.hasOwn(POST_INTENT_MIME_BY_EXTENSION, extension)) return false;
  const expectedMime = POST_INTENT_MIME_BY_EXTENSION[extension];
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
