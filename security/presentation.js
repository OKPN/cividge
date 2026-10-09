export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[char]);
}

export function safeHttpUrl(value, { endpoint = false } = {}) {
  try {
    const url = new URL(String(value || "").trim());
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return "";
    if (endpoint && (url.search || url.hash)) return "";
    return url.href;
  } catch (_) { return ""; }
}

export function safeMediaUrl(value) {
  try { const url = new URL(String(value || "")); if (url.protocol === "blob:") return url.href; } catch (_) { return ""; }
  return safeHttpUrl(value);
}

export function renderKuboStatus(element, info, documentRef = globalThis.document) {
  if (!element) return;
  const status = documentRef.createElement("span");
  status.style.color = info.online ? "#4caf50" : "#f87171";
  status.textContent = info.online ? `🟢 オンライン (${info.agentVersion || "Kubo"})` : `🔴 オフライン (${info.error || "Unavailable"})`;
  element.replaceChildren(status);
}

export const quotePosixShell = value => `'${String(value).replace(/'/g, "'\"'\"'")}'`;
export const quotePowerShell = value => `'${String(value).replace(/'/g, "''")}'`;
