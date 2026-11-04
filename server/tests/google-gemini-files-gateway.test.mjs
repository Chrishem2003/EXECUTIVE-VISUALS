import test from "node:test";
import assert from "node:assert/strict";
import { createGoogleGeminiFilesGateway } from "../google-gemini-files-gateway.mjs";

const ownerId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const assetId = "33333333-3333-4333-8333-333333333333";
const fileId = "gemini-file_123";
const fileName = "files/" + fileId;
const fileUri = "https://generativelanguage.googleapis.com/v1beta/files/" + fileId;
const uploadUrl = "https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=test-session";
const bytes = Buffer.from("private-test-image-bytes");
const sha256 = "a".repeat(64);
const env = { GEMINI_API_KEY: "server-test-key" };

function response(status, body, headers = {}) {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers });
}
function privateAsset(overrides = {}) {
  return {
    asset: {
      id: assetId, ownerId, projectId, mediaType: "image/png",
      size: bytes.byteLength, sha256, storageBucket: "executive-visuals-media",
      ...overrides
    },
    bytes,
    size: bytes.byteLength,
    sha256,
    cleanup: async () => {}
  };
}
function harness({ fileState = "PROCESSING", record = async () => {}, find, loader } = {}) {
  const calls = [];
  const records = [];
  let gets = 0;
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url) === "https://generativelanguage.googleapis.com/upload/v1beta/files") {
      return response(200, {}, { "x-goog-upload-url": uploadUrl });
    }
    if (String(url) === uploadUrl) {
      assert.equal(options.headers["X-Goog-Upload-Offset"], "0");
      assert.equal(options.headers["X-Goog-Upload-Command"], "upload, finalize");
      assert.equal(Buffer.from(options.body).byteLength, bytes.byteLength);
      return response(200, { file: {
        name: fileName, uri: fileUri, mimeType: "image/png",
        sizeBytes: String(bytes.byteLength), state: fileState
      }});
    }
    if (String(url) === "https://generativelanguage.googleapis.com/v1beta/files/" + fileId) {
      gets++;
      return response(200, { file: {
        name: fileName, uri: fileUri, mimeType: "image/png",
        sizeBytes: String(bytes.byteLength), state: "ACTIVE"
      }});
    }
    if (String(url) === "https://generativelanguage.googleapis.com/v1beta/files/" + fileId && options.method === "DELETE") {
      return response(204, null);
    }
    throw new Error("Unexpected URL: " + url);
  };
  const gateway = createGoogleGeminiFilesGateway({
    env, fetchImpl, loadPrivateAsset: loader || (async () => privateAsset()),
    findProviderFile: find,
    recordProviderFile: async value => { records.push(value); await record(value); },
    timeoutMs: 3000, chunkSize: 256 * 1024, processingPollIntervalMs: 1000,
    sleep: async () => {}, now: () => Date.parse("2026-11-05T00:00:00.000Z")
  });
  return { gateway, calls, records, getCount: () => gets };
}

test("uploads only an owner/project-authorized private asset through resumable Google Files API", async () => {
  const h = harness();
  const result = await h.gateway.resolveAsset({ assetId, ownerId, projectId, mediaType: "image/png" });
  assert.deepEqual(result, {
    uri: fileUri, mediaType: "image/png", providerFileName: fileName,
    expiresAt: "2026-11-07T00:00:00.000Z"
  });
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[0].options.method, "POST");
  assert.equal(h.calls[0].options.headers["x-goog-api-key"], "server-test-key");
  assert.equal(h.calls[0].options.headers["X-Goog-Upload-Protocol"], "resumable");
  assert.equal(h.calls[0].options.headers["X-Goog-Upload-Command"], "start");
  assert.equal(h.records.length, 1);
  assert.equal(h.records[0].ownerId, ownerId);
  assert.equal(h.records[0].projectId, projectId);
  assert.equal(h.records[0].assetId, assetId);
  assert.equal(h.records[0].state, "ACTIVE");
  assert.equal(h.records[0].expiresAt, "2026-11-07T00:00:00.000Z");
});

