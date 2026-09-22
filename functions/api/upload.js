// Pages compatibility endpoint. It has no lifecycle authority and proxies the
// upload capability to the canonical Worker control plane.

function workerUploadUrl(env) {
  const base = String(env.CIVIDGE_KV_WORKER_URL || "").trim().replace(/\/$/, "");
  return base ? `${base}/api/upload` : "";
}

function cors(response) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Upload-Password, X-Upload-Filename, X-Custom-Domain, X-Delivery-Domain, X-Storage-Backend",
      "Access-Control-Max-Age": "86400",
    },
  });
}

async function proxy(context) {
  const target = workerUploadUrl(context.env);
  if (!target) {
    return new Response(JSON.stringify({
      success: false,
      error: "CIVIDGE_KV_WORKER_URL is required; Pages does not own Link or Object lifecycle state.",
    }), { status: 503, headers: { "Content-Type": "application/json" } });
  }
  const source = new URL(context.request.url);
  const destination = new URL(target);
  destination.search = source.search;
  const headers = new Headers(context.request.headers);
  headers.delete("host");
  const init = {
    method: context.request.method,
    headers,
    redirect: "manual",
    body: ["GET", "HEAD"].includes(context.request.method) ? undefined : context.request.body,
  };
  return cors(await fetch(destination, init));
}

export async function onRequestGet(context) { return proxy(context); }
export async function onRequestPost(context) { return proxy(context); }
