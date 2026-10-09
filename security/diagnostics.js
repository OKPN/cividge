const SECRET_KEYS = ["r2AccessKeyId", "r2SecretAccessKey", "filebaseApiKey", "filebaseSecretKey", "adminApiToken"];
const SECRET_INPUTS = [...SECRET_KEYS, "uploadApiToken", "tempPasswordInput", "pinInput",
  "obAdminToken", "obFbKey", "obFbSecret", "obR2Key", "obR2Secret"];

export function localSecretValues() {
  const values = [];
  let storage;
  try { storage = globalThis.localStorage; } catch (_) { /* unavailable storage */ }
  for (const key of SECRET_KEYS) {
    try { values.push(storage?.getItem(key)); } catch (_) { /* one read must not disable others */ }
  }
  try {
    for (let index = 0; storage && index < storage.length; index++) {
      const key = storage.key(index);
      if (key?.startsWith("uploadApiToken:")) values.push(storage.getItem(key));
    }
  } catch (_) { /* unavailable browser storage */ }
  try { values.push(JSON.parse(storage?.getItem("uploadTokenVerifiedState") || "null")?.token); } catch (_) { /* malformed observation */ }
  for (const id of SECRET_INPUTS) {
    try { values.push(globalThis.document?.getElementById?.(id)?.value); } catch (_) { /* unavailable DOM */ }
  }
  return values.filter(value => typeof value === "string" && value.length);
}

export function redactSecrets(value, secrets = localSecretValues()) {
  let text = String(value ?? "");
  for (const secret of [...new Set(secrets.filter(value => typeof value === "string" && value.length))].sort((a, b) => b.length - a.length)) {
    const variants = new Set([secret]);
    try { variants.add(encodeURIComponent(secret)); } catch (_) { /* incomplete Unicode input */ }
    for (const encoded of variants) text = text.split(encoded).join("[REDACTED]");
  }
  return text.replace(/Bearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]")
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, "https://[REDACTED]@").slice(0, 4096);
}

export function diagnosticText(value, secrets = localSecretValues()) {
  if (value instanceof Error) return redactSecrets(`${value.name}: ${value.message}`, secrets);
  if (value && typeof value === "object") {
    try { return redactSecrets(JSON.stringify(value, (key, item) => /token|secret|password|authorization|credentials|accesskey|cookie/i.test(key) ? "[REDACTED]" : item), secrets); }
    catch (_) { return "[unserializable diagnostic]"; }
  }
  return redactSecrets(value, secrets);
}

export const safeConsole = Object.fromEntries(["log", "warn", "error", "debug"].map(level =>
  [level, (...values) => globalThis.console?.[level](...values.map(value => diagnosticText(value)))]));

export async function tokenDigest(token) {
  return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))),
    byte => byte.toString(16).padStart(2, "0")).join("");
}
