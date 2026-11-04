const MODEL = "gemini-omni-1.1-flash";
const PRICING_SOURCE = "https://ai.google.dev/gemini-api/docs/pricing";
const INPUT_USD_PER_MILLION = 1.50;
const VIDEO_OUTPUT_USD_PER_MILLION = 17.50;
const VIDEO_OUTPUT_TOKENS_PER_SECOND_720P = 5792;
const MAX_CONTEXT_TOKENS = 1_048_576;
const MAX_OUTPUT_SECONDS = 10;

function fail(message, code = "GOOGLE_OMNI_PRICE_INPUT_INVALID") {
  return Object.assign(new Error(message), { code });
}
function money(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}
function usageMoney(inputTokens, outputTokens) {
  const microsNumerator = BigInt(inputTokens) * 3n + BigInt(outputTokens) * 35n;
  return Number((microsNumerator + 1n) / 2n) / 1_000_000;
}

/**
 * Conservative preflight reservation for Gemini Omni Flash.
 * The public Gemini API exposes 720p video-token pricing but does not let
 * callers set a deterministic output duration. Reserve the full 10-second
 * output and full context window; actual usage is reconciled from provider
 * interaction usage metadata after completion.
 */
export function estimateGoogleOmniVideoCost({
  model = MODEL,
  resolution = "720p",
  durationSeconds = 5
} = {}) {
  if (model !== MODEL) throw fail("No verified Google video price is configured for this model.", "VIDEO_PRICE_UNVERIFIED");
  if (!["720p", "provider_default"].includes(resolution)) {
    throw fail("Google Omni's verified token-based price snapshot currently supports 720p only.", "VIDEO_PRICE_UNSUPPORTED_RESOLUTION");
  }
  if (!Number.isInteger(durationSeconds) || durationSeconds < 3 || durationSeconds > MAX_OUTPUT_SECONDS) {
    throw fail("Gemini Omni output duration must be between 3 and 10 seconds.", "VIDEO_PRICE_DURATION_INVALID");
  }
  const maxInputCost = MAX_CONTEXT_TOKENS * INPUT_USD_PER_MILLION / 1_000_000;
  const maxOutputTokens = VIDEO_OUTPUT_TOKENS_PER_SECOND_720P * MAX_OUTPUT_SECONDS;
  const maxOutputCost = maxOutputTokens * VIDEO_OUTPUT_USD_PER_MILLION / 1_000_000;
  const amount = usageMoney(MAX_CONTEXT_TOKENS, maxOutputTokens);
  return Object.freeze({
    provider: "google",
    model: MODEL,
    currency: "USD",
    amount,
    basis: "maximum_context_and_10_second_720p_output_reservation",
    maxInputTokens: MAX_CONTEXT_TOKENS,
    maxOutputTokens,
    maxOutputSeconds: MAX_OUTPUT_SECONDS,
    resolution: "720p",
    inputUsdPerMillionTokens: INPUT_USD_PER_MILLION,
    videoOutputUsdPerMillionTokens: VIDEO_OUTPUT_USD_PER_MILLION,
    outputTokensPerSecond: VIDEO_OUTPUT_TOKENS_PER_SECOND_720P,
    pricingSource: PRICING_SOURCE,
    pricingDate: "2026-11-05",
    billable: false,
    settlementEligible: false
  });
}

/** Actual provider usage reconciliation; never guesses when usage is absent. */
export function resolveGoogleOmniActualCost({ task, providerTaskId } = {}) {
  if (typeof providerTaskId !== "string" || !/^v1_[A-Za-z0-9_-]{6,200}$/.test(providerTaskId)) {
    throw fail("Google usage reconciliation requires a valid interaction ID.", "GOOGLE_OMNI_USAGE_EVIDENCE_INVALID");
  }
  const usage = task?.rawInteraction?.usage;
  const inputTokens = usage?.total_input_tokens;
  const outputTokens = usage?.total_output_tokens;
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 ||
      !Number.isSafeInteger(outputTokens) || outputTokens < 0 ||
      inputTokens > MAX_CONTEXT_TOKENS || outputTokens > 10_000_000) {
    throw fail("Google did not return bounded, authoritative interaction token usage.", "GOOGLE_OMNI_USAGE_EVIDENCE_MISSING");
  }
  const inputCost = inputTokens * INPUT_USD_PER_MILLION / 1_000_000;
  // Video output is priced at the highest applicable Omni output modality.
  // This conservative rate also avoids under-settling if the response includes
  // auxiliary text/thought tokens alongside the video payload.
  const outputCost = outputTokens * VIDEO_OUTPUT_USD_PER_MILLION / 1_000_000;
  const amount = usageMoney(inputTokens, outputTokens);
  return Object.freeze({
    amount,
    currency: "USD",
    evidenceReference: "google-interaction-usage:" + providerTaskId +
      ":input=" + inputTokens + ":output=" + outputTokens,
    inputTokens,
    outputTokens,
    inputAmount: money(inputCost),
    outputAmount: money(outputCost),
    pricingSource: PRICING_SOURCE
  });
}
