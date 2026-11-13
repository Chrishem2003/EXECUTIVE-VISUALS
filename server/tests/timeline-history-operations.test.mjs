import test from "node:test";
import assert from "node:assert/strict";
import { addClip, addMarker, addTrack, createTimeline, moveClip, rational, splitClip, trimClip } from "../../src/core/timeline.ts";
import {
  applyTimelineHistoryOperation,
  createTimelineHistory,
  createTimelineHistoryOperation,
  recordTimelineHistory,
  redoTimelineHistory,
  undoTimelineHistory
} from "../../src/core/timeline-history-operations.ts";

const clip = (id = "clip-a", start = 0, duration = 48) => ({
  id, assetId: "asset-" + id, name: "Shot " + id,
  sourceRange: { start: rational(0, 24), duration: rational(duration, 24) },
  timelineStart: rational(start, 24), duration: rational(duration, 24), enabled: true
});
function fixture() {
  let timeline = createTimeline("project-1", "timeline-1", "History test");
  timeline = addTrack(timeline, { id: "video-1", name: "Video 1", kind: "video", enabled: true, locked: false, clips: [] });
  timeline = addTrack(timeline, { id: "audio-1", name: "Audio 1", kind: "audio", enabled: true, locked: false, clips: [] });
  timeline = addClip(timeline, "video-1", clip());
  return timeline;
}
const operation = (before, after, label = "Edit clip") =>
  createTimelineHistoryOperation(before, after, { label, id: "operation-1", createdAt: "2026-11-05T00:00:00.000Z" });

test("split is stored as an entity-level reversible operation, not a timeline snapshot", () => {
  const before = fixture();
  const after = splitClip(before, "video-1", "clip-a", 24, "clip-b");
  const op = operation(before, after, "Split clip");
  assert.ok(op);
  assert.equal(op.changes.length, 2);
  assert.ok(op.changes.every(change => change.entity === "clip"));
  const applied = applyTimelineHistoryOperation(before, op);
  assert.deepEqual(applied.tracks[0].clips.map(item => item.id), after.tracks[0].clips.map(item => item.id));
  assert.equal(applied.revision, before.revision + 1);
});

test("undo and redo restore split clips while retaining monotonic local revisions", () => {
  const before = fixture();
  const after = splitClip(before, "video-1", "clip-a", 24, "clip-b");
  const op = operation(before, after, "Split clip");
  let history = recordTimelineHistory(createTimelineHistory(), op);
  const applied = applyTimelineHistoryOperation(before, op);
  const undone = undoTimelineHistory(history, applied);
  assert.equal(undone.timeline.tracks[0].clips.length, 1);
  assert.equal(undone.timeline.tracks[0].clips[0].id, "clip-a");
  assert.equal(undone.timeline.revision, applied.revision + 1);
  history = undone.history;
  const redone = redoTimelineHistory(history, undone.timeline);
  assert.deepEqual(redone.timeline.tracks[0].clips.map(item => item.id), ["clip-a", "clip-b"]);
  assert.equal(redone.timeline.revision, undone.timeline.revision + 1);
});

test("move across tracks, trim and marker creation can be independently reversed", () => {
  const before = fixture();
  const moved = moveClip(before, "video-1", "clip-a", "audio-1", 72);
  const moveOp = operation(before, moved, "Move clip");
  const movedApplied = applyTimelineHistoryOperation(before, moveOp);
  assert.equal(movedApplied.tracks[1].clips[0].id, "clip-a");
  const movedBack = applyTimelineHistoryOperation(movedApplied, moveOp, "undo");
  assert.equal(movedBack.tracks[0].clips[0].id, "clip-a");

  const trimmed = trimClip(before, "video-1", "clip-a", 6, 6);
  const trimOp = operation(before, trimmed, "Trim clip");
  const trimmedApplied = applyTimelineHistoryOperation(before, trimOp);
  const trimmedBack = applyTimelineHistoryOperation(trimmedApplied, trimOp, "undo");
  assert.deepEqual(trimmedBack.tracks[0].clips[0], before.tracks[0].clips[0]);

  const marked = addMarker(before, { id: "marker-1", name: "Hook", start: rational(24, 24), color: "YELLOW" });
  const markerOp = operation(before, marked, "Add marker");
  assert.equal(applyTimelineHistoryOperation(before, markerOp).markers.length, 1);
  assert.equal(applyTimelineHistoryOperation(marked, markerOp, "undo").markers.length, 0);
});