test("reuses an unexpired provider-file mapping only for the exact owner, project and asset", async () => {
  const h = harness({
    find: async () => ({
      ownerId, projectId, assetId, mimeType: "image/png", name: fileName,
      uri: fileUri, expiresAt: "2026-11-06T12:00:00.000Z"
    })
  });
  const result = await h.gateway.resolveAsset({ assetId, ownerId, projectId, mediaType: "image/png" });
  assert.equal(result.uri, fileUri);
  assert.equal(h.calls.length, 0);
  assert.equal(h.records.length, 0);
});

test("rejects provider-file cache records with mismatched scope or untrusted URI", async () => {
  const h = harness({
    find: async () => ({
      ownerId: "99999999-9999-4999-8999-999999999999", projectId, assetId,
      mimeType: "image/png", name: fileName,
      uri: "https://attacker.example/file", expiresAt: "2026-11-06T12:00:00.000Z"
    })
  });
  await assert.rejects(
    () => h.gateway.resolveAsset({ assetId, ownerId, projectId, mediaType: "image/png" }),
    error => error.code === "GEMINI_FILE_RESPONSE_INVALID"
  );
});

test("fails closed for absent credentials, unsupported MIME and mismatched private asset scope", async () => {
  const missing = createGoogleGeminiFilesGateway({
    env: {}, fetchImpl: async () => { throw new Error("must not fetch"); },
    loadPrivateAsset: async () => privateAsset(), recordProviderFile: async () => {}
  });
  await assert.rejects(() => missing.resolveAsset({ assetId, ownerId, projectId, mediaType: "image/png" }),
    error => error.code === "GEMINI_FILE_CONFIG_MISSING");

  const h = harness();
  await assert.rejects(() => h.gateway.resolveAsset({ assetId, ownerId, projectId, mediaType: "application/x-executable" }),
    error => error.code === "GEMINI_FILE_MIME_UNSUPPORTED");

  const wrongScope = harness({ loader: async () => privateAsset({ ownerId: "99999999-9999-4999-8999-999999999999" }) });
  await assert.rejects(() => wrongScope.gateway.resolveAsset({ assetId, ownerId, projectId, mediaType: "image/png" }),
    error => error.code === "GEMINI_FILE_ASSET_SCOPE_INVALID");
});

test("requires the upload mapping to be durable and attempts compensating provider deletion on persistence failure", async () => {
  const h = harness({ record: async () => { throw new Error("database unavailable"); } });
  await assert.rejects(() => h.gateway.resolveAsset({ assetId, ownerId, projectId, mediaType: "image/png" }),
    error => error.code === "GEMINI_FILE_MAPPING_PERSIST_FAILED");
  assert.equal(h.records.length, 1);
});

test("rejects unsafe resumable upload URLs and never follows redirects", async () => {
  const gateway = createGoogleGeminiFilesGateway({
    env, loadPrivateAsset: async () => privateAsset(), recordProviderFile: async () => {},
    fetchImpl: async url => {
      if (String(url).includes("/upload/v1beta/files")) {
        return response(200, {}, { "x-goog-upload-url": "https://attacker.example/upload?token=x" });
      }
      throw new Error("Unexpected network call");
    },
    timeoutMs: 3000
  });
  await assert.rejects(() => gateway.resolveAsset({ assetId, ownerId, projectId, mediaType: "image/png" }),
    error => error.code === "GEMINI_FILE_UPLOAD_URL_INVALID");
});

test("does not expose API keys or resumable upload URLs in public results", async () => {
  const h = harness();
  const result = await h.gateway.resolveAsset({ assetId, ownerId, projectId, mediaType: "image/png" });
  assert.equal(JSON.stringify(result).includes("server-test-key"), false);
  assert.equal(JSON.stringify(result).includes("upload_id"), false);
});

test("rejects invalid polling configuration and missing durable mapping callback", () => {
  assert.throws(() => createGoogleGeminiFilesGateway({
    env, loadPrivateAsset: async () => privateAsset(), recordProviderFile: null
  }));
  assert.throws(() => createGoogleGeminiFilesGateway({
    env, loadPrivateAsset: async () => privateAsset(), recordProviderFile: async () => {},
    maxBytes: 3 * 1024 * 1024 * 1024
  }));
});
