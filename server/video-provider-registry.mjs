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
        id: "seedance2_5",
        name: "Seedance 2.5",
        availability: "disabled",
        executionAdapter: "not_implemented",
        gateway: "runway",
        capabilities: {
          textToVideo: true, imageToVideo: true, videoToVideo: true,
          videoEdit: true, videoExtend: true, videoReframe: false,
          nativeAudio: true, negativePrompt: false, seed: true,
          startFrame: true, endFrame: true, motionReference: false,
          referenceImages: true, referenceVideos: true, referenceAudio: true,
          audioModes: ["generated", "none", "reference"],
          aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
          resolutions: ["480p", "720p", "1080p"],
          minDurationSeconds: 4, maxDurationSeconds: 30
        },
        constraints: {
          maxPromptCharacters: 15000, durationAuto: true, durationAutoBilledSeconds: 30,
          minimumCredits: 80, maxReferenceImages: 30, maxReferenceVideos: 10,
          maxReferenceAudio: 10, maxVideoToVideoReferenceVideos: 9,
          referenceImagesAndAudioCharged: false,
          inputVideoCreditsPerSecondByResolution: { "480p": 10, "720p": 15, "1080p": 34 },
          outputCreditsPerSecondByResolution: { "480p": 20, "720p": 30, "1080p": 68 },
          draftPreviewCreditsPerSecond: 20, draftEnhancedCreditsPerSecond: 68,
          draftEnhancementEndpoint: "text_to_video",
          videoEditRequiresAutoDuration: true,
          pricingSnapshotDate: "2026-11-04", creditUsdValue: 0.01,
          asynchronousTaskPolling: true, outputUrlTemporary: true,
          source: "https://dev.runwayml.com/learn/seedance-2-5-api"
        }
      },
      {
        id: "veo3.1",
        name: "Veo 3.1",
        availability: "disabled",
        executionAdapter: "not_implemented",
        gateway: "runway",
        capabilities: {
          textToVideo: true, imageToVideo: true, videoToVideo: false,
          videoEdit: false, videoExtend: false, videoReframe: false,
          nativeAudio: true, negativePrompt: true, seed: true,
          startFrame: true, endFrame: true, motionReference: false,
          referenceImages: true, referenceVideos: false, referenceAudio: false,
          audioModes: ["generated", "none"],
          aspectRatios: ["16:9", "9:16"],
          resolutions: ["720p", "1080p"],
          minDurationSeconds: 4, maxDurationSeconds: 8
        },
        constraints: {
          maxPromptCharacters: 1000, supportedDurationsSeconds: [4, 6, 8],
          maxKeyframes: 2, lastFrameRequiresFirstFrame: true,
          ratioValues: ["1280:720", "720:1280", "1080:1920", "1920:1080"],
          outputCreditsPerSecond: { audio: 40, noAudio: 20 },
          eightSecondsOnlyAt1080p: true,
          pricingSnapshotDate: "2026-11-04", creditUsdValue: 0.01,
          asynchronousTaskPolling: true, outputUrlTemporary: true,
          source: "https://dev.runwayml.com/learn/veo-3-1-api"
        }
      },
      {
        id: "veo3.1_fast",
        name: "Veo 3.1 Fast",
        availability: "disabled",
        executionAdapter: "not_implemented",
        gateway: "runway",
        capabilities: {
          textToVideo: true, imageToVideo: true, videoToVideo: false,
          videoEdit: false, videoExtend: false, videoReframe: false,
          nativeAudio: true, negativePrompt: true, seed: true,
          startFrame: true, endFrame: true, motionReference: false,
          referenceImages: true, referenceVideos: false, referenceAudio: false,
          audioModes: ["generated", "none"],
          aspectRatios: ["16:9", "9:16"],
          resolutions: ["720p", "1080p"],
          minDurationSeconds: 4, maxDurationSeconds: 8
        },
        constraints: {
          maxPromptCharacters: 1000, supportedDurationsSeconds: [4, 6, 8],
          maxKeyframes: 2, lastFrameRequiresFirstFrame: true,
          ratioValues: ["1280:720", "720:1280", "1080:1920", "1920:1080"],
          outputCreditsPerSecond: { audio: 15, noAudio: 10 },
          eightSecondsOnlyAt1080p: true,
          pricingSnapshotDate: "2026-11-04", creditUsdValue: 0.01,
          asynchronousTaskPolling: true, outputUrlTemporary: true,
          source: "https://dev.runwayml.com/learn/veo-3-1-api"
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
          videoToVideoMaxReferenceImages: 9,
          textToVideoMaxReferenceVideos: 3,
          videoToVideoMaxReferenceVideos: 2,
          maxReferenceAudio: 3,
          imageToVideoRatioValues: ["992:432", "864:496", "752:560", "640:640", "560:752", "496:864", "1470:630", "1280:720", "1112:834", "960:960", "834:1112", "720:1280", "2206:946", "1920:1080", "1664:1248", "1440:1440", "1248:1664", "1080:1920", "3840:1646", "3840:2160", "3840:2880", "3840:3840", "2880:3840", "2160:3840"],
          textToVideoRatioValues: ["992:432", "864:496", "752:560", "640:640", "560:752", "496:864", "1470:630", "1280:720", "1112:834", "960:960", "834:1112", "720:1280", "2206:946", "1920:1080", "1664:1248", "1440:1440", "1248:1664", "1080:1920", "3840:1646", "3840:2160", "3840:2880", "3840:3840", "2880:3840", "2160:3840"],
          videoToVideoRatioValues: ["992:432", "864:496", "752:560", "640:640", "560:752", "496:864", "1470:630", "1280:720", "1112:834", "960:960", "834:1112", "720:1280", "2206:946", "1920:1080", "1664:1248", "1440:1440", "1248:1664", "1080:1920", "3840:1646", "3840:2160", "3840:2880", "3840:3840", "2880:3840", "2160:3840"],
          minimumCreditsByResolution: { "480p": 56, "720p": 56, "1080p": 56, "2160p": 56 },
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
          videoToVideoMaxReferenceImages: 9,
          textToVideoMaxReferenceVideos: 3,
          maxReferenceVideos: 3,
          videoToVideoMaxReferenceVideos: 2,
          maxReferenceAudio: 3,
          supportedRatioValues: ["992:432", "864:496", "752:560", "640:640", "560:752", "496:864", "1470:630", "1280:720", "1112:834", "960:960", "834:1112", "720:1280"],
          minimumCreditsByResolution: { "480p": 44, "720p": 44 },
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
          videoToVideoMaxReferenceImages: 9,
          textToVideoMaxReferenceVideos: 3,
          maxReferenceVideos: 3,
          videoToVideoMaxReferenceVideos: 2,
          maxReferenceAudio: 3,
          supportedRatioValues: ["992:432", "864:496", "752:560", "640:640", "560:752", "496:864", "1470:630", "1280:720", "1112:834", "960:960", "834:1112", "720:1280"],
          minimumCreditsByResolution: { "480p": 28, "720p": 28 },
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
        id: "grok_imagine_1_5",
        name: "Grok Imagine Video 1.5",
        availability: "disabled",
        executionAdapter: "not_implemented",
        gateway: "runway",
        capabilities: {
          textToVideo: true, imageToVideo: true, videoToVideo: false,
          videoEdit: false, videoExtend: false, videoReframe: false,
          nativeAudio: true, negativePrompt: false, seed: false,
          startFrame: true, endFrame: false, motionReference: false,
          referenceImages: true, referenceVideos: false, referenceAudio: true,
          audioModes: ["generated", "reference"],
          resolutions: ["480p", "720p", "1080p"]
        },
        constraints: {
          maxReferenceImages: 7, maxReferenceAudio: 3,
          audioReferencesRequireImageReference: true,
          creditsPerSecondByResolution: { "480p": 10, "720p": 16, "1080p": 29 },
          referenceImageCredits: 1, referenceAudioCredits: 1,
          pricingSnapshotDate: "2026-11-04", creditUsdValue: 0.01,
          source: "https://docs.dev.runwayml.com/guides/models/"
        }
      },
      {
        id: "grok_imagine_1_5_lite",
        name: "Grok Imagine Video 1.5 Lite",
        availability: "disabled",
        executionAdapter: "not_implemented",
        gateway: "runway",
        capabilities: {
          textToVideo: true, imageToVideo: true, videoToVideo: false,
          videoEdit: false, videoExtend: false, videoReframe: false,
          nativeAudio: false, negativePrompt: false, seed: false,
          startFrame: true, endFrame: false, motionReference: false,
          referenceImages: false, referenceVideos: false, referenceAudio: false,
          audioModes: [],
          resolutions: ["480p", "720p", "1080p"]
        },
        constraints: {
          creditsPerSecondByResolution: { "480p": 2, "720p": 3, "1080p": 14 },
          startFrameCredits: 1,
          pricingSnapshotDate: "2026-11-04", creditUsdValue: 0.01,
          source: "https://docs.dev.runwayml.com/guides/models/"
        }
      },
      {
        id: "wan3",
        name: "WAN 3.0",
        availability: "disabled",
        executionAdapter: "not_implemented",
        gateway: "runway",
        capabilities: {
          textToVideo: true, imageToVideo: true, videoToVideo: false,
          videoEdit: false, videoExtend: false, videoReframe: false,
          nativeAudio: true, negativePrompt: false, seed: false,
          startFrame: true, endFrame: false, motionReference: false,
          referenceImages: true, referenceVideos: true, referenceAudio: true,
          audioModes: ["generated", "reference"],
          resolutions: ["480p", "720p", "1080p"],
          minDurationSeconds: 2, maxDurationSeconds: 30
        },
        constraints: {
          creditsPerSecondByResolution: { "480p": 5, "720p": 10, "1080p": 20 },
          pricingSnapshotDate: "2026-11-04", creditUsdValue: 0.01,
          source: "https://docs.dev.runwayml.com/guides/models/"
        }
      },
      {
        id: "wan3_prime",
        name: "WAN 3.0 Prime",
        availability: "disabled",
        executionAdapter: "not_implemented",
        gateway: "runway",
        capabilities: {
          textToVideo: true, imageToVideo: true, videoToVideo: false,
          videoEdit: false, videoExtend: false, videoReframe: false,
          nativeAudio: true, negativePrompt: false, seed: false,
          startFrame: true, endFrame: false, motionReference: false,
          referenceImages: true, referenceVideos: true, referenceAudio: true,
          audioModes: ["generated", "reference"],
          resolutions: ["480p", "720p", "1080p"],
          minDurationSeconds: 2, maxDurationSeconds: 30
        },
        constraints: {
          creditsPerSecondByResolution: { "480p": 6.8, "720p": 14, "1080p": 28 },
          pricingSnapshotDate: "2026-11-04", creditUsdValue: 0.01,
          source: "https://docs.dev.runwayml.com/guides/models/"
        }
      },
      {
        id: "h3_max",
        name: "MiniMax H3 Max",
        availability: "disabled",
        executionAdapter: "not_implemented",
        gateway: "runway",
        capabilities: {
          textToVideo: true, imageToVideo: true, videoToVideo: false,
          videoEdit: false, videoExtend: false, videoReframe: false,
          nativeAudio: true, negativePrompt: false, seed: false,
          startFrame: true, endFrame: true, motionReference: false,
          referenceImages: false, referenceVideos: false, referenceAudio: false,
          audioModes: ["generated"],
          resolutions: ["480p", "768p"]
        },
        constraints: {
          creditsPerSecondByResolution: { "480p": 5, "768p": 8 },
          pricingSnapshotDate: "2026-11-04", creditUsdValue: 0.01,
          source: "https://docs.dev.runwayml.com/guides/models/"
        }
      },
      {
        id: "happyhorse_1_0",
        name: "HappyHorse 1.0",
        availability: "disabled",
        executionAdapter: "not_implemented",
        gateway: "runway",
        capabilities: {
          textToVideo: true, imageToVideo: false, videoToVideo: false,
          videoEdit: false, videoExtend: false, videoReframe: false,
          nativeAudio: true, negativePrompt: false, seed: false,
          startFrame: false, endFrame: false, motionReference: false,
          referenceImages: false, referenceVideos: false, referenceAudio: false,
          audioModes: ["generated"],
          resolutions: ["720p", "1080p"],
          minDurationSeconds: 3, maxDurationSeconds: 15
        },
        constraints: {
          outputAspectRatioCount: 10,
          creditsPerSecondByResolution: { "720p": 15, "1080p": 30 },
          pricingSnapshotDate: "2026-11-04", creditUsdValue: 0.01,
          source: "https://docs.dev.runwayml.com/guides/models/"
        }
      },
      {
        id: "gemini_omni_flash_1.1",
        name: "Gemini Omni Flash 1.1 (Runway Dev)",
        availability: "disabled",
        executionAdapter: "not_implemented",
        gateway: "runway",
        capabilities: {
          textToVideo: true, imageToVideo: true, videoToVideo: true,
          videoEdit: true, videoExtend: false, videoReframe: false,
          nativeAudio: true, negativePrompt: false, seed: false,
          startFrame: true, endFrame: false, motionReference: false,
          referenceImages: true, referenceVideos: true, referenceAudio: true,
          audioModes: ["generated", "reference"],
          resolutions: ["360p", "720p", "1080p", "4k"]
        },
        constraints: {
          creditsPerSecondByResolution: { "360p": 3.4, "720p": 10, "1080p": 15, "4k": 30 },
          referenceImageCredits: 1, inputVideoCreditsPerSecond: 1,
          pricingSnapshotDate: "2026-11-04", creditUsdValue: 0.01,
          source: "https://docs.dev.runwayml.com/guides/models/"
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
          listCreditsPerSecondByResolution: { "720p": 15.7, "1080p": 23.5 },
          inputVideoCreditsPerSecondByResolution: { "720p": 9.4, "1080p": 14.1 },
          billingRounding: "ceil_list_credits_then_discount_then_ceil",
          promotionalDiscountPercent: 20,
          pricingPromotionEndDate: "2026-11-30",
          pricingSnapshotDate: "2026-11-04",
          creditUsdValue: 0.01,
          source: "https://dev.runwayml.com/learn/kling-4-0-api"
        }
      }
    ]
  },
  {
    id: "luma",
    name: "Luma",
    adapterState: "implemented_disabled",
    availability: "disabled",
    remote: true,
    models: [
      {
        id: "ray-3.2",
        name: "Ray 3.2",
        executionAdapter: "luma-ray32-video-adapter",
        executionCapabilities: ["textToVideo", "imageToVideo"],
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
          adapterImplementedOperations: ["video", "text_to_video", "image_to_video"],
          adapterPendingOperations: ["video_edit", "video_extend", "video_reframe"],
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
    id: "kie",
    name: "Kie.ai",
    adapterState: "implemented_disabled",
    availability: "disabled",
    remote: true,
    models: [
      {
        id: "bytedance/seedance-2",
        name: "Seedance 2.0",
        availability: "disabled",
        executionAdapter: "kie-seedance-video-adapter",
        capabilities: {
          textToVideo: true, imageToVideo: true, videoToVideo: false,
          videoEdit: false, videoExtend: false, videoReframe: false,
          nativeAudio: true, negativePrompt: false, seed: false,
          startFrame: true, endFrame: true, motionReference: false,
          referenceImages: true, referenceVideos: false, referenceAudio: false,
          audioModes: ["generated", "none"],
          aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
          resolutions: ["provider_default", "480p", "720p", "1080p", "2160p"],
          minDurationSeconds: 5, maxDurationSeconds: 15
        },
        pricing: {
          currency: "USD", creditUsdValue: 0.005,
          ratesPerSecond: {
            "480p": { withoutVideo: 0.095, withVideo: 0.0575 },
            "720p": { withoutVideo: 0.205, withVideo: 0.125 },
            "1080p": { withoutVideo: 0.51, withVideo: 0.31 },
            "2160p": { withoutVideo: 1.04, withVideo: 0.64 }
          },
          source: "https://kie.ai/seedance-2-0?model=bytedance/seedance-2",
          snapshotDate: "2026-11-05",
          preflightReservation: "output_seconds_or_reference_video_plus_output_seconds",
          actualSettlement: "task_credits_consumed_times_configured_effective_credit_value"
        },
        constraints: {
          maxPromptCharacters: 20000, maxReferenceImages: 9,
          maxReferenceVideos: 3, maxReferenceVideoSeconds: 15,
          maxReferenceAudio: 3, maxReferenceAudioSeconds: 15,
          referenceModesMutuallyExclusive: true,
          minimumPollIntervalMs: 5000, outputUrlTemporary: true,
          asynchronousTaskPolling: true,
          source: "https://docs.kie.ai/market/bytedance/seedance-2"
        }
      }
    ]
  },
  {
    id: "google",
    name: "Google",
    adapterState: "implemented_disabled",
    availability: "disabled",
    remote: true,
    models: [
      {
        id: "gemini-omni-1.1-flash",
        name: "Gemini Omni Flash 1.1",
        availability: "disabled",
        executionAdapter: "google-omni-cloud-video-adapter",
        capabilities: {
          textToVideo: true,
          imageToVideo: true,
          videoToVideo: true,
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
          referenceVideos: true,
          referenceAudio: false,
          audioModes: [],
          aspectRatios: ["16:9", "9:16"],
          resolutions: ["360p", "720p", "1080p", "4k"],
          minDurationSeconds: 3,
          maxDurationSeconds: 10
        },
        pricing: {
          currency: "USD",
          inputUsdPerMillionTokens: 1.50,
          videoOutputUsdPerMillionTokens: 17.50,
          videoOutputTokensPerSecondAt720p: 5792,
          paidTierOnly: true,
          source: "https://ai.google.dev/gemini-api/docs/pricing",
          snapshotDate: "2026-11-05",
          preflightReservation: "maximum_1m_context_plus_10_seconds_720p_output"
        },
        constraints: {
          frameRate: 24,
          supportsConversationalEdits: true,
          lineageField: "previous_interaction_id",
          extensionSecondsPerTurn: 10,
          maxExtendedVideoSeconds: 40,
          uploadedVideoMaxSeconds: 10,
          maxReferenceVideoClips: 3,
          maxReferenceVideoSecondsEach: 3,
          referenceVideoAudioUsed: false,
          audioReferenceUploads: false,
          negativePromptSupported: false,
          outputEncoding: "base64_in_interaction_steps",
          outputUriDeliverySupported: true,
          uriDeliveryRecommendedAboveBytes: 4194304,
          outputIncludesSynthIdWatermark: true,
          source: "https://ai.google.dev/gemini-api/docs/omni",
          paidTierOnly: true,
          apiEndpoint: "https://generativelanguage.googleapis.com/v1beta/interactions"
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
