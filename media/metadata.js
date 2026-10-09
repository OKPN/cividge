import { safeConsole } from "../security/diagnostics.js";
// --- ComfyUI ワークフロー / 生成メタデータ検出ユーティリティ ---
function parseA1111Parameters(raw) {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const negIndex = trimmed.indexOf("Negative prompt:");
  const stepsIndex = trimmed.search(/\bSteps:\s*\d+/);

  let prompt = "";
  let negativePrompt = "";
  let params = "";

  if (negIndex !== -1) {
    prompt = trimmed.substring(0, negIndex).trim();
    if (stepsIndex !== -1 && stepsIndex > negIndex) {
      negativePrompt = trimmed.substring(negIndex + "Negative prompt:".length, stepsIndex).trim();
      params = trimmed.substring(stepsIndex).trim();
    } else {
      negativePrompt = trimmed.substring(negIndex + "Negative prompt:".length).trim();
    }
  } else if (stepsIndex !== -1) {
    prompt = trimmed.substring(0, stepsIndex).trim();
    params = trimmed.substring(stepsIndex).trim();
  } else {
    prompt = trimmed;
  }

  return { prompt, negativePrompt, params, raw: trimmed };
}

function unescapeJsonString(str) {
  if (!str) return "";
  try {
    const sanitized = str.replace(/[\u0000-\u001f]/g, (c) => {
      if (c === "\n") return "\\n";
      if (c === "\r") return "\\r";
      if (c === "\t") return "\\t";
      return "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0");
    });
    return JSON.parse(`"${sanitized}"`);
  } catch (e) {
    return str
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
}

const EXCLUDE_WORDS = new Set([
  "true", "false", "null", "undefined", "none", "fixed", "increment",
  "decrement", "randomize", "auto", "enable", "disable", "cpu", "gpu", "cuda",
  "euler", "euler_ancestral", "heun", "dpm_2", "karras", "exponential",
  "normal", "simple", "ddim", "uni_pc"
]);

function isExcludedString(s) {
  if (!s || s.length < 3) return true;
  const lower = s.toLowerCase().trim();
  if (EXCLUDE_WORDS.has(lower)) return true;
  if (/^https?:\/\//i.test(lower)) return true;
  if (/\.(safetensors|ckpt|pt|bin|pth|onnx|engine|yaml|json|png|jpg|jpeg|webp|mp4|webm|gif|mov)$/i.test(lower)) return true;
  if (/^[\d\s.,_-]+$/.test(lower)) return true;
  return false;
}

function extractPromptsFromRawText(text) {
  if (!text || typeof text !== "string") return null;

  // AI関連キーワードが一切ない場合は重い走査をスキップ（高速化）
  const hasAiHint = text.includes('"inputs"') || 
                    text.includes('"class_type"') || 
                    text.includes('"prompt"') || 
                    text.includes('"workflow"') || 
                    text.includes('"nodes"') ||
                    text.includes('"widgets_values"') ||
                    text.includes('Negative prompt:') ||
                    text.includes('Steps:');
  if (!hasAiHint) return null;

  const candidates = [];

  const addCandidate = (rawVal) => {
    const val = unescapeJsonString(rawVal).trim();
    if (!isExcludedString(val) && !candidates.includes(val)) {
      candidates.push(val);
    }
  };

  // 1. "widgets_values": [...] の配列内を走査 (UI workflow形式)
  const widgetArrayMatches = text.matchAll(/"widgets_values"\s*:\s*\[([\s\S]*?)\]/gi);
  for (const m of widgetArrayMatches) {
    const arrayContent = m[1];
    const stringMatches = arrayContent.matchAll(/"((?:[^"\\]|\\.)*)"/gi);
    for (const sm of stringMatches) {
      addCandidate(sm[1]);
    }
  }

  // 2. キー名による抽出 ("text", "prompt", "positive", "caption", "text_positive", etc.)
  const keyMatches = text.matchAll(/"(?:text|prompt|positive|text_positive|caption|prompt_text)"\s*:\s*"((?:[^"\\]|\\.)*)"/gi);
  for (const m of keyMatches) {
    addCandidate(m[1]);
  }

  if (candidates.length === 0) return null;

  const negKeywords = ["low quality", "worst quality", "blurry", "bad anatomy", "watermark", "deformed", "ugly", "nsfw", "lowres", "bad hands", "error", "missing fingers"];
  const positives = [];
  const negatives = [];

  for (const c of candidates) {
    const lower = c.toLowerCase();
    const isNeg = negKeywords.some(k => lower.includes(k)) || lower.startsWith("negative") || lower.includes("embedding:");
    if (isNeg) {
      negatives.push(c);
    } else {
      positives.push(c);
    }
  }

  let prompt = "";
  let negativePrompt = "";

  if (positives.length > 0) {
    positives.sort((a, b) => b.length - a.length);
    prompt = positives[0];
    if (negatives.length > 0) {
      negativePrompt = negatives[0];
    } else if (positives.length > 1) {
      negativePrompt = positives[1];
    }
  } else {
    prompt = candidates[0];
    if (candidates.length > 1) negativePrompt = candidates[1];
  }

  return {
    prompt,
    negativePrompt,
    params: `Extracted ${candidates.length} candidate(s)`,
    raw: text.slice(0, 5000),
  };
}

