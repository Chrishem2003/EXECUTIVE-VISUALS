import test from "node:test";
import assert from "node:assert/strict";
import { createGoogleGeminiGcsFilesRegistrar } from "../google-gemini-gcs-registrar.mjs";

const ownerId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const assetId = "33333333-3333-4333-8333-333333333333";
const gcsUri = "gs://private-media-bucket/private/final.mp4";
const fileName = "files/gcs-file-123";
const fileUri = "https://generativelanguage.googleapis.com/v1beta/files/gcs-file-123";
const sha256 = "a".repeat(64);
const now = Date.parse("2026-11-05T00:00:00.000Z");
const asset = {
  id: assetId, ownerId, projectId, mediaType: "video/mp4",
  sizeBytes: 1024, sha256
};
const env = {
  GOOGLE_CLOUD_PROJECT_ID: "test-gcp-project-12345",
  GEMINI_GCS_ALLOWED_BUCKETS: "private-media-bucket,approved-assets"
};
function response(status, body) {
  return new Response(body === null ? null : JSON.stringify(body), { status });
}
function harness({ resolved = { asset, gcsUri }, authorized = asset, cached = null, record, fetchImpl, token = "oauth-test-access-token-123456" } = {}) {
  const calls = [], records = [];
  const repository = {
    async findProviderFile() { calls.push(["find"]); return cached; },
    async recordProviderFile(value) { calls.push(["record", value]); records.push(value); if (record) return record(value); return "mapping-1"; },
    async deleteProviderFileRecord(value) { calls.push(["deleteRecord", value]); return true; }
  };
  const registrar = createGoogleGeminiGcsFilesRegistrar({
    env,
    getAccessToken: async options => { calls.push(["token", options]); return token; },
    resolvePrivateGcsAsset: async scope => { calls.push(["resolve", scope]); return resolved; },
    authorizePrivateAsset: async scope => { calls.push(["authorize", scope]); return authorized; },
    repository,
    fetchImpl: async (url, options) => {
      calls.push(["fetch", String(url), options]);
      if (fetchImpl) return fetchImpl(url, options);
      return response(200, { files: [{
        name: fileName, uri: fileUri, mimeType: "video/mp4", sizeBytes: "1024",
        state: "ACTIVE", expirationTime: "2026-11-25T00:00:00.000Z"
      }] });
    },
    timeoutMs: 3000,
    now: () => now
  });
  return { registrar, calls, records };
}

test("registers an authorized private GCS object without downloading or copying media bytes", async () => {
  const h = harness();
  const result = await h.registrar.registerAsset({ assetId, ownerId, projectId, mediaType: "video/mp4" });
  assert.equal(result.uri, fileUri);
  assert.equal(result.providerFileName, fileName);
  assert.equal(result.sourceType, "gcs_registration");
  assert.equal(result.expiresAt, "2026-11-25T00:00:00.000Z");
  const request = h.calls.find(call => call[0] === "fetch");
  assert.equal(request[1], "https://generativelanguage.googleapis.com/v1beta/files:register");
  assert.equal(request[2].method, "POST");
  assert.equal(request[2].headers.authorization, "Bearer oauth-test-access-token-123456");
  assert.equal(request[2].headers["x-goog-user-project"], "test-gcp-project-12345");
  assert.equal(request[2].headers["x-goog-api-key"], undefined);
  assert.deepEqual(JSON.parse(request[2].body), { uris: [gcsUri] });
  assert.equal(h.records[0].sourceUri, gcsUri);
  assert.equal(h.records[0].sha256, sha256);
  assert.equal(JSON.stringify(result).includes("oauth-test-access-token"), false);
});

test("reuses a matching unexpired provider file mapping without OAuth or network calls", async () => {
  const cached = {
    ownerId, projectId, assetId, mimeType: "video/mp4", name: fileName,
    uri: fileUri, state: "ACTIVE", sizeBytes: 1024, sha256,
    expiresAt: "2026-11-20T00:00:00.000Z", sourceType: "gcs_registration", sourceUri: gcsUri
  };
  const h = harness({ cached });
  const result = await h.registrar.registerAsset({ assetId, ownerId, projectId, mediaType: "video/mp4" });
  assert.equal(result.reused, true);
  assert.equal(result.uri, fileUri);
  assert.equal(h.calls.some(call => call[0] === "token"), false);
  assert.equal(h.calls.some(call => call[0] === "fetch"), false);
});

