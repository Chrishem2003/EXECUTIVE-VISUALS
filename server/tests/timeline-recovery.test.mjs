import assert from "node:assert/strict";
import test from "node:test";
import {
  assessTimelineRecovery,
  checksumTimeline,
  isTimelineRecoveryDraft,
  timelineRecoveryKey,
  type TimelineRecoveryDraft
} from "../src/core/timeline-recovery.ts";
import { createTimeline, addTrack } from "../src/core/timeline.ts";

function sampleTimeline() {
  return addTrack(createTimeline("project-1", "timeline-1", "Recovery test"), {
    id: "track-1", name: "Video", kind: "video", enabled: true, locked: false, clips: []
  });
}

async function draft(baseRevision = 4): Promise<TimelineRecoveryDraft> {
  const snapshot = sampleTimeline();
  return {
    key: timelineRecoveryKey("cloud", "project-1", snapshot.id),
    projectId: "project-1",
    timelineId: snapshot.id,
    mode: "cloud",
    baseRevision,
    localRevision: snapshot.revision,
    sequence: 1,
    updatedAt: "2026-11-05T00:00:00.000Z",
    reason: "unit test edit",
    checksum: await checksumTimeline(snapshot),
    snapshot
  };
}

test("recovery key isolates mode, project and timeline", () => {
  assert.notEqual(timelineRecoveryKey("local", "p", "t"), timelineRecoveryKey("cloud", "p", "t"));
  assert.notEqual(timelineRecoveryKey("cloud", "p", "t"), timelineRecoveryKey("cloud", "other", "t"));
  assert.throws(() => timelineRecoveryKey("local", "p", ""));
});

test("valid draft based on current server revision is recoverable", async () => {
  const value = await draft(4);
  assert.equal(isTimelineRecoveryDraft(value), true);
  const assessment = await assessTimelineRecovery(value, 4);
  assert.equal(assessment.disposition, "recover");
  assert.equal(assessment.draft?.timelineId, "timeline-1");
});

test("draft based on another server revision is a conflict, not an overwrite", async () => {
  const value = await draft(4);
  const assessment = await assessTimelineRecovery(value, 5);
  assert.equal(assessment.disposition, "conflict");
  assert.equal(assessment.draft, value);
  assert.match(assessment.reason, /Compare them/);
});

test("missing draft is clean", async () => {
  assert.equal((await assessTimelineRecovery(null, 4)).disposition, "clean");
});

test("checksum detects modified recovery snapshot", async () => {
  const value = await draft(4);
  value.snapshot.name = "tampered";
  const assessment = await assessTimelineRecovery(value, 4);
  assert.equal(assessment.disposition, "invalid");
  assert.equal(assessment.draft, null);
});