function parseComfyPromptJson(rawJson) {
  if (!rawJson) return null;
  let obj = null;
  try {
    obj = typeof rawJson === "string" ? JSON.parse(rawJson) : rawJson;
  } catch (e) {
    if (typeof rawJson === "string") {
      return extractPromptsFromRawText(rawJson);
    }
    return null;
  }
  if (!obj || typeof obj !== "object") return null;

  // { prompt: { ... }, workflow: { ... } } などのラッパー対応
  const targetObj = (obj.prompt && typeof obj.prompt === "object") ? obj.prompt : obj;

  const textNodes = [];
  for (const k of Object.keys(targetObj)) {
    const node = targetObj[k];
    if (node && node.inputs) {
      const val = node.inputs.text || node.inputs.prompt || node.inputs.positive || node.inputs.text_positive || node.inputs.caption;
      if (typeof val === "string" && !isExcludedString(val)) {
        textNodes.push({
          type: node.class_type || "CLIPTextEncode",
          text: val.trim(),
        });
      }
    }
  }

  const wfObj = (obj.workflow && typeof obj.workflow === "object") ? obj.workflow : obj;
  if (textNodes.length === 0 && Array.isArray(wfObj.nodes)) {
    for (const node of wfObj.nodes) {
      if (node && Array.isArray(node.widgets_values)) {
        for (const val of node.widgets_values) {
          if (typeof val === "string" && !isExcludedString(val)) {
            textNodes.push({
              type: node.type || "CLIPTextEncode",
              text: val.trim(),
            });
          }
        }
      }
    }
  }

  if (textNodes.length === 0) {
    return extractPromptsFromRawText(JSON.stringify(obj));
  }

  const prompt = textNodes[0]?.text || "";
  const negativePrompt = textNodes.length > 1 ? textNodes[1]?.text : "";
  return {
    prompt,
    negativePrompt,
    params: `Nodes: ${textNodes.length}`,
    raw: typeof rawJson === "string" ? rawJson : JSON.stringify(rawJson, null, 2),
  };
}

function parseNovelAiComment(raw) {
  if (!raw) return null;
  try {
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (obj && (obj.prompt || obj.uc)) {
      return {
        prompt: obj.prompt || "",
        negativePrompt: obj.uc || "",
        params: `Steps: ${obj.steps || ""}, Scale: ${obj.scale || ""}, Seed: ${obj.seed || ""}`,
        raw: typeof raw === "string" ? raw : JSON.stringify(raw),
      };
    }
  } catch (e) {}
  return null;
}

