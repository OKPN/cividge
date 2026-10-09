import { safeConsole } from "./security/diagnostics.js";
"use strict";

import { encode as encodeJpeg } from "@jsquash/jpeg";
import { encode as encodePng } from "@jsquash/png";
import { encode as encodeWebp } from "@jsquash/webp";
import { encode as encodeJxl } from "@jsquash/jxl";

self.onmessage = async (event) => {
  const { file, buffer, type, targetFormat, quality, options } = event.data;

  try {
    const inputMedia = file || new Blob([buffer], { type: type || "image/png" });
    const mimeType = targetFormat || (options && options.mimeType) || "image/webp";
    
    let rawQuality = quality;
    if (rawQuality === undefined && options) {
      rawQuality = options.quality;
    }
    if (rawQuality === undefined) rawQuality = 85;
    
    // 1-100 を 0.0-1.0 に正規化
    const normalizedQuality = rawQuality > 1 ? rawQuality / 100 : rawQuality;

    const imageData = await fileToImageData(inputMedia);
    const arrayBuffer = await encodeImage(imageData, { mimeType, quality: normalizedQuality });

    self.postMessage({
      type: "SUCCESS",
      ok: true,
      buffer: arrayBuffer,
      blob: new Blob([arrayBuffer], { type: mimeType }),
    });
  } catch (error) {
    safeConsole.error("Worker conversion error:", error);
    self.postMessage({
      type: "ERROR",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

async function fileToImageData(file) {
  if (!self.createImageBitmap || !self.OffscreenCanvas) {
    throw new Error("このブラウザではWorker内画像変換に対応していません");
  }

  const image = await createImageBitmap(file);
  const canvas = new OffscreenCanvas(image.width, image.height);
  const context = canvas.getContext("2d", { alpha: true });
  context.drawImage(image, 0, 0);
  image.close();
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

async function encodeImage(imageData, options) {
  const quality = Math.round(options.quality * 100);

  if (options.mimeType === "image/jpeg") {
    return encodeJpeg(imageData, {
      quality,
      progressive: true,
      optimize_coding: true,
      auto_subsample: true,
    });
  }

  if (options.mimeType === "image/png") {
    return encodePng(imageData, { bitDepth: 8 });
  }

  if (options.mimeType === "image/webp") {
    const isLossless = quality >= 100;
    return encodeWebp(imageData, {
      quality: isLossless ? 75 : quality,
      lossless: isLossless,
      method: 5,
      sns_strength: 50,
      filter_strength: 60,
      alpha_quality: 100,
    });
  }

  if (options.mimeType === "image/jxl") {
    return encodeJxl(imageData, {
      quality,
      effort: 7,
      progressive: false,
      lossless: quality >= 100,
    });
  }

  throw new Error(`未対応の出力形式です: ${options.mimeType}`);
}
