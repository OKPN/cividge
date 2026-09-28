// Presentation-only resolution for both restored and freshly observed video rows.
export async function showManagedVideoPreview(article, objectId, publicUrl, cache,
  { documentRef = globalThis.document, urlApi = globalThis.URL } = {}) {
  if (!objectId || !publicUrl) return;
  let blob = null;
  try { blob = await cache.read(objectId); } catch (_) { /* cache unavailable */ }
  if (!blob) {
    try { blob = await cache.fetchOnMiss(objectId, publicUrl); } catch (_) { /* keep placeholder */ }
  }
  if (!blob || !article.isConnected || article.dataset.objectid !== objectId) return;
  const link = article.querySelector(".thumb-link");
  if (!link) return;
  const objectUrl = urlApi.createObjectURL(blob);
  const img = documentRef.createElement("img");
  img.className = "thumb";
  img.alt = "";
  img.src = objectUrl;
  img.addEventListener("load", () => urlApi.revokeObjectURL(objectUrl), { once: true });
  img.addEventListener("error", () => {
    urlApi.revokeObjectURL(objectUrl);
    img.replaceWith(Object.assign(documentRef.createElement("div"), { className: "thumb format-badge", textContent: "VIDEO" }));
  }, { once: true });
  link.replaceChildren(img);
}
