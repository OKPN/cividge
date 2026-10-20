import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { encryptConfiguration, decryptConfiguration, encryptedConfigurationUrl } from "../security/configuration-export.js";
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
  assert.ok(handler.indexOf('qrModal.style.display = "grid"') < handler.indexOf('await renderSyncQrStage("url")'));
  assert.match(handler, /qrContainer\.style\.display = "none"/);
  assert.match(handler, /messages\.qrTooLarge/);
  assert.match(i18nDict.ja.qrTooLarge, /QRコードの容量を超えています/);
  assert.match(i18nDict.en.qrTooLarge, /QR code capacity/);
  assert.doesNotMatch(handler, /alert\(/);
});

test("transfer UI reveals URL and restoration-key QR codes one stage at a time", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const renderStart = source.indexOf("async function renderSyncQrStage(stage) {");
  const renderEnd = source.indexOf("async function openSyncQrModal()", renderStart);
  const closeStart = source.indexOf('closeQrModalButton?.addEventListener("click", () => {');
  const closeEnd = source.indexOf("qrModal?.addEventListener", closeStart);
  assert.ok(renderStart >= 0 && renderEnd > renderStart);
  assert.match(source.slice(renderStart, renderEnd), /syncQrStage === "key" \? currentSyncRestorationKey : lastGeneratedSyncUrl/);
  assert.match(source.slice(renderStart, renderEnd), /copySyncUrlButton\.style\.display = syncQrStage === "url"/);
  assert.match(source.slice(renderStart, renderEnd), /copyRestorationKeyButton\.style\.display = syncQrStage === "key"/);
  assert.match(source.slice(closeStart, closeEnd), /currentSyncRestorationKey = ""/);
  assert.match(html, /id="qrRestorationKeyWrap" style="display: none/);
  assert.match(html, /id="toggleQrPayloadButton"/);
  assert.match(html, /id="copyRestorationKeyButton"/);
  assert.match(html, /URLと復元キーの両方が揃うと設定を復元できます/);
  assert.match(source.slice(renderStart, renderEnd), /pixelsPerModule = syncQrStage === "key" \? 8 : 4/);
  assert.match(source.slice(renderStart, renderEnd), /qrMatrix\.modules\.size \+ quietZoneModules \* 2/);
  assert.match(source.slice(renderStart, renderEnd), /margin: quietZoneModules/);
  assert.match(html, /max-width: 840px/);
  assert.match(html, /width: auto; max-width: 100%/);
});

test("backup key is removed from the DOM until its separate reveal stage", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const showKeyStart = source.indexOf('document.querySelector("#showBackupKeyButton")?.addEventListener');
  const showKeyEnd = source.indexOf('document.querySelector("#showBackupUrlButton")', showKeyStart);
  const showUrlStart = showKeyEnd;
  const showUrlEnd = source.indexOf('document.querySelector("#copyBackupUrlButton")', showUrlStart);
  assert.ok(showKeyStart >= 0 && showKeyEnd > showKeyStart && showUrlEnd > showUrlStart);
  assert.match(source.slice(showKeyStart, showKeyEnd), /keyDisplay\.textContent = currentBackupRestorationKey/);
  assert.match(source.slice(showUrlStart, showUrlEnd), /keyDisplay\.textContent = ""/);
  assert.match(html, /id="backupKeyStage" style="display: none/);
  assert.match(html, /id="copyBackupKeyButton"/);
  assert.match(html, /id="copyBackupUrlButton"/);
});

test("an encrypted configuration URL can exceed QR capacity without invalidating the URL", async () => {
  const payload = { v: 4, kv: "https://worker.example", cul: Array.from({ length: 120 }, (_, i) =>
    `creator-${i}-${createHash("sha256").update(String(i)).digest("hex")}`) };
  const { encrypted } = await encryptConfiguration(payload);
  const { restorationKey } = await encryptConfiguration({ v: 4, k: "dummy-key" });
  assert.match(restorationKey, /^[a-f0-9]{32}$/);
  const url = encryptedConfigurationUrl(encrypted, "https://cividge.pages.dev/");
  // Varied creator names force a capacity limit without real credentials.
  assert.throws(() => QRCode.create(url, { errorCorrectionLevel: "L" }), /too big to be stored in a QR Code/);
  assert.match(url, /#enc=v1\./);
});

test("phone-transfer URL and key QR images decode to their intended values and restore the payload", async () => {
  const payload = { v: 4, kv: "https://worker.example", preferences: "sample-setting-".repeat(120) };
  const { encrypted, restorationKey } = await encryptConfiguration(payload);
  const url = encryptedConfigurationUrl(encrypted, "https://cividge.pages.dev/preferences?old=discarded");

  async function decodeRenderedQr(value) {
    const matrix = QRCode.create(value, { errorCorrectionLevel: "L" });
    const pixelsPerModule = value === restorationKey ? 8 : 4;
    const quietZoneModules = 4;
    const width = (matrix.modules.size + quietZoneModules * 2) * pixelsPerModule;
    const bytes = await QRCode.toBuffer(value, { width, margin: quietZoneModules, errorCorrectionLevel: "L" });
    const png = PNG.sync.read(bytes);
    const result = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    assert.ok(result, `QR should decode at ${png.width}x${png.height} (${pixelsPerModule}px/module)`);
    return result.data;
  }

  const decodedUrl = await decodeRenderedQr(url);
  const decodedKey = await decodeRenderedQr(restorationKey);
  assert.equal(decodedUrl, url);
  assert.equal(new URL(decodedUrl).hash, `#enc=${encrypted}`);
  assert.equal(decodedKey, restorationKey);
  assert.equal(await decryptConfiguration(new URL(decodedUrl).hash.slice(5), decodedKey).then(value => JSON.stringify(value)), JSON.stringify(payload));
});