test("rejects unapproved buckets, mismatched ownership and malformed GCS URIs before provider access", async () => {
  const deniedBucket = harness({ resolved: { asset, gcsUri: "gs://other-bucket/private/file.mp4" } });
  await assert.rejects(() => deniedBucket.registrar.registerAsset({ assetId, ownerId, projectId, mediaType: "video/mp4" }),
    error => error.code === "GEMINI_GCS_BUCKET_FORBIDDEN");
  assert.equal(deniedBucket.calls.some(call => call[0] === "fetch"), false);

  const wrongOwner = harness({ authorized: { ...asset, ownerId: "99999999-9999-4999-8999-999999999999" } });
  await assert.rejects(() => wrongOwner.registrar.registerAsset({ assetId, ownerId, projectId, mediaType: "video/mp4" }),
    error => error.code === "GEMINI_GCS_ASSET_FORBIDDEN");
  assert.equal(wrongOwner.calls.some(call => call[0] === "fetch"), false);

  const malformed = harness({ resolved: { asset, gcsUri: "gs://private-media-bucket/a/../secret.mp4" } });
  await assert.rejects(() => malformed.registrar.registerAsset({ assetId, ownerId, projectId, mediaType: "video/mp4" }),
    error => error.code === "GEMINI_GCS_URI_INVALID");
});

test("requires OAuth credentials and rejects oversized or mismatched File resources", async () => {
  const missing = harness({ token: "" });
  await assert.rejects(() => missing.registrar.registerAsset({ assetId, ownerId, projectId, mediaType: "video/mp4" }),
    error => error.code === "GEMINI_GCS_OAUTH_FAILED");
  assert.equal(missing.calls.some(call => call[0] === "fetch"), false);

  const badFile = harness({ fetchImpl: async () => response(200, { files: [{
    name: fileName, uri: "https://attacker.example/file", mimeType: "video/mp4", sizeBytes: "1024", state: "ACTIVE"
  }] }) });
  await assert.rejects(() => badFile.registrar.registerAsset({ assetId, ownerId, projectId, mediaType: "video/mp4" }),
    error => error.code === "GEMINI_GCS_RESPONSE_INVALID");
});

test("compensates a registered Google file when durable mapping persistence fails", async () => {
  const h = harness({
    record: async () => { throw new Error("database unavailable"); },
    fetchImpl: async (url, options) => {
      if (String(url).endsWith("/files:register")) {
        return response(200, { files: [{
          name: fileName, uri: fileUri, mimeType: "video/mp4", sizeBytes: "1024", state: "ACTIVE"
        }] });
      }
      assert.equal(options.method, "DELETE");
      return response(204, null);
    }
  });
  await assert.rejects(() => h.registrar.registerAsset({ assetId, ownerId, projectId, mediaType: "video/mp4" }),
    error => error.code === "GEMINI_GCS_MAPPING_PERSIST_FAILED");
  assert.equal(h.calls.some(call => call[0] === "fetch" && call[2].method === "DELETE"), true);
});

test("deletes only the exact owner/project GCS registration and its durable mapping", async () => {
  const cached = {
    id: "mapping-1", ownerId, projectId, assetId, mimeType: "video/mp4",
    name: fileName, uri: fileUri, state: "ACTIVE", sizeBytes: 1024, sha256,
    expiresAt: "2026-11-20T00:00:00.000Z",
    sourceType: "gcs_registration", sourceUri: gcsUri
  };
  const h = harness({ cached, fetchImpl: async (_url, options) => {
    assert.equal(options.method, "DELETE");
    return response(204, null);
  }});
  const deleted = await h.registrar.deleteAssetRegistration({ assetId, ownerId, projectId, mediaType: "video/mp4" });
  assert.equal(deleted, true);
  const remoteDelete = h.calls.find(call => call[0] === "fetch");
  assert.equal(remoteDelete[1], "https://generativelanguage.googleapis.com/v1beta/files/gcs-file-123");
  assert.equal(h.calls.some(call => call[0] === "deleteRecord" && call[1].recordId === "mapping-1"), true);
});
