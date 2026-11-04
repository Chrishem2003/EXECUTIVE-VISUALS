import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRunwayWorkflowInvocationPayload,
  normalizeRunwayWorkflowInvocation,
  RUNWAY_WORKFLOW_POLL_INTERVAL_MS
} from "../runway-workflow-contract.mjs";

const workflowId = "4f0c9a52-8a3e-4c5b-9d1e-2b7a6c3e9f10";
const inputs = [
  { nodeId: "text-node", outputKey: "prompt", type: "primitive", exposedToApp: true },
  { nodeId: "image-node", outputKey: "image", type: "image", exposedToApp: true },
  { nodeId: "video-node", outputKey: "video", type: "video", exposedToApp: true },
  { nodeId: "audio-node", outputKey: "audio", type: "audio", exposedToApp: true },
  { nodeId: "private-node", outputKey: "hidden", type: "primitive", exposedToApp: false }
];

test("workflow invocation planner validates published inputs and emits Runway nodeOutputs shape", async () => {
  const result = await buildRunwayWorkflowInvocationPayload({
    workflowId, inputs,
    nodeOutputs: {
      "text-node": { prompt: { type: "primitive", value: "A product reveal" } }
    }
  });
  assert.equal(result.workflowId, workflowId);
  assert.deepEqual(result.payload, {
    nodeOutputs: {
      "text-node": { prompt: { type: "primitive", value: "A product reveal" } }
    }
  });
});

test("workflow planner rejects invalid IDs, unknown node keys, hidden inputs and invalid primitive values", async () => {
  await assert.rejects(() => buildRunwayWorkflowInvocationPayload({
    workflowId: "not-a-uuid", inputs, nodeOutputs: {}
  }));
  for (const nodeOutputs of [
    { "unknown-node": { prompt: { type: "primitive", value: "x" } } },
    { "private-node": { hidden: { type: "primitive", value: "x" } } },
    { "text-node": { prompt: { type: "image", uri: "https://example.com/a.png" } } },
    { "text-node": { prompt: { type: "primitive", value: NaN } } }
  ]) {
    await assert.rejects(() => buildRunwayWorkflowInvocationPayload({
      workflowId, inputs, nodeOutputs
    }));
  }
});

test("workflow media references are resolved with authenticated project scope", async () => {
  const resolverCalls = [];
  const result = await buildRunwayWorkflowInvocationPayload({
    workflowId, inputs, projectId: "project_1",
    nodeOutputs: {
      "image-node": { image: { type: "image", assetId: "asset_1" } },
      "video-node": { video: { type: "video", assetId: "asset_2" } },
      "audio-node": { audio: { type: "audio", assetId: "asset_3" } }
    },
    getAuthorizedAssetContext: async ({ projectId }) => ({ ownerId: "owner_1", projectId }),
    resolvePrivateAsset: async args => {
      resolverCalls.push(args);
      return { uri: "https://private.example.com/" + args.assetId + "." + args.mediaType };
    }
  });
  assert.deepEqual(result.payload.nodeOutputs, {
    "image-node": { image: { type: "image", uri: "https://private.example.com/asset_1.image" } },
    "video-node": { video: { type: "video", uri: "https://private.example.com/asset_2.video" } },
    "audio-node": { audio: { type: "audio", uri: "https://private.example.com/asset_3.audio" } }
  });
  assert.equal(resolverCalls.length, 3);
  assert.ok(resolverCalls.every(x => x.ownerId === "owner_1" && x.projectId === "project_1"));
});

test("workflow media fails closed without authenticated project scope or private resolver", async () => {
  const media = { "image-node": { image: { type: "image", assetId: "asset_1" } } };
  await assert.rejects(() => buildRunwayWorkflowInvocationPayload({
    workflowId, inputs, projectId: "project_1", nodeOutputs: media
  }), error => error.code === "RUNWAY_WORKFLOW_ASSET_AUTH_REQUIRED");
  await assert.rejects(() => buildRunwayWorkflowInvocationPayload({
    workflowId, inputs, projectId: "project_1", nodeOutputs: media,
    getAuthorizedAssetContext: async ({ projectId }) => ({ ownerId: "owner_1", projectId })
  }), error => error.code === "RUNWAY_WORKFLOW_ASSET_RESOLVER_REQUIRED");
  await assert.rejects(() => buildRunwayWorkflowInvocationPayload({
    workflowId, inputs, projectId: "project_1", nodeOutputs: media,
    getAuthorizedAssetContext: async () => { throw new Error("denied"); },
    resolvePrivateAsset: async () => ({ uri: "https://private.example.com/image.png" })
  }), error => error.code === "RUNWAY_WORKFLOW_ASSET_FORBIDDEN");
});

test("SUCCEEDED invocations with node errors or missing outputs are classified as partial", () => {
  const complete = normalizeRunwayWorkflowInvocation({
    id: "invocation-1", status: "SUCCEEDED", output: { "video-out": ["https://cdn.example.com/final.mp4"] },
    nodeErrors: {}, cost: { credits: 120 }, progress: 1
  }, ["video-out"]);
  assert.equal(complete.outcome, "complete");
  assert.equal(complete.costFinalized, true);
  assert.equal(complete.requiresPrivateOutputIngestion, true);

  const partial = normalizeRunwayWorkflowInvocation({
    id: "invocation-2", status: "SUCCEEDED", output: {},
    nodeErrors: { "node-1": { message: "One branch failed" } }
  }, ["video-out"]);
  assert.equal(partial.outcome, "partial");
  assert.deepEqual(partial.missingOutputs, ["video-out"]);
  assert.equal(partial.costFinalized, false);
  assert.equal(partial.requiresPrivateOutputIngestion, true);
});

test("workflow polling and terminal cost semantics follow Runway's invocation contract", () => {
  assert.equal(RUNWAY_WORKFLOW_POLL_INTERVAL_MS, 5000);
  assert.equal(normalizeRunwayWorkflowInvocation({ status: "PENDING" }).outcome, "running");
  assert.equal(normalizeRunwayWorkflowInvocation({ status: "THROTTLED" }).outcome, "running");
  assert.equal(normalizeRunwayWorkflowInvocation({ status: "RUNNING", progress: 0.5 }).progress, 0.5);
  const failed = normalizeRunwayWorkflowInvocation({
    status: "FAILED", failure: "Graph failed", cost: { credits: 35 }
  });
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.terminal, true);
  assert.equal(failed.costFinalized, true);
  assert.throws(() => normalizeRunwayWorkflowInvocation({ status: "CANCELLED" }));
});