// ==========================================
// 🧬 PNG メタデータ救出・再注入エンジン (ComfyUI / A1111 互換)
// ==========================================
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function calculateCrc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ bytes[i]) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// 元画像から ComfyUI / A1111 のメタデータ (tEXt / iTXt チャンクおよびテキスト) を救出
async function extractMetadataChunksFromPng(fileOrBuffer) {
  try {
    const buffer = (fileOrBuffer instanceof ArrayBuffer) ? fileOrBuffer : await fileOrBuffer.arrayBuffer();
    const view = new DataView(buffer);
    if (view.byteLength < 8 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a) {
      return { chunks: [], texts: {} };
    }

    const chunks = [];
    const texts = {};
    let offset = 8;
    const length = buffer.byteLength;

    while (offset < length - 8) {
      const chunkLength = view.getUint32(offset);
      const chunkType = String.fromCharCode(
        view.getUint8(offset + 4),
        view.getUint8(offset + 5),
        view.getUint8(offset + 6),
        view.getUint8(offset + 7)
      );

      if (chunkType === "IEND") break;

      // ComfyUI (prompt, workflow) および A1111 (parameters), NovelAI (Comment) 等のテキストメタデータを救出
      // ※ 位置情報・撮影機材情報が含まれうる "eXIf" チャンクは意図的に除外（プライバシー更地化）
      if (chunkType === "tEXt" || chunkType === "iTXt") {
        const fullChunk = new Uint8Array(buffer, offset, chunkLength + 12);
        chunks.push(new Uint8Array(fullChunk)); // コピーして保持

        const chunkData = new Uint8Array(buffer, offset + 8, chunkLength);
        let nullIndex = -1;
        for (let i = 0; i < chunkData.length; i++) {
          if (chunkData[i] === 0) { nullIndex = i; break; }
        }
        if (nullIndex > 0) {
          const keyword = new TextDecoder("utf-8").decode(chunkData.subarray(0, nullIndex));
          try {
            const valText = new TextDecoder("utf-8").decode(chunkData.subarray(nullIndex + 1));
            texts[keyword] = valText;
          } catch (e) {}
        }
      }

      offset += chunkLength + 12;
    }
    return { chunks, texts };
  } catch (err) {
    safeConsole.warn("Failed to extract PNG metadata chunks:", err);
    return { chunks: [], texts: {} };
  }
}

// 変換後の PNG バイナリの IEND 直前に救出したメタデータチャンクを再注入
async function injectMetadataChunksIntoPng(pngBlobOrBuffer, chunks) {
  if (!chunks || chunks.length === 0) return pngBlobOrBuffer;
  try {
    const buffer = (pngBlobOrBuffer instanceof ArrayBuffer) ? pngBlobOrBuffer : await pngBlobOrBuffer.arrayBuffer();
    const view = new DataView(buffer);
    if (view.byteLength < 8 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a) {
      return pngBlobOrBuffer;
    }

    // IEND チャンクの位置を探索
    let offset = 8;
    let iendOffset = -1;
    const length = buffer.byteLength;

    while (offset < length - 8) {
      const chunkLength = view.getUint32(offset);
      const chunkType = String.fromCharCode(
        view.getUint8(offset + 4),
        view.getUint8(offset + 5),
        view.getUint8(offset + 6),
        view.getUint8(offset + 7)
      );
      if (chunkType === "IEND") {
        iendOffset = offset;
        break;
      }
      offset += chunkLength + 12;
    }

    if (iendOffset === -1) return pngBlobOrBuffer;

    let extraSize = 0;
    for (const c of chunks) extraSize += c.byteLength;

    const newBuffer = new Uint8Array(buffer.byteLength + extraSize);
    // IENDの手前までコピー
    newBuffer.set(new Uint8Array(buffer, 0, iendOffset), 0);

    // 救出したメタデータチャンク群を挿入
    let cur = iendOffset;
    for (const c of chunks) {
      newBuffer.set(c, cur);
      cur += c.byteLength;
    }

    // 残りのIENDチャンクをコピー
    newBuffer.set(new Uint8Array(buffer, iendOffset), cur);

    return new Blob([newBuffer], { type: "image/png" });
  } catch (err) {
    safeConsole.warn("Failed to inject PNG metadata chunks:", err);
    return pngBlobOrBuffer;
  }
}

