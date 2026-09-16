// Browser-only media helpers. They do not depend on UI state, storage, or KV.

export const extensions = {
  "image/webp": "webp",
  "image/jxl": "jxl",
  "image/jpeg": "jpg",
  "image/png": "png",
};

const MIME_TYPES = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  gif: "image/gif", svg: "image/svg+xml", jxl: "image/jxl", avif: "image/avif",
  bmp: "image/bmp", ico: "image/x-icon",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4v: "video/mp4",
  avi: "video/x-msvideo", ogv: "video/ogg",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4",
  flac: "audio/flac", aac: "audio/aac",
  zip: "application/zip", "7z": "application/x-7z-compressed", rar: "application/vnd.rar",
  tar: "application/x-tar", gz: "application/gzip",
  pdf: "application/pdf", txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8",
  json: "application/json; charset=utf-8", csv: "text/csv; charset=utf-8",
};

export function getContentTypeFromFilename(filename, fallback = "application/octet-stream") {
  const ext = String(filename || "").split(".").pop().toLowerCase();
  return MIME_TYPES[ext] || fallback;
}

const VIDEO_THUMBNAIL_PARENT_EXTENSIONS = new Set(["mp4", "webm", "mov"]);

export function isVideoThumbnailParentKey(key = "") {
  const ext = String(key).split(".").pop().toLowerCase();
  return VIDEO_THUMBNAIL_PARENT_EXTENSIONS.has(ext);
}

export function getVideoThumbnailKey(originKey = "") {
  return isVideoThumbnailParentKey(originKey) ? `${originKey}.thumb.webp` : null;
}

export function isGeneratedVideoThumbnailKey(key = "") {
  return /\.(mp4|webm|mov)\.thumb\.webp$/i.test(String(key));
}

export async function getImageDimensions(blob, contentType = "") {
  const mime = String(contentType || blob?.type || "").toLowerCase();
  if (!blob || !mime.startsWith("image/")) return null;

  try {
    const bitmap = await createImageBitmap(blob);
    const dimensions = { width: bitmap.width, height: bitmap.height };
    bitmap.close?.();
    return dimensions.width > 0 && dimensions.height > 0 ? dimensions : null;
  } catch (bitmapError) {
    try {
      const objectUrl = URL.createObjectURL(blob);
      return await new Promise((resolve) => {
        const image = new Image();
        image.onload = () => {
          const dimensions = { width: image.naturalWidth, height: image.naturalHeight };
          URL.revokeObjectURL(objectUrl);
          resolve(dimensions.width > 0 && dimensions.height > 0 ? dimensions : null);
        };
        image.onerror = () => {
          URL.revokeObjectURL(objectUrl);
          resolve(null);
        };
        image.src = objectUrl;
      });
    } catch (imageError) {
      console.debug("Image dimension lookup skipped:", bitmapError, imageError);
      return null;
    }
  }
}
