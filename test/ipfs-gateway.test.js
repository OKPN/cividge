import assert from "node:assert/strict";
import test from "node:test";
import { normalizeGatewayEndpoint, normalizeGatewaySettings, selectGatewayEndpoint, gatewayRetrievalUrl } from "../ipfs-gateway.js";

test("Gateway endpoint is a canonical HTTPS retrieval route", () => {
  assert.deepEqual(normalizeGatewayEndpoint("https://example.org/ipfs/", "apac"), {
    url: "https://example.org/ipfs", region: "apac", enabled: true,
  });
  assert.throws(() => normalizeGatewayEndpoint("http://example.org/ipfs"), /HTTPS/);
  assert.throws(() => normalizeGatewayEndpoint("https://example.org/api"), /\/ipfs/);
  assert.throws(() => normalizeGatewayEndpoint("https://ipfs.filebase.io/ipfs"), /Filebase provider/);
});

test("auto selection uses region metadata; manual selects an enabled peer", () => {
  const settings = normalizeGatewaySettings({ endpoints: [
    { url: "https://eu.example/ipfs", region: "eu" },
    { url: "https://apac.example/ipfs", region: "apac" },
  ] });
  assert.equal(selectGatewayEndpoint(settings, "Asia/Tokyo").url, "https://apac.example/ipfs");
  assert.equal(selectGatewayEndpoint(settings, "Europe/Paris").url, "https://eu.example/ipfs");
  settings.mode = "manual";
  settings.selectedUrl = "https://eu.example/ipfs";
  assert.equal(selectGatewayEndpoint(settings, "Asia/Tokyo").url, "https://eu.example/ipfs");
  settings.endpoints[0].enabled = false;
  assert.equal(selectGatewayEndpoint(settings, "Asia/Tokyo"), null);
});

test("Gateway selection builds retrieval URL without touching Placement state", () => {
  const endpoint = normalizeGatewayEndpoint("https://example.org/ipfs");
  assert.equal(gatewayRetrievalUrl(endpoint, "bafybeigdyrzt"), "https://example.org/ipfs/bafybeigdyrzt");
});
