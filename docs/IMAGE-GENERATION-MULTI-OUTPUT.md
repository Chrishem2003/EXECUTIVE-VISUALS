# Image generation variations and workflow asset fan-out

**Reviewed:** 2026-11-07  
**Scope:** OpenAI-compatible image gateway and workflow engine

## Supported behavior

The OpenAI-compatible image gateway and gated Runway Model Router accept `outputCount` from 1 through 4. It sends that value as the Images API `n` parameter and validates that the response contains exactly the requested number of base64 image payloads. Each image is independently validated and persisted through `storeGeneratedImage`, producing its own private asset row, UUID, checksum and storage path.

The workflow image-generation node keeps the original `image` output as the first generated asset for backward compatibility. It additionally exposes `images` as a multi-value asset output. Connect `images` to the existing Batch Inputs node to pass all variations into downstream workflow steps.

## Provider-specific constraints

- OpenAI-compatible image endpoints: 1–4 outputs per request, subject to the configured model's own API limits.
- Runway direct `POST /v1/text_to_image` adapter: one output per task in this implementation.
- Runway Model Router `POST /v1/generate/image`: 1–4 outputs are supported in this workflow through a saved config slug. The adapter performs a `dryRun: true` preflight and uses the returned estimated credits for customer-credit reservation before creating the task. Router output is polled, validated and persisted as private assets. The provider's task-level actual cost is captured in the execution result but still requires task-correlated settlement reconciliation before production release.
- Runway Model Router `POST /v1/generate/image`: the public API documents `outputCount` 1–4. This route requires a saved Model Router `configId`; it is not silently substituted for the existing model-specific direct adapter.
- Gemini and FAL adapters: one output per workflow node until their model-specific multi-output contracts are implemented and tested.

## Billing and execution controls

The workflow reserves remote usage and model-specific estimated credits before provider dispatch. The requested output count is passed as the billing quantity for the OpenAI-compatible path. These are preflight estimates, not provider settlement. Remote provider execution remains disabled unless the server-side gateway is enabled and remote opt-in is true.

A provider response with fewer or more images than requested is rejected. No incomplete image collection is silently marked successful. The workflow's primary `image` output remains a single asset ID, while the `images` output carries the full asset-ID array.

## Storage and privacy

Generated image bytes are validated and saved as private application assets; the provider's temporary output URL is not exposed to users. Every variation receives its own asset record and checksum. The current local media-root storage still requires durable private object storage and backup/restore acceptance before production release.

## Official API references

- OpenAI image generation: https://developers.openai.com/api/docs/guides/image-generation — documents the `n` parameter and multi-turn image editing.
- Runway API reference: https://docs.dev.runwayml.com/api/ — documents direct image tasks and the Model Router image endpoint, including `outputCount`.
- Runway output formats: https://docs.dev.runwayml.com/assets/outputs/ — provider output URLs are temporary and must be copied to application-owned storage.
- Gemini image generation: https://ai.google.dev/gemini-api/docs/image-generation — documents response modalities, reference-image constraints and that the requested number of image outputs is not always followed.

## Release status

This implementation is code-complete only after the current branch's CI passes. It is not a production enablement. Dedicated staging storage, payment sandbox acceptance, provider settlement evidence, and production backup/restore remain separate release gates.
