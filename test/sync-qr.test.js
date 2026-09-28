import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import QRCode from "qrcode";
import * as fflate from "fflate";
import { i18nDict } from "../ui/i18n.js";

const source = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const start = source.indexOf("async function openSyncQrModal() {");
const end = source.indexOf("copySyncUrlButton?.addEventListener", start);
const handler = source.slice(start, end);

test("settings save does not reference S3 client state owned by storage/connections", () => {
  const saveStart = source.indexOf("function saveR2SettingsAuto() {");
  const saveEnd = source.indexOf('filebaseCorsButton?.addEventListener', saveStart);
  assert.ok(saveStart > 0 && saveEnd > saveStart);
  assert.doesNotMatch(source.slice(saveStart, saveEnd), /\bs3Client(?:R2|Filebase)\b/);
});

test("QR dialog opens before asynchronous rendering and reports failure inside the dialog", () => {
  assert.ok(start > 0 && end > start);
  assert.ok(handler.indexOf('qrModal.style.display = "grid"') < handler.indexOf("await QRCode.toCanvas"));
  assert.match(handler, /qrContainer\.style\.display = "none"/);
  assert.match(handler, /messages\.qrTooLarge/);
  assert.match(i18nDict.ja.qrTooLarge, /QRコードの容量を超えています/);
  assert.match(i18nDict.en.qrTooLarge, /QR code capacity/);
  assert.doesNotMatch(handler, /alert\(/);
});

test("a valid compressed sync URL can exceed QR capacity without invalidating the URL", () => {
  const payload = { v: 4, kv: "https://worker.example", cul: Array.from({ length: 120 }, (_, i) =>
    `creator-${i}-${createHash("sha256").update(String(i)).digest("hex")}`) };
  const compressed = Buffer.from(fflate.deflateSync(fflate.strToU8(JSON.stringify(payload)), { level: 9 })).toString("base64url");
  const url = `https://cividge.pages.dev/#sync=z.${compressed}`;
  // Varied creator names force a capacity limit without real credentials.
  assert.throws(() => QRCode.create(url, { errorCorrectionLevel: "L" }), /too big to be stored in a QR Code/);
  assert.match(url, /#sync=z\./);
});
