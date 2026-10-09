import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { escapeHtml, safeHttpUrl, safeMediaUrl, renderKuboStatus, quotePowerShell, quotePosixShell } from "../security/presentation.js";
import { encryptConfiguration, decryptConfiguration, encryptedConfigurationUrl } from "../security/configuration-export.js";
import { diagnosticText, redactSecrets, tokenDigest, safeConsole } from "../security/diagnostics.js";
import { createWorkerClient } from "../api/worker-client.js";
import { createStorageConnections } from "../storage/connections.js";
import { assertSafePublicArtifacts } from "../security/public-artifacts.js";

const source = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const dummySecret = "dummy-secret-for-boundary-test";

test("Kubo response text cannot become HTML or read a dummy secret", () => {
  const element = { replaceChildren(child) { this.child = child; }, set innerHTML(_) { throw new Error("Unsafe HTML sink"); } };
  const documentRef = { createElement: () => ({ style: {} }) };
  const payload = '<img src=x onerror="localStorage.getItem(\'adminApiToken\')">';
  renderKuboStatus(element, { online: true, agentVersion: payload }, documentRef);
  assert.equal(element.child.textContent, `🟢 オンライン (${payload})`);
  renderKuboStatus(element, { online: false, error: payload }, documentRef);
  assert.equal(element.child.textContent, `🔴 オフライン (${payload})`);
});

test("actual managed renderer escapes malicious filename and keeps metadata inert", () => {
  const filename = '<img src=x onerror="alert(1)">.webp';
  const row = { Key: filename, rawKey: `media.example:${filename}`, storageProvider: "filebase", entryKind: "link", Size: '1" onfocus="alert(1)',
    isFromS3: true, isCached: true, metadata: { mime: '<script>alert(1)</script>', allowedHost: "media.example" } };
  const cards = [];
  const documentRef = { createElement: () => ({ dataset: {}, setAttribute() {}, querySelector() { return null; } }) };
  const context = {
    r2FileList: { append: card => cards.push(card), prepend() {} }, document: documentRef,
    getAppLanguage: () => "ja", i18nDict: { ja: {} }, getVisibleManagedContents: () => [row],
    getStorageListLabels: () => new Proxy({}, { get: () => "label" }), updateStoragePaginationUI() {},
    managedController: { visiblePage: () => [row] }, localStorage: { getItem: () => "false" },
    getSelectedR2Domain: () => "https://media.example", getStoredIpfsCid: () => null, isValidIpfsCid: () => false,
    getFileStoredDomain: () => "https://media.example", getPublicDeliveryUrl: name => `https://media.example/${encodeURIComponent(name)}`,
    canUseCivitaiPostIntent: () => false, createCardDomainBadgeHtml: () => "", createCardTtlSelectHtml: () => "",
    KUBO_PLACEMENT_STATE: {}, checkRemoteFileWf: () => false, updateSelectedR2ActionButtonsState() {},
    escapeHtml, formatBytes: () => "1 B",
  };
  const renderer = source.slice(source.indexOf("function renderCurrentStoragePage()"), source.indexOf("// --- 🌊 IPFS漂流ファイル"));
  runInNewContext(`${renderer}\nrenderCurrentStoragePage();`, context);
  assert.equal(cards.length, 1);
  assert.ok(cards[0].innerHTML.includes(escapeHtml(filename)));
  assert.ok(!cards[0].innerHTML.includes(filename));
  assert.ok(!cards[0].innerHTML.includes("<script>"));
  assert.ok(!cards[0].innerHTML.includes('data-size="1" onfocus="'));
});

test("URL and configuration values reject executable schemes, credentials, and endpoint queries", () => {
  for (const value of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'https://user:secret@worker.example']) {
    assert.equal(safeHttpUrl(value), "");
    assert.equal(safeMediaUrl(value), "");
  }
  assert.equal(safeHttpUrl("https://worker.example?token=secret", { endpoint: true }), "");
  assert.equal(safeHttpUrl("http://127.0.0.1:5001", { endpoint: true }), "http://127.0.0.1:5001/");
  assert.equal(safeMediaUrl("blob:https://cividge.pages.dev/preview"), "blob:https://cividge.pages.dev/preview");
  assert.equal(quotePowerShell("x'$(alert)`y"), "'x''$(alert)`y'");
  assert.equal(quotePosixShell("x'$(alert)"), "'x'\"'\"'$(alert)'");
});

test("external Civitai statistic strings cannot inject markup", () => {
  const start = source.indexOf("function createCivitaiStatsHtml(stats)");
  const end = source.indexOf('\n}', start) + 2;
  const context = {};
  runInNewContext(`${source.slice(start, end)}\nresult = createCivitaiStatsHtml({ heartCount: '1\" onmouseover=\"alert(1)', likeCount: 2 });`, context);
  assert.doesNotMatch(context.result, /onmouseover|alert\(1\)/);
  assert.match(context.result, /<strong>2<\/strong>/);
});

