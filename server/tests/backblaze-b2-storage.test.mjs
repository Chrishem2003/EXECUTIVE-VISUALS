import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createBackblazeB2Storage } from "../backblaze-b2-storage.mjs";

const config = {
  region: "us-west-004",
  accessKeyId: "0123456789abcdef",
  secretAccessKey: "s".repeat(40),
  bucket: "executive-visuals-media",
  clock: () => new Date("2026-11-14T12:00:00.000Z")
};
const owner = "123e4567-e89b-42d3-a456-426614174000";
const asset = "223e4567-e89b-42d3-a456-426614174000";
const path = owner + "/" + asset + "/master.mp4";
const response = (status = 200) => ({ ok: status >= 200 && status < 300, status });

test("B2 adapter requires explicit account credentials and safe limits", () => {
  assert.throws(() => createBackblazeB2Storage({ ...config, region: "" }), /B2_REGION/);
  assert.throws(() => createBackblazeB2Storage({ ...config, secretAccessKey: "short" }), /credentials/);
  assert.throws(() => createBackblazeB2Storage({ ...config, bucket: "bad bucket" }), /bucket/);
  assert.doesNotThrow(() => createBackblazeB2Storage({ ...config, secretAccessKey: "s".repeat(20) }));
});

test("verifies completed B2 objects by streaming exact size and SHA-256 without exposing bytes", async () => {
  const bytes = Buffer.from("completed-private-video");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const calls = [];
  const storage = createBackblazeB2Storage({
    ...config,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true, status: 200,
        headers: { get: name => name.toLowerCase() === "content-length" ? String(bytes.length) : name.toLowerCase() === "content-type" ? "video/mp4" : null },
        body: (async function*(){ yield bytes.subarray(0, 7); yield bytes.subarray(7); })()
      };
    }
  });
  const receipt = await storage.verifyObject(path, { expectedSize: bytes.length, expectedSha256: digest, contentType: "video/mp4" });
  assert.deepEqual(receipt, { bucket: "executive-visuals-media", path, size: bytes.length, sha256: digest, contentType: "video/mp4" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "GET");
  assert.match(calls[0].options.headers.authorization, /^AWS4-HMAC-SHA256 Credential=/);
});

test("rejects completed B2 objects whose stored media type differs from the reservation", async () => {
  const bytes = Buffer.from("wrong-content-type");
  const storage = createBackblazeB2Storage({
    ...config,
    fetchImpl: async () => ({
      ok: true, status: 200,
      headers: { get: name => name.toLowerCase() === "content-length" ? String(bytes.length) : name.toLowerCase() === "content-type" ? "application/octet-stream" : null },
      body: (async function*(){ yield bytes; })()
    })
  });
  await assert.rejects(
    () => storage.verifyObject(path, { expectedSize: bytes.length, expectedSha256: createHash("sha256").update(bytes).digest("hex"), contentType: "video/mp4" }),
    error => error.code === "B2_OBJECT_MEDIA_TYPE_MISMATCH"
  );
});

test("rejects completed B2 objects with a mismatched length or SHA-256", async () => {
  const bytes = Buffer.from("wrong-object-bytes");
  const storage = createBackblazeB2Storage({
    ...config,
    fetchImpl: async () => ({
      ok: true, status: 200,
      headers: { get: name => name.toLowerCase() === "content-length" ? String(bytes.length) : name.toLowerCase() === "content-type" ? "video/mp4" : null },
      body: (async function*(){ yield bytes; })()
    })
  });
  await assert.rejects(
    () => storage.verifyObject(path, { expectedSize: bytes.length, expectedSha256: "a".repeat(64), contentType: "video/mp4" }),
    error => error.code === "B2_OBJECT_SHA256_MISMATCH"
  );
  await assert.rejects(
    () => storage.verifyObject(path, { expectedSize: bytes.length + 1, expectedSha256: createHash("sha256").update(bytes).digest("hex"), contentType: "video/mp4" }),
    error => error.code === "B2_OBJECT_SIZE_MISMATCH"
  );
});

test("rejects invalid B2 completed-object verification inputs before network access", async () => {
  let calls = 0;
  const storage = createBackblazeB2Storage({ ...config, fetchImpl: async () => { calls++; return response(200); } });
  await assert.rejects(() => storage.verifyObject(path, { expectedSize: 0, expectedSha256: "a".repeat(64) }), /size is invalid/);
  await assert.rejects(() => storage.verifyObject(path, { expectedSize: 4, expectedSha256: "bad" }), /SHA-256 is invalid/);
  assert.equal(calls, 0);
});