// 変換後の WebP (RIFF) バイナリに ComfyUI メタデータ (VP8X + EXIF チャンク) を再注入
async function injectMetadataIntoWebp(webpBlobOrBuffer, texts, width = 0, height = 0) {
  if (!texts || (!texts.workflow && !texts.prompt && !texts.parameters)) {
    return webpBlobOrBuffer;
  }

  const originalBlob = (webpBlobOrBuffer instanceof Blob) ? webpBlobOrBuffer : new Blob([webpBlobOrBuffer], { type: "image/webp" });

  try {
    const buffer = (webpBlobOrBuffer instanceof ArrayBuffer) ? webpBlobOrBuffer : await webpBlobOrBuffer.arrayBuffer();
    const view = new DataView(buffer);
    if (buffer.byteLength < 12) return originalBlob;

    const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    const webp = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
    if (riff !== "RIFF" || webp !== "WEBP") return originalBlob;

    // 元WebPから画像チャンク（VP8 または VP8L）の位置とサイズを特定
    let offset = 12;
    let imageChunkType = "";
    let imageChunkOffset = -1;
    let imageChunkTotalSize = 0;
    let hasAlpha = false;

    while (offset < buffer.byteLength - 8) {
      const chunkType = String.fromCharCode(
        view.getUint8(offset),
        view.getUint8(offset + 1),
        view.getUint8(offset + 2),
        view.getUint8(offset + 3)
      );
      const chunkSize = view.getUint32(offset + 4, true);
      const paddedSize = chunkSize + (chunkSize % 2 === 1 ? 1 : 0);

      if (chunkType === "VP8 " || chunkType === "VP8L") {
        imageChunkType = chunkType;
        imageChunkOffset = offset;
        imageChunkTotalSize = 8 + paddedSize;
        if (chunkType === "VP8L") hasAlpha = true;
        break;
      } else if (chunkType === "VP8X") {
        // 既にVP8Xがある場合はスキップ
        return originalBlob;
      }
      offset += 8 + paddedSize;
    }

    if (imageChunkOffset === -1) return originalBlob;

    // ComfyUI が解釈できる形式の Exif UserComment を構築
    const payload = {};
    if (texts.prompt) {
      try { payload.prompt = JSON.parse(texts.prompt); } catch (e) { payload.prompt = texts.prompt; }
    }
    if (texts.workflow) {
      try { payload.workflow = JSON.parse(texts.workflow); } catch (e) { payload.workflow = texts.workflow; }
    }
    if (texts.parameters) payload.parameters = texts.parameters;

    const payloadJsonStr = JSON.stringify(payload);
    const commentBytes = new TextEncoder().encode(payloadJsonStr);

    const userCommentHeader = new Uint8Array([0x55, 0x4E, 0x49, 0x43, 0x4F, 0x44, 0x45, 0x00]); // 'UNICODE\0'
    const totalCommentDataLen = userCommentHeader.length + commentBytes.length;
    const exifIfdOffset = 26;
    const userCommentDataOffset = 44;

    const exifPayloadSize = 6 + 8 + 2 + 12 + 4 + 2 + 12 + 4 + totalCommentDataLen;
    const exifChunkDataSize = exifPayloadSize + (exifPayloadSize % 2 === 1 ? 1 : 0);
    const exifData = new Uint8Array(exifChunkDataSize);
    const eView = new DataView(exifData.buffer);

    exifData.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 0); // 'Exif\0\0'
    eView.setUint8(6, 0x49); eView.setUint8(7, 0x49); // 'II'
    eView.setUint16(8, 42, true);
    eView.setUint32(10, 8, true);

    // IFD0
    eView.setUint16(14, 1, true);
    eView.setUint16(16, 0x8769, true);
    eView.setUint16(18, 4, true);
    eView.setUint32(20, 1, true);
    eView.setUint32(24, exifIfdOffset, true);
    eView.setUint32(28, 0, true);

    // ExifIFD
    eView.setUint16(32, 1, true);
    eView.setUint16(34, 0x9286, true);
    eView.setUint16(36, 7, true);
    eView.setUint32(38, totalCommentDataLen, true);
    eView.setUint32(42, userCommentDataOffset, true);
    eView.setUint32(46, 0, true);

    exifData.set(userCommentHeader, 50);
    exifData.set(commentBytes, 58);

    // WebP Extended Header (VP8X): 10 バイトデータ
    // Flags (1B): Exifフラグ (0x08) | (hasAlpha ? 0x10 : 0)
    // Reserved (3B): 00 00 00
    // Canvas Width - 1 (24-bit LE, 3B)
    // Canvas Height - 1 (24-bit LE, 3B)
    const vp8xChunkSize = 8 + 10; // 18 bytes
    const vp8xData = new Uint8Array(18);
    const vpView = new DataView(vp8xData.buffer);
    vp8xData.set([0x56, 0x50, 0x38, 0x58], 0); // 'VP8X'
    vpView.setUint32(4, 10, true); // size = 10
    vp8xData[8] = 0x08 | (hasAlpha ? 0x10 : 0); // Exif flag (+ Alpha if any)
    vp8xData[9] = 0; vp8xData[10] = 0; vp8xData[11] = 0; // Reserved

    const wMinus1 = Math.max(0, width - 1);
    const hMinus1 = Math.max(0, height - 1);
    vp8xData[12] = wMinus1 & 0xFF;
    vp8xData[13] = (wMinus1 >> 8) & 0xFF;
    vp8xData[14] = (wMinus1 >> 16) & 0xFF;
    vp8xData[15] = hMinus1 & 0xFF;
    vp8xData[16] = (hMinus1 >> 8) & 0xFF;
    vp8xData[17] = (hMinus1 >> 16) & 0xFF;

    // EXIF チャンクヘッダー
    const exifChunkHeader = new Uint8Array(8);
    exifChunkHeader.set([0x45, 0x58, 0x49, 0x46], 0); // 'EXIF'
    new DataView(exifChunkHeader.buffer).setUint32(4, exifChunkDataSize, true);

    // 全体組み立て: [RIFF] + [VP8X] + [画像データ(VP8/VP8L)] + [EXIF]
    const imageBytes = new Uint8Array(buffer, imageChunkOffset, imageChunkTotalSize);
    const totalNewSize = 12 + vp8xChunkSize + imageBytes.byteLength + 8 + exifChunkDataSize;
    const finalBuffer = new Uint8Array(totalNewSize);
    const fView = new DataView(finalBuffer.buffer);

    finalBuffer.set([0x52, 0x49, 0x46, 0x46], 0); // 'RIFF'
    fView.setUint32(4, totalNewSize - 8, true);
    finalBuffer.set([0x57, 0x45, 0x42, 0x50], 8); // 'WEBP'

    let cur = 12;
    finalBuffer.set(vp8xData, cur);
    cur += vp8xChunkSize;

    finalBuffer.set(imageBytes, cur);
    cur += imageBytes.byteLength;

    finalBuffer.set(exifChunkHeader, cur);
    cur += 8;

    finalBuffer.set(exifData, cur);

    const injectedBlob = new Blob([finalBuffer], { type: "image/webp" });

    // 🛡️ ロードテスト・セーフガード: ブラウザで正常に描画できるか検証
    const testUrl = URL.createObjectURL(injectedBlob);
    try {
      await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(true);
        img.onerror = () => reject(new Error("Decoded image broken"));
        img.src = testUrl;
      });
      URL.revokeObjectURL(testUrl);
      return injectedBlob; // 検証OK！
    } catch (testErr) {
      safeConsole.warn("Injected WebP verification failed, safely falling back to clean WebP:", testErr);
      URL.revokeObjectURL(testUrl);
      return originalBlob; // 壊れていた場合は元の正常なWebPを返す
    }
  } catch (err) {
    safeConsole.warn("Failed to inject WebP metadata, fallback:", err);
    return originalBlob;
  }
}

