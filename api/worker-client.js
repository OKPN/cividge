export function createWorkerClient({ hasAdminAccess, getLifecycleApiEndpoint, getCustomKvWorkerUrl, getAdminApiToken }) {
  async function lifecycleRequest(payload) {
  if (!hasAdminAccess()) return null;
  const endpoint = getLifecycleApiEndpoint();
  if (!endpoint) return null;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${getAdminApiToken()}` },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Lifecycle error (${response.status})`);
  return result;
}

  async function linkBindingRequest(payload) {
    if (!hasAdminAccess()) throw new Error("KV Worker URLとAdmin API Tokenが必要です");
    const worker = getCustomKvWorkerUrl().replace(/\/api\/cividge-kv\/?$/, "");
    const response = await fetch(`${worker}/api/link-binding`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${getAdminApiToken()}` },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || `Link binding error (${response.status})`);
      error.code = data.code;
      error.attempt = data.attempt;
      throw error;
    }
    return data;
  }
  
async function gatewayConfigRequest(method, body) {
    const worker = getCustomKvWorkerUrl().replace(/\/api\/cividge-kv\/?$/, "");
    const token = getAdminApiToken();
    if (!worker || !token) throw new Error("KV Worker URL and Admin API Token are required");
    const response = await fetch(`${worker}/api/gateway-config`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `GatewayConfig ${method} failed (${response.status})`);
    return payload.config;
  }

  return { lifecycleRequest, linkBindingRequest, gatewayConfigRequest };
}
