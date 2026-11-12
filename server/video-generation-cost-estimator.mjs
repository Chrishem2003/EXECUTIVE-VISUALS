import { estimateRunwayVideoCredits } from "./runway-video-pricing.mjs";
import { estimateLumaRay32Cost } from "./luma-video-pricing.mjs";
import { estimateGoogleOmniVideoCost } from "./google-omni-pricing.mjs";

const RUNWAY_PRICING_SOURCE = "https://docs.dev.runwayml.com/guides/pricing/";

function priceError(message, code = "VIDEO_PRICE_INPUT_INVALID") {
  return Object.assign(new Error(message), { code });
}

/**
 * Shared preflight estimator used by the cloud budget reservation boundary.
 * Estimates are provider-dated snapshots, never invoices or settlement evidence.
 * Only providers with an explicitly verified pricing contract are accepted.
 */
export function estimateVideoGenerationCost({
  provider, model, operation = "video", durationSeconds, outputFormat,
  resolution, audio, inputVideoSeconds, referenceVideoSeconds, referenceImageCount,
  referenceAudioCount, hasStartFrame, outputFrames, sourceWidth, sourceHeight,
  sourceDynamicRange, outputWidth, outputHeight, targetFramerate, inputType,
  hdr = false, exrExport = false
} = {}) {
  const pricingDate = new Date().toISOString().slice(0, 10);

  if (provider === "google") {
    const estimate = estimateGoogleOmniVideoCost({ model, resolution, durationSeconds });
    return Object.freeze({
      provider, model, operation, durationSeconds,
      resolution: estimate.resolution,
      currency: estimate.currency,
      amount: estimate.amount,
      basis: estimate.basis,
      maxInputTokens: estimate.maxInputTokens,
      maxOutputTokens: estimate.maxOutputTokens,
      maxOutputSeconds: estimate.maxOutputSeconds,
      inputUsdPerMillionTokens: estimate.inputUsdPerMillionTokens,
      videoOutputUsdPerMillionTokens: estimate.videoOutputUsdPerMillionTokens,
      outputTokensPerSecond: estimate.outputTokensPerSecond,
      pricingSource: estimate.pricingSource,
      pricingDate: estimate.pricingDate,
      billable: false,
      settlementEligible: false
    });
  }

  if (provider === "luma") {
    if (model !== "ray-3.2") {
      throw priceError("No verified Luma price is configured for this provider/model.", "VIDEO_PRICE_UNVERIFIED");
    }
    const estimate = estimateLumaRay32Cost({
      operation, resolution, durationSeconds, hdr, exrExport, pricingDate
    });
    return Object.freeze({
      provider, model, operation, durationSeconds,
      resolution: estimate.resolution,
      credits: estimate.credits,
      currency: estimate.currency,
      amount: estimate.amount,
      basis: estimate.basis,
      creditToUsdRate: estimate.creditToUsdRate,
      monetaryEstimateScope: estimate.monetaryEstimateScope,
      pricingSource: estimate.pricingSource,
      usageSource: estimate.usageSource,
      pricingDate: estimate.pricingDate,
      pricingFormula: estimate.pricingFormula,
      pricingStatus: estimate.pricingStatus,
      billable: false,
      settlementEligible: false
    });
  }

  if (provider !== "runway") {
    throw priceError("No verified video price is configured for this provider/model.", "VIDEO_PRICE_UNVERIFIED");
  }

  const effectiveOutputFormat = outputFormat ?? (model === "ruby" ? "hdr10" : "mp4");
  let estimate;
  try {
    estimate = estimateRunwayVideoCredits({
      model, durationSeconds, outputFormat, resolution, audio, inputVideoSeconds,
      referenceVideoSeconds, referenceImageCount, referenceAudioCount, hasStartFrame,
      outputFrames, sourceWidth, sourceHeight, sourceDynamicRange, outputWidth,
      outputHeight, targetFramerate, inputType, pricingDate
    });
  } catch (error) {
    const durationInvalid = error?.message?.startsWith("durationSeconds");
    const mapped = Object.assign(new Error(durationInvalid ? "Video duration is outside the verified pricing bounds." : error?.message || "Runway pricing estimate failed."), {
      code: error?.code === "RUNWAY_PRICE_UNSUPPORTED_MODEL" ? "VIDEO_PRICE_UNVERIFIED" :
        error?.code === "RUNWAY_PRICE_INPUT_REQUIRED" ? "VIDEO_PRICE_INPUT_REQUIRED" :
        error?.code === "RUNWAY_PRICE_UNSUPPORTED_OPTION" ? "VIDEO_PRICE_UNSUPPORTED_OPTION" :
        error?.code === "RUNWAY_PRICE_INVALID_RESULT" ? "VIDEO_PRICE_INVALID_RESULT" :
        durationInvalid ? "VIDEO_PRICE_DURATION_INVALID" : "VIDEO_PRICE_INPUT_INVALID"
    });
    throw mapped;
  }
  return Object.freeze({
    provider, model, durationSeconds, outputFormat: effectiveOutputFormat,
    credits: estimate.estimatedCredits, currency: estimate.currency,
    amount: Number(estimate.estimatedUsd.toFixed(6)),
    basis: "provider_list_price_estimate",
    pricingSource: RUNWAY_PRICING_SOURCE, pricingDate: estimate.pricingDate,
    pricingFormula: estimate.formula,
    evidenceType: estimate.evidenceType, billable: false, settlementEligible: false
  });
}
