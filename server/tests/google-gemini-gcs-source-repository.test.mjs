import test from "node:test";
import assert from "node:assert/strict";
import { createGoogleGeminiGcsSourceRepository } from "../google-gemini-gcs-source-repository.mjs";

const ownerId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const assetId = "33333333-3333-4333-8333-333333333333";
const sourceId = "44444444-4444-4444-8444-444444444444";
const source = {
  assetId, ownerId, projectId, bucket: "private-media-bucket",
  objectName: "mirrors/project/final-cut.mp4", generation: "1762300800000000",
  metageneration: "3", sizeBytes: 1024, mediaType: "video/mp4", sha256: "a".repeat(64)
};
const row = {
  id: sourceId, asset_id: assetId, owner_id: ownerId, project_id: projectId,
  bucket: source.bucket, object_name: source.objectName, generation: source.generation,
  metageneration: source.metageneration, byte_size: source.sizeBytes,
  media_type: source.mediaType, sha256: source.sha256, state: "ACTIVE",
  verified_at: "2026-11-05T10:00:00.000Z", revoked_at: null
};
function response(body, status = 200) {
  return new Response(body === null ? null : JSON.stringify(body), { status });
}
function harness(handler) {
  const calls = [];
  const repository = createGoogleGeminiGcsSourceRepository({
    url: "https://example.supabase.co",
    serviceRoleKey: "service-role-test-key",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return handler(String(url), options, calls.length - 1);
    }
  });
  return { repository, calls };
}

test("loads one active source scoped by asset, owner and nullable project", async () => {
  const h = harness(() => response([row]));
  const found = await h.repository.findActiveSource({ assetId, ownerId, projectId });
  assert.equal(found.assetId, assetId);
  assert.equal(found.ownerId, ownerId);
  assert.equal(found.projectId, projectId);
  const call = h.calls[0];
  const url = new URL(call.url);
  assert.equal(url.searchParams.get("asset_id"), "eq." + assetId);
  assert.equal(url.searchParams.get("owner_id"), "eq." + ownerId);
  assert.equal(url.searchParams.get("project_id"), "eq." + projectId);
  assert.equal(url.searchParams.get("state"), "eq.ACTIVE");
  assert.equal(call.options.headers["accept-profile"], "executive_visuals");
  assert.equal(call.options.headers.authorization, "Bearer service-role-test-key");
  assert.equal(call.options.redirect, "error");
});

test("returns null for no active mirror and rejects ambiguous active mappings", async () => {
  const missing = harness(() => response([]));
  assert.equal(await missing.repository.findActiveSource({ assetId, ownerId, projectId }), null);
  const ambiguous = harness(() => response([row, row]));
  await assert.rejects(
    () => ambiguous.repository.findActiveSource({ assetId, ownerId, projectId }),
    error => error.code === "GEMINI_GCS_SOURCE_AMBIGUOUS"
  );
});

test("records only a fully specified verified upload receipt and checks the persisted row", async () => {
  const h = harness((url, options) => {
    assert.equal(options.method, "POST");
    assert.equal(options.headers.prefer, "return=representation");
    const body = JSON.parse(options.body);
    assert.deepEqual(body, {
      asset_id: assetId, owner_id: ownerId, project_id: projectId,
      bucket: source.bucket, object_name: source.objectName,
      generation: source.generation, metageneration: source.metageneration,
      byte_size: source.sizeBytes, media_type: source.mediaType, sha256: source.sha256,
      state: "ACTIVE"
    });
    return response([row]);
  });
  const saved = await h.repository.recordVerifiedSource(source);
  assert.equal(saved.id, sourceId);
  assert.equal(saved.state, "ACTIVE");
  assert.equal(saved.sha256, source.sha256);
});

test("rejects malformed or untrusted source receipt before writing", async () => {
  const h = harness(() => response([row]));
  await assert.rejects(
    () => h.repository.recordVerifiedSource({ ...source, objectName: "../escape.mp4" }),
    error => error.code === "GEMINI_GCS_SOURCE_INVALID"
  );
  await assert.rejects(
    () => h.repository.recordVerifiedSource({ ...source, generation: "not-a-generation" }),
    error => error.code === "GEMINI_GCS_SOURCE_INVALID"
  );
  assert.equal(h.calls.length, 0);
});

test("revokes only the exact active source in the supplied owner/project scope", async () => {
  const h = harness((url, options) => {
    assert.equal(options.method, "PATCH");
    assert.equal(JSON.parse(options.body).state, "REVOKED");
    assert.ok(JSON.parse(options.body).revoked_at);
    const params = new URL(url).searchParams;
    assert.equal(params.get("id"), "eq." + sourceId);
    assert.equal(params.get("asset_id"), "eq." + assetId);
    assert.equal(params.get("owner_id"), "eq." + ownerId);
    assert.equal(params.get("project_id"), "eq." + projectId);
    assert.equal(params.get("state"), "eq.ACTIVE");
    return response([{ id: sourceId, state: "REVOKED", revoked_at: "2026-11-05T11:00:00.000Z" }]);
  });
  const result = await h.repository.revokeSource({ sourceId, assetId, ownerId, projectId });
  assert.equal(result.state, "REVOKED");
});

test("fails closed on a stale or already revoked source", async () => {
  const h = harness(() => response([]));
  await assert.rejects(
    () => h.repository.revokeSource({ sourceId, assetId, ownerId, projectId }),
    error => error.code === "GEMINI_GCS_SOURCE_REVOKE_CONFLICT"
  );
});

test("rejects invalid scope before making a registry request", async () => {
  const h = harness(() => response([]));
  await assert.rejects(
    () => h.repository.findActiveSource({ assetId, ownerId: "invalid", projectId }),
    error => error.code === "GEMINI_GCS_SOURCE_SCOPE_INVALID"
  );
  assert.equal(h.calls.length, 0);
});
