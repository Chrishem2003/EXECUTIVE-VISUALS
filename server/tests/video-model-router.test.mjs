import test from "node:test";
import assert from "node:assert/strict";
import { routeVideoModel } from "../video-model-router.mjs";
import { VIDEO_PROVIDER_CATALOG } from "../video-provider-registry.mjs";

const estimate = amount => ({
  amount, currency: "USD", billable: false, settlementEligible: false,
  pricingDate: "2026-11-04", pricingSource: "https://example.com/pricing"
});
const candidate = (providerId, modelId, amount, overrides = {}) => ({
  providerId, modelId,
  providerAvailability: "enabled", modelAvailability: "enabled", adapterState: "ready",
  capabilities: {
    textToVideo: true, imageToVideo: true, videoToVideo: false, videoEdit: false,
    videoExtend: false, videoReframe: false, nativeAudio: false, seed: true,
    resolutions: ["720p", "1080p"], aspectRatios: ["16:9", "9:16"]
  },
  constraints: { minDurationSeconds: 4, maxDurationSeconds: 15 },
  estimate: estimate(amount), observedLatencyMs: 5000, qualityScore: 0.8,
  latencyEvidence: { sampleCount: 12, measuredAt: "2026-11-04T12:00:00Z", evidenceReference: "benchmark:latency:run-12" },
  qualityEvidence: { sampleCount: 8, measuredAt: "2026-11-04T12:00:00Z", evidenceReference: "benchmark:quality:run-8" },
  ...overrides
});

test("routes by lowest verified cost after capability, duration and hard budget filtering", () => {
  const result = routeVideoModel({
    candidates: [
      candidate("runway", "seedance2", 1.2),
      candidate("luma", "ray-3.2", 0.9, { capabilities: { ...candidate("luma","ray-3.2",0.9).capabilities, textToVideo: true, resolutions: ["720p"] } }),
      candidate("kling", "kling-4", 0.2, { modelAvailability: "disabled" })
    ],
    requirements: { operation: "text_to_video", durationSeconds: 10, resolution: "720p" },
    maxCostUsd: 1
  });
  assert.equal(result.status, "selected");
  assert.equal(result.selected.modelKey, "luma:ray-3.2");
  assert.equal(result.selected.estimatedCostUsd, 0.9);
  assert.ok(result.excludedCandidates.some(item => item.reason === "over_budget"));
  assert.ok(result.excludedCandidates.some(item => item.reason === "model_disabled"));
});

test("supports quality and measured-latency optimization with deterministic tie breaking", () => {
  const candidates = [
    candidate("runway", "seedance2", 1.2, { observedLatencyMs: 7000, qualityScore: 0.92 }),
    candidate("luma", "ray-3.2", 0.9, { observedLatencyMs: 4000, qualityScore: 0.88 })
  ];
  assert.equal(routeVideoModel({ candidates, optimizeFor: "quality" }).selected.modelKey, "runway:seedance2");
  assert.equal(routeVideoModel({ candidates, optimizeFor: "latency" }).selected.modelKey, "luma:ray-3.2");
  assert.equal(routeVideoModel({ candidates: [candidate("runway", "unmeasured", 0.5, { latencyEvidence: null })], optimizeFor: "latency" }).status, "no_eligible_model");
  assert.equal(routeVideoModel({ candidates: [candidate("runway", "unmeasured", 0.5, { qualityEvidence: null })], optimizeFor: "quality" }).status, "no_eligible_model");
});

test("does not route to disabled models, unready adapters or unverified prices", () => {
  const candidates = [
    candidate("runway", "disabled", 0.1, { modelAvailability: "disabled" }),
    candidate("luma", "adapter", 0.2, { adapterState: "research_only" }),
    candidate("kling", "unknown-price", 0.3, { estimate: { amount: 0.3, currency: "USD" } })
  ];
  const result = routeVideoModel({ candidates });
  assert.equal(result.status, "no_eligible_model");
  assert.equal(result.selected, null);
  assert.deepEqual(result.excludedCandidates.map(item => item.reason), ["model_disabled", "adapter_not_ready", "pricing_unverified"]);
});

test("enforces audio, seed, aspect ratio, duration and resolution capabilities", () => {
  const base = candidate("runway", "model", 1);
  assert.equal(routeVideoModel({ candidates: [base], requirements: { audio: true } }).status, "no_eligible_model");
  assert.equal(routeVideoModel({ candidates: [base], requirements: { aspectRatio: "1:1" } }).status, "no_eligible_model");
  assert.equal(routeVideoModel({ candidates: [base], requirements: { durationSeconds: 20 } }).status, "no_eligible_model");
  assert.equal(routeVideoModel({ candidates: [base], requirements: { resolution: "4k" } }).status, "no_eligible_model");
  assert.equal(routeVideoModel({ candidates: [base], requirements: { seed: true } }).status, "selected");
});

test("enforces allowlists and denylists and returns immutable decision metadata", () => {
  const candidates = [candidate("runway", "a", 0.5), candidate("luma", "b", 0.4)];
  const result = routeVideoModel({ candidates, allowModels: ["runway:a"], denyModels: ["luma:b"] });
  assert.equal(result.selected.modelKey, "runway:a");
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.selected));
});

test("fails closed for malformed routing policy and requirements", () => {
  assert.throws(() => routeVideoModel({ candidates: [] }), error => error.code === "VIDEO_ROUTING_INVALID_INPUT");
  assert.throws(() => routeVideoModel({ candidates: [candidate("runway","x",0.5)], optimizeFor: "random" }), /optimizeFor/);
  assert.throws(() => routeVideoModel({ candidates: [candidate("runway","x",0.5)], requirements: { operation: "music_video" } }), /Unsupported video operation/);
  assert.throws(() => routeVideoModel({ candidates: [candidate("runway","x",0.5)], maxCostUsd: -1 }), /maxCostUsd/);
});

test("the actual provider catalogue cannot route while every provider remains disabled", () => {
  const candidates = VIDEO_PROVIDER_CATALOG.flatMap(provider => provider.models.map(model => ({
    providerId: provider.id,
    modelId: model.id,
    providerAvailability: provider.availability,
    modelAvailability: model.availability,
    adapterState: provider.adapterState,
    capabilities: model.capabilities,
    constraints: model.constraints
  })));
  const result = routeVideoModel({ candidates, requirements: { operation: "text_to_video" } });
  assert.equal(result.status, "no_eligible_model");
  assert.equal(result.eligibleModelCount, 0);
  assert.ok(result.excludedCandidates.length > 0);
  assert.ok(result.excludedCandidates.every(item => item.reason === "model_disabled"));
});
