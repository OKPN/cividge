import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PUBLIC_GATEWAYS, gatewayEditorSummary, gatewayRegionLabel, normalizeGatewayEndpoint, normalizeGatewaySettings } from "../ipfs-gateway.js";
import { readFileSync } from "node:fs";

test("Gateway endpoint is a canonical HTTPS retrieval route", () => {
  assert.deepEqual(normalizeGatewayEndpoint("https://example.org/ipfs/", "apac"), {
    url: "https://example.org/ipfs", region: "apac", enabled: true,
  });
  assert.throws(() => normalizeGatewayEndpoint("http://example.org/ipfs"), /HTTPS/);
  assert.throws(() => normalizeGatewayEndpoint("https://example.org/api"), /\/ipfs/);
  assert.throws(() => normalizeGatewayEndpoint("https://ipfs.filebase.io/ipfs"), /Filebase provider/);
});

test("the browser starts with a candidate catalog, not a local routing policy", () => {
  assert.ok(DEFAULT_PUBLIC_GATEWAYS.length >= 4);
  assert.deepEqual(normalizeGatewaySettings({}).endpoints, DEFAULT_PUBLIC_GATEWAYS);
  assert.deepEqual(normalizeGatewaySettings({ endpoints: [] }).endpoints, []);
});

test("LATAM is editable metadata; saved Global labels are not silently migrated", () => {
  assert.equal(DEFAULT_PUBLIC_GATEWAYS.find(item => item.url.includes("latam.")).region, "latam");
  const saved = { endpoints: [{ url: "https://latam.orbitor.dev/ipfs", region: "global" }] };
  assert.equal(normalizeGatewaySettings(saved).endpoints[0].region, "global");
  assert.equal(normalizeGatewayEndpoint(saved.endpoints[0].url, "latam").region, "latam");
  assert.match(gatewayRegionLabel("na"), /北米/);
  assert.match(gatewayRegionLabel("latam", "en"), /Caribbean/);
});

test("Gateway accordion summary projects mode, enabled count and unsaved draft", () => {
  const config = normalizeGatewaySettings({});
  assert.equal(gatewayEditorSummary(config, true), "— 自動・有効5件");
  config.mode = "manual";
  config.endpoints[0].enabled = false;
  assert.equal(gatewayEditorSummary(config, false), "— 手動・有効4件・未保存");
  assert.equal(gatewayEditorSummary(config, false, "en"), "— Manual · 4 enabled · Unsaved");
});

test("Gateway accordion starts closed and has no open/close mutation wiring", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const opening = html.match(/<details\b[^>]*id="publicGatewayAccordion"[^>]*>/)?.[0];
  assert.ok(opening);
  assert.doesNotMatch(opening, /\bopen\b/);
  assert.match(html, /<summary[^>]*>[\s\S]*?id="publicGatewaySummary"/);
  const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, /publicGatewayAccordion/);
  assert.match(app, /summary\.textContent = gatewayEditorSummary/);
});
