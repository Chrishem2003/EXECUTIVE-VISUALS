import test from "node:test";
import assert from "node:assert/strict";
import { assertVideoWorkflowExecutionMode } from "../video-workflow-execution-mode.mjs";

test("legacy execution remains the backward-compatible default", () => {
  assert.equal(assertVideoWorkflowExecutionMode(undefined), "legacy");
  assert.equal(assertVideoWorkflowExecutionMode(""), "legacy");
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
