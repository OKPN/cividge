import encodeJxl, { init as initJxl } from "@jsquash/jxl/encode.js";
import jxlWasmUrl from "@jsquash/jxl/codec/enc/jxl_enc.wasm?url";
import { conversionModeToMime, requireConvertedBlob } from "../view-policy.js";
import { isConvertibleImage } from "../media-utils.js";

let jxlInitialized = false;
async function ensureJxl() {
  if (!jxlInitialized) {
    try {
      const res = await fetch(jxlWasmUrl);
      if (!res.ok) throw new Error(`WASM fetch failed: HTTP ${res.status}`);
      const wasmBytes = await res.arrayBuffer();
      const wasmModule = await WebAssembly.compile(wasmBytes);
      await initJxl(wasmModule);
      jxlInitialized = true;
    } catch (e) {
      console.error("Failed to init JXL encoder:", e);
      throw e;
    }
  }
}
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

function canvasToBlob(canvas, mimeType, quality) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), mimeType, quality);
  });
}

export function createImageConverter({ getConversionMode, isConversionEnabled, qualityRange, createOutputName }) {
  async function convertImage(file, index = 0) {
    const isImage = isConvertibleImage(file);

    const isConvertOn = isConversionEnabled();

    if (!isImage || !isConvertOn) {
      const url = URL.createObjectURL(file);
      const outputName = createOutputName(file.name, null, index);
      return {
        id: crypto.randomUUID(),
        name: outputName,
        relativePath: file.relativePath || file.name,
        url,
        previewUrl: isImage ? url : "",
        blob: file,
        size: file.size,
        originalSize: file.size,
        isNonImage: !isImage,
      };
    }

    const options = {
      mimeType: conversionModeToMime(getConversionMode()),
      quality: qualityRange ? Number(qualityRange.value) / 100 : 0.85,
      name: createOutputName(file.name, conversionModeToMime(getConversionMode()), index),
    };

    let finalBlob = null;
    let previewSrc = "";

    try {
      const image = await loadImage(file);
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;

      const context = canvas.getContext("2d", { alpha: true });
      context.drawImage(image, 0, 0);

      if (options.mimeType === "image/jxl") {
        await ensureJxl();
        const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
        const qualityVal = qualityRange ? Number(qualityRange.value) : 85;
        const jxlBuffer = await encodeJxl(imageData, { quality: qualityVal });
        finalBlob = new Blob([jxlBuffer], { type: "image/jxl" });
        try {
          previewSrc = canvas.toDataURL("image/webp", 0.7);
        } catch (e) {}
      } else {
        // Canvas変換（生写真のGPS位置情報・Exifは自動更地化）
        finalBlob = await canvasToBlob(canvas, options.mimeType, options.quality);
      }
      requireConvertedBlob(finalBlob, options.mimeType);
    } catch (err) {
      console.error("Image conversion error:", err);
      throw new Error(`画像変換エラー (${options.name}): ${err.message}`, { cause: err });
    }

    const finalUrl = URL.createObjectURL(finalBlob);

    return {
      id: crypto.randomUUID(),
      name: options.name,
      relativePath: file.relativePath || file.name,
      url: finalUrl,
      previewUrl: previewSrc || finalUrl,
      blob: finalBlob,
      size: finalBlob.size,
      originalSize: file.size,
      isNonImage: false,
      hasRescuedWf: Boolean(file.metaStatus?.hasWorkflow || file.metaStatus?.hasPrompt),
    };
  }

  return { convertImage };
}
