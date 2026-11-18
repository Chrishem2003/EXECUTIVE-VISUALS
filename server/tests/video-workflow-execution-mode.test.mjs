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

test("cloud mode accepts explicitly governed direct Runway workers, Model Router and Luma Ray 3.2 adapters", () => {
  const supported = [
    { kind: "video.generate", config: { provider: "runway", model: "model-router" } },
    ...["gen4.5","seedance2_5","kling_4","kling_4_flash","kling3.0_standard","kling3.0_pro","kling3.0_4k"].map(model=>({kind:"video.generate",config:{provider:"runway",model}})),
    { kind: "video.generate", config: { provider: "luma", model: "ray-3.2" } }
  ];
  for (const node of supported) assert.equal(assertVideoWorkflowNodeSupport(node, "cloud"), true);
  for (const node of [
    { kind: "video.generate", config: { provider: "fal", model: "fal-ai/video" } },
    { kind: "video.generate", config: { provider: "luma", model: "ray-3.2-fast" } },
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


test("governed cloud bridge and project prerequisites are represented as blocked workflow states", async () => {
  const { isGovernedCloudWorkflowBlockedCode } = await import("../video-workflow-execution-mode.mjs");
  for (const code of [
    "CLOUD_VIDEO_WORKFLOW_BRIDGE_NOT_CONFIGURED",
    "VIDEO_WORKFLOW_CLOUD_DISABLED",
    "VIDEO_WORKFLOW_CLOUD_ADAPTER_UNAVAILABLE",
    "VIDEO_WORKFLOW_CLOUD_MODE_REQUIRED",
    "VIDEO_WORKFLOW_CLOUD_PROJECT_REQUIRED",
    "VIDEO_WORKFLOW_CLOUD_PROJECT_NOT_LINKED"
  ]) {
    assert.equal(isGovernedCloudWorkflowBlockedCode(code), true, code);
  }
  for (const code of [
    "VIDEO_PROVIDER_FAILED",
    "VIDEO_WORKFLOW_ACTUAL_COST_EVIDENCE_MISSING",
    "VIDEO_WORKFLOW_OUTPUT_INVALID",
    "VIDEO_WORKFLOW_EXECUTION_MODE_INVALID",
    "UNKNOWN_ERROR"
  ]) {
    assert.equal(isGovernedCloudWorkflowBlockedCode(code), false, code);
  }
});