test("adding a track and clips together restores track order through undo and redo", () => {
  const before = fixture();
  let after = addTrack(before, { id: "video-2", name: "Video 2", kind: "video", enabled: true, locked: false, clips: [] });
  after = addClip(after, "video-2", clip("clip-b", 0, 24));
  const op = operation(before, after, "Add track and clip");
  const applied = applyTimelineHistoryOperation(before, op);
  assert.deepEqual(applied.tracks.map(track => track.id), ["video-1", "audio-1", "video-2"]);
  assert.equal(applied.tracks[2].clips.length, 1);
  const undone = applyTimelineHistoryOperation(applied, op, "undo");
  assert.deepEqual(undone.tracks.map(track => track.id), ["video-1", "audio-1"]);
  const redone = applyTimelineHistoryOperation(undone, op);
  assert.deepEqual(redone.tracks.map(track => track.id), ["video-1", "audio-1", "video-2"]);
});

test("track removal is reversed with its clips and original ordering intact", () => {
  const before = fixture();
  const after = { ...before, tracks: before.tracks.filter(track => track.id !== "video-1") };
  const op = operation(before, after, "Remove track");
  const applied = applyTimelineHistoryOperation(before, op);
  assert.deepEqual(applied.tracks.map(track => track.id), ["audio-1"]);
  const undone = applyTimelineHistoryOperation(applied, op, "undo");
  assert.deepEqual(undone.tracks.map(track => track.id), ["video-1", "audio-1"]);
  assert.equal(undone.tracks[0].clips[0].id, "clip-a");
});

test("stale entity state fails closed instead of overwriting a newer edit", () => {
  const before = fixture();
  const after = trimClip(before, "video-1", "clip-a", 6, 6);
  const op = operation(before, after);
  const changed = { ...before, tracks: before.tracks.map(track => track.id === "video-1"
    ? { ...track, clips: track.clips.map(item => ({ ...item, name: "Changed elsewhere" })) } : track) };
  assert.throws(() => applyTimelineHistoryOperation(changed, op), /history conflict/);
});

test("invalid operations and invalid target timelines are rejected", () => {
  const before = fixture();
  const invalid = { ...before, tracks: before.tracks.map(track => track.id === "video-1"
    ? { ...track, clips: track.clips.map(item => ({ ...item, duration: rational(0, 24) })) } : track) };
  assert.throws(() => createTimelineHistoryOperation(before, invalid, { label: "Invalid" }), /invalid|positive/i);
  assert.throws(() => applyTimelineHistoryOperation(before, { schemaVersion: 1, id: "bad", label: "bad", origin: "local", createdAt: "", baseRevision: 1, changes: [] }), /invalid/);
});

test("history is bounded and a new local edit clears redo", () => {
  const before = fixture();
  let history = createTimelineHistory(2);
  for (let index = 0; index < 3; index++) {
    const prior = { ...before, name: "Sequence " + index };
    const next = { ...prior, name: "Sequence " + (index + 1), revision: prior.revision + 1 };
    const op = operation(prior, next, "Rename");
    history = recordTimelineHistory(history, op);
  }
  assert.equal(history.undo.length, 2);
  assert.deepEqual(history.redo, []);
});

test("remote operations can be applied without entering the local undo stack", () => {
  const before = fixture();
  const after = trimClip(before, "video-1", "clip-a", 3, 3);
  const op = createTimelineHistoryOperation(before, after, { label: "Remote trim", origin: "remote" });
  const history = recordTimelineHistory(createTimelineHistory(), op);
  assert.equal(history.undo.length, 0);
  assert.equal(history.redo.length, 0);
});
