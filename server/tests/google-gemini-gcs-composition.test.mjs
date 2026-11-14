import test from "node:test";
import assert from "node:assert/strict";
import { createGoogleGeminiGcsFilesComposition } from "../google-gemini-gcs-composition.mjs";

const ownerId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const assetId = "33333333-3333-4333-8333-333333333333";
const sha256 = "a".repeat(64);
const token = "oauth-test-access-token-123456";
const source = {
  assetId, ownerId, projectId, bucket: "private-media-bucket",
  objectName: "private/final.mp4", generation: "1762300800000000", metageneration: "3",
  sizeBytes: 1024, mediaType: "video/mp4", sha256, state: "ACTIVE"
};
const env = {
  GOOGLE_CLOUD_PROJECT_ID: "test-gcp-project-12345",
  GEMINI_GCS_ALLOWED_BUCKETS: "private-media-bucket"
};
function response(body, status = 200) {
  return new Response(body === null ? null : JSON.stringify(body), { status });
}

test("composes caller-readable GCS object verification with Gemini registration and durable mapping", async () => {
  const calls = [], records = [];
  const repository = {
    async findProviderFile() { calls.push("find-mapping"); return null; },
    async recordProviderFile(record) { calls.push("record-mapping"); records.push(record); return "mapping-1"; },
    async deleteProviderFileRecord() { calls.push("delete-mapping"); return true; }
  };
  const metadata = {
    bucket: source.bucket, name: source.objectName, generation: source.generation,
    metageneration: source.metageneration,
    size: String(source.sizeBytes), contentType: source.mediaType,
    metadata: {
      executivevisualsassetid: assetId,
      executivevisualsownerid: ownerId,
      executivevisualsprojectid: projectId,
      executivevisualssha256: sha256
    }
  };
  const composition = createGoogleGeminiGcsFilesComposition({
    env,
    getAccessToken: async () => token,
    loadSource: async scope => {
      calls.push("load-source");
      assert.deepEqual(scope, { assetId, ownerId, projectId });
      return source;
    },
    authorizePrivateAsset: async scope => {
      calls.push("authorize");
      assert.equal(scope.assetId, assetId);
      assert.equal(scope.gcsUri, "gs://private-media-bucket/private/final.mp4");
      return { id: assetId, ownerId, projectId };
    },
    repository,
    now: () => Date.parse("2026-11-05T00:00:00.000Z"),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).startsWith("https://storage.googleapis.com/")) return response(metadata);
      if (String(url).endsWith("/v1beta/files:register")) {
        assert.deepEqual(JSON.parse(options.body), { uris: ["gs://private-media-bucket/private/final.mp4"] });
        return response({ files: [{
          name: "files/gcs-file-123",
          uri: "https://generativelanguage.googleapis.com/v1beta/files/gcs-file-123",
          mimeType: "video/mp4", sizeBytes: "1024", state: "ACTIVE",
          expirationTime: "2026-11-25T00:00:00.000Z"
        }] });
      }
      throw new Error("Unexpected provider request: " + url);
    }
  });

  const result = await composition.registerAsset({ assetId, ownerId, projectId, mediaType: "video/mp4" });
  assert.equal(result.sourceType, "gcs_registration");
  assert.equal(result.reused, false);
  assert.equal(records.length, 1);
  assert.equal(records[0].sourceUri, "gs://private-media-bucket/private/final.mp4");
  assert.ok(calls.indexOf("load-source") < calls.indexOf("authorize"));
  assert.ok(calls.indexOf("authorize") < calls.indexOf("find-mapping"));
  const metadataCall = calls.find(call => typeof call === "object" && call.url.startsWith("https://storage.googleapis.com/"));
  const registerCall = calls.find(call => typeof call === "object" && call.url.endsWith("/v1beta/files:register"));
  assert.ok(metadataCall);
  assert.ok(registerCall);
  assert.equal(metadataCall.options.method, "GET");
  assert.equal(registerCall.options.method, "POST");
  assert.equal(JSON.stringify(result).includes(token), false);
});

test("requires trusted source, authorization and OAuth dependencies before constructing", () => {
  assert.throws(() => createGoogleGeminiGcsFilesComposition({}), /requires OAuth/);
});

test("uses the governed source repository by default and exposes scoped source revocation", async () => {
  const calls = [];
  const sourceRepository = {
    async findActiveSource(scope) { calls.push({ op: "find", scope }); return source; },
    async revokeSource(scope) { calls.push({ op: "revoke", scope }); return { id: "source-1", state: "REVOKED" }; }
  };
  const metadata = {
    bucket: source.bucket, name: source.objectName, generation: source.generation,
    metageneration: source.metageneration, size: String(source.sizeBytes),
    contentType: source.mediaType,
    metadata: {
      executivevisualsassetid: assetId,
      executivevisualsownerid: ownerId,
      executivevisualsprojectid: projectId,
      executivevisualssha256: sha256
    }
  };
  const repository = {
    async findProviderFile() { return null; },
    async recordProviderFile() { return "mapping-1"; },
    async deleteProviderFileRecord() { return true; }
  };
  const composition = createGoogleGeminiGcsFilesComposition({
    env, sourceRepository, repository,
    getAccessToken: async () => token,
    authorizePrivateAsset: async () => ({ id: assetId, ownerId, projectId }),
    fetchImpl: async (url, options) => {
      if (String(url).startsWith("https://storage.googleapis.com/")) return response(metadata);
      if (String(url).endsWith("/v1beta/files:register")) return response({ files: [{
        name: "files/gcs-file-456",
        uri: "https://generativelanguage.googleapis.com/v1beta/files/gcs-file-456",
        mimeType: "video/mp4", sizeBytes: "1024", state: "ACTIVE",
        expirationTime: "2026-11-25T00:00:00.000Z"
      }] });
      throw new Error("Unexpected provider request: " + url);
    }
  });
  const result = await composition.registerAsset({ assetId, ownerId, projectId, mediaType: "video/mp4" });
  assert.equal(result.sourceType, "gcs_registration");
  assert.deepEqual(calls[0], { op: "find", scope: { assetId, ownerId, projectId } });
  const revoked = await composition.revokeSource({ sourceId: "source-1", assetId, ownerId, projectId });
  assert.equal(revoked.state, "REVOKED");
  assert.deepEqual(calls[1], { op: "revoke", scope: { sourceId: "source-1", assetId, ownerId, projectId } });
});
