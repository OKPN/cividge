import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PUBLIC_GATEWAYS, gatewayRegionLabel, normalizeGatewayEndpoint, normalizeGatewaySettings } from "../ipfs-gateway.js";

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
