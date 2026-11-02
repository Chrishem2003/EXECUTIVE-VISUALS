import assert from "node:assert/strict";
import { createTimelineFromTemplate, getTimelineTemplate, TIMELINE_TEMPLATES } from "../src/core/timeline-templates.ts";
import { validateTimeline } from "../src/core/timeline.ts";

assert.equal(TIMELINE_TEMPLATES.length, 5);
assert.equal(new Set(TIMELINE_TEMPLATES.map(item => item.id)).size, TIMELINE_TEMPLATES.length);
for (const template of TIMELINE_TEMPLATES) {
  const timeline = createTimelineFromTemplate(template.id, "project-test", "timeline-" + template.id);
  assert.equal(timeline.width, template.width);
  assert.equal(timeline.height, template.height);
  assert.equal(timeline.frameRate.numerator, template.frameRate);
  assert.equal(timeline.frameRate.denominator, 1);
  assert.equal(timeline.tracks.length, template.tracks.length);
  assert.equal(timeline.metadata?.templateId, template.id);
  assert.equal(new Set(timeline.tracks.map(track => track.id)).size, timeline.tracks.length);
  assert.ok(timeline.tracks.every(track => track.enabled && !track.locked && track.clips.length === 0));
  assert.equal(validateTimeline(timeline).valid, true);
}
assert.equal(getTimelineTemplate("missing"), undefined);
assert.throws(() => createTimelineFromTemplate("missing", "project-test", "timeline-bad"), /unknown timeline template/i);
console.log("Timeline template checks passed: format metadata, track structure, unique IDs, empty safe defaults and invalid-template rejection.");
