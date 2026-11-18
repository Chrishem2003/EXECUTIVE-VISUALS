import test from "node:test";
import assert from "node:assert/strict";
import { getLatestWorkflowRunId } from "../../src/core/workflow-run-selection.mjs";

test("selects the newest valid workflow run from a newest-first API response", () => {
  assert.equal(getLatestWorkflowRunId([
    { id: "newest-run", status: "processing" },
    { id: "older-run", status: "completed" }
  ]), "newest-run");
});

test("skips malformed run entries without selecting an older valid run first", () => {
  assert.equal(getLatestWorkflowRunId([
    null,
    { id: "  " },
    { id: "current-run", status: "queued" },
    { id: "previous-run", status: "completed" }
  ]), "current-run");
});

test("returns an empty identifier when the selected workflow has no runs", () => {
  assert.equal(getLatestWorkflowRunId([]), "");
  assert.equal(getLatestWorkflowRunId(undefined), "");
  assert.equal(getLatestWorkflowRunId(null), "");
});
