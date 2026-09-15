// functions/api/resolve-url.js
// URLリダイレクト解決 API: image.civitai.com 等の 301/302 リダイレクト先（blobs-b2.civitai.com 等）を取得して返却

function isAllowedCivitaiUrl(candidate) {
  try {
    const parsed = new URL(candidate);
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol === "https:" &&
      !parsed.port &&
      (host === "civitai.com" || host.endsWith(".civitai.com"));
  } catch (_) {
    return false;
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
}

export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get("url");

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=86400",
  };

  if (!targetUrl) {
    return new Response(JSON.stringify({ error: "Missing url parameter" }), {
      status: 400,
      headers: corsHeaders,
    });
  }

  try {
    const parsed = new URL(targetUrl);
    if (!isAllowedCivitaiUrl(targetUrl)) {
      return new Response(JSON.stringify({ error: "Only HTTPS Civitai media URLs are allowed" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    // HEAD リクエストを手動リダイレクト（redirect: 'manual'）で送信して 301/302 の Location ヘッダーを取得
    let resolvedUrl = targetUrl;
    try {
      const res = await fetch(targetUrl, {
        method: "HEAD",
        redirect: "manual",
      });

      const location = res.headers.get("location");
      if (location) {
        const nextUrl = new URL(location, targetUrl).href;
        if (!isAllowedCivitaiUrl(nextUrl)) throw new Error("Redirect target is not an allowed Civitai URL");
        resolvedUrl = nextUrl;
      } else if (res.url && res.url !== targetUrl) {
        resolvedUrl = res.url;
      }
    } catch (headErr) {
      // HEAD が上流サーバーで拒否された場合は GET の手動リダイレクトを試行
      try {
        const resGet = await fetch(targetUrl, {
          method: "GET",
          redirect: "manual",
          headers: { "Range": "bytes=0-0" }, // 最小限のバイト数のみ取得
        });
        const location = resGet.headers.get("location");
        if (location) {
          const nextUrl = new URL(location, targetUrl).href;
          if (!isAllowedCivitaiUrl(nextUrl)) throw new Error("Redirect target is not an allowed Civitai URL");
          resolvedUrl = nextUrl;
        } else if (resGet.url && resGet.url !== targetUrl) {
          resolvedUrl = resGet.url;
        }
      } catch (getErr) {
        console.warn("Failed to resolve URL redirect:", getErr);
      }
    }

    return new Response(JSON.stringify({ resolvedUrl, originalUrl: targetUrl }), {
      status: 200,
      headers: corsHeaders,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message, resolvedUrl: targetUrl }), {
      status: 200,
      headers: corsHeaders,
    });
  }
}
