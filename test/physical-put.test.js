import test from "node:test";
import assert from "node:assert/strict";
import { PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { putUploadObject } from "../upload/physical-put.js";

const base = { bucket: "bucket", key: "objects/QmCid", bytes: new Uint8Array([1, 2]),
  contentType: "image/webp", contentDisposition: "inline", metadata: { cid: "QmCid" },
  isValidIpfsCid: cid => cid === "QmCid" };

test("R2 performs one PUT with the reserved physical locator", async () => {
  const calls = [];
  const result = await putUploadObject({ ...base, provider: "r2", s3: { send: async command => {
    calls.push(command);
    return {};
  } } });
  assert.equal(result.ipfsCid, null);
  assert.equal(calls.length, 1);
  assert.ok(calls[0] instanceof PutObjectCommand);
  assert.equal(calls[0].input.Key, base.key);
});

test("Filebase uses the PUT response CID without an extra HEAD", async () => {
  const calls = [];
  const result = await putUploadObject({ ...base, provider: "filebase", s3: { send: async command => {
    calls.push(command);
    return { $metadata: { httpHeaders: { "x-amz-meta-cid": "QmCid" } } };
  } } });
  assert.equal(result.ipfsCid, "QmCid");
  assert.equal(calls.length, 1);
});

test("Filebase retries CID observation by HEAD only when PUT omitted it", async () => {
  const calls = [];
  const result = await putUploadObject({ ...base, provider: "filebase", sleep: async () => {},
    s3: { send: async command => {
      calls.push(command);
      return command instanceof HeadObjectCommand ? { Metadata: { cid: "QmCid" } } : {};
    } },
  });
  assert.equal(result.ipfsCid, "QmCid");
  assert.equal(calls.length, 2);
  assert.ok(calls[1] instanceof HeadObjectCommand);
  assert.equal(calls[1].input.Key, base.key);
});
