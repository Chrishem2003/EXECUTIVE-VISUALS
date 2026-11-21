import test from "node:test";
import assert from "node:assert/strict";
import { createGoogleOmniVertexCloudVideoIntegration } from "../google-omni-vertex-cloud-video-adapter.mjs";

const ownerId = "123e4567-e89b-42d3-a456-426614174000";
const projectId = "223e4567-e89b-42d3-a456-426614174000";
const jobId = "323e4567-e89b-42d3-a456-426614174000";
const leaseToken = "423e4567-e89b-42d3-a456-426614174000";
const interactionId = "v1_abcdef123456";
const requestHash = "a".repeat(64);
const outputUri = "gs://executive-visuals-test-media/executive-visuals/omni-12/" + jobId + "/" + requestHash + "/video.mp4";
const job = {
  id: jobId, owner_id: ownerId, project_id: projectId, job_type: "video.generate",
  lease_owner: "worker-1", lease_token: leaseToken,
  estimated_cost: { amount: 4, currency: "USD" },
  input: { provider: "google", model: "gemini-omni-1.2-flash", requestHash }
};
const plan = {
  policy: { provider: "google", model: "gemini-omni-1.2-flash", requiresApproval: true },
  payload: {
    model: "gemini-omni-1.2-flash",
    input: [{ type: "text", text: "A sunrise over Kampala." }],
    response_format: [{ type: "video", delivery: "uri", resolution: "720p", duration: "15s" }],
    generation_config: { video_config: { task: "text_to_video" } }
  }
};
const completed = {
  id: interactionId, model: "gemini-omni-1.2-flash", status: "completed",
  usage: {
    total_input_tokens: 100,
    input_tokens_by_modality: [{ modality: "text", tokens: 100 }],
    total_output_tokens: 1000,
    output_tokens_by_modality: [{ modality: "video", tokens: 1000 }]
  },
  steps: [{ type: "model_output", content: [{ type: "video", mime_type: "video/mp4", uri: outputUri }] }]
};

function harness({ stored = true, status = completed } = {}) {
  const calls = [];
  const records = new Map();
  const interactions = {
    async recordInteraction(value) {
      calls.push(["record", value]);
      const record = {
        ...value, interactionId: value.interactionId, ownerId: value.ownerId,
        projectId: value.projectId, jobId: value.jobId
      };
      records.set(value.interactionId, record);
      return record;
    },
    async findInteraction(scope) {
      calls.push(["find", scope]);
      if (!stored) return null;
      const record = records.get(scope.interactionId);
      if (!record || record.ownerId !== scope.ownerId || record.projectId !== scope.projectId ||
          record.jobId !== scope.jobId) return null;
      return record;
    },
    async updateInteraction(value) {
      calls.push(["update", value]);
      const record = records.get(value.interactionId);
      if (!record) throw new Error("missing record");
      Object.assign(record, value);
      return record;
    }
  };
  const client = {
    async createInteraction(_plan, _context, { onInteractionCreated }) {
      calls.push(["create"]);
      await onInteractionCreated({ interactionId, status: "in_progress", model: "gemini-omni-1.2-flash", outputUri });
      return { interactionId, taskId: interactionId, provider: "google", model: "gemini-omni-1.2-flash", status: "in_progress", outputUri };
    },
    async getInteractionForIngestion(id, scope) {
      calls.push(["poll", id, scope]);
      return status;
    },
    async cancelInteraction(id, scope) { calls.push(["cancel", id, scope]); return { id, status: "cancelled" }; }
  };
  const outputIngestor = {
    async ingestInteraction(raw, context) {
      calls.push(["ingest", raw.id, context]);
      assert.equal(await context.assertLease(), true);
      return { assetId: "523e4567-e89b-42d3-a456-426614174000", sizeBytes: 2048, sha256: "b".repeat(64) };
    }
  };
  const integration = createGoogleOmniVertexCloudVideoIntegration({
    client, interactions, outputIngestor,
    preparePlan: async (input, scope) => {
      calls.push(["preparePlan", input.requestHash, scope.job.id]);
      return plan;
    },
    assertApprovedSubmission: async () => true,
    retentionExpiresAt: async () => new Date(Date.now() + 86400000).toISOString()
  });
  return { ...integration, calls, records };
}

test("Vertex adapter prepares an approved model plan and a bounded maximum reservation", async () => {
  const h = harness();
  const prepared = await h.adapter.prepareInput(job.input, { job });
  assert.equal(prepared.plan.policy.model, "gemini-omni-1.2-flash");
  const quote = await h.adapter.preflight(prepared, { job });
  assert.equal(quote.model, "gemini-omni-1.2-flash");
  assert.equal(quote.estimatedUsd, 3.324288);
  assert.equal(quote.billable, false);
});

