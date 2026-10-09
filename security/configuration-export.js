// Explicit portable export: random 128-bit key is displayed separately from
// the authenticated ciphertext in a URL/QR. No plaintext credential or key in URL.
const MAX_BYTES = 128 * 1024;
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");

export async function encryptConfiguration(payload, cryptoApi = globalThis.crypto) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  if (bytes.length > MAX_BYTES) throw new Error("Configuration backup is too large");
  const keyBytes = cryptoApi.getRandomValues(new Uint8Array(16));
  const iv = cryptoApi.getRandomValues(new Uint8Array(12));
  const key = await cryptoApi.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const encrypted = new Uint8Array(await cryptoApi.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes));
  const envelope = new Uint8Array(iv.length + encrypted.length);
  envelope.set(iv); envelope.set(encrypted, iv.length);
  const encoded = btoa(Array.from(envelope, byte => String.fromCharCode(byte)).join(""))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { encrypted: `v1.${encoded}`, restorationKey: hex(keyBytes) };
}

export async function decryptConfiguration(encoded, restorationKey, cryptoApi = globalThis.crypto) {
  if (!/^v1\.[A-Za-z0-9_-]+$/.test(encoded || "") || !/^[a-f0-9]{32}$/i.test(restorationKey || "") || encoded.length > MAX_BYTES * 2) return null;
  try {
    const base64 = encoded.slice(3).replace(/-/g, "+").replace(/_/g, "/");
    const envelope = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    if (envelope.length < 29) return null;
    const keyBytes = Uint8Array.from(restorationKey.match(/../g), byte => parseInt(byte, 16));
    const key = await cryptoApi.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
    const decrypted = await cryptoApi.subtle.decrypt({ name: "AES-GCM", iv: envelope.slice(0, 12) }, key, envelope.slice(12));
    const payload = JSON.parse(new TextDecoder().decode(decrypted));
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  } catch (_) { return null; }
}

export function encryptedConfigurationUrl(encrypted, pageUrl) {
  const url = new URL(pageUrl);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid backup origin");
  url.search = ""; url.hash = `enc=${encrypted}`;
  return url.href;
}
