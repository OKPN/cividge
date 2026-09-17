// functions/api/upload.js
// Cloudflare Pages Function: 外部スクリプト・Windows「送る」バッチ用 POST アップロード API

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Upload-Password, X-Custom-Domain, X-Storage-Backend",
    },
  });
}

// 許可拡張子一覧
const ALLOWED_EXTS = [
  "jpg", "jpeg", "png", "webp", "gif", "avif", "jxl", "bmp", "ico",
  "mp4", "webm", "ogv", "mov", "m4v", "avi",
  "mp3", "wav", "ogg", "m4a", "flac", "aac",
  "zip", "7z", "rar", "tar", "gz",
  "pdf", "txt", "md", "json", "csv"
];

const MIME_MAP = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  gif: "image/gif", avif: "image/avif", jxl: "image/jxl", bmp: "image/bmp", ico: "image/x-icon",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
  zip: "application/zip", "7z": "application/x-7z-compressed", pdf: "application/pdf"
};

const MAX_UPLOAD_BYTES = 80 * 1024 * 1024;

// 投稿トークンの検証
function verifyAuth(request, env) {
  const adminToken = (env.API_TOKEN || "").trim();
  const uploadToken = (env.UPLOAD_TOKEN || "").trim();
  if (!adminToken && !uploadToken) return false;

  let clientToken = "";
  const authHeader = (request.headers.get("Authorization") || "").trim();
  if (authHeader) {
    clientToken = authHeader.startsWith("Bearer ") ? authHeader.substring(7).trim() : authHeader;
  }
  if (adminToken && clientToken === adminToken) return true;
  if (uploadToken && clientToken === uploadToken) return true;
  return false;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // 1. 認証チェック
  if (!verifyAuth(request, env)) {
    return new Response(JSON.stringify({ success: false, error: "Unauthorized: Invalid token" }), {
      status: 401,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  try {
    const declaredLength = Number(request.headers.get("content-length") || 0);
    if (declaredLength > MAX_UPLOAD_BYTES) {
      return new Response(JSON.stringify({ success: false, error: "File too large (Max: 80MB)" }), {
        status: 413,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    let fileBuffer = null;
    let originalFilename = url.searchParams.get("filename") || "";
    let password = (request.headers.get("X-Upload-Password") || url.searchParams.get("password") || "").trim();
    let contentType = "";

    const contentTypeHeader = request.headers.get("Content-Type") || "";

    if (contentTypeHeader.includes("multipart/form-data")) {
      const formData = await request.formData();
      const uploadedFile = formData.get("file") || formData.get("image");
      if (uploadedFile && typeof uploadedFile.arrayBuffer === "function") {
        originalFilename = originalFilename || uploadedFile.name || "upload_file";
        contentType = uploadedFile.type || "";
        fileBuffer = await uploadedFile.arrayBuffer();
      }
      if (formData.get("password")) {
        password = String(formData.get("password")).trim();
      }
    } else {
      fileBuffer = await request.arrayBuffer();
      contentType = contentTypeHeader.split(";")[0].trim();
    }

    if (!fileBuffer || fileBuffer.byteLength === 0) {
      return new Response(JSON.stringify({ success: false, error: "No file content uploaded" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
    if (fileBuffer.byteLength > MAX_UPLOAD_BYTES) {
      return new Response(JSON.stringify({ success: false, error: "File too large (Max: 80MB)" }), {
        status: 413,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // 2. 拡張子バリデーション
    let ext = originalFilename.includes(".") ? originalFilename.split(".").pop().toLowerCase() : "";
    if (!ext || !ALLOWED_EXTS.includes(ext)) {
      ext = "webp"; // デフォルト拡張子
    }
    contentType = contentType || MIME_MAP[ext] || "application/octet-stream";

    // 3. ランダムファイル名生成（6文字英数）
    const randomArray = new Uint8Array(4);
    crypto.getRandomValues(randomArray);
    const randomStr = Array.from(randomArray, b => b.toString(36).padStart(2, "0")).join("").substring(0, 6);
    const shortKey = `${randomStr}.${ext}`;

    // 4. パスワードハッシュ生成 (PBKDF2)
    let passwordMeta = {};
    if (password) {
      const saltBytes = crypto.getRandomValues(new Uint8Array(16));
      const enc = new TextEncoder();
      const keyMaterial = await crypto.subtle.importKey(
        "raw",
        enc.encode(password),
        { name: "PBKDF2" },
        false,
        ["deriveBits"]
      );
      const derivedBits = await crypto.subtle.deriveBits(
        {
          name: "PBKDF2",
          salt: saltBytes,
          iterations: 100000,
          hash: "SHA-256",
        },
        keyMaterial,
        256
      );
      const hashHex = Array.from(new Uint8Array(derivedBits)).map(b => b.toString(16).padStart(2, "0")).join("");
      const saltHex = Array.from(saltBytes).map(b => b.toString(16).padStart(2, "0")).join("");
      passwordMeta = {
        passwordHash: hashHex,
        passwordSalt: saltHex,
      };
    }

    // 5. ストレージへの保存
    const blobKey = `blob_${shortKey}`;
    let targetCid = null;

    // R2 バケットバインディングがある場合
    const kv = env.CIVIDGE_KV || env.IPFS_KV;
    if (env.R2_BUCKET && (url.searchParams.get("storage") === "r2" || request.headers.get("X-Storage-Backend") === "r2")) {
      await env.R2_BUCKET.put(shortKey, fileBuffer, {
        httpMetadata: { contentType },
        customMetadata: { size: String(fileBuffer.byteLength) },
      });
    } else {
      // デフォルト: CIVIDGE_KV に直接実データを保持 (超高速・無料・即時配信)
      if (kv) {
        await kv.put(blobKey, fileBuffer);
      }
    }

    // KV にルーティング登録
    if (kv) {
      await kv.put(shortKey, targetCid || shortKey, {
        metadata: {
          blobKey,
          size: fileBuffer.byteLength,
          mime: contentType,
          registeredAt: Date.now(),
          ...passwordMeta,
        },
      });
    }

    // 6. 返却 URL の構築
    let publicOrigin = (url.searchParams.get("domain") || request.headers.get("X-Custom-Domain") || env.CUSTOM_DOMAIN || url.origin).trim();
    if (!/^https?:\/\//i.test(publicOrigin)) {
      publicOrigin = `https://${publicOrigin}`;
    }
    publicOrigin = publicOrigin.replace(/\/+$/, "");
    const targetUrl = `${publicOrigin}/${encodeURIComponent(shortKey)}`;

    return new Response(JSON.stringify({
      success: true,
      url: targetUrl,
      key: shortKey,
      filename: shortKey,
      size: fileBuffer.byteLength,
      hasPassword: Boolean(password),
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("Upload error:", err);
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
}
