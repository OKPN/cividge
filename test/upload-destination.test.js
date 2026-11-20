import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createUploadDestinationGuard } from "../ui/upload-destination.js";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("destination fields share a wrapping row while upload stays below", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /class="upload-destination-fields">[\s\S]*?id="uploadProviderSelect"[\s\S]*?id="quickDomainSelect"[\s\S]*?<\/div>\s*<button[^>]*id="uploadButton"/);
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(css, /\.upload-destination-fields\s*\{[^}]*display: flex;[^}]*flex-wrap: wrap;/);
});
function guardFixture({ domain = "https://selected.pages.dev", configured = true, relay = true } = {}) {
  const events = [];
  const guard = createUploadDestinationGuard({
    getDomain: () => domain, getDomains: () => domain ? [domain] : [],
    isConfigured: () => configured, requiresRelay: () => true,
    verifyRelay: async () => { events.push("probe"); return relay; },
    onIssue: async (provider, reason) => events.push(`${provider}:${reason}`),
  });
  return { guard, events };
}

test("missing domain or storage stops before relay network I/O", async () => {
  for (const [options, reason] of [[{ domain: "" }, "domain"], [{ domain: "javascript:alert(1)" }, "domain"],
    [{ domain: "https://name:secret@example.com" }, "domain"], [{ configured: false }, "storage"]]) {
    const f = guardFixture(options);
    assert.equal(await f.guard("filebase"), null);
    assert.deepEqual(f.events, [`filebase:${reason}`]);
  }
});

test("failed relay validation opens guidance; valid destination is a captured presentation value", async () => {
  const failed = guardFixture({ relay: false });
  assert.equal(await failed.guard("r2"), null);
  assert.deepEqual(failed.events, ["probe", "r2:relay"]);
  const valid = guardFixture();
  const destination = await valid.guard("filebase");
  assert.deepEqual(destination, { provider: "filebase", domain: "https://selected.pages.dev" });
  assert.equal(Object.isFrozen(destination), true);
});

function batchFixture(guard) {
  const calls = [];
  const context = {
    uploadDestinationBusy: false,
    uploadState: { getFiles: () => [1, 2], getResults: () => [{}, {}] },
    requestUploadDestination: guard,
    runConversion: async () => { calls.push("convert"); return true; },
    uploadImage: async (_, provider, _password, options) => { calls.push([provider, options.deliveryDomain]); return true; },
    setUiLock: () => {}, renderCurrentStoragePage: () => {},
    document: { querySelector: () => ({ value: "" }) },
    statusText: { textContent: "", className: "" }, progressBar: { value: 0 },
    safeConsole: { error: assert.fail }, redactSecrets: value => value,
  };
  const source = app.slice(app.indexOf("async function handleBatchUpload("), app.indexOf('uploadButton?.addEventListener("click"'));
  const run = runInNewContext(`(${source.trim()})`, context);
  return { calls, run, context };
}

test("actual batch entry stops before conversion/PUT when destination is missing", async () => {
  const f = guardFixture({ configured: false });
  const batch = batchFixture(f.guard);
  await batch.run("r2");
  assert.deepEqual(batch.calls, []);
  assert.deepEqual(f.events, ["r2:storage"]);
  assert.equal(batch.context.uploadDestinationBusy, false);
});

test("actual batch captures provider/domain and does not follow changed settings mid-conversion", async () => {
  let domain = "https://chosen.pages.dev";
  const guard = createUploadDestinationGuard({ getDomain: () => domain, getDomains: () => [domain],
    isConfigured: () => true, requiresRelay: () => false, verifyRelay: assert.fail, onIssue: assert.fail });
  const batch = batchFixture(guard);
  batch.context.runConversion = async () => { domain = "https://other.pages.dev"; return true; };
  await batch.run("filebase");
  assert.deepEqual(batch.calls, [["filebase", "https://chosen.pages.dev"], ["filebase", "https://chosen.pages.dev"]]);
});

test("one upload CTA and one destination selector are independent of managed view", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.equal((html.match(/id="uploadButton"/g) || []).length, 1);
  assert.equal((html.match(/id="uploadProviderSelect"/g) || []).length, 1);
  assert.doesNotMatch(html, /convertUploadR2Button|convertUploadFilebaseButton|quickFilebaseDomainSelect/);
  assert.doesNotMatch(app, /upload-r2-btn|upload-filebase-btn/);
  const selection = app.slice(app.indexOf('uploadProviderSelect?.addEventListener("change"'), app.indexOf("function showDomainAddForm"));
  assert.doesNotMatch(selection, /fetchAndRender|setActiveProvider|handleDomainSelectionChange/);
  assert.ok(app.indexOf("let uploadUiLocked = false") < app.indexOf("\nupdateR2Status();"));
  const batch = app.slice(app.indexOf("async function handleBatchUpload("), app.indexOf('uploadButton?.addEventListener("click"'));
  assert.ok(batch.indexOf("requestUploadDestination(") < batch.indexOf("runConversion()"));
});

