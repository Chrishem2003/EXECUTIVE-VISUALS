import test from "node:test";
import assert from "node:assert/strict";
import { getLatestWorkflowRunId, normalizeWorkflowRunHistory } from "../../src/core/workflow-run-selection.mjs";

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

test("normalizes run history and caps it to the server-supported 50 entries", () => {
  const history = Array.from({ length: 55 }, (_, index) => ({
    id: "run-" + index,
    status: "completed",
    created_at: "2026-11-18T00:00:00Z"
  }));
  const normalized = normalizeWorkflowRunHistory(history);
  assert.equal(normalized.length, 50);
  assert.equal(normalized[0].id, "run-0");
  assert.equal(normalized[0].created_at, "2026-11-18T00:00:00Z");
});

test("normalizes malformed history rows without inventing identifiers", () => {
  assert.deepEqual(normalizeWorkflowRunHistory([
    null,
    {},
    { id: " " },
    { id: "valid-run" },
    { id: "next-run", status: 12, created_at: 4 }
  ]), [
    { id: "valid-run", status: "unknown" },
    { id: "next-run", status: "unknown" }
  ]);
});
