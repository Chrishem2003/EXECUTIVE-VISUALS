import test from "node:test";
import assert from "node:assert/strict";
import { createGoogleOmniCloudVideoIntegration } from "../google-omni-cloud-video-adapter.mjs";

const ownerId = "123e4567-e89b-42d3-a456-426614174000";
const projectId = "223e4567-e89b-42d3-a456-426614174000";
const jobId = "323e4567-e89b-42d3-a456-426614174000";
const interactionId = "v1_abcdef123456";
const requestHash = "a".repeat(64);
const videoBytes = Buffer.from("mock-video");
const job = {
  id: jobId, owner_id: ownerId, project_id: projectId, job_type: "video.generate",
  input: { provider: "google", model: "gemini-omni-1.1-flash", requestHash },
  estimated_cost: { amount: 10, currency: "USD" }
};
const plan = {
  policy: { provider: "google", model: "gemini-omni-1.1-flash", requiresApproval: true },
  payload: { previous_interaction_id: "v1_parent123456" }
};
function raw(status = "in_progress") {
  return {
    id: interactionId, model: "gemini-omni-1.1-flash", status,
    steps: status === "completed" ? [{
      type: "model_output",
      content: [{ type: "video", mime_type: "video/mp4", uri: "https://generativelanguage.googleapis.com/v1beta/files/generated123" }]
    }] : []
  };
}
function harness({ providerStatus = "completed", failRecord = false, stored = true, interruptAfterCreate = false } = {}) {
  const calls = [];
  const records = new Map();
  const client = {
    async createInteraction(value, context, options = {}) {
      calls.push(["create", value, context]);
      if (interruptAfterCreate) {
        await options.onInteractionCreated({ interactionId, status: "running", model: "gemini-omni-1.1-flash" });
        throw Object.assign(new Error("stream interrupted"), { code: "GEMINI_OMNI_SUBMISSION_OUTCOME_UNKNOWN" });
      }
      return { interactionId, taskId: interactionId, provider: "google", model: "gemini-omni-1.1-flash", status: "running", outputUri: "https://generativelanguage.googleapis.com/v1beta/files/generated123" };
    },
    async getInteractionForIngestion(id, context) {
      calls.push(["get", id, context]);
      const value = raw(providerStatus);
      if (providerStatus === "completed") value.steps = []; // Simulate GET omitting the creation-time URI.
      return value;
    }
  };
  const interactions = {
    async recordInteraction(value) {
      calls.push(["record", value]);
      if (failRecord) throw new Error("database unavailable");
      records.set(value.interactionId, {
        ...value, id: "interaction-row-1", interactionId: value.interactionId,
        provider: value.provider, model: value.model, ownerId: value.ownerId,
        projectId: value.projectId, jobId: value.jobId, requestHash: value.requestHash
      });
      return records.get(value.interactionId);
    },
    async findInteraction(scope) {
      calls.push(["find", scope]);
      const value = records.get(scope.interactionId);
      if (!stored || !value || value.ownerId !== scope.ownerId ||
          value.projectId !== scope.projectId || value.jobId !== scope.jobId) return null;
      return value;
    },
    async updateInteraction(value) {
      calls.push(["update", value]);
      const current = records.get(value.interactionId);
      if (!current) throw new Error("missing");
      const next = { ...current, state: value.state, ...(value.outputUri !== undefined ? { outputUri: value.outputUri } : {}) };
      records.set(value.interactionId, next);
      return next;
    }
  };
  const outputIngestor = {
    async ingestInteraction(value, context) {
      calls.push(["ingest", value.id, context]);
      return { assetId: "423e4567-e89b-42d3-a456-426614174000", sizeBytes: videoBytes.length, sha256: "b".repeat(64) };
    }
  };
  const integration = createGoogleOmniCloudVideoIntegration({
    client, interactions, outputIngestor,
    preparePlan: async (input, context) => {
      calls.push(["preparePlan", input.requestHash, context.job.id]);
      return plan;
    },
    retentionExpiresAt: async ({ job: activeJob }) => {
      calls.push(["retention", activeJob.id]);
      return new Date(Date.now() + 86400000).toISOString();
    }
  });
  return { ...integration, calls, records };
}

test("prepares an authorized job plan, submits once and durably records owner/project lineage", async () => {
  const h = harness();
  const prepared = await h.adapter.prepareInput(job.input, { job });
  const accepted = await h.adapter.submit(prepared, { job });
  assert.equal(accepted.taskId, interactionId);
  const createCall = h.calls.find(call => call[0] === "create");
  assert.equal(createCall[2].jobId, jobId);
  assert.equal(createCall[2].requestHash, requestHash);
  assert.equal(createCall[2].estimatedCost.amount, 10);
  assert.equal(h.records.get(interactionId).ownerId, ownerId);
  assert.equal(h.records.get(interactionId).projectId, projectId);
  assert.equal(h.records.get(interactionId).parentInteractionId, "v1_parent123456");
  assert.equal(h.records.get(interactionId).outputUri, "https://generativelanguage.googleapis.com/v1beta/files/generated123");
  assert.deepEqual(h.calls.map(call => call[0]), ["preparePlan", "create", "retention", "record", "update"]);
});

