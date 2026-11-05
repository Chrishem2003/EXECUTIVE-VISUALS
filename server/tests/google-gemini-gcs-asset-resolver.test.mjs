import test from "node:test";
import assert from "node:assert/strict";
import { createGoogleGeminiGcsAssetResolver } from "../google-gemini-gcs-asset-resolver.mjs";

const ownerId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const assetId = "33333333-3333-4333-8333-333333333333";
const objectName = "private/project/final-cut.mp4";
const sha256 = "a".repeat(64);
const source = {
  assetId, ownerId, projectId, bucket: "private-media-bucket", objectName,
  generation: "1762300800000000", sizeBytes: 1024, mediaType: "video/mp4",
  sha256, state: "ACTIVE"
};
const env = {
  GOOGLE_CLOUD_PROJECT_ID: "test-gcp-project-12345",
  GEMINI_GCS_ALLOWED_BUCKETS: "private-media-bucket,approved-assets"
};
const token = "oauth-test-access-token-123456";

function response(status, body) {
  return new Response(body === null ? null : JSON.stringify(body), { status });
}
function objectMetadata(overrides = {}) {
  return {
    bucket: source.bucket,
    name: source.objectName,
    generation: source.generation,
    size: String(source.sizeBytes),
    contentType: source.mediaType,
    metadata: {
      executiveVisualsAssetId: assetId,
      executiveVisualsOwnerId: ownerId,
      executiveVisualsProjectId: projectId,
      executiveVisualsSha256: sha256
    },
    ...overrides
  };
}
function harness({ sourceRecord = source, metadata = objectMetadata(), status = 200, getAccessToken = async () => token, fetchImpl } = {}) {
  const calls = [];
  const resolver = createGoogleGeminiGcsAssetResolver({
    env,
    loadSource: async scope => { calls.push({ type: "source", scope }); return sourceRecord; },
    getAccessToken: async options => { calls.push({ type: "token", options }); return getAccessToken(options); },
    fetchImpl: async (url, options) => {
      calls.push({ type: "fetch", url: String(url), options });
      if (fetchImpl) return fetchImpl(url, options);
      return response(status, metadata);
    },
    timeoutMs: 3000
  });
  return { resolver, calls };
}

test("resolves only a server-owned GCS source and verifies the exact object metadata using caller OAuth", async () => {
  const h = harness();
  const result = await h.resolver.resolvePrivateGcsAsset({ assetId, ownerId, projectId });
  assert.deepEqual(result, {
    asset: { id: assetId, ownerId, projectId, mediaType: "video/mp4", sizeBytes: 1024, sha256 },
    gcsUri: "gs://private-media-bucket/" + objectName,
    generation: source.generation
  });
  const sourceCall = h.calls.find(call => call.type === "source");
  assert.deepEqual(sourceCall.scope, { assetId, ownerId, projectId });
  const tokenCall = h.calls.find(call => call.type === "token");
  assert.deepEqual(tokenCall.options.scopes, [
    "https://www.googleapis.com/auth/devstorage.read_only",
    "https://www.googleapis.com/auth/cloud-platform"
  ]);
  const request = h.calls.find(call => call.type === "fetch");
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.redirect, "error");
  assert.equal(request.options.headers.authorization, "Bearer " + token);
  assert.ok(request.url.includes(encodeURIComponent(objectName)));
  assert.equal(JSON.stringify(result).includes(token), false);
});

test("fails closed when the caller identity cannot read the exact GCS object", async () => {
  const h = harness({ status: 403, metadata: { error: { message: "private provider detail" } } });
  await assert.rejects(
    () => h.resolver.resolvePrivateGcsAsset({ assetId, ownerId, projectId }),
    error => error.code === "GEMINI_GCS_CALLER_ACCESS_DENIED" && !error.message.includes("private provider detail")
  );
});

test("rejects an object generation, checksum, owner or MIME mismatch before returning a gs URI", async () => {
  for (const metadata of [
    objectMetadata({ generation: "1762300800000001" }),
    objectMetadata({ metadata: { executiveVisualsAssetId: assetId, executiveVisualsOwnerId: ownerId, executiveVisualsProjectId: projectId, executiveVisualsSha256: "b".repeat(64) } }),
    objectMetadata({ contentType: "application/octet-stream" }),
    objectMetadata({ metadata: { executiveVisualsAssetId: assetId, executiveVisualsOwnerId: "44444444-4444-4444-8444-444444444444", executiveVisualsProjectId: projectId, executiveVisualsSha256: sha256 } })
  ]) {
    const h = harness({ metadata });
    await assert.rejects(
      () => h.resolver.resolvePrivateGcsAsset({ assetId, ownerId, projectId }),
      error => error.code === "GEMINI_GCS_OBJECT_INTEGRITY_MISMATCH"
    );
  }
});

test("rejects unapproved buckets, revoked source records and cross-owner source records before OAuth", async () => {
  const invalidSources = [
    { ...source, bucket: "unapproved-bucket" },
    { ...source, state: "REVOKED" },
    { ...source, ownerId: "44444444-4444-4444-8444-444444444444" }
  ];
  for (const sourceRecord of invalidSources) {
    const h = harness({ sourceRecord });
    await assert.rejects(
      () => h.resolver.resolvePrivateGcsAsset({ assetId, ownerId, projectId }),
      error => error.code === "GEMINI_GCS_SOURCE_INVALID"
    );
    assert.equal(h.calls.some(call => call.type === "token" || call.type === "fetch"), false);
  }
});

test("does not accept missing or malformed server-side source mappings", async () => {
  const missing = harness({ sourceRecord: null });
  await assert.rejects(
    () => missing.resolver.resolvePrivateGcsAsset({ assetId, ownerId, projectId }),
    error => error.code === "GEMINI_GCS_SOURCE_NOT_FOUND"
  );
  const invalid = harness({ sourceRecord: { ...source, objectName: "../private.mp4" } });
  await assert.rejects(
    () => invalid.resolver.resolvePrivateGcsAsset({ assetId, ownerId, projectId }),
    error => error.code === "GEMINI_GCS_SOURCE_INVALID"
  );
});

test("rejects invalid owner and project IDs before reading the source registry", async () => {
  const h = harness();
  await assert.rejects(
    () => h.resolver.resolvePrivateGcsAsset({ assetId, ownerId: "not-a-uuid", projectId }),
    error => error.code === "GEMINI_GCS_ASSET_SCOPE_INVALID"
  );
  assert.equal(h.calls.length, 0);
});
