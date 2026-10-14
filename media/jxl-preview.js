// Presentation only: no new Object, Link, Placement or persisted image bytes.
export function attachJxlPreviewFallback(image, { sourceUrl = image.src,
  decodePreview = decodeJxlPreview, onFailure = () => {} } = {}) {
  let attempted = false;
  const restore = async () => {
    if (attempted) return;
    attempted = true;
    try {
      const blob = await decodePreview(sourceUrl);
      if (!image.isConnected || image.src !== sourceUrl) return;
      const url = URL.createObjectURL(blob);
      const cleanup = () => URL.revokeObjectURL(url);
      image.addEventListener("load", cleanup, { once: true });
      image.addEventListener("error", () => { cleanup(); onFailure(image); }, { once: true });
      image.src = url;
    } catch (_) {
      if (image.isConnected && image.src === sourceUrl) onFailure(image);
    }
  };
  image.addEventListener("error", restore, { once: true });
  // Rendering may attach this handler after a cached native decode failure.
  if (image.complete && !image.naturalWidth) void restore();
}

async function decodeJxlPreview(url) {
  const { decodeJxlPreviewBlob } = await import("./jxl-preview-decoder.js");
  return decodeJxlPreviewBlob(url);
}
