import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createCloudflareR2Storage } from "../cloudflare-r2-storage.mjs";

const config = {
  accountId: "0123456789abcdef0123456789abcdef",
  accessKeyId: "0123456789abcdef",
  secretAccessKey: "s".repeat(40),
  bucket: "executive-visuals-media",
  clock: () => new Date("2026-11-14T12:00:00.000Z")
};
const owner = "123e4567-e89b-42d3-a456-426614174000";
const asset = "223e4567-e89b-42d3-a456-426614174000";
const path = owner + "/" + asset + "/master.mp4";
const response = (status = 200) => ({ ok: status >= 200 && status < 300, status });

test("R2 adapter requires explicit account credentials and safe limits", () => {
  assert.throws(() => createCloudflareR2Storage({ ...config, accountId: "" }), /R2_ACCOUNT_ID/);
  assert.throws(() => createCloudflareR2Storage({ ...config, secretAccessKey: "short" }), /credentials/);
  assert.throws(() => createCloudflareR2Storage({ ...config, bucket: "bad bucket" }), /bucket/);
});

test("uploads private bytes with an AWS SigV4 request and exact object path", async () => {
  const calls = [];
  const storage = createCloudflareR2Storage({
    ...config,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return response(200); }
  });
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const result = await storage.upload(path, bytes, "video/mp4");
  assert.deepEqual(result, { bucket: "executive-visuals-media", path, size: 4, contentType: "video/mp4" });
  assert.equal(calls[0].url, "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/executive-visuals-media/" + path);
  assert.equal(calls[0].options.method, "PUT");
  assert.match(calls[0].options.headers.authorization, /^AWS4-HMAC-SHA256 Credential=/);
  assert.equal(calls[0].options.headers["x-amz-date"], "20261114T120000Z");
  assert.equal(calls[0].options.headers["x-amz-content-sha256"], createHash("sha256").update(bytes).digest("hex"));
  assert.equal(calls[0].options.headers["content-type"], "video/mp4");
  assert.equal(calls[0].options.body, bytes);
});

test("streams a media file and returns a verified SHA-256 receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-r2-test-"));
  const file = join(root, "master.mp4");
  const bytes = Buffer.from("streamed-private-video");
  await writeFile(file, bytes);
  let captured = null;
  try {
    const storage = createCloudflareR2Storage({
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

test("creates short-lived host-bound presigned URLs", async () => {
  const storage = createCloudflareR2Storage({ ...config, fetchImpl: async () => response(200) });
  const signed = new URL(await storage.createSignedUrl(path, 300));
  assert.equal(signed.origin, "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com");
  assert.equal(signed.pathname, "/executive-visuals-media/" + path);
  assert.equal(signed.searchParams.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
  assert.equal(signed.searchParams.get("X-Amz-Expires"), "300");
  assert.equal(signed.searchParams.get("X-Amz-SignedHeaders"), "host");
  assert.match(signed.searchParams.get("X-Amz-Signature"), /^[a-f0-9]{64}$/);
  await assert.rejects(() => storage.createSignedUrl(path, 10), /expiry/);
});

test("checks that the private bucket exists and treats missing objects as idempotent cleanup", async () => {
  const calls = [];
  const storage = createCloudflareR2Storage({
    ...config,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(options.method === "DELETE" ? 404 : 200);
    }
  });
  assert.deepEqual(await storage.checkReadiness(), {
    ready: true, storage: "private", provider: "cloudflare-r2", bucket: "executive-visuals-media"
  });
  assert.equal(await storage.remove(path), true);
  assert.equal(calls[0].options.method, "HEAD");
  assert.equal(calls[1].options.method, "DELETE");
});

test("rejects traversal, malformed UUID paths, unsupported media and oversized bytes before upload", async () => {
  let called = false;
  const storage = createCloudflareR2Storage({
    ...config,
    maxBytes: 4,
    fetchImpl: async () => { called = true; return response(200); }
  });
  await assert.rejects(() => storage.upload("../escape", new Uint8Array([1]), "video/mp4"), /path/);
  await assert.rejects(() => storage.upload("not-a-uuid/" + asset + "/x.mp4", new Uint8Array([1]), "video/mp4"), /UUIDs/);
  await assert.rejects(() => storage.upload(path, new Uint8Array([1]), "application/x-executable"), /Unsupported/);
  await assert.rejects(() => storage.upload(path, new Uint8Array(5), "video/mp4"), /size limit/);
  assert.equal(called, false);
});

test("surfaces bounded upstream errors and propagates caller cancellation", async () => {
  const failing = createCloudflareR2Storage({ ...config, fetchImpl: async () => response(403) });
  await assert.rejects(() => failing.upload(path, new Uint8Array([1]), "video/mp4"), error => error.code === "R2_STORAGE_HTTP_403");
  const controller = new AbortController();
  controller.abort();
  const cancelled = createCloudflareR2Storage({ ...config, fetchImpl: async (url, options) => {
    assert.equal(options.signal.aborted, true);
    const error = new Error("aborted"); error.name = "AbortError"; throw error;
  }});
  await assert.rejects(() => cancelled.uploadFile(path, "/not-used", "video/mp4", { signal: controller.signal }), /ENOENT/);
});
