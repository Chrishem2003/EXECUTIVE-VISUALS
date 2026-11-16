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

## Current mainline capability status

The original text-to-video adapter described above was the first implementation slice, not the current feature boundary. The current durable provider worker and workflow contract have expanded beyond that foundation:

- Direct generation: Gen-4.5, Seedance 2.5, Kling 4.0, Kling 4.0 Flash, Kling 3.0 profiles and Gemini Omni Flash 1.2.
- Source-video operations: Aleph 2, Seedance 2.5, Kling 4.0, Kling 4.0 Flash and Gemini Omni Flash 1.2, with model-specific source duration, resolution and mode validation.
- Seedance 2.5 supports reference, extend and edit modes, 480p draft previews and a separately approved 1080p draft enhancement.
- Gemini Omni Flash 1.2 supports reference, extend and edit modes; edit/extend requests use the provider's automatic source-length behavior and fixed 720p output.
- Private source assets are resolved within the authenticated owner/project boundary, probed server-side, uploaded to Runway's ephemeral storage and then submitted as durable provider tasks.
- Provider task IDs, lease-fenced submission state, private output ingestion and task-level cost reconciliation remain part of the existing durable job path.
- The Video Studio exposes source-video selection, rights confirmation, mode selection and output controls for the supported direct models.

The adapter intentionally does not claim universal Runway feature parity. Remaining model-specific restrictions include direct-worker reference collections that require the separate Model Router path, unsupported Kling 3.0 source-video editing, non-MP4 professional video-edit outputs, and provider-side cancellation where no verified cancellation adapter is registered. Unsupported combinations fail closed.

Tests use mocked provider and storage boundaries; they do not make paid external requests. Remote execution remains disabled unless server-side credentials, model allowlists, cost reconciliation, storage and worker gates are explicitly configured.

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
