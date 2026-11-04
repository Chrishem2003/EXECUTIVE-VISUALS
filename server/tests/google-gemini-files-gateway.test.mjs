import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createGoogleGeminiFilesGateway } from "../google-gemini-files-gateway.mjs";

const ownerId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const assetId = "33333333-3333-4333-8333-333333333333";
const fileId = "gemini-file_123";
const fileName = "files/" + fileId;
const fileUri = "https://generativelanguage.googleapis.com/v1beta/files/" + fileId;
const uploadUrl = "https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=test-session";
const bytes = Buffer.from("private-test-image-bytes");
const sha256 = createHash("sha256").update(bytes).digest("hex");
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
function harness({ fileState = "PROCESSING", record = async () => {}, find, loader, authorize } = {}) {
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
    if (String(url) === "https://generativelanguage.googleapis.com/v1beta/files/" + fileId && options.method === "DELETE") {
      return response(204, null);
    }
    if (String(url) === "https://generativelanguage.googleapis.com/v1beta/files/" + fileId) {
      gets++;
      return response(200, { file: {
        name: fileName, uri: fileUri, mimeType: "image/png",
        sizeBytes: String(bytes.byteLength), state: "ACTIVE"
      }});
    }
    throw new Error("Unexpected URL: " + url);
  };
  const gateway = createGoogleGeminiFilesGateway({
    env, fetchImpl, loadPrivateAsset: loader || (async () => privateAsset()),
    authorizePrivateAsset: authorize || (async () => privateAsset().asset),
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
    expiresAt: "2026-11-06T23:50:00.000Z"
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
  assert.equal(h.records[0].expiresAt, "2026-11-06T23:50:00.000Z");
});

test("reuses an unexpired provider-file mapping only for the exact owner, project and asset", async () => {
  const h = harness({
    find: async () => ({
      ownerId, projectId, assetId, mimeType: "image/png", name: fileName,
      uri: fileUri, state: "ACTIVE", sizeBytes: bytes.byteLength, sha256,
      expiresAt: "2026-11-06T12:00:00.000Z"
    })
  });
  const result = await h.gateway.resolveAsset({ assetId, ownerId, projectId, mediaType: "image/png" });
  assert.equal(result.uri, fileUri);
  assert.equal(h.calls.length, 0);
  assert.equal(h.records.length, 0);
});

test("ignores mismatched or untrusted cache records and reuploads from the private source", async () => {
  const h = harness({
    find: async () => ({
      ownerId: "99999999-9999-4999-8999-999999999999", projectId, assetId,
      mimeType: "image/png", name: fileName,
      uri: "https://attacker.example/file", expiresAt: "2026-11-06T12:00:00.000Z"
    })
  });
  const result = await h.gateway.resolveAsset({ assetId, ownerId, projectId, mediaType: "image/png" });
  assert.equal(result.uri, fileUri);
  assert.equal(h.calls.length, 3);
  assert.equal(h.records.length, 1);
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

 
test("allows a project collaborator to upload a project asset owned by another member", async () => {
  const collaboratorAsset = {
    asset: {
      id: assetId, ownerId: "99999999-9999-4999-8999-999999999999", projectId,
      mediaType: "image/png", size: bytes.byteLength, sha256,
      storageBucket: "executive-visuals-media"
    },
    bytes, size: bytes.byteLength, sha256, cleanup: async () => {}
  };
  const h = harness({ loader: async () => collaboratorAsset, authorize: async () => collaboratorAsset.asset });
  const result = await h.gateway.resolveAsset({ assetId, ownerId, projectId, mediaType: "image/png" });
  assert.equal(result.uri, fileUri);
  assert.equal(h.records[0].ownerId, ownerId);
  assert.equal(h.records[0].projectId, projectId);
});

test("rejects personal assets belonging to another user and rejects tampered byte hashes", async () => {
  const personalAsset = privateAsset({ projectId: null, ownerId: "99999999-9999-4999-8999-999999999999" }).asset;
  const personal = harness({
    loader: async () => ({
      ...privateAsset({ projectId: null, ownerId: "99999999-9999-4999-8999-999999999999" }),
      asset: personalAsset
    }),
    authorize: async () => personalAsset
  });
  await assert.rejects(
    () => personal.gateway.resolveAsset({ assetId, ownerId, projectId: null, mediaType: "image/png" }),
    error => error.code === "GEMINI_FILE_ASSET_SCOPE_INVALID"
  );

  const tamperedBytes = Buffer.from("tampered bytes");
  const tampered = harness({
    loader: async () => ({
      ...privateAsset({ size: tamperedBytes.byteLength }),
      asset: { ...privateAsset({ size: tamperedBytes.byteLength }).asset },
      bytes: tamperedBytes,
      size: tamperedBytes.byteLength
    })
  });
  await assert.rejects(
    () => tampered.gateway.resolveAsset({ assetId, ownerId, projectId, mediaType: "image/png" }),
    error => error.code === "GEMINI_FILE_ASSET_HASH_MISMATCH"
  );
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