test("polls only an interaction durably scoped to the exact leased job", async () => {
  const h = harness();
  const prepared = await h.adapter.prepareInput(job.input, { job });
  await h.adapter.submit(prepared, { job });
  const task = await h.adapter.getStatus(interactionId, { job, workerId: "worker-1" });
  assert.equal(task.status, "succeeded");
  assert.equal(task.outputUrls.length, 1);
  assert.equal(task.rawInteraction.id, interactionId);
  assert.ok(task.rawInteraction.steps.some(step => step?.type === "model_output" && Array.isArray(step.content) && step.content.some(item => item?.type === "video" && item.uri === "https://generativelanguage.googleapis.com/v1beta/files/generated123")));
  assert.equal(h.records.get(interactionId).state, "succeeded");
});

test("ingests completed output into the private asset service without exposing provider output", async () => {
  const h = harness();
  const prepared = await h.adapter.prepareInput(job.input, { job });
  await h.adapter.submit(prepared, { job });
  const task = await h.adapter.getStatus(interactionId, { job });
  const output = await h.ingestOutputs({ job, task, providerTaskId: interactionId });
  assert.deepEqual(output.assetIds, ["423e4567-e89b-42d3-a456-426614174000"]);
  assert.equal(output.usage.outputCount, 1);
  const ingest = h.calls.find(call => call[0] === "ingest");
  assert.equal(ingest[2].ownerId, ownerId);
  assert.equal(ingest[2].projectId, projectId);
  assert.equal(ingest[2].jobId, jobId);
});

test("quarantines submission if interaction ownership cannot be persisted", async () => {
  const h = harness({ failRecord: true });
  const prepared = await h.adapter.prepareInput(job.input, { job });
  await assert.rejects(() => h.adapter.submit(prepared, { job }));
  assert.equal(h.calls.filter(call => call[0] === "create").length, 1);
  assert.equal(h.calls.some(call => call[0] === "record"), true);
});


test("persists the interaction ID before an interrupted SSE submission is reconciled", async () => {
  const h = harness({ interruptAfterCreate: true });
  const prepared = await h.adapter.prepareInput(job.input, { job });
  await assert.rejects(() => h.adapter.submit(prepared, { job }), error =>
    error.code === "GEMINI_OMNI_SUBMISSION_OUTCOME_UNKNOWN");
  assert.equal(h.records.get(interactionId).state, "running");
  assert.equal(h.records.get(interactionId).outputUri, null);
  assert.equal(h.calls.filter(call => call[0] === "create").length, 1);
  assert.equal(h.calls.filter(call => call[0] === "record").length, 1);
});

test("rejects polling without a matching durable job record before contacting Google", async () => {
  const h = harness({ stored: false });
  await assert.rejects(() => h.adapter.getStatus(interactionId, { job }), error =>
    error.code === "GEMINI_OMNI_INTERACTION_FORBIDDEN");
  assert.equal(h.calls.some(call => call[0] === "get"), false);
});

test("maps incomplete Google interactions to a terminal failed state", async () => {
  const h = harness({ providerStatus: "incomplete" });
  const prepared = await h.adapter.prepareInput(job.input, { job });
  await h.adapter.submit(prepared, { job });
  const task = await h.adapter.getStatus(interactionId, { job });
  assert.equal(task.status, "failed");
  assert.equal(h.records.get(interactionId).state, "failed");
});

test("rejects output ingestion when task and leased job context do not match", async () => {
  const h = harness();
  await assert.rejects(() => h.ingestOutputs({
    job, task: { taskId: "v1_other123456", provider: "google", model: "gemini-omni-1.1-flash" },
    providerTaskId: interactionId
  }), error => error.code === "GEMINI_OMNI_OUTPUT_CONTEXT_INVALID");
});

test("exposes authoritative provider token usage as the cloud executor cost resolver", async () => {
  const h = harness();
  const result = await h.resolveActualCost({
    providerTaskId: interactionId,
    task: { rawInteraction: { usage: { total_input_tokens: 1000, total_output_tokens: 57920, output_tokens_by_modality: [{ modality: "video", tokens: 57920 }] } } }
  });
  assert.equal(result.amount, 1.0151);
  assert.equal(result.currency, "USD");
  assert.match(result.evidenceReference, new RegExp(interactionId));
});

test("refuses polling while retention cleanup owns the interaction record", async () => {
  const h = harness();
  const prepared = await h.adapter.prepareInput(job.input, { job });
  await h.adapter.submit(prepared, { job });
  h.records.get(interactionId).state = "deleting";
  await assert.rejects(() => h.adapter.getStatus(interactionId, { job }), error =>
    error.code === "GEMINI_OMNI_INTERACTION_FORBIDDEN");
  assert.equal(h.calls.some(call => call[0] === "get"), false);
});
