const PRICING = Object.freeze({
  runway: Object.freeze({
    "gen4.5": Object.freeze({
      creditsPerSecond: 12,
      usdPerCredit: 0.01,
      minDurationSeconds: 2,
      maxDurationSeconds: 10,
      outputFormat: "mp4",
      source: "https://dev.runwayml.com/pricing"
    })
  })
});

/**
 * Deterministic preflight estimate for the currently implemented Runway model.
 * This is a conservative provider-priced estimate, not a per-task invoice.
 */
export function estimateVideoGenerationCost({
  provider,
  model,
  durationSeconds,
  outputFormat = "mp4"
} = {}) {
  const pricing = PRICING[provider]?.[model];
  if (!pricing) {
    const error = new Error("No verified video price is configured for this provider/model.");
    error.code = "VIDEO_PRICE_UNVERIFIED";
    throw error;
  }
  if (!Number.isInteger(durationSeconds) ||
      durationSeconds < pricing.minDurationSeconds ||
      durationSeconds > pricing.maxDurationSeconds) {
    const error = new Error("Video duration is outside the verified pricing bounds.");
    error.code = "VIDEO_PRICE_DURATION_INVALID";
    throw error;
  }
  if (outputFormat !== pricing.outputFormat) {
    const error = new Error("The verified estimate currently covers MP4 output only.");
    error.code = "VIDEO_PRICE_OUTPUT_FORMAT_UNSUPPORTED";
    throw error;
  }
  const credits = durationSeconds * pricing.creditsPerSecond;
  const amount = Number((credits * pricing.usdPerCredit).toFixed(6));
  return Object.freeze({
    provider,
    model,
    durationSeconds,
    outputFormat,
    credits,
    currency: "USD",
    amount,
    basis: "provider_list_price_estimate",
    creditsPerSecond: pricing.creditsPerSecond,
    usdPerCredit: pricing.usdPerCredit,
    pricingSource: pricing.source
  });
}
