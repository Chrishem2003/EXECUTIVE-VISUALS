import test from "node:test";
import assert from "node:assert/strict";
import { createVideoWorkflowCloudRequest } from "../video-workflow-cloud-contract.mjs";

const node = { id: "video-1", kind: "video.generate", config: {
  provider: "runway", model: "model-router", durationSeconds: 8, aspectRatio: "16:9"
} };
const base = {
  node, projectId: "project-1", requestId: "workflow-run-1:video-1",
  values: { prompt: "A cinematic product launch" }
};

test("builds deterministic text-to-video contract for the exact router adapter", () => {
  const first = createVideoWorkflowCloudRequest(base);
  const second = createVideoWorkflowCloudRequest(base);
  assert.equal(first.provider, "runway");
  assert.equal(first.model, "model-router");
  assert.equal(first.operation, "text-to-video");
  assert.equal(first.input.durationSeconds, 8);
  assert.equal(first.requestHash, second.requestHash);
  assert.match(first.requestHash, /^[a-f0-9]{64}$/);
  assert.equal(first.input.requestHash, first.requestHash);
});

test("maps one first-frame asset to image-to-video without resolving private storage", () => {
  const result = createVideoWorkflowCloudRequest({
    ...base, values: { prompt: "Animate the product", "start-frame": "asset-image-1" }
  });
  assert.equal(result.operation, "image-to-video");
  assert.equal(result.input.startFrameAssetId, "asset-image-1");
});

test("maps existing image/reference workflow ports and numeric UI duration values", () => {
  const result = createVideoWorkflowCloudRequest({
    ...base,
    node: { ...node, config: { ...node.config, duration: "10" } },
    values: { prompt: "Animate the image", image: "asset-image-2" }
  });
  assert.equal(result.operation, "image-to-video");
  assert.equal(result.input.startFrameAssetId, "asset-image-2");
  assert.equal(result.input.durationSeconds, 10);
});

test("preserves the existing referenceAssetId node configuration", () => {
  const result = createVideoWorkflowCloudRequest({
    ...base,
    node: { ...node, config: { ...node.config, referenceAssetId: "asset-reference-legacy" } }
  });
  assert.equal(result.operation, "image-to-video");
  assert.equal(result.input.startFrameAssetId, "asset-reference-legacy");
});

test("maps source video to video-to-video and retains asset lineage IDs", () => {
  const result = createVideoWorkflowCloudRequest({
    ...base, values: {
      prompt: "Replace the background", sourceVideoAssetId: "asset-video-1",
      referenceImageAssetIds: ["asset-image-1"]
    }
  });
  assert.equal(result.operation, "video-to-video");
  assert.equal(result.input.sourceVideoAssetId, "asset-video-1");
  assert.deepEqual(result.input.referenceAssetIds, ["asset-image-1"]);
});

test("rejects unsupported nodes and provider/model fallbacks", () => {
  assert.throws(
    () => createVideoWorkflowCloudRequest({ ...base, node: { ...node, kind: "image.generate" } }),
    error => error.code === "VIDEO_WORKFLOW_CLOUD_NODE_UNSUPPORTED"
  );
  assert.throws(
    () => createVideoWorkflowCloudRequest({ ...base, node: { ...node, config: { provider: "fal", model: "fal-ai/video" } } }),
    error => error.code === "VIDEO_WORKFLOW_CLOUD_ADAPTER_UNAVAILABLE"
  );
});

test("requires stable request identity and a saved project", () => {
  assert.throws(
    () => createVideoWorkflowCloudRequest({ ...base, requestId: "" }),
    error => error.code === "VIDEO_WORKFLOW_CLOUD_REQUEST_ID_REQUIRED"
  );
  assert.throws(
    () => createVideoWorkflowCloudRequest({ ...base, projectId: null }),
    error => error.code === "VIDEO_WORKFLOW_CLOUD_PROJECT_REQUIRED"
  );
});

test("rejects an operation that conflicts with connected asset types", () => {
  assert.throws(
    () => createVideoWorkflowCloudRequest({
      ...base, node: { ...node, config: { ...node.config, operation: "text-to-video" } },
      values: { prompt: "Edit", sourceVideoAssetId: "asset-video-1" }
    }),
    error => error.code === "VIDEO_WORKFLOW_CLOUD_OPERATION_MISMATCH"
  );
});

test("rejects invalid router durations and unsupported reference audio combinations", () => {
  assert.throws(
    () => createVideoWorkflowCloudRequest({
      ...base, node: { ...node, config: { ...node.config, durationSeconds: 31 } }
    }),
    error => error.code === "VIDEO_WORKFLOW_CLOUD_CAPABILITY_UNSUPPORTED"
  );
  assert.throws(
    () => createVideoWorkflowCloudRequest({
      ...base, node: { ...node, config: { ...node.config, audioMode: "reference" } }
    }),
    /exactly one connected reference-audio asset/
  );
});

test("rejects duplicate or excessive reference assets", () => {
  assert.throws(
    () => createVideoWorkflowCloudRequest({
      ...base, values: { prompt: "Test", references: ["a", "a"] }
    }),
    /duplicate asset IDs/
  );
  assert.throws(
    () => createVideoWorkflowCloudRequest({
      ...base, values: { prompt: "Test", references: ["a", "b", "c", "d", "e"] }
    }),
    /at most 4/
  );
});
