import test from "node:test";
import assert from "node:assert/strict";
import {
  VIDEO_PROVIDER_CATALOG,
  getVideoProviderModel,
  listSelectableVideoProviderModels,
  listVideoProviders
} from "../video-provider-registry.mjs";

test("provider catalog is evidence-backed metadata and all remote providers remain disabled", () => {
  assert.deepEqual(
    VIDEO_PROVIDER_CATALOG.map(provider => [provider.id, provider.availability]),
    [
      ["runway", "disabled"],
      ["luma", "disabled"],
      ["kling", "disabled"],
      ["google", "disabled"],
      ["openai", "unavailable"]
    ]
  );
  assert.equal(listSelectableVideoProviderModels().length, 0);
});

test("Runway catalog exposes implemented Gen-4.5 text-to-video and image-to-video contracts", () => {
  const model = getVideoProviderModel("runway", "gen4.5");
  assert.equal(model.availability, "disabled");
  assert.equal(model.capabilities.textToVideo, true);
  assert.equal(model.capabilities.imageToVideo, true);
  assert.equal(model.capabilities.startFrame, true);
  assert.equal(model.capabilities.seed, true);
  assert.deepEqual(model.capabilities.aspectRatios, ["16:9", "9:16"]);
  assert.equal(model.capabilities.minDurationSeconds, 2);
  assert.equal(model.capabilities.maxDurationSeconds, 10);
  assert.equal(model.constraints.minimumPollIntervalMs, 5000);
  assert.equal(model.constraints.cancellation, "best_effort");
});

test("Kling 4.0 is catalogued as a Runway-routed model but has no executable adapter", () => {
  const model = getVideoProviderModel("runway", "kling_4");
  assert.equal(model.gateway, "runway");
  assert.equal(model.availability, "disabled");
  assert.equal(model.executionAdapter, "not_implemented");
  assert.equal(model.capabilities.videoToVideo, true);
  assert.equal(model.capabilities.nativeAudio, true);
  assert.equal(model.capabilities.maxDurationSeconds, 30);
  assert.equal(model.constraints.maxReferenceImages, 10);
  assert.equal(model.constraints.maxReferenceVideos, 5);
  assert.equal(model.constraints.pricingPromotionEndDate, "2026-11-30");
  assert.equal(listSelectableVideoProviderModels().length, 0);
});
test("Luma no-cancel and temporary output semantics remain explicit", () => {
  const model = getVideoProviderModel("luma", "ray-3.2");
  assert.deepEqual(model.constraints.supportedDurationsSeconds, [5, 10]);
  assert.equal(model.constraints.maxKeyframes, 64);
  assert.equal(model.constraints.outputUrlExpirySeconds, 3600);
  assert.equal(model.constraints.cancellation, "unsupported");
});

test("Kling mixed-reference and duration limits are represented without enabling the adapter", () => {
  const model = getVideoProviderModel("kling", "kling-4.0");
  assert.equal(model.availability, "disabled");
  assert.equal(model.constraints.maxDurationSeconds, 30);
  assert.equal(model.constraints.maxKeyframes, 10);
  assert.equal(model.constraints.maxCombinedReferences, 15);
  assert.equal(model.constraints.billingBasis, "input_and_output_duration");
});

test("Gemini conversational lineage and output encoding are explicit", () => {
  const model = getVideoProviderModel("google", "gemini-omni-1.1-flash");
  assert.equal(model.constraints.supportsConversationalEdits, true);
  assert.equal(model.constraints.lineageField, "previous_interaction_id");
  assert.equal(model.constraints.outputEncoding, "base64_in_interaction_steps");
  assert.equal(model.constraints.paidTierOnly, true);
});

test("retired Sora API is unavailable and cannot be selected", () => {
  const model = getVideoProviderModel("openai", "sora-2");
  assert.equal(model.availability, "unavailable");
  assert.equal(model.constraints.apiShutdownDate, "2026-09-24");
  assert.equal(model.constraints.replacementVerified, false);
  assert.equal(listSelectableVideoProviderModels().length, 0);
});

test("catalog is immutable and unavailable providers can be filtered", () => {
  assert.ok(Object.isFrozen(VIDEO_PROVIDER_CATALOG));
  assert.ok(Object.isFrozen(VIDEO_PROVIDER_CATALOG[0].models[0].capabilities.aspectRatios));
  assert.equal(listVideoProviders({ includeUnavailable: false }).some(item => item.id === "openai"), false);
  assert.equal(getVideoProviderModel("missing", "missing"), null);
});
