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


test("Runway Dev catalog-only models are discoverable but cannot be selected", () => {
  const expected = [
    ["gen4_turbo", "imageToVideo"],
    ["aleph2", "videoEdit"],
    ["kling_4", "videoToVideo"],
    ["seedance2_5", "videoToVideo"],
    ["gemini_omni_flash_1.1", "nativeAudio"]
  ];
  for (const [id, capability] of expected) {
    const model = getVideoProviderModel("runway", id);
    assert.ok(model, id + " must be in the Runway Dev catalog");
    assert.equal(model.availability, "disabled");
    assert.equal(model.implementationState, "catalog_only");
    assert.equal(model.capabilities[capability], true);
  }
  assert.equal(getVideoProviderModel("runway", "kling_4").constraints.apiModelId, "kling_4");
  assert.equal(getVideoProviderModel("runway", "seedance2_5").constraints.draftEnhancement, "1080p");
  assert.equal(getVideoProviderModel("runway", "gemini_omni_flash_1.1").constraints.billingModel,
    "resolution_plus_reference_images_and_input_video_duration");
  assert.equal(listSelectableVideoProviderModels().length, 0);
});

test("remaining documented Runway Dev video and finishing operations are catalog-only", () => {
  const ids = [
    "seedance2","seedance2_fast","seedance2_mini",
    "kling3.0_pro","kling3.0_standard","kling3.0_4k",
    "klingO3_pro","klingO3_standard","klingO3_4k","kling2.5_turbo_pro",
    "hailuo3","h3_max","wan3","wan3_prime",
    "grok_imagine_1_5","grok_imagine_1_5_lite","happyhorse_1_0",
    "veo3.1","veo3.1_fast","gemini_omni_flash","act_two",
    "magnific_video_upscaler_creative","enhance_frame_rate","ruby"
  ];
  for (const id of ids) {
    const model = getVideoProviderModel("runway", id);
    assert.ok(model, id + " must be discoverable");
    assert.equal(model.availability, "disabled");
    assert.equal(model.implementationState, "catalog_only");
    assert.equal(model.constraints.apiModelId, id);
  }
  assert.equal(getVideoProviderModel("runway", "magnific_video_upscaler_creative").constraints.operationType, "video_upscale");
  assert.equal(getVideoProviderModel("runway", "enhance_frame_rate").constraints.operationType, "frame_rate_enhancement");
  assert.equal(getVideoProviderModel("runway", "ruby").constraints.operationType, "video_hdr");
  assert.equal(listSelectableVideoProviderModels().length, 0);
});

test("catalog is immutable and unavailable providers can be filtered", () => {
  assert.ok(Object.isFrozen(VIDEO_PROVIDER_CATALOG));
  assert.ok(Object.isFrozen(VIDEO_PROVIDER_CATALOG[0].models[0].capabilities.aspectRatios));
  assert.equal(listVideoProviders({ includeUnavailable: false }).some(item => item.id === "openai"), false);
  assert.equal(getVideoProviderModel("missing", "missing"), null);
});
