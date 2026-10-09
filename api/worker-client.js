import { redactSecrets } from "../security/diagnostics.js";
import { safeHttpUrl } from "../security/presentation.js";

export function createWorkerClient({ hasAdminAccess, getLifecycleApiEndpoint, getCustomKvWorkerUrl, getAdminApiToken }) {
  const endpointUrl = value => {
    const endpoint = safeHttpUrl(value, { endpoint: true });
    if (!endpoint) throw new Error("Invalid Worker endpoint URL");
    return endpoint.replace(/\/$/, "");
  };
  const safeMessage = (value, token) => redactSecrets(value, [token]);
  async function lifecycleRequest(payload) {
  if (!hasAdminAccess()) return null;
  const rawEndpoint = getLifecycleApiEndpoint();
  if (!rawEndpoint) return null;
  const endpoint = endpointUrl(rawEndpoint);
  const token = getAdminApiToken();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(safeMessage(result.error || `Lifecycle error (${response.status})`, token));
  return result;
}

  async function linkBindingRequest(payload) {
    if (!hasAdminAccess()) throw new Error("KV Worker URLとAdmin API Tokenが必要です");
    const worker = endpointUrl(getCustomKvWorkerUrl()).replace(/\/api\/cividge-kv\/?$/, "");
    const token = getAdminApiToken();
    const response = await fetch(`${worker}/api/link-binding`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(safeMessage(data.error || `Link binding error (${response.status})`, token));
      error.code = typeof data.code === "string" ? safeMessage(data.code, token) : undefined;
      // Preserve the retry protocol fields; do not attach arbitrary response
      // properties to a diagnostic Error object.
      Object.defineProperty(error, "attempt", { value: data.attempt });
      throw error;
    }
    return data;
  }
  
async function gatewayConfigRequest(method, body) {
    const worker = endpointUrl(getCustomKvWorkerUrl()).replace(/\/api\/cividge-kv\/?$/, "");
    const token = getAdminApiToken();
    if (!worker || !token) throw new Error("KV Worker URL and Admin API Token are required");
    const response = await fetch(`${worker}/api/gateway-config`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(safeMessage(payload.error || `GatewayConfig ${method} failed (${response.status})`, token));
    return payload.config;
  }

  return { lifecycleRequest, linkBindingRequest, gatewayConfigRequest };
}