test("Vertex adapter submits once and records interaction ownership before worker task persistence", async () => {
  const h = harness();
  const prepared = await h.adapter.prepareInput(job.input, { job });
  const accepted = await h.adapter.submit(prepared, { job });
  assert.equal(accepted.taskId, interactionId);
  assert.equal(h.records.get(interactionId).model, "gemini-omni-1.2-flash");
  assert.equal(h.records.get(interactionId).ownerId, ownerId);
  assert.equal(h.records.get(interactionId).projectId, projectId);
  assert.equal(h.records.get(interactionId).outputUri, outputUri);
  assert.equal(h.records.get(interactionId).state, "running");
});

test("Vertex adapter polls the exact owned interaction and persists the completed GCS object URI", async () => {
  const h = harness();
  const prepared = await h.adapter.prepareInput(job.input, { job });
  await h.adapter.submit(prepared, { job });
  const task = await h.adapter.getStatus(interactionId, { job });
  assert.equal(task.status, "succeeded");
  assert.equal(task.provider, "google");
  assert.equal(task.model, "gemini-omni-1.2-flash");
  assert.deepEqual(task.outputUrls, ["google-vertex-interaction:" + interactionId]);
  assert.equal(task.rawInteraction, completed);
  assert.equal(h.records.get(interactionId).state, "succeeded");
  assert.equal(h.records.get(interactionId).outputUri, outputUri);
  assert.equal(h.records.get(interactionId).metadata.usageEvidence.total_input_tokens, 100);
  assert.equal(h.records.get(interactionId).metadata.usageEvidence.total_output_tokens, 1000);
});

test("Vertex adapter rejects polling if the durable interaction does not belong to the leased job", async () => {
  const h = harness({ stored: false });
  await assert.rejects(() => h.adapter.getStatus(interactionId, { job }), error =>
    error.code === "GOOGLE_VERTEX_INTERACTION_FORBIDDEN");
  assert.equal(h.calls.some(call => call[0] === "poll"), false);
});

test("Vertex adapter passes the live worker lease into private GCS output ingestion", async () => {
  const h = harness();
  const prepared = await h.adapter.prepareInput(job.input, { job });
  await h.adapter.submit(prepared, { job });
  const task = await h.adapter.getStatus(interactionId, { job });
  const assertLease = async () => true;
  const output = await h.ingestOutputs({ job, task, providerTaskId: interactionId, signal: undefined, assertLease });
  assert.deepEqual(output.assetIds, ["523e4567-e89b-42d3-a456-426614174000"]);
  const ingest = h.calls.find(call => call[0] === "ingest");
  assert.equal(ingest[2].ownerId, ownerId);
  assert.equal(ingest[2].jobId, jobId);
  assert.equal(ingest[2].workerId, job.lease_owner);
  assert.equal(ingest[2].leaseToken, leaseToken);
});

test("Vertex adapter reconciles usage with the model-specific authoritative rate", async () => {
  const h = harness();
  const cost = await h.resolveActualCost({ task: { rawInteraction: completed }, providerTaskId: interactionId });
  assert.equal(cost.amount, 0.01215);
  assert.equal(cost.currency, "USD");
  assert.equal(cost.actualCredits, 2);
  assert.match(cost.evidenceReference, /google-vertex-interaction-usage/);
});

test("Vertex adapter refuses unapproved or mismatched plans before provider submission", async () => {
  const h = harness();
  h.adapter = undefined;
  const bad = createGoogleOmniVertexCloudVideoIntegration({
    client: { createInteraction: async () => { throw new Error("must not submit"); }, getInteractionForIngestion: async () => completed, cancelInteraction: async () => completed },
    interactions: { recordInteraction: async () => {}, findInteraction: async () => null, updateInteraction: async () => {} },
    outputIngestor: { ingestInteraction: async () => ({}) },
    preparePlan: async () => ({ ...plan, policy: { ...plan.policy, requiresApproval: false } }),
    assertApprovedSubmission: async () => true,
    retentionExpiresAt: async () => new Date(Date.now() + 86400000).toISOString()
  });
  await assert.rejects(() => bad.adapter.prepareInput(job.input, { job }), error =>
    error.code === "GOOGLE_VERTEX_PLAN_INVALID");
});


test("Vertex adapter refuses submission when the durable budget approval validator denies the job", async () => {
  const h = harness();
  const denied = createGoogleOmniVertexCloudVideoIntegration({
    client: h.adapter && {
      createInteraction: async () => { throw new Error("must not submit"); },
      getInteractionForIngestion: async () => completed,
      cancelInteraction: async () => completed
    },
    interactions: {
      recordInteraction: async () => { throw new Error("must not persist"); },
      findInteraction: async () => null,
      updateInteraction: async () => {}
    },
    outputIngestor: { ingestInteraction: async () => ({}) },
    preparePlan: async () => plan,
    assertApprovedSubmission: async () => false,
    retentionExpiresAt: async () => new Date(Date.now() + 86400000).toISOString()
  });
  const prepared = await denied.adapter.prepareInput(job.input, { job });
  await assert.rejects(() => denied.adapter.submit(prepared, { job }), error =>
    error.code === "GOOGLE_VERTEX_APPROVAL_REQUIRED");
});
