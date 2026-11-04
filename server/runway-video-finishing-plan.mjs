import { estimateRunwayVideoCredits } from "./runway-video-pricing.mjs";

const ORDER = Object.freeze({ upscale: 1, frame_rate: 2, hdr: 3 });
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (message, code = "RUNWAY_FINISHING_PLAN_INVALID") => Object.assign(new Error(message), { code });

function positive(value, label, max) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > max) {
    throw fail(label + " must be a positive finite number no greater than " + max + ".");
  }
  return value;
}
function dimension(value, label) {
  if (!Number.isSafeInteger(value) || value < 16 || value > 8192) {
    throw fail(label + " must be an integer between 16 and 8192.");
  }
  return value;
}

/**
 * Build an estimate-only Runway finishing plan.
 * No credentials, uploads, provider calls, reservations or executions occur here.
 *
 * Cost-aware order: upscale at source FPS, retime, then HDR.
 * The caller must pass the resulting plan to the separately approved durable pipeline.
 */
export function createRunwayVideoFinishingPlan({
  pipelineId, sourceAsset, sourceMetadata, operations, pricingDate
} = {}) {
  if (typeof pipelineId !== "string" || !pipelineId.trim() || pipelineId.length > 160) {
    throw fail("A bounded pipelineId is required.");
  }
  if (!plain(sourceAsset) || typeof sourceAsset.id !== "string" || !sourceAsset.id.trim() ||
      typeof sourceAsset.mediaType !== "string" || !sourceAsset.mediaType.startsWith("video/") ||
      !/^[a-f0-9]{64}$/i.test(sourceAsset.sha256 || "")) {
    throw fail("sourceAsset requires an ID, video media type and SHA-256.");
  }
  if (!plain(sourceMetadata)) throw fail("Verified source media metadata is required.");
  const durationSeconds = positive(sourceMetadata.durationSeconds, "durationSeconds", 300);
  const frameRate = positive(sourceMetadata.frameRate, "frameRate", 240);
  const width = dimension(sourceMetadata.width, "source width");
  const height = dimension(sourceMetadata.height, "source height");
  if (!["sdr", "hdr"].includes(sourceMetadata.dynamicRange)) {
    throw fail("dynamicRange must be verified as sdr or hdr.");
  }
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > 3) {
    throw fail("Choose between one and three supported finishing operations.");
  }
  const parsedPricingDate = typeof pricingDate === "string" && /^20[0-9]{2}-[0-9]{2}-[0-9]{2}$/.test(pricingDate)
    ? new Date(pricingDate + "T00:00:00Z") : null;
  if (!parsedPricingDate || Number.isNaN(parsedPricingDate.getTime()) ||
      parsedPricingDate.toISOString().slice(0, 10) !== pricingDate) {
    throw fail("An explicit valid YYYY-MM-DD pricingDate is required.");
  }

  const seen = new Set();
  let previousOrder = 0;
  const steps = operations.map((operation, index) => {
    if (!plain(operation) || !Object.hasOwn(ORDER, operation.kind) || seen.has(operation.kind)) {
      throw fail("Each finishing operation must be unique and supported.");
    }
    const order = ORDER[operation.kind];
    if (order <= previousOrder) {
      throw fail("Finishing order must be upscale, frame-rate conversion, then HDR.");
    }
    previousOrder = order;
    seen.add(operation.kind);

    let model, capability, adapter, stepKind, estimate, config;
    if (operation.kind === "upscale") {
      if (durationSeconds > 30) throw fail("Magnific video upscaling accepts source clips up to 30 seconds.");
      const resolution = operation.resolution;
      if (!["720p", "1k", "2k", "4k"].includes(resolution)) throw fail("Upscale resolution must be 720p, 1k, 2k or 4k.");
      const outputFrames = Math.ceil(durationSeconds * frameRate);
      model = "magnific_video_upscaler_creative";
      capability = "video.upscale";
      adapter = "runway.video_upscale";
      stepKind = "upscale";
      estimate = estimateRunwayVideoCredits({ model, durationSeconds, outputFrames, resolution, pricingDate });
      config = { model, resolution, outputFrames, sourceFrameRate: frameRate, fpsBoost: false };
    } else if (operation.kind === "frame_rate") {
      const targetFramerate = operation.targetFramerate;
      model = "enhance_frame_rate";
      capability = "video.frame_rate";
      adapter = "runway.enhance_frame_rate";
      stepKind = "frame_rate";
      estimate = estimateRunwayVideoCredits({ model, durationSeconds, inputVideoSeconds: durationSeconds, targetFramerate, pricingDate });
      config = { model, targetFramerate, billingBasis: "input_duration_seconds" };
    } else {
      if (durationSeconds > 30) throw fail("Ruby HDR accepts source clips up to 30 seconds.");
      if (sourceMetadata.dynamicRange !== "sdr") throw fail("Ruby HDR requires a verified SDR source.");
      if (seen.has("upscale") &&
          (operation.expectedInputWidth == null || operation.expectedInputHeight == null)) {
        throw fail("Expected post-upscale HDR input dimensions are required for an accurate Ruby estimate.");
      }
      const sourceWidth = dimension(operation.expectedInputWidth ?? width, "HDR source width");
      const sourceHeight = dimension(operation.expectedInputHeight ?? height, "HDR source height");
      const outputFormat = operation.outputFormat ?? "hdr10";
      model = "ruby";
      capability = "video.hdr";
      adapter = "runway.video_to_hdr";
      stepKind = "hdr";
      estimate = estimateRunwayVideoCredits({
        model, durationSeconds, sourceWidth, sourceHeight,
        sourceDynamicRange: "sdr", outputFormat, pricingDate
      });
      config = { model, outputFormat, sourceWidth, sourceHeight, sourceDynamicRange: "sdr" };
    }

    return Object.freeze({
      id: operation.kind + "-" + (index + 1),
      kind: stepKind,
      adapter,
      capability,
      remote: true,
      estimatedCostMicros: Math.round(estimate.estimatedCredits * 10000),
      config: Object.freeze({
        ...config,
        estimatedCredits: estimate.estimatedCredits,
        estimatedUsd: estimate.estimatedUsd,
        pricingDate: estimate.pricingDate,
        pricingSource: estimate.source
      })
    });
  });

  const totalCredits = steps.reduce((sum, step) => sum + step.config.estimatedCredits, 0);
  return Object.freeze({
    pipelineId,
    sourceAsset: Object.freeze({ ...sourceAsset, sha256: sourceAsset.sha256.toLowerCase() }),
    steps: Object.freeze(steps),
    pricingDate,
    totalEstimatedCredits: totalCredits,
    totalEstimatedCostMicros: Math.round(totalCredits * 10000),
    totalEstimatedUsd: Number((totalCredits * 0.01).toFixed(4)),
    executionEnabled: false,
    approvalRequired: true
  });
}
