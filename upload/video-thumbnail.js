import { safeConsole } from "../security/diagnostics.js";
import { captureVideoFirstFrame } from "../media/video-preview.js";
import { isVideoThumbnailParentKey } from "../media-utils.js";

// Preview creation is intentionally best-effort after the main Link commits.
export function createVideoThumbnailRegistration({ hasAdminAccess, getCustomKvWorkerUrl, getAdminApiToken,
  captureFrame = captureVideoFirstFrame, cachePreview = async () => {}, onPreviewCached = () => {},
  onFailure = error => safeConsole.warn("Video preview is unavailable; main video remains published:", error) }) {
  return function queueVideoThumbnail(videoBlob, filename, objectId) {
    if (!videoBlob || !objectId || !isVideoThumbnailParentKey(filename) || !hasAdminAccess()) return;
    (async () => {
      const thumbnail = await captureFrame(videoBlob);
      if (!thumbnail) return;
      try {
        await cachePreview(objectId, thumbnail);
        onPreviewCached(objectId);
      } catch (_) { /* local presentation cache cannot fail the main upload */ }
      const endpoint = `${getCustomKvWorkerUrl().replace(/\/api\/cividge-kv\/?$/, "")}/api/thumbnail`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${getAdminApiToken()}`, "Content-Type": "image/webp", "X-Object-Id": objectId },
        body: thumbnail,
      });
      if (!response.ok) throw new Error((await response.json()).error || `Thumbnail upload failed (${response.status})`);
    })().catch(onFailure);
  };
}
