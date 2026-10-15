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
