import assert from "node:assert/strict";
import test from "node:test";
import { matchesSelectedRelayProbe } from "../relay-compat.js";

function probe(url, relayHost = "content-cache.pages.dev") {
  return { ok: true, url, headers: new Headers({ "content-type": "image/webp",
    "x-cividge-relay-host": relayHost }) };
}

test("selected Pages host must be the Worker-confirmed relay identity", () => {
  const selected = "https://content-cache.pages.dev";
  assert.equal(matchesSelectedRelayProbe(selected,
    probe("https://relay.example/r/content-relay/404-character.webp", "content-relay.pages.dev")), false);
  assert.equal(matchesSelectedRelayProbe(selected,
    probe("https://relay.example/r/content-cache/404-character.webp")), true);
  assert.equal(matchesSelectedRelayProbe(selected,
    probe("https://relay.example/r/content-cache.pages.dev/404-character.webp")), true);
  assert.equal(matchesSelectedRelayProbe(selected,
    probe("https://relay.example/r/content-cache/404-character.webp", "other.pages.dev")), false);
  assert.equal(matchesSelectedRelayProbe(selected,
    probe("https://content-cache.pages.dev/404-character.webp")), false);
});
