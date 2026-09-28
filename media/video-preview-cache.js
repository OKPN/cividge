// Browser-only presentation cache. The parent ObjectId, never a filename or
// Link key, identifies a generated video preview.
const CACHE_NAME = "cividge-video-previews-v1";
const OBJECT_ID = /^sha256:[0-9a-f]{64}$/;

export function createVideoPreviewCache({ cacheStorage = globalThis.caches,
  fetcher = globalThis.fetch, origin = globalThis.location?.origin || "https://cividge.invalid" } = {}) {
  const key = objectId => {
    if (!OBJECT_ID.test(objectId || "")) return null;
    return new URL(`/__cividge_local_video_preview__/${encodeURIComponent(objectId)}`, origin).href;
  };

  async function read(objectId) {
    const url = key(objectId);
    if (!url || !cacheStorage) return null;
    const response = await (await cacheStorage.open(CACHE_NAME)).match(url);
    return response?.ok && response.headers.get("Content-Type")?.startsWith("image/webp")
      ? response.blob() : null;
  }

  async function write(objectId, blob) {
    const url = key(objectId);
    if (!url || !cacheStorage || !blob || !blob.type.startsWith("image/webp")) return false;
    await (await cacheStorage.open(CACHE_NAME)).put(url, new Response(blob, {
      headers: { "Content-Type": "image/webp" },
    }));
    return true;
  }

  async function fetchOnMiss(objectId, publicUrl) {
    if (!key(objectId) || !publicUrl) return null;
    const response = await fetcher(`${publicUrl}${publicUrl.includes("?") ? "&" : "?"}preview=1`);
    if (!response.ok || !response.headers.get("Content-Type")?.startsWith("image/webp")) return null;
    const blob = await response.blob();
    try { await write(objectId, blob); } catch (_) { /* preview cache is best-effort */ }
    return blob;
  }

  async function remove(objectId) {
    const url = key(objectId);
    if (!url || !cacheStorage) return false;
    return (await cacheStorage.open(CACHE_NAME)).delete(url);
  }

  return { read, write, fetchOnMiss, remove };
}