export async function detectComfyMetadata(file) {
  if (!file) return { hasWorkflow: false, hasPrompt: false, hasA1111: false, type: "none" };

  const fileName = (file.name || "").toLowerCase();
  const isPng = fileName.endsWith(".png") || file.type === "image/png";
  const isMp4 = fileName.endsWith(".mp4") || file.type === "video/mp4";
  const isWebm = fileName.endsWith(".webm") || file.type === "video/webm";

  let promptDetails = null;

  try {
    // 1. 先頭領域（10MB以下の動画クリップは全体、それ以外は先頭 5MB）
    const isSmallVideo = (isMp4 || isWebm) && file.size <= 10 * 1024 * 1024;
    const headSize = isSmallVideo ? file.size : Math.min(file.size, 5 * 1024 * 1024);
    const headBuffer = await file.slice(0, headSize).arrayBuffer();

    if (isPng) {
      const view = new DataView(headBuffer);
      if (view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a) {
        let offset = 8;
        const length = headBuffer.byteLength;
        let hasWorkflow = false;
        let hasPrompt = false;
        let hasA1111 = false;
        let nodeCount = 0;

        while (offset < length - 8) {
          const chunkLength = view.getUint32(offset);
          offset += 4;
          const chunkType = String.fromCharCode(
            view.getUint8(offset),
            view.getUint8(offset + 1),
            view.getUint8(offset + 2),
            view.getUint8(offset + 3)
          );
          offset += 4;

          if (chunkType === "IEND") break;

          if (chunkType === "tEXt" || chunkType === "iTXt") {
            const chunkData = new Uint8Array(headBuffer, offset, chunkLength);
            let nullIndex = -1;
            for (let i = 0; i < chunkData.length; i++) {
              if (chunkData[i] === 0) { nullIndex = i; break; }
            }
            if (nullIndex > 0) {
              const keyword = new TextDecoder("utf-8").decode(chunkData.subarray(0, nullIndex));
              if (keyword === "workflow") {
                hasWorkflow = true;
                try {
                  const text = new TextDecoder("utf-8").decode(chunkData.subarray(nullIndex + 1));
                  const wfJson = JSON.parse(text);
                  if (Array.isArray(wfJson.nodes)) nodeCount = wfJson.nodes.length;
                  if (!promptDetails) promptDetails = parseComfyPromptJson(wfJson);
                } catch (e) {}
              } else if (keyword === "prompt") {
                hasPrompt = true;
                try {
                  const text = new TextDecoder("utf-8").decode(chunkData.subarray(nullIndex + 1));
                  const parsed = parseComfyPromptJson(text);
                  if (parsed && parsed.prompt) promptDetails = parsed;
                } catch (e) {}
              } else if (keyword === "parameters") {
                hasA1111 = true;
                try {
                  const text = new TextDecoder("utf-8").decode(chunkData.subarray(nullIndex + 1));
                  promptDetails = parseA1111Parameters(text);
                } catch (e) {}
              } else if (keyword === "Comment") {
                try {
                  const text = new TextDecoder("utf-8").decode(chunkData.subarray(nullIndex + 1));
                  if (!promptDetails) promptDetails = parseNovelAiComment(text);
                } catch (e) {}
              }
            }
          }

          offset += chunkLength + 4;
        }

        if (hasWorkflow) return { hasWorkflow: true, hasPrompt, hasA1111, nodeCount, type: "comfy_workflow", promptDetails };
        if (hasPrompt) return { hasWorkflow: false, hasPrompt: true, hasA1111, type: "comfy_prompt", promptDetails };
        if (hasA1111) return { hasWorkflow: false, hasPrompt: false, hasA1111: true, type: "a1111", promptDetails };
      }
    }

    // 2. テキスト判定
    let textSample = new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(headBuffer));

    // 3. 動画（MP4 / WebM）で 10MB 超の場合、末尾（moov atom）も読み込む
    if ((isMp4 || isWebm) && file.size > headSize) {
      const tailSize = Math.min(file.size, 5 * 1024 * 1024);
      const tailBuffer = await file.slice(file.size - tailSize).arrayBuffer();
      const tailText = new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(tailBuffer));
      textSample = textSample + "\n" + tailText;
    }

    // 判定ロジック（ComfyUI-VideoHelperSuite / VHS 形式対応 & 汎用プロンプト検出）
    const hasWf = (textSample.includes('"nodes"') && textSample.includes('"links"')) ||
                  (textSample.includes('"workflow"') && textSample.includes('"nodes"'));
    let hasPrompt = (textSample.includes('"inputs"') && (textSample.includes('"class_type"') || textSample.includes('"text"'))) ||
                    textSample.includes('"client_id"') || textSample.includes('"extra_pnginfo"');
    const hasA1111 = textSample.includes("Negative prompt:") || textSample.includes("Steps: ");

    if (!promptDetails) {
      if (hasA1111) {
        const m = textSample.match(/([\s\S]+?)(Negative prompt:[\s\S]+?)(Steps:\s*\d+[\s\S]*)/);
        if (m) {
          promptDetails = parseA1111Parameters(m[0]);
        } else {
          const negIdx = textSample.indexOf("Negative prompt:");
          if (negIdx !== -1) {
            const start = Math.max(0, negIdx - 800);
            promptDetails = parseA1111Parameters(textSample.substring(start, negIdx + 800));
          }
        }
      }

      if (!promptDetails) {
        promptDetails = extractPromptsFromRawText(textSample);
      }
    }

    if (promptDetails && promptDetails.prompt) {
      hasPrompt = true;
    }

    if (hasWf) return { hasWorkflow: true, hasPrompt: true, hasA1111: false, type: "comfy_workflow", promptDetails };
    if (hasPrompt) return { hasWorkflow: false, hasPrompt: true, hasA1111: false, type: "comfy_prompt", promptDetails };
    if (hasA1111) return { hasWorkflow: false, hasPrompt: false, hasA1111: true, type: "a1111", promptDetails };
    if (promptDetails && promptDetails.prompt) return { hasWorkflow: false, hasPrompt: true, hasA1111: false, type: "ai_metadata", promptDetails };

  } catch (err) {
    safeConsole.warn("Metadata detection error:", err);
  }

  return { hasWorkflow: false, hasPrompt: Boolean(promptDetails?.prompt), hasA1111: false, type: promptDetails ? "comfy_prompt" : "none", promptDetails };
}

