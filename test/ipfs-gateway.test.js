import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PUBLIC_GATEWAYS, normalizeGatewayEndpoint, normalizeGatewaySettings } from "../ipfs-gateway.js";

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
