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
          aspectRatios: ["16:9", "9:16"],
          resolutions: ["provider_default"],
          minDurationSeconds: 2,
          maxDurationSeconds: 10
        },
        constraints: {
          promptMaxCharacters: 1000,
          durationStepSeconds: 1,
          outputUrlTemporary: true,
          minimumPollIntervalMs: 5000,
          cancellation: "best_effort"
        }
      },
      {
        id: "gen4_turbo",
        name: "Gen-4 Turbo",
        availability: "disabled",
        implementationState: "catalog_only",
        capabilities: {
          textToVideo: false,
          imageToVideo: true,
          videoToVideo: false,
          videoEdit: false,
          nativeAudio: false
        },
        constraints: {
          apiModelId: "gen4_turbo",
          creditsPerSecond: 5,
          outputUrlTemporary: true,
          source: "https://docs.dev.runwayml.com/guides/models/"
        }
      },
      {
        id: "aleph2",
        name: "Aleph 2.0",
        availability: "disabled",
        implementationState: "catalog_only",
        capabilities: {
          textToVideo: false,
          imageToVideo: false,
          videoToVideo: true,
          videoEdit: true,
          keyframeGuided: true
        },
        constraints: {
          apiModelId: "aleph2",
          creditsPerSecond: 28,
          minimumCreditsPerGeneration: 56,
          source: "https://docs.dev.runwayml.com/guides/models/"
        }
      },
      {
        id: "kling_4",
        name: "Kling 4.0 via Runway Dev",
        availability: "disabled",
        implementationState: "catalog_only",
        originProvider: "kling",
        capabilities: {
          textToVideo: true,
          imageToVideo: true,
          videoToVideo: true,
          videoEdit: true,
          nativeAudio: true,
          referenceImages: true,
          referenceVideos: true,
          resolutions: ["720p", "1080p"],
          minDurationSeconds: 3,
          maxDurationSeconds: 30
        },
        constraints: {
          apiModelId: "kling_4",
          billingModel: "resolution_and_input_output_video_duration",
          temporaryDiscountEnds: "2026-11-30",
          source: "https://docs.dev.runwayml.com/guides/pricing/"
        }
      },
      {
        id: "seedance2_5",
        name: "Seedance 2.5 via Runway Dev",
        availability: "disabled",
        implementationState: "catalog_only",
        originProvider: "bytedance",
        capabilities: {
          textToVideo: true,
          imageToVideo: true,
          videoToVideo: true,
          nativeAudio: true,
          referenceImages: true,
          referenceVideos: true,
          resolutions: ["480p", "720p", "1080p"],
          maxDurationSeconds: 30
        },
        constraints: {
          apiModelId: "seedance2_5",
          draftPreview: true,
          draftEnhancement: "1080p",
          billingModel: "resolution_output_plus_input_and_reference_video_duration",
          minimumCreditsPerGeneration: 80,
          source: "https://docs.dev.runwayml.com/guides/models/"
        }
      },
      {
        id: "gemini_omni_flash_1.1",
        name: "Gemini Omni Flash 1.1 via Runway Dev",
        availability: "disabled",
        implementationState: "catalog_only",
        originProvider: "google",
        capabilities: {
          textToVideo: true,
          imageToVideo: true,
          videoToVideo: true,
          nativeAudio: true,
          referenceImages: true,
          referenceVideos: true,
          resolutions: ["360p", "720p", "1080p", "2160p"]
        },
        constraints: {
          apiModelId: "gemini_omni_flash_1.1",
          billingModel: "resolution_plus_reference_images_and_input_video_duration",
          source: "https://docs.dev.runwayml.com/guides/pricing/"
        }
      },
      {
        "id": "seedance2",
        "name": "Seedance 2.0",
        "availability": "disabled",
        "implementationState": "catalog_only",
        "originProvider": "bytedance",
        "capabilities": {
          "textToVideo": true,
          "imageToVideo": true,
          "videoToVideo": true,
          "nativeAudio": true,
          "referenceImages": true,
          "referenceVideos": true
        },
        "constraints": {
          "apiModelId": "seedance2",
          "source": "https://docs.dev.runwayml.com/guides/models/"
        }
      },
      {
        "id": "seedance2_fast",
        "name": "Seedance 2.0 Fast",
        "availability": "disabled",
        "implementationState": "catalog_only",
        "originProvider": "bytedance",
        "capabilities": {
          "textToVideo": true,
          "imageToVideo": true,
          "videoToVideo": true,
          "nativeAudio": true,
          "referenceImages": true,
          "referenceVideos": true,
          "resolutions": [
            "480p",
            "720p"
          ]
        },
        "constraints": {
          "apiModelId": "seedance2_fast",
          "source": "https://docs.dev.runwayml.com/guides/models/"
        }
      },
      {
        "id": "seedance2_mini",
        "name": "Seedance 2.0 Mini",
        "availability": "disabled",
        "implementationState": "catalog_only",
        "originProvider": "bytedance",
        "capabilities": {
          "textToVideo": true,
          "imageToVideo": true,
          "videoToVideo": true,
          "nativeAudio": true,
          "referenceImages": true,
          "referenceVideos": true,
          "resolutions": [
            "480p",
            "720p"
          ]
        },
        "constraints": {
          "apiModelId": "seedance2_mini",
          "source": "https://docs.dev.runwayml.com/guides/models/"
        }
      },
      {
        "id": "kling3.0_pro",
        "name": "Kling 3.0 Pro",
        "availability": "disabled",
        "implementationState": "catalog_only",
        "originProvider": "kling",
        "capabilities": {
          "textToVideo": true,
          "imageToVideo": true,
          "nativeAudio": true,
          "startFrame": true,
          "endFrame": true,
          "multiShot": true,
          "resolutions": [
            "1080p"
          ],
          "minDurationSeconds": 3,
          "maxDurationSeconds": 15
        },
        "constraints": {
          "apiModelId": "kling3.0_pro",
          "source": "https://docs.dev.runwayml.com/guides/models/"
        }
      },
      {
        "id": "kling3.0_standard",
        "name": "Kling 3.0 Standard",
        "availability": "disabled",
        "implementationState": "catalog_only",
        "originProvider": "kling",
        "capabilities": {
          "textToVideo": true,
          "imageToVideo": true,
          "nativeAudio": true,
          "startFrame": true,
          "endFrame": true,
          "multiShot": true,
          "resolutions": [
            "720p"
          ],
          "minDurationSeconds": 3,
          "maxDurationSeconds": 15
        },
        "constraints": {
          "apiModelId": "kling3.0_standard",
          "source": "https://docs.dev.runwayml.com/guides/models/"
        }
      },
      {
        "id": "kling3.0_4k",
        "name": "Kling 3.0 4K",
        "availability": "disabled",
        "implementationState": "catalog_only",
        "originProvider": "kling",
        "capabilities": {
          "textToVideo": true,
          "imageToVideo": true,
          "nativeAudio": true,
          "startFrame": true,
          "endFrame": true,
          "multiShot": true,
          "resolutions": [
            "4k"
          ],
          "minDurationSeconds": 3,
          "maxDurationSeconds": 15
        },
        "constraints": {
          "apiModelId": "kling3.0_4k",
          "source": "https://docs.dev.runwayml.com/guides/models/"
        }
      },
      {
        "id": "klingO3_pro",
        "name": "Kling O3 Pro",
        "availability": "disabled",
        "implementationState": "catalog_only",
        "originProvider": "kling",
        "capabilities": {
          "textToVideo": true,
          "imageToVideo": true,
          "videoToVideo": true,
          "nativeAudio": true,
          "referenceImages": true,
          "resolutions": [
            "1080p"
          ]
        },
        "constraints": {
          "apiModelId": "klingO3_pro",
          "source": "https://docs.dev.runwayml.com/guides/models/"
        }
      },
      {
        "id": "klingO3_standard",
        "name": "Kling O3 Standard",
        "availability": "disabled",
        "implementationState": "catalog_only",
        "originProvider": "kling",
        "capabilities": {
          "textToVideo": true,
          "imageToVideo": true,
          "videoToVideo": true,
          "nativeAudio": true,
          "referenceImages": true,
          "resolutions": [
            "720p"
          ]
        },
        "constraints": {
          "apiModelId": "klingO3_standard",
          "source": "https://docs.dev.runwayml.com/guides/models/"
        }
      },
      {
        "id": "klingO3_4k",
        "name": "Kling O3 4K",
        "availability": "disabled",
        "implementationState": "catalog_only",
        "originProvider": "kling",
        "capabilities": {
          "textToVideo": true,
          "imageToVideo": true,
          "videoToVideo": true,
          "nativeAudio": true,
          "referenceImages": true,
          "resolutions": [
            "4k"
          ]
        },
        "constraints": {
          "apiModelId": "klingO3_4k",
          "source": "https://docs.dev.runwayml.com/guides/models/"
        }
      },
      {
        "id": "kling2.5_turbo_pro",
        "name": "Kling 2.5 Turbo Pro",
        "availability": "disabled",
        "implementationState": "catalog_only",
        "originProvider": "kling",
        "capabilities": {
          "textToVideo": true,
          "imageToVideo": true,
          "startFrame": true,
          "endFrame": true,
          "supportedDurationsSeconds": [
            5,
            10
          ]
        },
        "constraints": {
          "apiModelId": "kling2.5_turbo_pro",
          "source": "https://docs.dev.runwayml.com/guides/models/"
        }
      },
      {
        "id": "hailuo3",
        "name": "MiniMax H3",
        "availability": "disabled",
        "implementationState": "catalog_only",
        "originProvider": "minimax",
        "capabilities": {
          "textToVideo": true,
          "imageToVideo": true,
          "videoToVideo": true,
          "referenceImages": true,
          "referenceVideos": true,
          "referenceAudio": true
        },
        "constraints": {
          "apiModelId": "hailuo3",
          "source": "https://docs.dev.runwayml.com/guides/models/"
        }
      },
      {
        "id": "h3_max",
        "name": "MiniMax H3 Max",
        "availability": "disabled",
        "implementationState": "catalog_only",
        "originProvider": "minimax",
        "capabilities": {
          "textToVideo": true,
          "imageToVideo": true,
          "nativeAudio": true,
          "startFrame": true,
          "endFrame": true,
          "resolutions": [
            "480p",
            "768p"
          ]
        },
        "constraints": {
          "apiModelId": "h3_max",
          "source": "https://docs.dev.runwayml.com/guides/models/"
        }
      },
      {
        "id": "wan3",
        "name": "WAN 3.0",
        "availability": "disabled",
        "implementationState": "catalog_only",
        "originProvider": "alibaba",
        "capabilities": {
          "textToVideo": true,
          "imageToVideo": true,
          "videoToVideo": true,
          "nativeAudio": true,
          "referenceImages": true,
          "referenceVideos": true,
          "referenceAudio": true,
          "resolutions": [
            "480p",
            "720p",
            "1080p"
          ],
          "minDurationSeconds": 2,
          "maxDurationSeconds": 30
        },
        "constraints": {
          "apiModelId": "wan3",
          "source": "https://docs.dev.runwayml.com/guides/models/"
        }
      },
      {
        "id": "wan3_prime",
        "name": "WAN 3.0 Prime",
        "availability": "disabled",
        "implementationState": "catalog_only",
        "originProvider": "alibaba",
        "capabilities": {
          "textToVideo": true,
          "imageToVideo": true,
          "videoToVideo": true,
          "nativeAudio": true,
          "referenceImages": true,
          "referenceVideos": true,
          "referenceAudio": true,
          "resolutions": [
            "480p",
            "720p",
            "1080p"
          ],
          "minDurationSeconds": 2,
          "maxDurationSeconds": 30
        },
        "constraints": {
          "apiModelId": "wan3_prime",
          "source": "https://docs.dev.runwayml.com/guides/models/"
        }
      },
      {
        "id": "grok_imagine_1_5",
        "name": "Grok Imagine Video 1.5",
        "availability": "disabled",
        "implementationState": "catalog_only",
        "originProvider": "xai",
        "capabilities": {
          "textToVideo": true,
          "imageToVideo": true,
          "nativeAudio": true,
          "referenceImages": true,
          "audioDrivenPerformance": true
        },
        "constraints": {
          "apiModelId": "grok_imagine_1_5",
          "source": "https://docs.dev.runwayml.com/guides/models/"
        }
      },
      {
        "id": "grok_imagine_1_5_lite",
        "name": "Grok Imagine Video 1.5 Lite",
        "availability": "disabled",
        "implementationState": "catalog_only",
        "originProvider": "xai",
        "capabilities": {
          "textToVideo": true,
          "imageToVideo": true,
          "resolutions": [
            "480p",
            "720p",
            "1080p"
          ]
        },
        "constraints": {
          "apiModelId": "grok_imagine_1_5_lite",
          "source": "https://docs.dev.runwayml.com/guides/models/"
        }
      },
      {
        "id": "happyhorse_1_0",
        "name": "HappyHorse 1.0",
        "availability": "disabled",
        "implementationState": "catalog_only",
        "originProvider": "alibaba",
        "capabilities": {
          "textToVideo": true,
          "imageToVideo": true,
          "nativeAudio": true,
          "aspectRatioCount": 10,
          "minDurationSeconds": 3,
          "maxDurationSeconds": 15
        },
        "constraints": {
          "apiModelId": "happyhorse_1_0",
          "source": "https://docs.dev.runwayml.com/guides/models/"
        }
      },
      {
        "id": "veo3.1",
        "name": "Veo 3.1",
        "availability": "disabled",
        "implementationState": "catalog_only",
        "originProvider": "google",
        "capabilities": {
          "textToVideo": true,
          "imageToVideo": true,
          "nativeAudio": true
        },
        "constraints": {
          "apiModelId": "veo3.1",
          "source": "https://docs.dev.runwayml.com/guides/models/"
        }
      },
      {
        "id": "veo3.1_fast",
        "name": "Veo 3.1 Fast",
        "availability": "disabled",
        "implementationState": "catalog_only",
        "originProvider": "google",
        "capabilities": {
          "textToVideo": true,
          "imageToVideo": true,
          "nativeAudio": true
        },
        "constraints": {
          "apiModelId": "veo3.1_fast",
          "source": "https://docs.dev.runwayml.com/guides/models/"
        }
      },
      {
        "id": "gemini_omni_flash",
        "name": "Gemini Omni Flash",
        "availability": "disabled",
        "implementationState": "catalog_only",
        "originProvider": "google",
        "capabilities": {
          "textToVideo": true,
          "imageToVideo": true,
          "videoToVideo": true,
          "videoEdit": true,
          "nativeAudio": true
        },
        "constraints": {
          "apiModelId": "gemini_omni_flash",
          "source": "https://docs.dev.runwayml.com/guides/models/"
        }
      },
      {
        "id": "act_two",
        "name": "Act-Two",
        "availability": "disabled",
        "implementationState": "catalog_only",
        "originProvider": "runway",
        "capabilities": {
          "imageToVideo": true,
          "videoToVideo": true,
          "motionCapture": true
        },
        "constraints": {
          "apiModelId": "act_two",
          "source": "https://docs.dev.runwayml.com/guides/models/"
        }
      },
      {
        "id": "magnific_video_upscaler_creative",
        "name": "Magnific Video Upscaler",
        "availability": "disabled",
        "implementationState": "catalog_only",
        "originProvider": "magnific",
        "capabilities": {
          "videoUpscale": true,
          "outputResolution": "up_to_4k",
          "frameRateBoost": true
        },
        "constraints": {
          "apiModelId": "magnific_video_upscaler_creative",
          "operationType": "video_upscale",
          "source": "https://docs.dev.runwayml.com/guides/models/"
        }
      },
      {
        "id": "enhance_frame_rate",
        "name": "Enhance Frame Rate",
        "availability": "disabled",
        "implementationState": "catalog_only",
        "originProvider": "runway",
        "capabilities": {
          "frameRateConversion": true
        },
        "constraints": {
          "apiModelId": "enhance_frame_rate",
          "operationType": "frame_rate_enhancement",
          "source": "https://docs.dev.runwayml.com/guides/models/"
        }
      },
      {
        "id": "ruby",
        "name": "Ruby HDR",
        "availability": "disabled",
        "implementationState": "catalog_only",
        "originProvider": "runway",
        "capabilities": {
          "videoHdr": true,
          "outputFormats": [
            "hevc",
            "prores",
            "exr_sequence"
          ]
        },
        "constraints": {
          "apiModelId": "ruby",
          "operationType": "video_hdr",
          "source": "https://docs.dev.runwayml.com/guides/models/"
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
          videoToVideo: false,
          videoEdit: true,
          videoExtend: true,
          videoReframe: true,
          nativeAudio: false,
          negativePrompt: false,
          seed: false,
          startFrame: false,
          endFrame: false,
          motionReference: false,
          referenceImages: true,
          audioModes: [],
          minDurationSeconds: 5,
          maxDurationSeconds: 10
        },
        constraints: {
          supportedDurationsSeconds: [5, 10],
          maxKeyframes: 64,
          outputUrlExpirySeconds: 3600,
          cancellation: "unsupported"
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
