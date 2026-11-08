import test from "node:test";
import assert from "node:assert/strict";
import { createRunwayVideoFinishingPlan } from "../runway-video-finishing-plan.mjs";
import { createVideoFinishingPipeline } from "../video-finishing-pipeline.mjs";

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

test("finishing plan plugs into the durable pipeline approval and full-budget gates", async () => {
  const plan = createRunwayVideoFinishingPlan({
    pipelineId: "governed-plan",
    sourceAsset,
    sourceMetadata,
    pricingDate,
    operations: [{ kind: "upscale", resolution: "2k" }, { kind: "frame_rate", targetFramerate: 60 }]
  });
  let executions = 0;
  const checkpoints = new Map();
  const pipeline = createVideoFinishingPipeline({
    resolveAdapter: async adapter => ({
      status: "ready", remote: true,
      capabilities: [adapter.endsWith("video_upscale") ? "video.upscale" : "video.frame_rate"]
    }),
    checkpoints: {
      get: async (pipelineId, stepId) => checkpoints.get(pipelineId + ":" + stepId) ?? null,
      save: async record => checkpoints.set(record.pipelineId + ":" + record.stepId, record)
    },
    executeStep: async ({ step, sourceAsset: input }) => {
      executions++;
      return {
        id: step.id + "-asset",
        mediaType: "video/mp4",
        sha256: String(executions).padStart(64, "0"),
        derivativeOf: input.id
      };
    }
  });
  await assert.rejects(() => pipeline.run(plan), error => error.code === "VIDEO_PIPELINE_APPROVAL_REQUIRED");
  assert.equal(executions, 0);
  const result = await pipeline.run(plan, {
    remoteExecutionApproved: true,
    approvalId: "explicit-approval",
    approvedBudgetMicros: plan.totalEstimatedCostMicros
  });
  assert.equal(result.status, "completed");
  assert.equal(result.steps.length, 2);
  assert.equal(executions, 2);
});

test("accepts canonical pricing dates and rejects impossible or non-canonical dates", () => {
  const base = {
    pipelineId: "pricing-date-check",
    sourceAsset,
    sourceMetadata,
    operations: [{ kind: "upscale", resolution: "2k" }]
  };
  assert.equal(createRunwayVideoFinishingPlan({ ...base, pricingDate: "2026-11-04" }).pricingDate, "2026-11-04");
  for (const pricingDate of ["2026-02-31", "2026-2-03", "26-11-04", "2026/11/04", null]) {
    assert.throws(
      () => createRunwayVideoFinishingPlan({ ...base, pricingDate }),
      error => error.code === "RUNWAY_FINISHING_PLAN_INVALID"
    );
  }
});
