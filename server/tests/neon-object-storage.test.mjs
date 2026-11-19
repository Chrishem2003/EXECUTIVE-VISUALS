import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createNeonObjectStorage } from "../neon-object-storage.mjs";

const config = {
  endpoint: "https://br-test.storage.c-9.us-east-2.aws.neon.tech",
  region: "us-east-2",
  accessKeyId: "neon_test_key_123",
  secretAccessKey: "s".repeat(40),
  bucket: "executive-visuals-media",
  clock: () => new Date("2026-11-19T12:00:00.000Z")
};
const owner = "123e4567-e89b-42d3-a456-426614174000";
const asset = "223e4567-e89b-42d3-a456-426614174000";
const path = owner + "/" + asset + "/master.mp4";
const response = (status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: name => headers[name.toLowerCase()] ?? null }
});

test("Neon adapter requires valid HTTPS endpoint, region, credentials and limits", () => {
  assert.throws(() => createNeonObjectStorage({ ...config, endpoint: "http://storage.example.test" }), /HTTPS origin/);
  assert.throws(() => createNeonObjectStorage({ ...config, region: "auto" }), /NEON_STORAGE_REGION/);
  assert.throws(() => createNeonObjectStorage({ ...config, accessKeyId: "" }), /credentials/);
  assert.throws(() => createNeonObjectStorage({ ...config, bucket: "bad bucket" }), /BUCKET/i);
  assert.throws(() => createNeonObjectStorage({ ...config, maxBytes: 0 }), /size limit/);
  assert.doesNotThrow(() => createNeonObjectStorage({ ...config, region: "aws-ap-southeast-1" }));
});

test("uploads private media with path-style addressing and AWS SigV4", async () => {
  const calls = [];
  const storage = createNeonObjectStorage({
    ...config,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return response(200); }
  });
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const result = await storage.upload(path, bytes, "video/mp4");
  assert.deepEqual(result, { bucket: "executive-visuals-media", path, size: 4, contentType: "video/mp4" });
  assert.equal(calls[0].url, config.endpoint + "/executive-visuals-media/" + path);
  assert.equal(calls[0].options.method, "PUT");
  assert.match(calls[0].options.headers.authorization, /^AWS4-HMAC-SHA256 Credential=/);
  assert.equal(calls[0].options.headers["x-amz-date"], "20261119T120000Z");
  assert.equal(calls[0].options.headers["x-amz-content-sha256"], createHash("sha256").update(bytes).digest("hex"));
  assert.equal(calls[0].options.headers["content-type"], "video/mp4");
});

test("creates short-lived presigned GET URLs without exposing credentials in the host", async () => {
  const storage = createNeonObjectStorage(config);
  const url = new URL(await storage.createSignedUrl(path, 600));
  assert.equal(url.origin, config.endpoint);
  assert.equal(url.pathname, "/executive-visuals-media/" + path);
  assert.equal(url.searchParams.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
  assert.equal(url.searchParams.get("X-Amz-Expires"), "600");
  assert.equal(url.searchParams.get("X-Amz-SignedHeaders"), "host");
  assert.match(url.searchParams.get("X-Amz-Signature"), /^[a-f0-9]{64}$/);
  assert.equal(url.searchParams.has("X-Amz-Signature") && url.searchParams.has("X-Amz-Credential"), true);
  await assert.rejects(() => storage.createSignedUrl(path, 10), /expiry/);
});

test("streams media files and returns a stable SHA-256 receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-neon-storage-"));
  const file = join(root, "master.mp4");
  const bytes = Buffer.from("private-neon-media");
  await writeFile(file, bytes);
  let captured = null;
  try {
    const storage = createNeonObjectStorage({
      ...config,
      fetchImpl: async (url, options) => {
        const chunks = [];
        for await (const chunk of options.body) chunks.push(Buffer.from(chunk));
        captured = { url, options, bytes: Buffer.concat(chunks) };
        return response(200);
      }
    });
    const result = await storage.uploadFile(path, file, "video/mp4");
    assert.equal(result.size, bytes.length);
    assert.equal(result.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.deepEqual(captured.bytes, bytes);
    assert.equal(captured.options.duplex, "half");
    assert.equal(captured.options.headers["content-length"], String(bytes.length));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verifies stored object size, media type and SHA-256 by streaming bytes", async () => {
  const bytes = Buffer.from("completed-private-video");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const storage = createNeonObjectStorage({
    ...config,
    fetchImpl: async () => ({
      ...response(200, { "content-length": String(bytes.length), "content-type": "video/mp4" }),
      body: (async function* () { yield bytes.subarray(0, 5); yield bytes.subarray(5); })()
    })
  });
  const receipt = await storage.verifyObject(path, {
    expectedSize: bytes.length, expectedSha256: digest, contentType: "video/mp4"
  });
  assert.deepEqual(receipt, {
    bucket: "executive-visuals-media", path, size: bytes.length, sha256: digest, contentType: "video/mp4"
  });
});

test("rejects objects with mismatched size, type or checksum", async () => {
  const bytes = Buffer.from("private-media");
  const storage = createNeonObjectStorage({
    ...config,
    fetchImpl: async () => ({
      ...response(200, { "content-length": String(bytes.length), "content-type": "application/octet-stream" }),
      body: (async function* () { yield bytes; })()
    })
  });
  await assert.rejects(() => storage.verifyObject(path, {
    expectedSize: bytes.length, expectedSha256: createHash("sha256").update(bytes).digest("hex"), contentType: "video/mp4"
  }), error => error.code === "NEON_OBJECT_MEDIA_TYPE_MISMATCH");
  await assert.rejects(() => storage.verifyObject(path, {
    expectedSize: bytes.length, expectedSha256: "a".repeat(64)
  }), error => error.code === "NEON_OBJECT_SHA256_MISMATCH");
  await assert.rejects(() => storage.verifyObject(path, {
    expectedSize: bytes.length + 1, expectedSha256: createHash("sha256").update(bytes).digest("hex")
  }), error => error.code === "NEON_OBJECT_SIZE_MISMATCH");
});

test("deletes objects idempotently and reports private storage readiness", async () => {
  const calls = [];
  const storage = createNeonObjectStorage({
    ...config,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(options.method === "DELETE" ? 404 : 200);
    }
  });
  assert.deepEqual(await storage.checkReadiness(), {
    ready: true, storage: "private", provider: "neon-object-storage", bucket: "executive-visuals-media"
  });
  assert.equal(await storage.remove(path), true);
  assert.equal(calls[0].options.method, "HEAD");
  assert.equal(calls[1].options.method, "DELETE");
});

test("rejects unsafe object paths before making a request", async () => {
  let calls = 0;
  const storage = createNeonObjectStorage({ ...config, fetchImpl: async () => { calls++; return response(200); } });
  await assert.rejects(() => storage.upload("../escape/master.mp4", new Uint8Array([1]), "video/mp4"), /object path/);
  await assert.rejects(() => storage.upload(path, new Uint8Array([1]), "application/x-msdownload"), /Unsupported/);
  assert.equal(calls, 0);
});
