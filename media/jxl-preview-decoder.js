import decode, { init } from "@jsquash/jxl/decode.js";
import wasmUrl from "@jsquash/jxl/codec/dec/jxl_dec.wasm?url";
import { GLOBAL_UPLOAD_LIMIT_BYTES } from "../upload-limit.js";

let initialization;
function initialize() {
  if (!initialization) initialization = (async () => {
    const response = await fetch(wasmUrl);
    if (!response.ok) throw new Error("JXL decoder unavailable");
    await init(await WebAssembly.compile(await response.arrayBuffer()));
  })().catch(error => { initialization = undefined; throw error; });
  return initialization;
}

export async function decodeJxlPreviewBlob(url) {
  const response = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer" });
  if (!response.ok) throw new Error("JXL preview unavailable");
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > GLOBAL_UPLOAD_LIMIT_BYTES) throw new Error("JXL preview too large");
  await initialize();
  const pixels = await decode(buffer);
  const source = document.createElement("canvas");
  source.width = pixels.width;
  source.height = pixels.height;
  source.getContext("2d").putImageData(pixels, 0, 0);
  const preview = document.createElement("canvas");
  const scale = Math.min(1, 256 / Math.max(pixels.width, pixels.height));
  preview.width = Math.max(1, Math.round(pixels.width * scale));
  preview.height = Math.max(1, Math.round(pixels.height * scale));
  preview.getContext("2d").drawImage(source, 0, 0, preview.width, preview.height);
  source.width = source.height = 0;
  return new Promise((resolve, reject) => preview.toBlob(blob => {
    preview.width = preview.height = 0;
    if (blob) resolve(blob);
    else reject(new Error("JXL preview rendering failed"));
  }, "image/png"));
}
