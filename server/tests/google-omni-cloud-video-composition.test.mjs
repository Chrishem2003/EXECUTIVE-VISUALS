import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createGoogleOmniCloudVideoComposition } from "../google-omni-cloud-video-composition.mjs";

const interactionId = "v1_abcdef123456";
const ownerId = "owner-1";
const projectId = "project-1";
const jobId = "job-1";
const requestHash = "a".repeat(64);
const bytes = Buffer.from("private-video");
const digest = createHash("sha256").update(bytes).digest("hex");
const rawInteraction = {
  id: interactionId,
  model: "gemini-omni-1.1-flash",
  status: "completed",
  steps: [{ type: "model_output", content: [{
    type: "video", mime_type: "video/mp4", data: bytes.toString("base64")
  }] }]
};
function setup({ record = {}, existing = null, extraAuthorization } = {}) {
  const calls = { find: [], create: [], extra: [] };
  const asset = {
    id: "asset-1", ownerId, projectId, mediaType: "video/mp4",
    size: bytes.byteLength, sha256: digest,
    storageBucket: "executive-visuals-media"
  };
  const assets = {
    async findVideoGenerationOutput(args) {
      calls.find.push(args);
      return existing;
    },
    async create(args) {
      calls.create.push(args);
      return asset;
    }
  };
  const stored = {
    interactionId, provider: "google", model: "gemini-omni-1.1-flash",
    ownerId, projectId, jobId, requestHash, state: "succeeded", ...record
  };
  const interactions = {
    async findInteraction(scope) {
      calls.extra.push(scope);
      return scope.interactionId === interactionId &&
        scope.ownerId === ownerId && scope.projectId === projectId &&
        scope.jobId === jobId ? stored : null;
    },
    async recordInteraction() {},
    async updateInteraction() {}
  };
  const integration = createGoogleOmniCloudVideoComposition({
    assets,
    client: {
      async createInteraction() { return { interactionId, provider: "google", model: "gemini-omni-1.1-flash", status: "running" }; },
      async getInteractionForIngestion() { return rawInteraction; }
    },
    interactions,
    preparePlan: async () => ({
      policy: { provider: "google", model: "gemini-omni-1.1-flash", requiresApproval: true },
      payload: {}
    }),
    retentionExpiresAt: async () => "2026-12-03T00:00:00.000Z",
    authorizeOutputIngestion: extraAuthorization
  });
  return { integration, calls, asset };
}
const job = { id: jobId, owner_id: ownerId, project_id: projectId, input: { requestHash } };

test("composes Google output ingestion into the existing private Cloud Asset repository", async () => {
  const h = setup();
  const result = await h.integration.ingestOutputs({
    job,
    providerTaskId: interactionId,
    task: {
      taskId: interactionId, provider: "google", model: "gemini-omni-1.1-flash",
      rawInteraction
    }
  });
  assert.deepEqual(result.assetIds, ["asset-1"]);
  assert.equal(result.usage.outputBytes, bytes.byteLength);
  assert.equal(h.calls.find.length, 1);
  assert.equal(h.calls.create.length, 1);
  assert.equal(h.calls.create[0].ownerId, ownerId);
  assert.equal(h.calls.create[0].projectId, projectId);
  assert.equal(h.calls.create[0].mediaType, "video/mp4");
  assert.equal(h.calls.create[0].metadata.source, "video-generation");
  assert.equal(h.calls.create[0].metadata.providerTaskId, interactionId);
  assert.equal(h.calls.create[0].metadata.outputIndex, 0);
});

test("reuses an existing private output without creating a second asset", async () => {
  const existing = {
    id: "asset-existing", ownerId, projectId, mediaType: "video/mp4",
    size: bytes.byteLength, sha256: digest,
    storageBucket: "executive-visuals-media"
  };
  const h = setup({ existing });
  const result = await h.integration.ingestOutputs({
    job,
    providerTaskId: interactionId,
    task: {
      taskId: interactionId, provider: "google", model: "gemini-omni-1.1-flash",
      rawInteraction
    }
  });
  assert.deepEqual(result.assetIds, ["asset-existing"]);
  assert.equal(h.calls.create.length, 0);
});

test("rejects output ingestion unless the durable interaction is succeeded and correctly scoped", async () => {
  for (const record of [
    { state: "running" },
    { ownerId: "owner-2" },
    { projectId: "project-2" },
    { jobId: "job-2" },
    { model: "another-model" },
    { requestHash: "b".repeat(64) }
  ]) {
    const h = setup({ record });
    await assert.rejects(() => h.integration.ingestOutputs({
      job,
      providerTaskId: interactionId,
      task: {
        taskId: interactionId, provider: "google", model: "gemini-omni-1.1-flash",
        rawInteraction
      }
    }), error => error.code === "GEMINI_OMNI_OUTPUT_FORBIDDEN");
    assert.equal(h.calls.create.length, 0);
  }
});

test("supports an additional approval/lineage authorization gate", async () => {
  const h = setup({ extraAuthorization: async () => false });
  await assert.rejects(() => h.integration.ingestOutputs({
    job,
    providerTaskId: interactionId,
    task: {
      taskId: interactionId, provider: "google", model: "gemini-omni-1.1-flash",
      rawInteraction
    }
  }), error => error.code === "GEMINI_OMNI_OUTPUT_FORBIDDEN");
  assert.equal(h.calls.create.length, 0);
});