test("PC compact command bar and top-right settings drawer preserve full-width file list", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(html, /class="command-bar-grid"/);
  assert.match(html, /class="execution-bar"/);
  assert.match(html, /id="openSettingsDrawerButton"/);
  assert.match(html, /id="settingsDrawerBackdrop"[\s\S]*?id="settingsDrawer"[\s\S]*?id="desktopSettingsSlot"[\s\S]*?id="allSettingsAccordionsContainer"/);
  assert.match(html, /class="panel r2-files-panel"[\s\S]*?id="r2FileList"/);
  assert.match(css, /\.command-bar-grid\s*\{[^}]*grid-template-columns:/);
  assert.match(css, /\.execution-bar\s*\{/);
  assert.match(css, /\.settings-drawer\s*\{/);
});

test("upload destination provider and pagination size are persisted to localStorage and restored on startup", () => {
  assert.match(app, /localStorage\.setItem\("uploadProvider",\s*uploadProviderSelect\.value\)/);
  assert.match(app, /const savedUploadProvider = localStorage\.getItem\("uploadProvider"\)/);
  assert.match(app, /if \(savedUploadProvider && \["auto", "r2", "filebase"\]\.includes\(savedUploadProvider\)\)/);
  assert.match(app, /if \(r2PerPageSelect\) \{\s*r2PerPageSelect\.value = String\(managedController\.getPerPage\(\)\);\s*\}/);
});

test("auto upload provider routes video/audio to R2 and images to Filebase when both are configured", () => {
  const resolverSrc = app.slice(app.indexOf("function resolveAutoUploadProvider("), app.indexOf("async function handleBatchUpload("));
  const resolveAuto = runInNewContext(`(${resolverSrc.trim()})`, {
    isR2Configured: () => true,
    isFilebaseConfigured: () => true,
  });
  assert.equal(resolveAuto({ name: "clip.mp4", type: "video/mp4" }), "r2");
  assert.equal(resolveAuto({ name: "voice.m4a", type: "audio/mp4" }), "r2");
  assert.equal(resolveAuto({ name: "pic.webp", type: "image/webp" }), "filebase");

  const r2Only = runInNewContext(`(${resolverSrc.trim()})`, {
    isR2Configured: () => true,
    isFilebaseConfigured: () => false,
  });
  assert.equal(r2Only({ name: "pic.webp", type: "image/webp" }), "r2");

  const calls = [];
  const files = [
    { name: "clip.mp4", type: "video/mp4" },
    { name: "pic.png", type: "image/png" },
  ];
  const results = [
    { name: "clip.mp4", blob: { type: "video/mp4" } },
    { name: "pic.webp", blob: { type: "image/webp" } },
  ];
  const batchSrc = app.slice(app.indexOf("async function handleBatchUpload("), app.indexOf('uploadButton?.addEventListener("click"'));
  const runBatch = runInNewContext(`(${batchSrc.trim()})`, {
    uploadDestinationBusy: false,
    uploadState: { getFiles: () => files, getResults: () => results },
    resolveAutoUploadProvider: resolveAuto,
    requestUploadDestination: async p => ({ provider: p, domain: p === "r2" ? "https://kv.k7m.f5.si" : "https://misskey.okpn.f5.si" }),
    runConversion: async () => true,
    uploadImage: async (res, provider, _pw, opts) => { calls.push([res.name, provider, opts.deliveryDomain]); return true; },
    setUiLock: () => {}, renderCurrentStoragePage: () => {},
    document: { querySelector: () => ({ value: "" }) },
    statusText: { textContent: "", className: "" }, progressBar: { value: 0 },
    safeConsole: { error: assert.fail }, redactSecrets: v => v,
  });
  return runBatch("auto").then(() => {
    assert.deepEqual(calls, [
      ["clip.mp4", "r2", "https://kv.k7m.f5.si"],
      ["pic.webp", "filebase", "https://misskey.okpn.f5.si"],
    ]);
  });
});
