import assert from "node:assert/strict";
import test from "node:test";
import { applyTimelineHistory } from "../../src/core/timeline-history.ts";
import { createTimeline } from "../../src/core/timeline.ts";

function timeline(name, revision = 1) {
  return { ...createTimeline("project-1", "timeline-1", name), revision };
}

test("undo persists the previous snapshot and moves the current snapshot to redo", async () => {
  const current = timeline("Current", 2);
  const history = { undo: [timeline("Previous", 1)], redo: [] };
  const saved = await applyTimelineHistory(current, history, "undo", async next => ({
    ...next,
    revision: 3
  }));

  assert.equal(saved.name, "Previous");
  assert.equal(saved.revision, 3);
  assert.equal(history.undo.length, 0);
  assert.equal(history.redo.length, 1);
  assert.equal(history.redo[0].name, "Current");
});

test("redo persists the next snapshot and moves the current snapshot to undo", async () => {
  const current = timeline("Previous", 3);
  const history = { undo: [], redo: [timeline("Next", 2)] };
  const saved = await applyTimelineHistory(current, history, "redo", async next => ({
    ...next,
    revision: 4
  }));

  assert.equal(saved.name, "Next");
  assert.equal(saved.revision, 4);
  assert.equal(history.redo.length, 0);
  assert.equal(history.undo.length, 1);
  assert.equal(history.undo[0].name, "Previous");
});

test("failed persistence restores both history stacks without consuming the entry", async () => {
  const current = timeline("Current", 2);
  const history = { undo: [timeline("Previous", 1)], redo: [timeline("Future", 3)] };
  const beforeUndo = structuredClone(history.undo);
  const beforeRedo = structuredClone(history.redo);

  await assert.rejects(
    () => applyTimelineHistory(current, history, "undo", async () => {
      throw Object.assign(new Error("Revision conflict"), { code: "TIMELINE_REVISION_CONFLICT" });
    }),
    error => error.code === "TIMELINE_REVISION_CONFLICT"
  );

  assert.deepEqual(history.undo, beforeUndo);
  assert.deepEqual(history.redo, beforeRedo);
  assert.equal(current.name, "Current");
});

test("empty history is a no-op and does not call persistence", async () => {
  const current = timeline("Current");
  const history = { undo: [], redo: [] };
  let persisted = false;
  const result = await applyTimelineHistory(current, history, "undo", async () => {
    persisted = true;
  });

  assert.equal(result, current);
  assert.equal(persisted, false);
});
