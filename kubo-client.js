// Kubo RPC client. UI code supplies the configured endpoint and decides how to
// display status; this module only performs IPFS pin operations.

export function createKuboClient(getEndpoint) {
  async function checkKuboOnline(timeoutMs = 4000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${getEndpoint()}/api/v0/version`, { method: "POST", signal: controller.signal });
      if (!res.ok) return { online: false, error: `HTTP ${res.status}` };
      const data = await res.json();
      return { online: true, agentVersion: data.Version ? `kubo/${data.Version}` : "Kubo", commit: data.Commit || "" };
    } catch (err) {
      return { online: false, error: err.name === "AbortError" ? "Timeout" : err.message };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function checkKuboPinned(cid, timeoutMs = 2000) {
    if (!cid) return false;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${getEndpoint()}/api/v0/pin/ls?arg=${encodeURIComponent(cid)}&type=recursive`, { method: "POST", signal: controller.signal });
      if (!res.ok) return false;
      const data = await res.json();
      return Boolean(data.Keys && data.Keys[cid]);
    } catch {
      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function pinToKubo(cid) {
    if (!cid) return { success: false, error: "Missing CID" };
    try {
      fetch(`${getEndpoint()}/api/v0/pin/add?arg=${encodeURIComponent(cid)}&recursive=true`, { method: "POST" })
        .then(async (res) => res.ok ? { success: true } : { success: false, error: await res.text() })
        .then((result) => {
          if (!result.success) console.warn(`Kubo pin failed: ${cid}`, result.error);
        })
        .catch((err) => console.warn(`Kubo pin request failed: ${cid}`, err));

      if (await checkKuboPinned(cid, 800)) return { success: true, alreadyPinned: true };
      return { success: true, inProgress: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async function getKuboPinnedCids(timeoutMs = 3000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${getEndpoint()}/api/v0/pin/ls?type=recursive`, { method: "POST", signal: controller.signal });
      if (!res.ok) return null;
      const data = await res.json();
      return new Set(Object.keys(data.Keys || {}));
    } catch {
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function unpinFromKubo(cid) {
    if (!cid) return { success: false, error: "Missing CID" };
    try {
      const res = await fetch(`${getEndpoint()}/api/v0/pin/rm?arg=${encodeURIComponent(cid)}`, { method: "POST" });
      if (res.ok) return { success: true };
      const error = await res.text();
      if (error.includes("not pinned") || error.includes("pinned indirectly")) return { success: true, alreadyUnpinned: true };
      return { success: false, error };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async function addFileToKubo(blob, filename = "file") {
    if (!blob) return { success: false, error: "Missing blob" };
    try {
      const formData = new FormData();
      formData.append("file", blob, filename);
      const res = await fetch(`${getEndpoint()}/api/v0/add?pin=true&cid-version=0&raw-leaves=false`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const errorText = await res.text();
        return { success: false, error: `HTTP ${res.status}: ${errorText}` };
      }
      const data = await res.json();
      return { success: true, cid: data.Hash, size: data.Size };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  return { checkKuboOnline, checkKuboPinned, pinToKubo, getKuboPinnedCids, unpinFromKubo, addFileToKubo };
}