test("public build guard rejects secret configuration without outputting its content", () => {
  const directory = mkdtempSync(join(tmpdir(), "cividge-public-audit-"));
  const file = join(directory, ".env.production");
  try {
    writeFileSync(file, `DUMMY_SECRET=${dummySecret}`);
    assert.throws(() => assertSafePublicArtifacts(directory), error => /Secret configuration/.test(error.message) && !error.message.includes(dummySecret));
    unlinkSync(file);
    assert.doesNotThrow(() => assertSafePublicArtifacts(directory));
  } finally {
    try { unlinkSync(file); } catch (_) { /* already removed */ }
    rmdirSync(directory);
  }
});

test("portable encrypted export restores credentials; wrong key and tampering fail closed", async () => {
  const payload = { v: 4, k: "dummy-access-key", s: dummySecret, fs: "dummy-filebase-secret", kt: "dummy-admin-token" };
  const { encrypted, restorationKey } = await encryptConfiguration(payload);
  const url = encryptedConfigurationUrl(encrypted, "https://cividge.pages.dev/?token=must-be-removed");
  for (const value of [...Object.values(payload).filter(value => typeof value === "string"), restorationKey, "must-be-removed"]) assert.ok(!url.includes(value));
  assert.deepEqual(await decryptConfiguration(encrypted, restorationKey), payload);
  assert.equal(await decryptConfiguration(encrypted, "0".repeat(32)), null);
  const tampered = encrypted.slice(0, 8) + (encrypted[8] === "a" ? "b" : "a") + encrypted.slice(9);
  assert.equal(await decryptConfiguration(tampered, restorationKey), null);
  assert.equal(await decryptConfiguration(encrypted, "123456"), null);
  assert.match(url, /#enc=v1\./);
});

test("error diagnostics redact stored secrets and do not serialize raw Error properties", async () => {
  const previous = globalThis.localStorage;
  const previousDocument = globalThis.document;
  globalThis.localStorage = { getItem: key => key === "adminApiToken" ? dummySecret : null };
  const originalConsole = globalThis.console;
  const logged = [];
  try {
    const error = new Error(`remote echo ${dummySecret}`);
    error.request = { Authorization: `Bearer ${dummySecret}`, credentials: { secretAccessKey: dummySecret } };
    assert.ok(!diagnosticText(error).includes(dummySecret));
    assert.ok(!diagnosticText({ secretAccessKey: dummySecret, response: dummySecret }).includes(dummySecret));
    assert.ok(!redactSecrets(`Bearer unknown-token`).includes("unknown-token"));
    assert.equal((await tokenDigest(dummySecret)).length, 64);
    globalThis.console = { warn: (...args) => logged.push(args) };
    safeConsole.warn("remote failure", error);
    assert.ok(!JSON.stringify(logged).includes(dummySecret));
    globalThis.localStorage = { getItem: key => key === "uploadTokenVerifiedState" ? "broken-json" : null };
    globalThis.document = { getElementById: () => ({ value: dummySecret }) };
    assert.ok(!diagnosticText(error).includes(dummySecret));
  } finally { globalThis.localStorage = previous; globalThis.document = previousDocument; globalThis.console = originalConsole; }
});

test("Worker error echo and error serialization do not expose its admin token", async () => {
  const previous = globalThis.fetch;
  let activeToken = dummySecret;
  globalThis.fetch = async () => {
    activeToken = "rotated-dummy-token";
    return new Response(JSON.stringify({ error: `echo ${dummySecret}`, code: "CONFLICT", attempt: { token: dummySecret } }), { status: 409 });
  };
  try {
    const client = createWorkerClient({ hasAdminAccess: () => true, getLifecycleApiEndpoint: () => "https://worker.example/api/lifecycle",
      getCustomKvWorkerUrl: () => "https://worker.example", getAdminApiToken: () => activeToken });
    await assert.rejects(client.linkBindingRequest({ action: "inspect" }), error => !error.message.includes(dummySecret) && !JSON.stringify(error).includes(dummySecret));
  } finally { globalThis.fetch = previous; }
});

test("provider credentials survive reconstructed browser settings without network requests", async () => {
  const previous = globalThis.localStorage;
  const values = new Map(Object.entries({ r2AccountId: "a".repeat(32), r2AccessKeyId: "dummy-r2-key", r2SecretAccessKey: dummySecret,
    r2BucketName: "cividge", filebaseApiKey: "dummy-filebase-key", filebaseSecretKey: dummySecret, filebaseBucket: "cividge" }));
  globalThis.localStorage = { getItem: key => values.get(key) || "" };
  try {
    for (let reload = 0; reload < 2; reload++) {
      const connections = createStorageConnections({ getSelectedR2Domain: () => "https://media.example" });
      assert.equal(connections.isR2Configured(), true);
      assert.equal(connections.isFilebaseConfigured(), true);
      for (const provider of ["r2", "filebase"]) assert.equal((await connections.getS3Client(provider).config.credentials()).secretAccessKey, dummySecret);
    }
  } finally { globalThis.localStorage = previous; }
});

test("CSP and current markup have no inline executable script or credential-bearing sync URL", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const headers = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
  assert.match(headers, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.doesNotMatch(headers, /'unsafe-eval'/);
  assert.doesNotMatch(html + source, /\son(?:click|error|load)="/);
  assert.match(headers, /object-src 'none'; base-uri 'none'/);
  assert.doesNotMatch(source, /#sync=z\.|encryptPayloadWithPin|xorBytes|generateRandom6DigitPin/);
});