test("uploads private bytes with an AWS SigV4 request and exact object path", async () => {
  const calls = [];
  const storage = createBackblazeB2Storage({
    ...config,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return response(200); }
  });
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const result = await storage.upload(path, bytes, "video/mp4");
  assert.deepEqual(result, { bucket: "executive-visuals-media", path, size: 4, contentType: "video/mp4" });
  assert.equal(calls[0].url, "https://s3.us-west-004.backblazeb2.com/executive-visuals-media/" + path);
  assert.equal(calls[0].options.method, "PUT");
  assert.match(calls[0].options.headers.authorization, /^AWS4-HMAC-SHA256 Credential=/);
  assert.equal(calls[0].options.headers["x-amz-date"], "20261114T120000Z");
  assert.equal(calls[0].options.headers["x-amz-content-sha256"], createHash("sha256").update(bytes).digest("hex"));
  assert.equal(calls[0].options.headers["content-type"], "video/mp4");
  assert.equal(calls[0].options.body, bytes);
});

test("streams a media file and returns a verified SHA-256 receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-b2-test-"));
  const file = join(root, "master.mp4");
  const bytes = Buffer.from("streamed-private-video");
  await writeFile(file, bytes);
  let captured = null;
  try {
    const storage = createBackblazeB2Storage({
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


test("streams large files through signed multipart upload and completes with ordered ETags", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-b2-multipart-"));
  const file = join(root, "large-master.mp4");
  const bytes = Buffer.alloc(5 * 1024 * 1024 + 123, 0x5a);
  await writeFile(file, bytes);
  const calls = [];
  const etags = ["a".repeat(32), "b".repeat(32)];
  try {
    const storage = createBackblazeB2Storage({
      ...config,
      multipartThresholdBytes: 1,
      multipartPartBytes: 5 * 1024 * 1024,
      fetchImpl: async (url, options) => {
        const parsed = new URL(url);
        let body = options.body;
        if (body && typeof body !== "string" && typeof body[Symbol.asyncIterator] === "function") {
          const chunks = [];
          for await (const chunk of body) chunks.push(Buffer.from(chunk));
          body = Buffer.concat(chunks);
        }
        calls.push({ url, options, body });
        if (options.method === "POST" && parsed.searchParams.has("uploads")) {
          return { ok: true, status: 200, text: async () => "<InitiateMultipartUploadResult><UploadId>upload_12345678</UploadId></InitiateMultipartUploadResult>" };
        }
        if (options.method === "PUT") {
          const part = Number(parsed.searchParams.get("partNumber"));
          if (part === 1 && calls.filter(x => x.options.method === "PUT" && new URL(x.url).searchParams.get("partNumber") === "1").length === 1) {
            return { ok: false, status: 503 };
          }
          return { ok: true, status: 200, headers: { get: name => name.toLowerCase() === "etag" ? '"' + etags[part - 1] + '"' : null } };
        }
        if (options.method === "POST" && parsed.searchParams.has("uploadId")) {
          return { ok: true, status: 200, text: async () => "<CompleteMultipartUploadResult/>" };
        }
        throw new Error("Unexpected B2 request.");
      }
    });
    const result = await storage.uploadFile(path, file, "video/mp4");
    assert.equal(result.multipart, true);
    assert.equal(result.parts, 2);
    assert.equal(result.size, bytes.length);
    assert.equal(result.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.deepEqual(calls.filter(x => x.options.method === "PUT").map(x => x.body.length), [5 * 1024 * 1024, 5 * 1024 * 1024, 123]);
    assert.deepEqual(calls.filter(x => x.options.method === "PUT").map(x => x.options.headers["x-amz-content-sha256"]), [
      createHash("sha256").update(bytes.subarray(0, 5 * 1024 * 1024)).digest("hex"),
      createHash("sha256").update(bytes.subarray(0, 5 * 1024 * 1024)).digest("hex"),
      createHash("sha256").update(bytes.subarray(5 * 1024 * 1024)).digest("hex")
    ]);
    const completion = calls.find(x => x.options.method === "POST" && new URL(x.url).searchParams.has("uploadId"));
    assert.match(completion.body, /<PartNumber>1<\/PartNumber>/);
    assert.match(completion.body, /<PartNumber>2<\/PartNumber>/);
    assert.ok(completion.body.indexOf(etags[0]) < completion.body.indexOf(etags[1]));
    assert.match(calls[0].options.headers.authorization, /^AWS4-HMAC-SHA256 Credential=/);
    assert.match(calls[1].options.headers.authorization, /^AWS4-HMAC-SHA256 Credential=/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("aborts a multipart upload after a failed part instead of leaving partial storage behind", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-b2-multipart-abort-"));
  const file = join(root, "large-master.mp4");
  await writeFile(file, Buffer.alloc(5 * 1024 * 1024 + 1, 0x31));
  const methods = [];
  try {
    const storage = createBackblazeB2Storage({
      ...config,
      multipartThresholdBytes: 1,
      multipartPartBytes: 5 * 1024 * 1024,
      fetchImpl: async (url, options) => {
        const parsed = new URL(url);
        methods.push({ method: options.method, query: parsed.searchParams });
        if (options.method === "POST" && parsed.searchParams.has("uploads")) {
          return { ok: true, status: 200, text: async () => "<UploadId>upload_12345678</UploadId>" };
        }
        if (options.method === "PUT") return { ok: false, status: 403 };
        if (options.method === "DELETE") return { ok: true, status: 204 };
        throw new Error("Unexpected B2 request.");
      }
    });
    await assert.rejects(() => storage.uploadFile(path, file, "video/mp4"), error => error.code === "B2_STORAGE_HTTP_403");
    assert.deepEqual(methods.map(x => x.method), ["POST", "PUT", "DELETE"]);
    assert.equal(methods[2].query.get("uploadId"), "upload_12345678");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects invalid multipart sizing before contacting B2", () => {
  const fetchImpl = async () => { throw new Error("Network must not be called."); };
  assert.throws(() => createBackblazeB2Storage({ ...config, maxBytes: 1024, multipartThresholdBytes: 2048, fetchImpl }), /threshold/);
  assert.throws(() => createBackblazeB2Storage({ ...config, multipartPartBytes: 1024, fetchImpl }), /part size/);
});

test("exposes signed multipart begin, list-parts, part-upload, completion and abort primitives", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-b2-multipart-primitives-"));
  const file = join(root, "part.bin");
  const bytes = Buffer.alloc(5 * 1024 * 1024, 0x4d);
  await writeFile(file, bytes);
  const calls = [];
  const etag = "a".repeat(32);
  try {
    const storage = createBackblazeB2Storage({
      ...config,
      fetchImpl: async (url, options) => {
        const parsed = new URL(url);
        calls.push({ url, options });
        if (options.method === "POST" && parsed.searchParams.has("uploads")) {
          return { ok: true, status: 200, text: async () => "<UploadId>upload_12345678</UploadId>" };
        }
        if (options.method === "GET" && parsed.searchParams.has("uploadId")) {
          return { ok: true, status: 200, text: async () => "<ListPartsResult><IsTruncated>false</IsTruncated><Part><PartNumber>1</PartNumber><ETag>\"" + etag + "\"</ETag><Size>" + bytes.length + "</Size></Part></ListPartsResult>" };
        }
        if (options.method === "PUT" && parsed.searchParams.has("partNumber")) {
          for await (const chunk of options.body) { /* consume the bounded part stream */ }
          return { ok: true, status: 200, headers: { get: name => name.toLowerCase() === "etag" ? "\"" + etag + "\"" : null } };
        }
        if (options.method === "POST" && parsed.searchParams.has("uploadId")) {
          return { ok: true, status: 200, text: async () => "<CompleteMultipartUploadResult/>" };
        }
        if (options.method === "DELETE" && parsed.searchParams.has("uploadId")) {
          return { ok: true, status: 204 };
        }
        throw new Error("Unexpected B2 multipart operation.");
      }
    });
    assert.equal(typeof storage.beginMultipartUpload, "function");
    const begun = await storage.beginMultipartUpload(path, "video/mp4");
    assert.equal(begun.uploadId, "upload_12345678");
    const listed = await storage.listMultipartParts(path, begun.uploadId);
    assert.deepEqual(listed.parts, [{ partNumber: 1, etag, size: bytes.length }]);
    const part = await storage.uploadMultipartPartFile(path, begun.uploadId, 1, file, 0, bytes.length - 1);
    assert.equal(part.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(part.etag, etag);
    const completed = await storage.completeMultipartUpload(path, begun.uploadId, [{ partNumber: 1, etag }]);
    assert.equal(completed.parts, 1);
    assert.equal(await storage.abortMultipartUpload(path, begun.uploadId), true);
    assert.deepEqual(calls.map(call => call.options.method), ["POST", "GET", "PUT", "POST", "DELETE"]);
    for (const call of calls) assert.match(call.options.headers.authorization, /^AWS4-HMAC-SHA256 Credential=/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects malformed multipart listings and non-contiguous completion receipts", async () => {
  const storage = createBackblazeB2Storage({
    ...config,
    fetchImpl: async (url, options) => options.method === "GET"
      ? { ok: true, status: 200, text: async () => "<ListPartsResult><IsTruncated>false</IsTruncated><Part><PartNumber>0</PartNumber><ETag>bad</ETag><Size>1</Size></Part></ListPartsResult>" }
      : { ok: true, status: 200, text: async () => "<UploadId>upload_12345678</UploadId>" }
  });
  await assert.rejects(() => storage.listMultipartParts(path, "upload_12345678"), /invalid multipart part listing/);
  await assert.rejects(() => storage.completeMultipartUpload(path, "upload_12345678", [{ partNumber: 2, etag: "a".repeat(32) }]), /contiguous ordered/);
});

test("creates short-lived host-bound presigned URLs", async () => {
  const storage = createBackblazeB2Storage({ ...config, fetchImpl: async () => response(200) });
  const signed = new URL(await storage.createSignedUrl(path, 300));
  assert.equal(signed.origin, "https://s3.us-west-004.backblazeb2.com");
  assert.equal(signed.pathname, "/executive-visuals-media/" + path);
  assert.equal(signed.searchParams.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
  assert.equal(signed.searchParams.get("X-Amz-Expires"), "300");
  assert.equal(signed.searchParams.get("X-Amz-SignedHeaders"), "host");
  assert.match(signed.searchParams.get("X-Amz-Signature"), /^[a-f0-9]{64}$/);
  await assert.rejects(() => storage.createSignedUrl(path, 10), /expiry/);
});

test("creates scoped presigned multipart PUT URLs", async () => {
  const storage = createBackblazeB2Storage({ ...config, fetchImpl: async () => response(200) });
  const signed = new URL(await storage.createMultipartPartSignedUrl(path, "upload_12345678", 3, 300));
  assert.equal(signed.origin, "https://s3.us-west-004.backblazeb2.com");
  assert.equal(signed.pathname, "/executive-visuals-media/" + path);
  assert.equal(signed.searchParams.get("partNumber"), "3");
  assert.equal(signed.searchParams.get("uploadId"), "upload_12345678");
  assert.equal(signed.searchParams.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
  assert.equal(signed.searchParams.get("X-Amz-Expires"), "300");
  assert.match(signed.searchParams.get("X-Amz-Signature"), /^[a-f0-9]{64}$/);
  await assert.rejects(() => storage.createMultipartPartSignedUrl(path, "upload_12345678", 0), /invalid/);
  await assert.rejects(() => storage.createMultipartPartSignedUrl(path, "upload_12345678", 1, 10), /expiry/);
});

test("checks that the private bucket exists and treats missing objects as idempotent cleanup", async () => {
  const calls = [];
  const storage = createBackblazeB2Storage({
    ...config,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(options.method === "DELETE" ? 404 : 200);
    }
  });
  assert.deepEqual(await storage.checkReadiness(), {
    ready: true, storage: "private", provider: "backblaze-b2", bucket: "executive-visuals-media"
  });
  assert.equal(await storage.remove(path), true);
  assert.equal(calls[0].options.method, "HEAD");
  assert.equal(calls[1].options.method, "DELETE");
});

test("rejects traversal, malformed UUID paths, unsupported media and oversized bytes before upload", async () => {
  let called = false;
  const storage = createBackblazeB2Storage({
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

test("surfaces bounded upstream errors", async () => {
  const failing = createBackblazeB2Storage({ ...config, fetchImpl: async () => response(403) });
  await assert.rejects(() => failing.upload(path, new Uint8Array([1]), "video/mp4"), error => error.code === "B2_STORAGE_HTTP_403");
});
