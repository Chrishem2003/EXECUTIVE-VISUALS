import test from "node:test";
import assert from "node:assert/strict";
import { addClip, addTrack, createTimeline, rational } from "./timeline.ts";
import { CAMPAIGN_FORMATS, compileCampaignFormatVariants, type CampaignFormatId } from "./campaign-format-compiler.ts";

function source() {
  let timeline = createTimeline("project-a", "timeline-master", "Summer campaign", { numerator: 24, denominator: 1 });
  timeline = addTrack(timeline, { id: "video", name: "Video", kind: "video", enabled: true, locked: false, clips: [] });
  timeline = addClip(timeline, "video", {
    id: "clip-opening",
    assetId: "asset-product",
    name: "Product reveal",
    sourceRange: { start: rational(0, 24), duration: rational(48, 24) },
    timelineStart: rational(0, 24),
    duration: rational(48, 24),
    enabled: true,
    metadata: { creativeTrace: { storyBeat: "Hook" } }
  });
  return timeline;
}

test("compiles four independent campaign canvases with correct dimensions and lineage", () => {
  const original = source();
  const result = compileCampaignFormatVariants({
    sourceTimeline: original,
    createdAt: "2026-11-28T10:00:00.000Z",
    idFactory: format => "variant-" + format
  });
  assert.equal(result.variants.length, 4);
  assert.deepEqual(result.variants.map(item => [item.target.width, item.target.height]), [
    [1920, 1080], [1080, 1920], [1080, 1080], [1080, 1350]
  ]);
  assert.equal(result.manifest.totalVariants, 4);
  assert.equal(result.manifest.totalSourceClips, 1);
  assert.equal(result.manifest.status, "awaiting_reframe_review");
  for (const item of result.variants) {
    assert.equal(item.timeline.metadata?.variantOf, original.id);
    assert.equal(item.timeline.metadata?.variantParentId, original.id);
    assert.equal(item.timeline.tracks[0].clips[0].id, "clip-opening");
    assert.equal(item.reviewRequired, true);
    assert.equal(item.renderReady, false);
    const delivery = item.timeline.metadata?.campaignDelivery as { review: { status: string }; export: { renderReady: boolean } };
    assert.equal(delivery.review.status, "pending");
    assert.equal(delivery.export.renderReady, false);
  }
  assert.equal(original.width, 1920);
  assert.equal(original.height, 1080);
  assert.equal(original.name, "Summer campaign");
});

test("supports selected formats without creating unnecessary variants", () => {
  const result = compileCampaignFormatVariants({
    sourceTimeline: source(),
    formats: ["vertical_9_16", "portrait_4_5"],
    idFactory: (_format, index) => "selected-" + index
  });
  assert.deepEqual(result.variants.map(item => item.formatId), ["vertical_9_16", "portrait_4_5"]);
  assert.equal(result.manifest.totalVariants, 2);
});

test("records conservative safe-area guidance as review metadata", () => {
  const result = compileCampaignFormatVariants({
    sourceTimeline: source(),
    formats: ["vertical_9_16"],
    idFactory: () => "vertical-review"
  });
  const delivery = result.variants[0].timeline.metadata?.campaignDelivery as { safeAreaPercent: object; reframe: { status: string; reason: string } };
  assert.deepEqual(delivery.safeAreaPercent, CAMPAIGN_FORMATS.vertical_9_16.safeArea);
  assert.equal(delivery.reframe.status, "required");
  assert.match(delivery.reframe.reason, /require review/);
});

test("rejects invalid format selections, duplicate IDs, invalid dates and invalid timelines", () => {
  const timeline = source();
  assert.throws(() => compileCampaignFormatVariants({ sourceTimeline: timeline, formats: [] }), /between one and four/);
  assert.throws(() => compileCampaignFormatVariants({ sourceTimeline: timeline, formats: ["vertical_9_16", "vertical_9_16"] }), /unique/);
  assert.throws(() => compileCampaignFormatVariants({ sourceTimeline: timeline, formats: ["unknown" as CampaignFormatId] }), /Unsupported/);
  assert.throws(() => compileCampaignFormatVariants({ sourceTimeline: timeline, createdAt: "not-a-date" }), /valid timestamp/);
  assert.throws(() => compileCampaignFormatVariants({ sourceTimeline: timeline, idFactory: () => "timeline-master" }), /unique/);
  assert.throws(() => compileCampaignFormatVariants({ sourceTimeline: timeline, idFactory: "not-a-function" as never }), /must be a function/);
  assert.throws(() => compileCampaignFormatVariants({ sourceTimeline: { ...timeline, width: 0 } }), /invalid timeline/);
});
