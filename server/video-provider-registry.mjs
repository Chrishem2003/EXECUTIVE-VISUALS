const freeze = value => {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
};

/**
 * Evidence-backed metadata only. This registry does not load credentials,
 * make provider requests, or enable remote generation.
 *
 * availability remains "disabled" until the application-level governance,
 * budget reservation, durable job lifecycle and private output ingestion gates
 * have all been implemented and accepted.
 */
export const VIDEO_PROVIDER_CATALOG = freeze([
  {
    id: "runway",
    name: "Runway",
    adapterState: "foundation",
    availability: "disabled",
    remote: true,
    models: [
      {
        id: "gen4.5",
        name: "Gen-4.5",
        availability: "disabled",
        capabilities: {
          textToVideo: true,
          imageToVideo: true,
          videoToVideo: false,
          videoEdit: false,
          videoExtend: false,
          videoReframe: false,
          nativeAudio: false,
          negativePrompt: false,
          seed: true,
          startFrame: true,
          endFrame: false,
          motionReference: false,
          referenceImages: false,
          audioModes: [],
          // Image-to-video accepts six ratios; text-to-video is limited to landscape/portrait.
          aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
          // provider_default preserves existing enqueue requests that defer resolution to the adapter.
          resolutions: ["provider_default", "720p"],
          minDurationSeconds: 2,
          maxDurationSeconds: 10
        },
        constraints: {
          promptMaxCharacters: 1000,
          durationStepSeconds: 1,
          textToVideoAspectRatios: ["16:9", "9:16"],
          imageToVideoAspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
          outputUrlTemporary: true,
          minimumPollIntervalMs: 5000,
          cancellation: "best_effort"
        }
      },
      {
        id: "seedance2",
        name: "Seedance 2.0",
        availability: "disabled",
        executionAdapter: "not_implemented",
        gateway: "runway",
        capabilities: {
          textToVideo: true,
          imageToVideo: true,
          videoToVideo: true,
          videoEdit: false,
          videoExtend: false,
          videoReframe: false,
          nativeAudio: true,
          negativePrompt: false,
          seed: true,
          startFrame: true,
          endFrame: true,
          motionReference: false,
          referenceImages: true,
          referenceVideos: true,
          referenceAudio: true,
          audioModes: ["generated", "none", "reference"],
          aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
          resolutions: ["480p", "720p", "1080p", "2160p"],
          minDurationSeconds: 4,
          maxDurationSeconds: 15
        },
        constraints: {
          maxPromptCharacters: 10000,
          durationAuto: true,
          durationAutoBilledSeconds: 15,
          minimumBillableDurationSeconds: 4,
          imageToVideoMaxImages: 2,
          textToVideoMaxReferenceImages: 9,
          maxReferenceVideos: 3,
          videoToVideoMaxReferenceVideos: 2,
          maxReferenceAudio: 3,
          inputReferencesCharged: false,
          generatedAudioDefault: true,
          ratiosDefineResolution: true,
          pricingBasis: "output_duration_seconds",
          creditsPerSecondByResolution: { "480p": 14, "720p": 30, "1080p": 40, "2160p": 150 },
          creditUsdValue: 0.01,
          pricingSnapshotDate: "2026-11-04",
          taskPolling: "asynchronous",
          outputUrlTemporary: true,
          source: "https://dev.runwayml.com/learn/seedance-2-0-api"
        }
      },
      {
        id: "seedance2_fast",
        name: "Seedance 2.0 Fast",
        availability: "disabled",
        executionAdapter: "not_implemented",
        gateway: "runway",
        capabilities: {
          textToVideo: true,
          imageToVideo: true,
          videoToVideo: true,
          videoEdit: false,
          videoExtend: false,
          videoReframe: false,
          nativeAudio: true,
          negativePrompt: false,
          seed: true,
          startFrame: true,
          endFrame: true,
          motionReference: false,
          referenceImages: true,
          referenceVideos: true,
          referenceAudio: true,
          audioModes: ["generated", "none", "reference"],
          aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
          resolutions: ["480p", "720p"],
          minDurationSeconds: 4,
          maxDurationSeconds: 15
        },
        constraints: {
          maxPromptCharacters: 10000,
          durationAuto: true,
          durationAutoBilledSeconds: 15,
          minimumBillableDurationSeconds: 4,
          textToVideoMaxReferenceImages: 9,
          maxReferenceVideos: 3,
          videoToVideoMaxReferenceVideos: 2,
          maxReferenceAudio: 3,
          inputReferencesCharged: false,
          generatedAudioDefault: true,
          ratiosDefineResolution: true,
          pricingBasis: "output_duration_seconds",
          creditsPerSecondByResolution: { "480p": 11, "720p": 24 },
          creditUsdValue: 0.01,
          pricingSnapshotDate: "2026-11-04",
          taskPolling: "asynchronous",
          outputUrlTemporary: true,
          source: "https://dev.runwayml.com/learn/seedance-2-0-api"
        }
      },
      {
        id: "seedance2_mini",
        name: "Seedance 2.0 Mini",
        availability: "disabled",
        executionAdapter: "not_implemented",
        gateway: "runway",
        capabilities: {
          textToVideo: true,
          imageToVideo: true,
          videoToVideo: true,
          videoEdit: false,
          videoExtend: false,
          videoReframe: false,
          nativeAudio: true,
          negativePrompt: false,
          seed: true,
          startFrame: true,
          endFrame: true,
          motionReference: false,
          referenceImages: true,
          referenceVideos: true,
          referenceAudio: true,
          audioModes: ["generated", "none", "reference"],
          aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
          resolutions: ["480p", "720p"],
          minDurationSeconds: 4,
          maxDurationSeconds: 15
        },
        constraints: {
          maxPromptCharacters: 10000,
          durationAuto: true,
          durationAutoBilledSeconds: 15,
          minimumBillableDurationSeconds: 4,
          textToVideoMaxReferenceImages: 9,
          maxReferenceVideos: 3,
          videoToVideoMaxReferenceVideos: 2,
          maxReferenceAudio: 3,
          inputReferencesCharged: false,
          generatedAudioDefault: true,
          ratiosDefineResolution: true,
          pricingBasis: "output_duration_seconds",
          creditsPerSecondByResolution: { "480p": 7, "720p": 15 },
          creditUsdValue: 0.01,
          pricingSnapshotDate: "2026-11-04",
          taskPolling: "asynchronous",
          outputUrlTemporary: true,
          source: "https://dev.runwayml.com/learn/seedance-2-0-api"
        }
      },
      {
        id: "kling_4",
        name: "Kling 4.0 (Runway Dev)",
        availability: "disabled",
        executionAdapter: "not_implemented",
        gateway: "runway",
        capabilities: {
          textToVideo: true,
          imageToVideo: true,
          videoToVideo: true,
          videoEdit: true,
          videoExtend: false,
          videoReframe: false,
          nativeAudio: true,
          negativePrompt: false,
          seed: false,
          startFrame: true,
          endFrame: true,
          motionReference: false,
          referenceImages: true,
          audioModes: ["provider_default"],
          aspectRatios: ["16:9", "9:16", "1:1", "21:9"],
          resolutions: ["720p", "1080p"],
          minDurationSeconds: 3,
          maxDurationSeconds: 30
        },
        constraints: {
          maxPromptCharacters: 26000,
          maxReferenceImages: 10,
          maxReferenceVideos: 5,
          maxCombinedImageReferences: 10,
          inputVideoMaxSeconds: 30,
          outputUrlTemporary: true,
          billingBasis: "output_plus_max_input_or_output_duration",
          pricingModel: "kling_4",
          pricingPromotionEndDate: "2026-11-30",
          source: "https://dev.runwayml.com/learn/kling-4-0-api"
        }
      }
    ]
  },
  {
    id: "luma",
    name: "Luma",
    adapterState: "research_only",
    availability: "disabled",
    remote: true,
    models: [
      {
        id: "ray-3.2",
        name: "Ray 3.2",
        availability: "disabled",
        capabilities: {
          textToVideo: true,
          imageToVideo: true,
          videoToVideo: true,
          videoEdit: true,
          videoExtend: true,
          videoReframe: true,
          nativeAudio: false,
          negativePrompt: false,
          seed: false,
          startFrame: true,
          endFrame: true,
          multiKeyframe: true,
          videoSource: true,
          editConditioning: true,
          hdr: true,
          exrExport: true,
          motionReference: false,
          referenceImages: false,
          audioModes: [],
          aspectRatios: ["9:16", "3:4", "1:1", "4:3", "16:9", "21:9"],
          resolutions: ["540p", "720p", "1080p"],
          minDurationSeconds: 5,
          maxDurationSeconds: 10
        },
        constraints: {
          supportedDurationsSeconds: [5, 10],
          maxKeyframes: 64,
          maxImageToVideoDurationFrames: 240,
          maxVideoEditSourceSeconds: 18,
          maxVideoReframeSourceSeconds: 10,
          maxVideoExtendSourceSeconds: 30,
          maxSourceVideoBytes: 209715200,
          outputUrlExpirySeconds: 3600,
          cancellation: "unsupported",
          videoEditStrengths: ["adhere_1", "adhere_2", "adhere_3", "flex_1", "flex_2", "flex_3", "reimagine_1", "reimagine_2", "reimagine_3"],
          reframePreservesSourceFrames: true,
          exrRequiresHdr: true,
          hdrUnavailableForReframe: true,
          source: "https://docs.agents.lumalabs.ai/guides/videos/"
        }
      }
    ]
  },
  {
    id: "kling",
    name: "Kling",
    adapterState: "research_only",
    availability: "disabled",
    remote: true,
    models: [
      {
        id: "kling-4.0",
        name: "Kling 4.0",
        availability: "disabled",
        capabilities: {
          textToVideo: true,
          imageToVideo: true,
          videoToVideo: false,
          videoEdit: false,
          videoExtend: false,
          videoReframe: false,
          negativePrompt: false,
          seed: false,
          motionReference: false,
          referenceImages: true
        },
        constraints: {
          maxDurationSeconds: 30,
          maxKeyframes: 10,
          maxReferenceImages: 10,
          maxReferenceVideos: 5,
          maxCombinedReferences: 15,
          billingBasis: "input_and_output_duration"
        }
      }
    ]
  },
  {
    id: "google",
    name: "Google",
    adapterState: "research_only",
    availability: "disabled",
    remote: true,
    models: [
      {
        id: "gemini-omni-1.1-flash",
        name: "Gemini Omni Flash",
        availability: "disabled",
        capabilities: {
          textToVideo: true,
          imageToVideo: true,
          videoToVideo: false,
          videoEdit: true,
          videoExtend: true,
          videoReframe: false,
          nativeAudio: true,
          negativePrompt: false,
          seed: false,
          startFrame: true,
          endFrame: true,
          motionReference: false,
          referenceImages: true,
          minDurationSeconds: 3,
          maxDurationSeconds: 10
        },
        constraints: {
          frameRate: 24,
          supportsConversationalEdits: true,
          lineageField: "previous_interaction_id",
          outputEncoding: "base64_in_interaction_steps",
          paidTierOnly: true
        }
      }
    ]
  },
  {
    id: "openai",
    name: "OpenAI",
    adapterState: "retired_api",
    availability: "unavailable",
    remote: true,
    models: [
      {
        id: "sora-2",
        name: "Sora 2",
        availability: "unavailable",
        capabilities: {},
        constraints: {
          apiShutdownDate: "2026-09-24",
          replacementVerified: false
        }
      }
    ]
  }
]);

export function listVideoProviders({ includeUnavailable = true } = {}) {
  return VIDEO_PROVIDER_CATALOG.filter(provider =>
    includeUnavailable || provider.availability !== "unavailable"
  );
}

export function getVideoProviderModel(providerId, modelId) {
  const provider = VIDEO_PROVIDER_CATALOG.find(item => item.id === providerId);
  return provider?.models.find(model => model.id === modelId) ?? null;
}

/** No provider is user-selectable until the release gates are implemented. */
export function listSelectableVideoProviderModels() {
  return VIDEO_PROVIDER_CATALOG.flatMap(provider =>
    provider.models
      .filter(model => provider.availability === "enabled" && model.availability === "enabled")
      .map(model => ({ providerId: provider.id, ...model }))
  );
}
