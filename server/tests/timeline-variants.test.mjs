import test from "node:test";
import assert from "node:assert/strict";
import { addClip, addTrack, createTimeline, rational } from "../../src/core/timeline.ts";
import { compareTimelineVariants, createTimelineVariant } from "../../src/core/timeline-variants.ts";

function fixture() {
  let timeline = createTimeline("project", "base", "Original", { numerator: 24, denominator: 1 });
  timeline = addTrack(timeline, { id: "video", name: "Video 1", kind: "video", enabled: true, locked: false, clips: [] });
  timeline = addClip(timeline, "video", {
    id: "clip-a", assetId: "asset-a", name: "Opening", sourceRange: { start: rational(0, 24), duration: rational(48, 24) },
    timelineStart: rational(0, 24), duration: rational(48, 24), enabled: true,
    metadata: { creativeTrace: { storyBeat: "Hook", purpose: "Establish the question" } },
  });
  return timeline;
}

test("variant is a deep, independent copy with explicit lineage and a fresh revision", () => {
  const original = fixture();
  const variant = createTimelineVariant(original, "variant-a", "Opening — alternate", "2026-11-02T10:00:00.000Z");
  assert.equal(variant.id, "variant-a");
  assert.equal(variant.revision, 1);
  assert.equal(variant.metadata?.variantOf, "base");
  assert.equal(variant.metadata?.variantParentId, "base");
  variant.tracks[0].clips[0].metadata.creativeTrace.purpose = "A different purpose";
  assert.equal(original.tracks[0].clips[0].metadata.creativeTrace.purpose, "Establish the question");
});

test("nested variants retain root lineage and identify their immediate parent", () => {
  const first = createTimelineVariant(fixture(), "variant-a", "A", "2026-11-02T10:00:00.000Z");
  const second = createTimelineVariant(first, "variant-b", "B", "2026-11-02T10:01:00.000Z");
  assert.equal(second.metadata?.variantOf, "base");
  assert.equal(second.metadata?.variantParentId, "variant-a");
});

test("comparison reports clip position, duration, source, and creative-intent changes", () => {
  const base = fixture();
  const candidate = createTimelineVariant(base, "variant-a", "Alternate", "2026-11-02T10:00:00.000Z");
  const clip = candidate.tracks[0].clips[0];
  clip.timelineStart = rational(12, 24);
  clip.duration = rational(36, 24);
  clip.sourceRange = { start: rational(12, 24), duration: rational(36, 24) };
  clip.metadata.creativeTrace.purpose = "Reveal the evidence";
  const report = compareTimelineVariants(base, candidate);
  assert.equal(report.changedClips, 1);
  assert.deepEqual(report.changes[0].fields, ["timeline position", "duration", "source trim", "creative intent"]);
});

test("comparison detects added and removed clips and markers", () => {
  const base = fixture();
  const candidate = createTimelineVariant(base, "variant-a", "Alternate", "2026-11-02T10:00:00.000Z");
  candidate.tracks[0].clips = [];
  candidate.markers.push({ id: "marker-new", name: "New hook", start: rational(12, 24) });
  const report = compareTimelineVariants(base, candidate);
  assert.equal(report.removedClips, 1);
  assert.equal(report.addedMarkers, 1);
  assert.match(report.summary, /clip\(s\) removed/);
});

test("variant creation rejects invalid identity, names, dates, and invalid source timelines", () => {
  const base = fixture();
  assert.throws(() => createTimelineVariant(base, "base", "Duplicate"));
  assert.throws(() => createTimelineVariant(base, "variant", " "));
  assert.throws(() => createTimelineVariant(base, "variant", "Valid", "not-a-date"));
  const invalid = { ...base, width: 0 };
  assert.throws(() => createTimelineVariant(invalid, "variant", "Valid"));
});

test("comparison rejects invalid input instead of returning a misleading result", () => {
  const base = fixture();
  assert.throws(() => compareTimelineVariants(base, { ...base, height: 0 }));
});
