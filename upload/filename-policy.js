import { extensions } from "../media-utils.js";

export function createFilenameTools({ isConversionEnabled, getFilenamePolicy }) {
  function generateRandomString(length) {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let result = "";
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  // ファイル名を最大100文字に制限し、超過時は安全に切り詰めて短縮ハッシュを付与
  function truncateFilename(filename, maxLength = 100) {
    if (!filename || typeof filename !== "string") return filename || "";
    const fullChars = Array.from(filename);
    if (fullChars.length <= maxLength) return filename;

    const dotIndex = filename.lastIndexOf(".");
    let ext = "";
    let baseStr = filename;
    if (dotIndex > 0 && dotIndex < filename.length - 1) {
      ext = filename.slice(dotIndex);
      baseStr = filename.slice(0, dotIndex);
    }

    let hash = "";
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      const rand = new Uint8Array(4);
      crypto.getRandomValues(rand);
      hash = Array.from(rand, b => b.toString(36).padStart(2, "0")).join("").slice(0, 6);
    } else {
      hash = Math.random().toString(36).slice(2, 8);
    }

    const suffix = `_${hash}${ext}`;
    const suffixChars = Array.from(suffix);
    const allowedBaseCharsCount = Math.max(1, maxLength - suffixChars.length);
    const baseChars = Array.from(baseStr);
    const truncatedBase = baseChars.slice(0, allowedBaseCharsCount).join("").replace(/[._\s-]+$/, "");

    return `${truncatedBase}${suffix}`;
  }

  function createOutputName(originalName, mimeType, index = 0) {
    const dotIndex = originalName.lastIndexOf(".");
    const baseName = dotIndex > 0 ? originalName.slice(0, dotIndex) : originalName;
    const originalExt = dotIndex > 0 ? originalName.slice(dotIndex + 1) : "";

    const isConvertOn = isConversionEnabled();
    const filenamePolicy = getFilenamePolicy();
    let safeBase = filenamePolicy.replaceAll("{original}", baseName);

    safeBase = safeBase.replace(/\{random(?::(\d+))?\}/g, (match, digits) => {
      const len = digits ? parseInt(digits, 10) : 6;
      return generateRandomString(len);
    });

    safeBase = safeBase.replace(/\{num(?::(\d+))?\}/g, (match, digits) => {
      const numValue = index + 1;
      if (digits) {
        const targetLength = parseInt(digits, 10);
        return String(numValue).padStart(targetLength, "0");
      }
      return String(numValue);
    });

    if (filenamePolicy !== "{original}") {
      safeBase = safeBase.replace(/[\\/:*?"<>|]/g, "-");
    }

    // URL・ストレージセーフ化: 空白・連続スペースをアンダースコアにサニタイズ（SNSでのリンク分断を防止）
    safeBase = safeBase.trim().replace(/\s+/g, "_");

    const isImageMime = mimeType && (mimeType in extensions);
    const ext = (isConvertOn && isImageMime)
      ? extensions[mimeType]
      : (originalExt || "bin");

    // 🛡️ どんなプリセット・連番を重ねても、最終出力は厳格に100文字以内にサニタイズ
    return truncateFilename(`${safeBase}.${ext}`, 100);
  }

  return { createOutputName, truncateFilename };
}
