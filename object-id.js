// Exact final bytes determine Object identity, independent of delivery and
// every storage provider/CID. Call only after conversion and metadata changes.
export async function objectIdFromFinalBytes(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", view);
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
