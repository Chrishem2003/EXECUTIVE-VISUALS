const CAPABILITY_BY_OPERATION = Object.freeze({
  text_to_video: "textToVideo",
  image_to_video: "imageToVideo",
  video_to_video: "videoToVideo",
  video_edit: "videoEdit",
  video_extend: "videoExtend",
  video_reframe: "videoReframe"
});
const MODES = new Set(["cost", "latency", "quality"]);
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
const freeze = value => {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
};
const fail = (message, code = "VIDEO_ROUTING_INVALID_INPUT") => Object.assign(new Error(message), { code });
const finitePositive = (value, label) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw fail(label + " must be a positive finite number.");
  return value;
};

/**
 * Deterministic, side-effect-free model selection.
 *
 * Candidates must already carry a dated, verified estimate from the shared
 * pricing estimator and observed quality/latency telemetry where required.
 * This planner never calls a provider, reserves budget, creates a job or
 * enables a disabled model.
 */
export function routeVideoModel({
  candidates,
  requirements = {},
  optimizeFor = "cost",
  maxCostUsd,
  allowModels,
  denyModels = []
} = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) throw fail("At least one routing candidate is required.");
  if (!MODES.has(optimizeFor)) throw fail("optimizeFor must be cost, latency or quality.");
  if (!plain(requirements)) throw fail("requirements must be an object.");
  const capability = CAPABILITY_BY_OPERATION[requirements.operation ?? "text_to_video"];
  if (!capability) throw fail("Unsupported video operation.");
  if (maxCostUsd !== undefined && (typeof maxCostUsd !== "number" || !Number.isFinite(maxCostUsd) || maxCostUsd < 0)) {
    throw fail("maxCostUsd must be a non-negative finite number.");
  }
  const normalizeSet = (value, label) => {
    if (value === undefined) return null;
    if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item.trim())) throw fail(label + " must be an array of non-empty model IDs.");
    return new Set(value);
  };
  const allow = normalizeSet(allowModels, "allowModels");
  const deny = normalizeSet(denyModels, "denyModels") ?? new Set();

  const exclusions = [];
  const eligible = [];
  for (const candidate of candidates) {
    const id = candidate && typeof candidate.providerId === "string" && typeof candidate.modelId === "string"
      ? candidate.providerId + ":" + candidate.modelId : null;
    const exclude = reason => exclusions.push({ modelId: id, reason });
    if (!plain(candidate) || !id) { exclude("invalid_candidate_identity"); continue; }
    if (allow && !allow.has(id)) { exclude("not_allowlisted"); continue; }
    if (deny.has(id)) { exclude("denylisted"); continue; }
    if (candidate.providerAvailability !== "enabled" || candidate.modelAvailability !== "enabled") { exclude("model_disabled"); continue; }
    if (candidate.adapterState !== "ready") { exclude("adapter_not_ready"); continue; }
    if (!plain(candidate.capabilities) || candidate.capabilities[capability] !== true) { exclude("capability_unsupported"); continue; }

    const constraints = plain(candidate.constraints) ? candidate.constraints : {};
    const duration = requirements.durationSeconds;
    if (duration !== undefined) {
      if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) throw fail("durationSeconds must be positive and finite.");
      if (Number.isFinite(constraints.minDurationSeconds) && duration < constraints.minDurationSeconds) { exclude("duration_below_minimum"); continue; }
      if (Number.isFinite(constraints.maxDurationSeconds) && duration > constraints.maxDurationSeconds) { exclude("duration_above_maximum"); continue; }
      if (Array.isArray(constraints.supportedDurationsSeconds) && !constraints.supportedDurationsSeconds.includes(duration)) { exclude("duration_not_supported"); continue; }
    }
    if (requirements.resolution !== undefined &&
        (!Array.isArray(candidate.capabilities.resolutions) || !candidate.capabilities.resolutions.includes(requirements.resolution))) {
      exclude("resolution_unsupported"); continue;
    }
    if (requirements.aspectRatio !== undefined &&
        (!Array.isArray(candidate.capabilities.aspectRatios) || !candidate.capabilities.aspectRatios.includes(requirements.aspectRatio))) {
      exclude("aspect_ratio_unsupported"); continue;
    }
    if (requirements.audio === true && candidate.capabilities.nativeAudio !== true) { exclude("native_audio_unsupported"); continue; }
    if (requirements.audio === false && candidate.capabilities.nativeAudio === true && constraints.audioToggle !== true) { exclude("cannot_disable_native_audio"); continue; }
    if (requirements.seed === true && candidate.capabilities.seed !== true) { exclude("seed_unsupported"); continue; }

    const estimate = candidate.estimate;
    if (!plain(estimate) || estimate.currency !== "USD" ||
        typeof estimate.amount !== "number" || !Number.isFinite(estimate.amount) || estimate.amount < 0 ||
        estimate.billable !== false || estimate.settlementEligible !== false ||
        typeof estimate.pricingDate !== "string" || !/^20[0-9]{2}-[0-9]{2}-[0-9]{2}$/.test(estimate.pricingDate) ||
        typeof estimate.pricingSource !== "string" || !estimate.pricingSource.startsWith("https://")) {
      exclude("pricing_unverified"); continue;
    }
    if (maxCostUsd !== undefined && estimate.amount > maxCostUsd) { exclude("over_budget"); continue; }

    if (optimizeFor === "latency") {
      if (candidate.observedLatencyMs === undefined) { exclude("latency_unmeasured"); continue; }
      finitePositive(candidate.observedLatencyMs, "observedLatencyMs");
    }
    if (optimizeFor === "quality") {
      if (typeof candidate.qualityScore !== "number" || !Number.isFinite(candidate.qualityScore) ||
          candidate.qualityScore < 0 || candidate.qualityScore > 1) { exclude("quality_unmeasured"); continue; }
    }
    eligible.push({ candidate, id, estimate });
  }

  const compare = (a, b) => {
    if (optimizeFor === "cost" && a.estimate.amount !== b.estimate.amount) return a.estimate.amount - b.estimate.amount;
    if (optimizeFor === "latency" && a.candidate.observedLatencyMs !== b.candidate.observedLatencyMs) return a.candidate.observedLatencyMs - b.candidate.observedLatencyMs;
    if (optimizeFor === "quality" && a.candidate.qualityScore !== b.candidate.qualityScore) return b.candidate.qualityScore - a.candidate.qualityScore;
    if (a.estimate.amount !== b.estimate.amount) return a.estimate.amount - b.estimate.amount;
    const latencyA = a.candidate.observedLatencyMs ?? Number.MAX_SAFE_INTEGER;
    const latencyB = b.candidate.observedLatencyMs ?? Number.MAX_SAFE_INTEGER;
    if (latencyA !== latencyB) return latencyA - latencyB;
    return a.id.localeCompare(b.id);
  };
  eligible.sort(compare);
  const winner = eligible[0] ?? null;
  return freeze({
    status: winner ? "selected" : "no_eligible_model",
    optimizeFor,
    selected: winner ? {
      providerId: winner.candidate.providerId,
      modelId: winner.candidate.modelId,
      modelKey: winner.id,
      estimatedCostUsd: winner.estimate.amount,
      pricingDate: winner.estimate.pricingDate,
      pricingSource: winner.estimate.pricingSource,
      observedLatencyMs: winner.candidate.observedLatencyMs ?? null,
      qualityScore: winner.candidate.qualityScore ?? null
    } : null,
    eligibleModelCount: eligible.length,
    excludedCandidates: exclusions
  });
}
