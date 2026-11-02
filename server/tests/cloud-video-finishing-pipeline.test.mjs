import test from "node:test";
import assert from "node:assert/strict";
import { createCloudVideoFinishingPipeline } from "../cloud-video-finishing-pipeline.mjs";

const owner = "11111111-1111-4111-8111-111111111111";
const project = "22222222-2222-4222-8222-222222222222";
const source = { id: "33333333-3333-4333-8333-333333333333", mediaType: "video/mp4", sha256: "a".repeat(64) };
const outputId = "44444444-4444-4444-8444-444444444444";
const plan = {
  pipelineId: "cloud-pipeline-1", sourceAsset: source,
  steps: [{ id: "upscale", kind: "upscale", adapter: "local-upscale", capability: "video.upscale", remote: false, estimatedCostMicros: 0, config: { resolution: "4k" } }]
};

test("binds finishing pipeline reads and writes to the verified cloud owner and project", async () => {
  const records = new Map();
  const calls = [];
  const checkpointStore = {
    async get(scope) {
      calls.push({ kind: "get", scope });
      return records.get(scope.pipelineId + ":" + scope.stepId) || null;
    },
    async save({ ownerId, projectId, record }) {
      calls.push({ kind: "save", ownerId, projectId });
      records.set(record.pipelineId + ":" + record.stepId, {
        ...record, createdAt: "2026-11-02T10:00:00.000Z"
      });
    }
  };
  const pipeline = createCloudVideoFinishingPipeline({
    ownerId: owner, projectId: project, checkpointStore,
    resolveAdapter: async () => ({ status: "ready", remote: false, capabilities: ["video.upscale"] }),
    executeStep: async ({ sourceAsset }) => ({
      id: outputId, mediaType: "video/mp4", sha256: "b".repeat(64), derivativeOf: sourceAsset.id
    })
  });
  const result = await pipeline.run(plan, {});
  assert.equal(result.status, "completed");
  assert.equal(result.outputAsset.id, outputId);
  assert.deepEqual(calls.map(call => call.kind), ["get", "save"]);
  assert.equal(calls[0].scope.ownerId, owner);
  assert.equal(calls[0].scope.projectId, project);
  assert.equal(calls[1].ownerId, owner);
  assert.equal(calls[1].projectId, project);
});

test("refuses to construct a cloud finishing pipeline without verified scope or durable storage", () => {
  assert.throws(() => createCloudVideoFinishingPipeline({ ownerId: "bad", projectId: project }), /verified owner and project/);
  assert.throws(() => createCloudVideoFinishingPipeline({ ownerId: owner, projectId: project }), /durable cloud checkpoint/);
});
