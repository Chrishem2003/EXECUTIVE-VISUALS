import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGoogleGeminiGcsMirrorService } from "../google-gemini-gcs-mirror-service.mjs";

const ownerId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const assetId = "33333333-3333-4333-8333-333333333333";
const sha256 = "a".repeat(64);
const token = "oauth-test-access-token-123456";
const generation = "1762300800000000";
const metageneration = "3";
const sessionUri = "https://storage.googleapis.com/upload/storage/v1/b/private-media-bucket/o?uploadType=resumable&upload_id=opaque-session";
const env = {
  GOOGLE_CLOUD_PROJECT_ID: "test-gcp-project-12345",
  GEMINI_GCS_ALLOWED_BUCKETS: "private-media-bucket",
  GEMINI_GCS_MIRROR_BUCKET: "private-media-bucket"
};
const asset = {
  id: assetId, ownerId, projectId, mediaType: "video/mp4", size: 4, sha256,
  storageBucket: "executive-visuals-media", objectPath: "private/source.mp4"
};
function source(objectName) {
  return {
    id: "55555555-5555-4555-8555-555555555555", assetId, ownerId, projectId,
    bucket: "private-media-bucket", objectName, generation, metageneration,
    sizeBytes: 4, mediaType: "video/mp4", sha256, state: "ACTIVE"
  };
}
function gcsMetadata(objectName) {
  return {
    bucket: "private-media-bucket", name: objectName, generation, metageneration,
    size: "4", contentType: "video/mp4",
    metadata: {
      executivevisualsassetid: assetId, executivevisualsownerid: ownerId,
      executivevisualsprojectid: projectId, executivevisualssha256: sha256
    }
  };
}
async function setup({ existing = null, authorize = async () => asset } = {}) {
  const root = await mkdtemp(join(tmpdir(), "ev-gcs-service-test-"));
  const filePath = join(root, "source.mp4");
  await writeFile(filePath, new Uint8Array([1,2,3,4]));
  const calls = [], sourceRows = [];
  let active = existing;
  const sourceRepository = {
    async findActiveSource(scope) {
      calls.push({ op: "find", scope });
      return active;
    },
    async recordVerifiedSource(record) {
      calls.push({ op: "record", record });
      const saved = source(record.objectName);
      sourceRows.push(saved); active = saved;
      return saved;
    },
    async revokeSource(scope) { calls.push({ op: "revoke", scope }); return { state: "REVOKED" }; }
  };
  const fetchImpl = async (url, options) => {
    calls.push({ op: options.method, url: String(url), options });
    if (options.method === "POST") return new Response(null, { status: 200, headers: { location: sessionUri } });
    if (options.method === "PUT") {
      const chunks = [];
      for await (const chunk of options.body) chunks.push(Buffer.from(chunk));
      assert.deepEqual(Buffer.concat(chunks), Buffer.from([1,2,3,4]));
      return new Response(JSON.stringify({ generation }), { status: 200 });
    }
    if (options.method === "GET") {
      const objectName = active?.objectName || "mirrors/" + ownerId + "/" + projectId + "/" + assetId + "/fixed-id.mp4";
      return new Response(JSON.stringify(gcsMetadata(objectName)), { status: 200 });
    }
    throw new Error("Unexpected GCS method");
  };
  const attemptRepository = {
    async createAttempt(input) { calls.push({op:"attempt_create",input}); return {id:"44444444-4444-4444-8444-444444444444"}; },
    async recordSession(input) { calls.push({op:"attempt_session",input}); },
    async transition(input) { calls.push({op:"attempt_transition",input}); }
  };
  const service = createGoogleGeminiGcsMirrorService({
    env, fetchImpl, getAccessToken: async () => token, sourceRepository, attemptRepository,
    authorizePrivateAsset: authorize,
    loadPrivateAsset: async scope => {
      calls.push({ op: "load", scope });
      return { asset, path: filePath, size: 4, sha256, cleanup: async () => calls.push({ op: "cleanup" }) };
    },
    makeId: () => "fixed-id"
  });
  return { root, service, calls, sourceRows };
}

test("authorizes and materializes the private asset, mirrors it, verifies it and cleans temporary bytes", async () => {
  const f = await setup();
  try {
    const result = await f.service.mirrorAsset({ assetId, ownerId, projectId });
    assert.equal(result.reused, false);
    assert.equal(result.source.state, "ACTIVE");
    assert.equal(result.gcsUri, "gs://private-media-bucket/" + result.source.objectName);
    assert.equal(f.sourceRows.length, 1);
    assert.ok(f.calls.some(call => call.op === "POST"));
    assert.ok(f.calls.some(call => call.op === "PUT"));
    assert.ok(f.calls.some(call => call.op === "cleanup"));
    assert.ok(f.calls.some(call => call.op === "attempt_create"));
    assert.ok(f.calls.some(call => call.op === "attempt_session"));
    assert.ok(f.calls.some(call => call.op === "attempt_transition" && call.input.state === "REGISTERED"));
    assert.ok(f.calls.findIndex(call => call.op === "find") < f.calls.findIndex(call => call.op === "load"));
    assert.ok(f.calls.findIndex(call => call.op === "load") < f.calls.findIndex(call => call.op === "POST"));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("reuses and re-verifies an existing active mirror without materializing or uploading", async () => {
  const existing = source("mirrors/" + ownerId + "/" + projectId + "/" + assetId + "/existing.mp4");
  const f = await setup({ existing });
  try {
    const result = await f.service.mirrorAsset({ assetId, ownerId, projectId });
    assert.equal(result.reused, true);
    assert.equal(result.gcsUri, "gs://private-media-bucket/" + existing.objectName);
    assert.equal(f.calls.some(call => call.op === "load"), false);
    assert.equal(f.calls.some(call => call.op === "POST" || call.op === "PUT"), false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("denies the mirror before materializing private bytes when authorization fails", async () => {
  const f = await setup({ authorize: async () => { throw new Error("denied"); } });
  try {
    await assert.rejects(() => f.service.mirrorAsset({ assetId, ownerId, projectId }));
    assert.equal(f.calls.some(call => call.op === "load"), false);
    assert.equal(f.calls.some(call => call.op === "POST"), false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("rejects an authorized asset whose durable storage boundary is not the private application bucket", async () => {
  const f = await setup({ authorize: async () => ({ ...asset, storageBucket: "public-bucket" }) });
  try {
    await assert.rejects(
      () => f.service.mirrorAsset({ assetId, ownerId, projectId }),
      error => error.code === "GEMINI_GCS_ASSET_SCOPE_INVALID"
    );
    assert.equal(f.calls.some(call => call.op === "load"), false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
