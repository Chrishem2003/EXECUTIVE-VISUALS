import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGoogleOmniVertexOutputIngestor } from "../google-omni-vertex-output-ingestion.mjs";

const bucket = "executive-visuals-test-media";
const ownerId = "123e4567-e89b-42d3-a456-426614174000";
const projectId = "223e4567-e89b-42d3-a456-426614174000";
const jobId = "323e4567-e89b-42d3-a456-426614174000";
const leaseToken = "423e4567-e89b-42d3-a456-426614174000";
const interactionId = "v1_abcdef123456";
const requestHash = "a".repeat(64);
const object = "executive-visuals/omni-12/" + jobId + "/" + requestHash + "/video.mp4";
const uri = "gs://" + bucket + "/" + object;
const bytes = Buffer.from("verified-private-vertex-video");
const token = "vertex-test-access-token-1234567890";
const authClient = { async getClient() { return { async getAccessToken() { return { token }; } }; } };
const context = {
  ownerId, projectId, jobId, requestHash,
  workerId: "video-worker-1", leaseToken,
  async assertLease() { return true; }
};
function raw(outputUri = uri) {
  return { id: interactionId, model: "gemini-omni-1.2-flash", status: "completed", steps: [{
    type: "model_output", content: [{ type: "video", mime_type: "video/mp4", uri: outputUri }]
  }] };
}
function harness({ assertLease = async () => true, outputUri = uri } = {}) {
  const calls = [];
  const interactions = {
    async findInteraction(scope) {
      calls.push(["authorize", scope]);
      return {
        provider: "google", model: "gemini-omni-1.2-flash", interactionId,
        ownerId, projectId, jobId, requestHash, state: "succeeded", outputUri
      };
    }
  };
  const assets = {
    async createFromFileIdempotent(value) {
      calls.push(["publish", value]);
      assert.equal(await value.assertLease(), true);
      assert.deepEqual(await readFile(value.filePath), bytes);
      return { id: "523e4567-e89b-42d3-a456-426614174000" };
    }
  };
  const ingestor = createGoogleOmniVertexOutputIngestor({
    assets, interactions, outputBucket: bucket, authClient,
    tempRoot: tmpdir(), timeoutMs: 3000,
    fetchImpl: async (url, options) => {
      calls.push(["fetch", String(url), options]);
      return new Response(bytes, {
        status: 200,
        headers: { "content-type": "video/mp4", "content-length": String(bytes.length) }
      });
    }
  });
  return { ingestor, calls, assertLease };
}

test("Vertex GCS output is authorized, bounded, downloaded and published as a private asset", async () => {
  const h = harness();
  const result = await h.ingestor.ingestInteraction(raw(), { ...context, assertLease: h.assertLease });
  assert.equal(result.assetId, "523e4567-e89b-42d3-a456-426614174000");
  assert.equal(result.ownerId, ownerId);
  assert.equal(result.projectId, projectId);
  assert.equal(result.sizeBytes, bytes.length);
  assert.equal(result.mediaType, "video/mp4");
  const fetchCall = h.calls.find(call => call[0] === "fetch");
  assert.match(fetchCall[1], /^https:\/\/storage\.googleapis\.com\/storage\/v1\/b\//);
  assert.match(fetchCall[1], /alt=media$/);
  assert.equal(fetchCall[2].headers.authorization, "Bearer " + token);
  const publication = h.calls.find(call => call[0] === "publish")[1];
  assert.equal(publication.ownerId, ownerId);
  assert.equal(publication.projectId, projectId);
  assert.equal(publication.publicationKey, "google:" + jobId + ":" + interactionId + ":output:0");
  assert.equal(publication.metadata.model, "gemini-omni-1.2-flash");
  assert.equal(publication.leaseContext.workerId, "video-worker-1");
});

test("Vertex output ingestion rejects GCS paths outside the exact job prefix before network access", async () => {
  const h = harness();
  const unsafe = "gs://" + bucket + "/other-user/video.mp4";
  await assert.rejects(() => h.ingestor.ingestInteraction(raw(unsafe), { ...context, assertLease: h.assertLease }),
    error => error.code === "GOOGLE_VERTEX_OUTPUT_URI_INVALID");
  assert.equal(h.calls.some(call => call[0] === "fetch"), false);
  assert.equal(h.calls.some(call => call[0] === "publish"), false);
});

test("Vertex output ingestion refuses a missing or mismatched durable interaction record", async () => {
  const h = harness();
  h.ingestor = createGoogleOmniVertexOutputIngestor({
    assets: { async createFromFileIdempotent() { throw new Error("must not publish"); } },
    interactions: { async findInteraction() { return null; } },
    outputBucket: bucket, authClient,
    fetchImpl: async () => { throw new Error("must not download"); }
  });
  await assert.rejects(() => h.ingestor.ingestInteraction(raw(), { ...context, assertLease: h.assertLease }),
    error => error.code === "GOOGLE_VERTEX_OUTPUT_FORBIDDEN");
});

test("Vertex output ingestion stops before publication if the worker lease is lost", async () => {
  const h = harness();
  const lost = async () => false;
  await assert.rejects(() => h.ingestor.ingestInteraction(raw(), { ...context, assertLease: lost }),
    error => error.code === "GOOGLE_VERTEX_OUTPUT_INGEST_FAILED" || error.code === "CLOUD_WORKER_LEASE_LOST");
  assert.equal(h.calls.some(call => call[0] === "publish"), false);
});

test("Vertex output ingestion enforces MP4 content type and configured bucket", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vertex-output-test-"));
  try {
    assert.throws(() => createGoogleOmniVertexOutputIngestor({
      assets: { async createFromFileIdempotent() {} },
      interactions: { async findInteraction() {} },
      outputBucket: "other-bucket"
    }), /dedicated GCS output bucket/);
    const ingestor = createGoogleOmniVertexOutputIngestor({
      assets: { async createFromFileIdempotent() { throw new Error("must not publish"); } },
      interactions: { async findInteraction() { return {
        provider: "google", model: "gemini-omni-1.2-flash", interactionId,
        ownerId, projectId, jobId, requestHash, state: "succeeded", outputUri: uri
      }; } },
      outputBucket: bucket, authClient, tempRoot: dir,
      fetchImpl: async () => new Response(bytes, {
        status: 200, headers: { "content-type": "text/html", "content-length": String(bytes.length) }
      })
    });
    await assert.rejects(() => ingestor.ingestInteraction(raw(), { ...context, assertLease: context.assertLease }),
      error => error.code === "GOOGLE_VERTEX_OUTPUT_INGEST_FAILED");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
