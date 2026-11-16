# Runway video adapter — implementation and release boundary

**Date:** 2026-11-07  
**Branch:** `feat/runway-video-provider-foundation`  
**Scope:** First provider-native video generation adapter for Executive Visuals.

## What is implemented in this slice

- A server-only Runway Dev adapter using the documented API version header `2024-11-06`.
- Asynchronous task submission and task polling through `POST /v1/text_to_video` and `GET /v1/tasks/{id}`.
- Bounded polling, output download limits, MP4 signature validation and restricted HTTPS output-host validation.
- Model-specific text-to-video capability profiles for:
  - Runway Gen-4.5 (`gen4.5`)
  - Seedance 2.5 (`seedance2_5`)
  - Kling 4.0 (`kling_4`)
  - Kling 3.0 Standard (`kling3.0_standard`)
  - Kling 3.0 Pro (`kling3.0_pro`)
- Model selector and shared-safe initial controls in the video workspace. Duration, aspect ratio and resolution are validated again on the server.
- Integration with the existing approved workflow executor, remote usage reservation, private generated-asset storage and provenance metadata.
- Deterministic tests with a fake HTTP provider; tests do not make external API calls.

## Explicit limitations

The direct gateway supports text-to-video and first-frame image-to-video for the listed models. The durable provider-aware worker now also registers Seedance 2.5, Kling 4.0 and Kling 3.0 Standard/Pro using those model-specific request builders, plus the existing Aleph2 video-edit, Magnific video-upscale and Ruby HDR source operations. Private source assets are resolved by owner/project scope and uploaded through Runway ephemeral uploads before provider submission. See `DURABLE-SEEDANCE-KLING-WORKER-INTEGRATION.md` for the worker integration boundary. Seedance/Kling video-to-video, last/middle keyframes, multi-shot prompt segmentation, video/audio reference collections and native audio controls are still not complete for those newer profiles; do not expose them as available.

The adapter returns provider cost metadata when Runway supplies it, but Executive Visuals does not yet calculate customer-facing prices, reserve subscription credits, or reconcile provider charges against a subscription ledger.

## Configuration

The adapter is disabled unless the server is explicitly configured:

```dotenv
VIDEO_GATEWAY_PROVIDER=runway
VIDEO_GATEWAY_ENABLED=true
VIDEO_GATEWAY_ALLOW_REMOTE=true
RUNWAYML_API_SECRET=<server-side secret>
RUNWAY_VIDEO_MODEL=seedance2_5
VIDEO_GATEWAY_TIMEOUT_MS=300000
```

Do not put the API secret in browser code, a workflow graph, a public repository, or user-visible logs. No key is committed by this change. No external request is made by tests or by deployment.

## Model behaviour and validation

The provider/model capability declarations are deliberately narrower than the complete Runway API. They represent only the first text-to-video request shape used here. Unsupported inputs fail closed instead of being silently ignored. The model list is sourced from the current Runway Dev API reference and input documentation; recheck provider documentation before adding model versions or new request fields.

## Operational notes

- Runway output URLs are ephemeral; the adapter downloads the result immediately and stores the MP4 in the existing private generated-asset path.
- The current production Render service is on the Free plan and has no durable disk. Do not enable paid remote generation on that service as a customer-facing production feature until durable storage, credit accounting, queue capacity and recovery have passed release gates.
- The application subscription and provider generation charges are separate economic systems. Never promise unlimited video generation under a fixed subscription without a verified margin model.

## Official provider references

- API reference: https://docs.dev.runwayml.com/api/
- API input parameters and model-specific limits: https://docs.dev.runwayml.com/assets/inputs/
- Output URLs and expiry: https://docs.dev.runwayml.com/assets/outputs/
- Current model catalogue: https://docs.dev.runwayml.com/guides/models/
- Pricing: https://docs.dev.runwayml.com/guides/pricing/
- Seedance 2.5 API availability and modes: https://docs.dev.runwayml.com/api-details/api_changelog/
