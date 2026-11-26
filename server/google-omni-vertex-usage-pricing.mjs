const MODEL = "gemini-omni-1.2-flash";
const PRICING_SOURCE = "https://cloud.google.com/model-garden/pricing";
const INPUT_USD_PER_MILLION = 1.50;
const TEXT_OUTPUT_USD_PER_MILLION = 9.00;
const VIDEO_OUTPUT_USD_PER_MILLION = 12.00;
const MAX_INPUT_TOKENS = 131_072;
const MAX_OUTPUT_TOKENS = 260_640;
const CUSTOMER_CREDITS_PER_USD = 100;

function fail(message, code = "GOOGLE_OMNI_VERTEX_PRICE_INPUT_INVALID") {
  return Object.assign(new Error(message), { code });
}
function money(value) { return Math.round(value * 1_000_000) / 1_000_000; }
function credits(amount) { return Math.ceil(amount * CUSTOMER_CREDITS_PER_USD - 1e-9); }

/** Maximum model input and 4K/15-second output reservation, never a customer charge. */
export function estimateGoogleOmniVertexVideoCost({ model = MODEL } = {}) {
  if (model !== MODEL) throw fail("No verified Vertex price is configured for this model.", "VIDEO_PRICE_UNVERIFIED");
  const maxInputCost = MAX_INPUT_TOKENS * INPUT_USD_PER_MILLION / 1_000_000;
  const maxOutputCost = MAX_OUTPUT_TOKENS * VIDEO_OUTPUT_USD_PER_MILLION / 1_000_000;
  const amount = money(maxInputCost + maxOutputCost);
  return Object.freeze({
    provider: "google", model: MODEL, currency: "USD", amount,
    estimatedCredits: credits(amount), customerCreditsPerUsd: CUSTOMER_CREDITS_PER_USD,
    basis: "maximum_model_input_and_4k_15_second_video_output_reservation",
    maxInputTokens: MAX_INPUT_TOKENS, maxOutputTokens: MAX_OUTPUT_TOKENS,
    inputUsdPerMillionTokens: INPUT_USD_PER_MILLION,
    textOutputUsdPerMillionTokens: TEXT_OUTPUT_USD_PER_MILLION,
    videoOutputUsdPerMillionTokens: VIDEO_OUTPUT_USD_PER_MILLION,
    pricingSource: PRICING_SOURCE, pricingDate: "2026-11-05",
    billable: false, settlementEligible: false
  });
}

/** Reconcile authoritative per-interaction usage; never infer cost from duration alone. */
export function resolveGoogleOmniVertexActualCost({ task, providerTaskId } = {}) {
  if (typeof providerTaskId !== "string" || !/^v1_[A-Za-z0-9_-]{6,200}$/.test(providerTaskId)) {
    throw fail("Vertex usage reconciliation requires a valid interaction ID.", "GOOGLE_OMNI_VERTEX_USAGE_EVIDENCE_INVALID");
  }
  const usage = task?.rawInteraction?.usage;
  const inputTokens = usage?.total_input_tokens;
  const outputTokens = usage?.total_output_tokens;
  const outputBreakdown = usage?.output_tokens_by_modality;
  const thoughtTokens = usage?.total_thought_tokens ?? 0;
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || inputTokens > MAX_INPUT_TOKENS ||
      !Number.isSafeInteger(outputTokens) || outputTokens < 0 || outputTokens > MAX_OUTPUT_TOKENS ||
      !Number.isSafeInteger(thoughtTokens) || thoughtTokens < 0 || outputTokens + thoughtTokens > MAX_OUTPUT_TOKENS ||
      !Array.isArray(outputBreakdown) || outputBreakdown.length < 1 || outputBreakdown.length > 8) {
    throw fail("Vertex did not return bounded token usage with output modality breakdown.", "GOOGLE_OMNI_VERTEX_USAGE_EVIDENCE_MISSING");
  }

  const inputBreakdown = usage.input_tokens_by_modality;
  if (inputBreakdown !== undefined) {
    if (!Array.isArray(inputBreakdown) || inputBreakdown.length > 8) {
      throw fail("Vertex input modality usage is malformed.", "GOOGLE_OMNI_VERTEX_USAGE_EVIDENCE_MISSING");
    }
    const inputSeen = new Set();
    let inputSum = 0;
    for (const item of inputBreakdown) {
      if (!item || typeof item !== "object" || Array.isArray(item) ||
          !["text", "image", "video", "audio"].includes(item.modality) ||
          !Number.isSafeInteger(item.tokens) || item.tokens < 0 || inputSeen.has(item.modality)) {
        throw fail("Vertex input modality usage is malformed.", "GOOGLE_OMNI_VERTEX_USAGE_EVIDENCE_MISSING");
      }
      inputSeen.add(item.modality);
      inputSum += item.tokens;
    }
    if (inputSum !== inputTokens) {
      throw fail("Vertex input modality totals do not reconcile to total_input_tokens.", "GOOGLE_OMNI_VERTEX_USAGE_EVIDENCE_MISSING");
    }
  }

  let textOutputTokens = 0;
  let videoOutputTokens = 0;
  const seen = new Set();
  for (const item of outputBreakdown) {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        !["text", "video"].includes(item.modality) ||
        !Number.isSafeInteger(item.tokens) || item.tokens < 0 || seen.has(item.modality)) {
      throw fail("Vertex output modality usage is malformed or includes an unpriced modality.", "GOOGLE_OMNI_VERTEX_USAGE_EVIDENCE_MISSING");
    }
    seen.add(item.modality);
    if (item.modality === "text") textOutputTokens = item.tokens;
    if (item.modality === "video") videoOutputTokens = item.tokens;
  }
  if (textOutputTokens + videoOutputTokens !== outputTokens) {
    throw fail("Vertex output modality totals do not reconcile to total_output_tokens.", "GOOGLE_OMNI_VERTEX_USAGE_EVIDENCE_MISSING");
  }

  const billableTextOutputTokens = textOutputTokens + thoughtTokens;
  const halfMicroDollars = BigInt(inputTokens) * 3n +
    BigInt(billableTextOutputTokens) * 18n + BigInt(videoOutputTokens) * 24n;
  const amount = Number((halfMicroDollars + 1n) / 2n) / 1_000_000;
  return Object.freeze({
    amount, actualCredits: credits(amount), customerCreditsPerUsd: CUSTOMER_CREDITS_PER_USD,
    currency: "USD",
    evidenceReference: "google-vertex-interaction-usage:" + providerTaskId +
      ":input=" + inputTokens + ":text=" + textOutputTokens + ":video=" + videoOutputTokens,
    inputTokens, outputTokens, textOutputTokens, thoughtTokens,
    billableTextOutputTokens, videoOutputTokens,
    inputAmount: money(inputTokens * INPUT_USD_PER_MILLION / 1_000_000),
    textOutputAmount: money(billableTextOutputTokens * TEXT_OUTPUT_USD_PER_MILLION / 1_000_000),
    videoOutputAmount: money(videoOutputTokens * VIDEO_OUTPUT_USD_PER_MILLION / 1_000_000),
    pricingSource: PRICING_SOURCE
  });
}
