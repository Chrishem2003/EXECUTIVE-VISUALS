import test from "node:test";
import assert from "node:assert/strict";
import {
  VIDEO_PROVIDER_CATALOG,
  getVideoProviderModel,
  listSelectableVideoProviderModels,
  listVideoProviders,
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
  assert.deepEqual(model.capabilities.aspectRatios, ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]);
  assert.deepEqual(model.capabilities.resolutions, ["provider_default", "720p"]);
  assert.equal(model.capabilities.minDurationSeconds, 2);
  assert.equal(model.capabilities.maxDurationSeconds, 10);
  assert.deepEqual(model.constraints.textToVideoAspectRatios, ["16:9", "9:16"]);
  assert.deepEqual(model.constraints.imageToVideoAspectRatios, ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]);
  assert.equal(model.constraints.minimumPollIntervalMs, 5000);
  assert.equal(model.constraints.cancellation, "best_effort");
});

test("Seedance 2.0 tiers expose distinct verified capabilities and dated credit rates", () => {
  const full = getVideoProviderModel("runway", "seedance2");
  const fast = getVideoProviderModel("runway", "seedance2_fast");
  const mini = getVideoProviderModel("runway", "seedance2_mini");
  for (const model of [full, fast, mini]) {
    assert.equal(model.availability, "disabled");
    assert.equal(model.executionAdapter, "not_implemented");
    assert.equal(model.gateway, "runway");
    assert.equal(model.capabilities.textToVideo, true);
    assert.equal(model.capabilities.imageToVideo, true);
    assert.equal(model.capabilities.videoToVideo, true);
    assert.equal(model.capabilities.nativeAudio, true);
    assert.equal(model.capabilities.seed, true);
    assert.equal(model.capabilities.referenceImages, true);
    assert.equal(model.capabilities.referenceVideos, true);
    assert.equal(model.capabilities.referenceAudio, true);
    assert.equal(model.capabilities.minDurationSeconds, 4);
    assert.equal(model.capabilities.maxDurationSeconds, 15);
    assert.equal(model.constraints.maxPromptCharacters, 10000);
    assert.equal(model.constraints.maxReferenceAudio, 3);
    assert.equal(model.constraints.durationAutoBilledSeconds, 15);
    assert.equal(model.constraints.creditUsdValue, 0.01);
    assert.equal(model.constraints.pricingSnapshotDate, "2026-11-04");
  }
  assert.deepEqual(full.capabilities.resolutions, ["480p", "720p", "1080p", "2160p"]);
  assert.deepEqual(fast.capabilities.resolutions, ["480p", "720p"]);
  assert.deepEqual(mini.capabilities.resolutions, ["480p", "720p"]);
  assert.deepEqual(full.constraints.creditsPerSecondByResolution, {"480p":14,"720p":30,"1080p":40,"2160p":150});
  assert.deepEqual(fast.constraints.creditsPerSecondByResolution, {"480p":11,"720p":24});
  assert.deepEqual(mini.constraints.creditsPerSecondByResolution, {"480p":7,"720p":15});
  assert.equal(full.constraints.imageToVideoRatioValues.length, 24);
  assert.equal(full.constraints.textToVideoRatioValues.length, 24);
  assert.equal(full.constraints.videoToVideoRatioValues.length, 24);
  assert.equal(full.constraints.minimumCreditsByResolution["480p"], 56);
  assert.equal(full.constraints.textToVideoMaxReferenceImages, 9);
  assert.equal(full.constraints.videoToVideoMaxReferenceImages, 9);
  assert.equal(fast.constraints.minimumCreditsByResolution["480p"], 44);
  assert.equal(mini.constraints.minimumCreditsByResolution["480p"], 28);
  assert.equal(mini.constraints.supportedRatioValues.length, 12);
  assert.equal(fast.constraints.supportedRatioValues.length, 12);
  assert.deepEqual(fast.constraints.supportedRatioValues, mini.constraints.supportedRatioValues);
  assert.equal(full.constraints.inputReferencesCharged, false);
  assert.equal(listSelectableVideoProviderModels().length, 0);
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
  assert.deepEqual(model.constraints.listCreditsPerSecondByResolution, { "720p": 15.7, "1080p": 23.5 });
  assert.deepEqual(model.constraints.inputVideoCreditsPerSecondByResolution, { "720p": 9.4, "1080p": 14.1 });
  assert.equal(model.constraints.promotionalDiscountPercent, 20);
  assert.equal(model.constraints.billingRounding, "ceil_list_credits_then_discount_then_ceil");
  assert.equal(listSelectableVideoProviderModels().length, 0);
});
test("Luma no-cancel and temporary output semantics remain explicit", () => {
  const model = getVideoProviderModel("luma", "ray-3.2");
  assert.deepEqual(model.constraints.supportedDurationsSeconds, [5, 10]);
  assert.equal(model.capabilities.startFrame, true);
  assert.equal(model.capabilities.endFrame, true);
  assert.equal(model.capabilities.multiKeyframe, true);
  assert.equal(model.capabilities.videoSource, true);
  assert.equal(model.capabilities.videoEdit, true);
  assert.equal(model.capabilities.videoReframe, true);
  assert.equal(model.capabilities.hdr, true);
  assert.equal(model.capabilities.exrExport, true);
  assert.deepEqual(model.capabilities.aspectRatios, ["9:16", "3:4", "1:1", "4:3", "16:9", "21:9"]);
  assert.deepEqual(model.capabilities.resolutions, ["540p", "720p", "1080p"]);
  assert.equal(model.constraints.maxKeyframes, 64);
  assert.equal(model.constraints.maxVideoEditSourceSeconds, 18);
  assert.equal(model.constraints.maxVideoReframeSourceSeconds, 10);
  assert.equal(model.constraints.maxVideoExtendSourceSeconds, 30);
  assert.equal(model.constraints.maxSourceVideoBytes, 209715200);
  assert.equal(model.constraints.reframePreservesSourceFrames, true);
  assert.equal(model.constraints.exrRequiresHdr, true);
  assert.equal(model.constraints.hdrUnavailableForReframe, true);
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

test("Seedance 2.5 catalogue captures official 30-second references, draft and edit constraints without enabling execution", () => {
  const model = getVideoProviderModel("runway", "seedance2_5");
  assert.equal(model.availability, "disabled");
  assert.equal(model.executionAdapter, "not_implemented");
  assert.equal(model.capabilities.videoEdit, true);
  assert.equal(model.capabilities.videoExtend, true);
  assert.equal(model.capabilities.maxDurationSeconds, 30);
  assert.deepEqual(model.capabilities.resolutions, ["480p", "720p", "1080p"]);
  assert.equal(model.constraints.maxPromptCharacters, 15000);
  assert.equal(model.constraints.durationAutoBilledSeconds, 30);
  assert.equal(model.constraints.maxReferenceImages, 30);
  assert.equal(model.constraints.maxReferenceVideos, 10);
  assert.equal(model.constraints.maxReferenceAudio, 10);
  assert.deepEqual(model.constraints.outputCreditsPerSecondByResolution, { "480p": 20, "720p": 30, "1080p": 68 });
  assert.equal(model.constraints.minimumCredits, 80);
  assert.equal(model.constraints.videoEditRequiresAutoDuration, true);
  assert.equal(listSelectableVideoProviderModels().length, 0);
});

test("Veo 3.1 and Fast catalogue enforce duration, resolution, audio and tier-specific pricing boundaries", () => {
  const standard = getVideoProviderModel("runway", "veo3.1");
  const fast = getVideoProviderModel("runway", "veo3.1_fast");
  for (const model of [standard, fast]) {
    assert.equal(model.availability, "disabled");
    assert.equal(model.executionAdapter, "not_implemented");
    assert.equal(model.capabilities.nativeAudio, true);
    assert.deepEqual(model.constraints.supportedDurationsSeconds, [4, 6, 8]);
    assert.equal(model.constraints.eightSecondsOnlyAt1080p, true);
    assert.equal(model.constraints.maxKeyframes, 2);
    assert.equal(model.constraints.lastFrameRequiresFirstFrame, true);
  }
  assert.deepEqual(standard.constraints.outputCreditsPerSecond, { audio: 40, noAudio: 20 });
  assert.deepEqual(fast.constraints.outputCreditsPerSecond, { audio: 15, noAudio: 10 });
  assert.equal(listSelectableVideoProviderModels().length, 0);
});

test("Runway's expanded model directory is catalogued with dated pricing and disabled adapters", () => {
  const expected = [
    ["grok_imagine_1_5", ["480p", "720p", "1080p"]],
    ["grok_imagine_1_5_lite", ["480p", "720p", "1080p"]],
    ["wan3", ["480p", "720p", "1080p"]],
    ["wan3_prime", ["480p", "720p", "1080p"]],
    ["h3_max", ["480p", "768p"]],
    ["happyhorse_1_0", ["720p", "1080p"]],
    ["gemini_omni_flash_1.1", ["360p", "720p", "1080p", "4k"]]
  ];
  for (const [id, resolutions] of expected) {
    const model = getVideoProviderModel("runway", id);
    assert.ok(model, id + " must exist in the Runway Dev catalogue");
    assert.equal(model.availability, "disabled", id + " must remain disabled");
    assert.equal(model.executionAdapter, "not_implemented", id + " must not imply execution support");
    assert.deepEqual(model.capabilities.resolutions, resolutions);
    assert.equal(model.constraints.pricingSnapshotDate, "2026-11-04");
    assert.equal(model.constraints.creditUsdValue, 0.01);
    assert.match(model.constraints.source, /^https:\/\/docs\.dev\.runwayml\.com\//);
  }
  assert.deepEqual(getVideoProviderModel("runway", "grok_imagine_1_5").constraints.creditsPerSecondByResolution,
    { "480p": 10, "720p": 16, "1080p": 29 });
  assert.deepEqual(getVideoProviderModel("runway", "grok_imagine_1_5_lite").constraints.creditsPerSecondByResolution,
    { "480p": 2, "720p": 3, "1080p": 14 });
  assert.deepEqual(getVideoProviderModel("runway", "wan3").constraints.creditsPerSecondByResolution,
    { "480p": 5, "720p": 10, "1080p": 20 });
  assert.deepEqual(getVideoProviderModel("runway", "wan3_prime").constraints.creditsPerSecondByResolution,
    { "480p": 6.8, "720p": 14, "1080p": 28 });
  assert.deepEqual(getVideoProviderModel("runway", "h3_max").constraints.creditsPerSecondByResolution,
    { "480p": 5, "768p": 8 });
  assert.deepEqual(getVideoProviderModel("runway", "happyhorse_1_0").constraints.creditsPerSecondByResolution,
    { "720p": 15, "1080p": 30 });
  assert.deepEqual(getVideoProviderModel("runway", "gemini_omni_flash_1.1").constraints.creditsPerSecondByResolution,
    { "360p": 3.4, "720p": 10, "1080p": 15, "4k": 30 });
  assert.equal(listSelectableVideoProviderModels().length, 0);
});

test("November 2026 Runway model releases are catalogued with verified constraints but disabled execution", () => {
  const kling = getVideoProviderModel("runway", "kling_4_flash");
  const omni = getVideoProviderModel("runway", "gemini_omni_flash_1.2");
  for (const model of [kling, omni]) {
    assert.ok(model);
    assert.equal(model.availability, "disabled");
    assert.equal(model.executionAdapter, "not_implemented");
    assert.equal(model.gateway, "runway");
    assert.equal(model.constraints.pricingSnapshotDate, "2026-11-07");
  }
  assert.equal(kling.capabilities.nativeAudio, true);
  assert.equal(kling.capabilities.maxDurationSeconds, 20);
  assert.deepEqual(kling.capabilities.resolutions, ["720p"]);
  assert.equal(kling.constraints.maxReferenceImagesIncludingFirstFrame, 10);
  assert.equal(kling.constraints.maxReferenceVideos, 5);
  assert.equal(kling.constraints.minimumCredits, 29);
  assert.equal(kling.constraints.outputCreditsPerSecondWithoutInputVideo, 9.4);
  assert.equal(kling.constraints.outputCreditsPerSecondWithInputVideo, 6.3);
  assert.equal(kling.constraints.inputVideoCreditsPerSecond, 6.3);
  assert.equal(omni.capabilities.imageToVideo, true);
  assert.equal(omni.capabilities.videoEdit, true);
  assert.equal(omni.capabilities.videoExtend, true);
  assert.equal(omni.capabilities.minDurationSeconds, 3);
  assert.equal(omni.capabilities.maxDurationSeconds, 15);
  assert.deepEqual(omni.capabilities.resolutions, ["360p", "720p", "1080p", "4k"]);
  assert.deepEqual(omni.constraints.outputCreditsPerSecondByResolution, {"360p":2,"720p":7,"1080p":10,"4k":21});
  assert.equal(omni.constraints.maxReferenceImages, 5);
  assert.equal(omni.constraints.maxReferenceVideos, 3);
  assert.equal(omni.constraints.minimumCredits, 6);
  assert.equal(omni.constraints.inputVideoCreditsPerSecond, 1);
  assert.equal(listSelectableVideoProviderModels().length, 0);
});

test("Runway Veo model IDs are distinct from the retired Gemini API preview endpoint", () => {
  const runwayVeo = getVideoProviderModel("runway", "veo3.1");
  const googleOmni = getVideoProviderModel("google", "gemini-omni-1.1-flash");
  assert.equal(runwayVeo.gateway, "runway");
  assert.equal(runwayVeo.availability, "disabled");
  assert.equal(googleOmni.availability, "disabled");
  const retired = getVideoProviderModel("google", "veo-3.1-generate-preview");
  assert.equal(retired, null);
});


test("Google Gemini Omni Flash catalog matches the current Interactions API contract", () => {
  const model = getVideoProviderModel("google", "gemini-omni-1.1-flash");
  assert.ok(model);
  assert.equal(model.availability, "disabled");
  assert.equal(model.executionAdapter, "google-omni-cloud-video-adapter");
  assert.equal(model.capabilities.textToVideo, true);
  assert.equal(model.capabilities.imageToVideo, true);
  assert.equal(model.capabilities.videoToVideo, true);
  assert.equal(model.capabilities.videoEdit, true);
  assert.equal(model.capabilities.videoExtend, true);
  assert.equal(model.capabilities.nativeAudio, true);
  assert.equal(model.capabilities.negativePrompt, false);
  assert.equal(model.constraints.supportsConversationalEdits, true);
  assert.equal(model.constraints.lineageField, "previous_interaction_id");
  assert.equal(model.constraints.outputEncoding, "base64_in_interaction_steps");
  assert.equal(model.constraints.paidTierOnly, true);
  assert.deepEqual(model.capabilities.aspectRatios, ["16:9", "9:16"]);
  assert.deepEqual(model.capabilities.resolutions, ["360p", "720p", "1080p", "4k"]);
  assert.equal(model.constraints.maxReferenceVideoClips, 3);
  assert.equal(model.constraints.maxReferenceVideoSecondsEach, 3);
  assert.equal(model.constraints.uploadedVideoMaxSeconds, 10);
  assert.equal(model.constraints.maxExtendedVideoSeconds, 40);
  assert.equal(model.constraints.audioReferenceUploads, false);
  assert.equal(model.constraints.outputUriDeliverySupported, true);
  assert.match(model.constraints.source, /^https:\/\/ai\.google\.dev\/gemini-api\/docs\/omni$/);
  assert.equal(listSelectableVideoProviderModels().length, 0);
});

test("Kling 4.0 Flash and Gemini Omni 1.2 are accurately catalogued but remain non-selectable", () => {
  const kling = getVideoProviderModel("kling", "kling-4.0-flash");
  assert.ok(kling);
  assert.equal(kling.availability, "disabled");
  assert.equal(kling.executionAdapter, "not_implemented");
  assert.deepEqual(kling.capabilities.resolutions, ["720p"]);
  assert.equal(kling.capabilities.minDurationSeconds, 3);
  assert.equal(kling.capabilities.maxDurationSeconds, 20);
  assert.equal(kling.pricing.noInputVideoUnitsPerOutputSecond, 0.6);
  assert.equal(kling.pricing.withInputVideoUnitsPerBillableSecond, 0.4);
  assert.equal(kling.pricing.accountPackagePriceRequired, true);
  assert.equal(kling.constraints.maxReferenceImages, 10);
  assert.equal(kling.constraints.maxReferenceVideos, 5);
  assert.equal(kling.constraints.maxCombinedReferences, 15);

  const gemini = getVideoProviderModel("google", "gemini-omni-1.2-flash");
  assert.ok(gemini);
  assert.equal(gemini.availability, "disabled");
  assert.equal(gemini.executionAdapter, "not_implemented");
  assert.equal(gemini.capabilities.maxDurationSeconds, 15);
  assert.deepEqual(gemini.constraints.generationResolutions, ["360p", "720p"]);
  assert.deepEqual(gemini.constraints.finishingResolutions, ["1080p", "4k"]);
  assert.equal(gemini.pricing.outputUsdPerSecondAt720p, 0.07);
  assert.equal(gemini.pricing.otherResolutionPricesVerified, false);
  assert.equal(gemini.constraints.requiresInteractionsApi, true);
  assert.equal(listSelectableVideoProviderModels().length, 0);
});

test("Runway Model Router is catalogued as a disabled synthetic route, not a concrete model", () => {
  const model = getVideoProviderModel("runway", "model-router");
  assert.ok(model);
  assert.equal(model.availability, "disabled");
  assert.equal(model.executionAdapter, "runway-model-router-cloud-worker");
  assert.equal(model.capabilities.textToVideo, true);
  assert.equal(model.capabilities.imageToVideo, true);
  assert.equal(model.capabilities.nativeAudio, true);
  assert.equal(model.capabilities.referenceAudio, true);
  assert.deepEqual(model.capabilities.audioModes, ["generated", "none", "reference"]);
  assert.equal(model.capabilities.maxReferenceImages, 4);
  assert.equal(model.capabilities.maxReferenceVideos, 2);
  assert.equal(model.capabilities.maxReferenceAudio, 1);
  assert.equal(model.constraints.pricingMode, "server-dry-run-with-approved-budget-ceiling");
  assert.equal(listSelectableVideoProviderModels().length, 0);
});



