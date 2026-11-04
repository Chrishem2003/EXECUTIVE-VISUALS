import test from "node:test";
import assert from "node:assert/strict";
import { createRunwayVideoFinishingPlan } from "../runway-video-finishing-plan.mjs";

const sourceAsset = { id: "source-asset-1", mediaType: "video/mp4", sha256: "A".repeat(64) };
const sourceMetadata = { durationSeconds: 10, frameRate: 30, width: 1920, height: 1080, dynamicRange: "sdr" };
const pricingDate = "2026-11-04";

test("builds an estimate-only upscaling, retiming and HDR plan in cost-aware order", () => {
  const plan = createRunwayVideoFinishingPlan({
    pipelineId: "finishing-plan-1",
    sourceAsset,
    sourceMetadata,
    pricingDate,
    operations: [
      { kind: "upscale", resolution: "4k" },
      { kind: "frame_rate", targetFramerate: 60 },
      { kind: "hdr", outputFormat: "hdr10", expectedInputWidth: 4096, expectedInputHeight: 2304 }
    ]
  });
  assert.deepEqual(plan.steps.map(step => step.kind), ["upscale", "frame_rate", "hdr"]);
  assert.deepEqual(plan.steps.map(step => step.config.estimatedCredits), [360, 5, 400]);
  assert.equal(plan.totalEstimatedCredits, 765);
  assert.equal(plan.totalEstimatedUsd, 7.65);
  assert.equal(plan.totalEstimatedCostMicros, 7650000);
  assert.equal(plan.executionEnabled, false);
  assert.equal(plan.approvalRequired, true);
  assert.equal(plan.sourceAsset.sha256, "a".repeat(64));
  assert.ok(plan.steps.every(step => step.remote && Number.isSafeInteger(step.estimatedCostMicros)));
});

test("uses source frame rate for upscaler frame billing and does not apply fps boost", () => {
  const plan = createRunwayVideoFinishingPlan({
    pipelineId: "upscale-only",
    sourceAsset,
    sourceMetadata,
    pricingDate,
    operations: [{ kind: "upscale", resolution: "2k" }]
  });
  assert.equal(plan.steps[0].config.outputFrames, 300);
  assert.equal(plan.steps[0].config.sourceFrameRate, 30);
  assert.equal(plan.steps[0].config.fpsBoost, false);
  assert.equal(plan.totalEstimatedCredits, 270);
});

test("requires source HDR metadata and exact output dimensions for Ruby cost tier", () => {
  assert.throws(() => createRunwayVideoFinishingPlan({
    pipelineId: "bad-hdr", sourceAsset,
    sourceMetadata: { ...sourceMetadata, dynamicRange: "hdr" },
    pricingDate, operations: [{ kind: "hdr" }]
  }), error => error.code === "RUNWAY_FINISHING_PLAN_INVALID");
  assert.throws(() => createRunwayVideoFinishingPlan({
    pipelineId: "missing-hdr-dims", sourceAsset, sourceMetadata,
    pricingDate, operations: [{ kind: "upscale", resolution: "4k" }, { kind: "hdr" }]
  }), error => error.code === "RUNWAY_FINISHING_PLAN_INVALID");
});

test("rejects non-canonical operation order, duplicate operations and unsupported frame rates", () => {
  const base = { pipelineId: "invalid", sourceAsset, sourceMetadata, pricingDate };
  assert.throws(() => createRunwayVideoFinishingPlan({
    ...base, operations: [{ kind: "hdr" }, { kind: "upscale", resolution: "4k" }]
  }), /upscale, frame-rate conversion, then HDR/);
  assert.throws(() => createRunwayVideoFinishingPlan({
    ...base, operations: [{ kind: "upscale", resolution: "2k" }, { kind: "upscale", resolution: "4k" }]
  }), /unique and supported/);
  assert.throws(() => createRunwayVideoFinishingPlan({
    ...base, operations: [{ kind: "frame_rate", targetFramerate: 15 }]
  }), error => error.code === "RUNWAY_PRICE_INPUT_REQUIRED");
});

test("enforces provider source duration limits and verified input metadata", () => {
  assert.throws(() => createRunwayVideoFinishingPlan({
    pipelineId: "too-long", sourceAsset,
    sourceMetadata: { ...sourceMetadata, durationSeconds: 31 },
    pricingDate, operations: [{ kind: "upscale", resolution: "4k" }]
  }), /up to 30 seconds/);
  assert.throws(() => createRunwayVideoFinishingPlan({
    pipelineId: "missing-fps", sourceAsset,
    sourceMetadata: { ...sourceMetadata, frameRate: undefined },
    pricingDate, operations: [{ kind: "upscale", resolution: "4k" }]
  }), /frameRate/);
});
