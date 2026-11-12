import test from "node:test";
import assert from "node:assert/strict";
import { assertVideoWorkflowExecutionMode, assertVideoWorkflowNodeSupport } from "../video-workflow-execution-mode.mjs";

test("non-production execution retains the legacy default for local development", () => {
  assert.equal(assertVideoWorkflowExecutionMode(undefined, { environment: { NODE_ENV: "test" } }), "legacy");
  assert.equal(assertVideoWorkflowExecutionMode("", { environment: { NODE_ENV: "test" } }), "legacy");
  assert.equal(assertVideoWorkflowExecutionMode("legacy"), "legacy");
  assert.equal(assertVideoWorkflowExecutionMode(" LEGACY "), "legacy");
});

test("cloud execution fails closed until the governed bridge is implemented", () => {
  assert.throws(
    () => assertVideoWorkflowExecutionMode("cloud"),
    error => error.code === "CLOUD_VIDEO_WORKFLOW_BRIDGE_NOT_CONFIGURED"
  );
});

test("cloud execution is available only when the authenticated bridge is injected", () => {
  assert.equal(assertVideoWorkflowExecutionMode("cloud", { cloudBridgeAvailable: true }), "cloud");
});

test("unknown execution modes fail closed rather than silently selecting legacy", () => {
  for (const mode of ["", "automatic", "legacy-cloud", "true", "disabled"]) {
    if (mode === "") continue;
    assert.throws(
      () => assertVideoWorkflowExecutionMode(mode),
      error => error.code === "VIDEO_WORKFLOW_EXECUTION_MODE_INVALID"
    );
  }
});

test("production defaults to governed cloud execution and fails closed without the bridge", () => {
  assert.throws(
    () => assertVideoWorkflowExecutionMode(undefined, { environment: { NODE_ENV: "production" } }),
    error => error.code === "CLOUD_VIDEO_WORKFLOW_BRIDGE_NOT_CONFIGURED"
  );
  assert.equal(assertVideoWorkflowExecutionMode(undefined, {
    cloudBridgeAvailable: true,
    environment: { NODE_ENV: "production" }
  }), "cloud");
});

test("cloud mode accepts only the explicitly implemented Runway Model Router adapter", () => {
  const supported = { kind: "video.generate", config: { provider: "runway", model: "model-router" } };
  assert.equal(assertVideoWorkflowNodeSupport(supported, "cloud"), true);
  for (const node of [
    { kind: "video.generate", config: { provider: "fal", model: "fal-ai/video" } },
    { kind: "video.generate", config: { provider: "runway", model: "gen4_turbo" } },
    { kind: "image.generate", config: { provider: "runway", model: "model-router" } }
  ]) {
    assert.throws(
      () => assertVideoWorkflowNodeSupport(node, "cloud"),
      error => error.code === "VIDEO_WORKFLOW_CLOUD_ADAPTER_UNAVAILABLE"
    );
  }
});

test("legacy adapter support remains unchanged outside governed cloud mode", () => {
  assert.equal(assertVideoWorkflowNodeSupport(
    { kind: "video.generate", config: { provider: "fal", model: "fal-ai/video" } }, "legacy"
  ), true);
});
