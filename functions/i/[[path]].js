// functions/i/[[path]].js
// Cloudflare Pages Function: IPFS ゲートウェイ中継プロキシ ＆ エッジキャッシュ配信

export async function onRequest(context) {
  const { request, params } = context;
  const pathParam = params.path;

  // パスが空の場合は 404
  if (!pathParam || (Array.isArray(pathParam) && pathParam.length === 0)) {
    return new Response("404 Not Found: Missing IPFS CID", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const pathParts = Array.isArray(pathParam) ? pathParam : [pathParam];
  const cid = pathParts[0];
  const subPath = pathParts.slice(1).join("/");

  if (!cid || cid.length < 10) {
    return new Response("400 Bad Request: Invalid IPFS CID", {
      status: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  // 1. IPFS ターゲット URL の構築
  const targetPath = subPath ? `${cid}/${subPath}` : cid;
  const primaryGateway = `https://ipfs.filebase.io/ipfs/${targetPath}`;
  const fallbackGateway = `https://ipfs.io/ipfs/${targetPath}`;

  // 拡張子に応じた Content-Disposition と Content-Type の決定
  const filename = subPath || cid;
  const ext = filename.includes(".") ? filename.split(".").pop().toLowerCase() : "";
  const isArchive = ["zip", "7z", "rar", "tar", "gz"].includes(ext);
  const disposition = isArchive
    ? `attachment; filename="${encodeURIComponent(filename)}"`
    : "inline";

  const mimeMap = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    jxl: "image/jxl",
    avif: "image/avif",
    svg: "image/svg+xml",
    mp4: "video/mp4",
    webm: "video/webm",
    zip: "application/zip",
  };

  // 2. IPFS ゲートウェイへ fetch（エッジキャッシュ有効化 & タイムアウト制御）
  async function fetchGateway(baseUrl, path) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500); // 3.5秒タイムアウト
    try {
      const res = await fetch(`${baseUrl}/${path}`, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Cividge-IPFS-Relay/1.0",
          ...(request.headers.get("Range") ? { "Range": request.headers.get("Range") } : {}),
        },
        cf: {
          cacheEverything: true,
          cacheTtl: 86400 * 30, // 30 日間 Cloudflare エッジにキャッシュ
        },
      });
      clearTimeout(timeoutId);
      return res;
    } catch (err) {
      clearTimeout(timeoutId);
      return null;
    }
  }

  const gateways = [
    "https://apac.orbitor.dev/ipfs",    // アジア太平洋 (APAC - 日本・近隣最速)
    "https://dget.top/ipfs",             // 高速オープンゲートウェイ (グローバル)
    "https://ipfs.orbitor.dev/ipfs",    // 北米・グローバル (Orbitor Main)
    "https://eu.orbitor.dev/ipfs",      // 欧州 (EU)
    "https://latam.orbitor.dev/ipfs",   // 中南米 (LATAM)
    "https://ipfs.filebase.io/ipfs",    // Filebase 保険
  ];

  let upstreamResponse = null;
  for (const gw of gateways) {
    try {
      const res = await fetchGateway(gw, cid);
      if (res && res.ok) {
        upstreamResponse = res;
        break;
      }
      if (subPath) {
        const dirRes = await fetchGateway(gw, `${cid}/${subPath}`);
        if (dirRes && dirRes.ok) {
          upstreamResponse = dirRes;
          break;
        }
      }
    } catch (err) {
      // 次のゲートウェイへフォールバック
    }
  }

  if (!upstreamResponse) {
    return new Response("504 Gateway Timeout: IPFS network did not respond", {
      status: 504,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  // 3. レスポンスヘッダーの再構成
  const headers = new Headers(upstreamResponse.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  headers.set("Content-Disposition", disposition);
  headers.set("X-Content-Type-Options", "nosniff");

  // MIME タイプの自動補正
  if (mimeMap[ext]) {
    headers.set("Content-Type", mimeMap[ext]);
  }

  // 成功時は長期キャッシュ（IPFS のコンテンツはイミュータブルで中身が変わらないため immutable 設定）
  if (upstreamResponse.status === 200 || upstreamResponse.status === 206) {
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
  } else {
    headers.set("Cache-Control", "public, max-age=60");
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}
