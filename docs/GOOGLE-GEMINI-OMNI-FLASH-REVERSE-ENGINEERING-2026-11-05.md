# Gemini Omni Flash — reverse-engineered integration contract

Research snapshot: 2026-11-05. Sources are Google's current Gemini API documentation. This branch adds a request planner and raw REST response normalizer only; it does not make a provider request.

## Critical migration finding

Google shut down the Gemini API Veo 3.1 Preview endpoints on October 22, 2026. Google recommends Gemini Omni Flash (`gemini-omni-1.1-flash`) for general video generation and conversational editing, or GA Veo models through the Gemini Enterprise Agent Platform. Do not route new Gemini API traffic to the retired preview model IDs.

## Current API shape

- Endpoint: `POST https://generativelanguage.googleapis.com/v1beta/interactions`
- Authentication: server-side Google API key via `x-goog-api-key`
- Model: `gemini-omni-1.1-flash`
- Input: text or multimodal content parts (image/video URI plus text)
- Output: `response_format: { type: "video", aspect_ratio, resolution, delivery }`
- Aspect ratios: 16:9 and 9:16
- Resolutions: 360p, 720p (default), 1080p and 4k (upscaled)
- Output length: 3–10 seconds per generation; extensions can add up to 10 seconds, up to 40 seconds total
- Stateful edits: `previous_interaction_id`
- Raw REST video output: `steps[].content[]` with `type: "video"`, `mime_type: "video/mp4"`, and either `data` (base64) or `uri`
- URI delivery is recommended for outputs larger than 4 MB; Google-hosted files must be polled until ACTIVE before download.

## Media and limitations

- Uploaded source videos for editing/extension are limited to 10 seconds.
- Up to three reference video clips are supported, each up to three seconds.
- Audio from reference videos is ignored.
- Audio-reference uploads are not supported.
- Generated videos include native audio.
- Negative prompts, system instructions, temperature, and top-p are not supported.
- Video extension appends to the end; it cannot prepend or extend the middle.
- Editing or extending uploaded videos has regional availability restrictions (EEA, Switzerland and UK); generated-video multi-turn edits remain supported.
- Outputs include SynthID provenance watermarking.

## Implementation

- `server/google-omni-flash-interaction.mjs`
  - Builds a pure request plan for the Interactions API.
  - Uses only private asset IDs, authenticated owner/project context, and a server-side Google Files URI resolver.
  - Rejects arbitrary URLs and malformed Google Files URIs.
  - Enforces source/reference video duration limits.
  - Supports first/last frame interpolation and previous-interaction lineage.
  - Normalizes the documented raw REST `steps` response, not the SDK-only `output_video` convenience property.
  - Caps inline response size and recommends URI delivery for large outputs.
  - Does not send requests, load credentials, upload media, or download outputs.
- `server/video-provider-registry.mjs`
  - Updates current Omni capabilities and documents its constraints.
  - Keeps the provider disabled and adapter marked not implemented.
- `server/tests/google-omni-flash-interaction.test.mjs`
  - Covers request planning, project authorization, media URI validation, durations, response normalization and failure cases.

## Executive Visuals integration boundary

This provider should plug into the shared video generation contract and durable cloud worker lifecycle. A live adapter must not be enabled until the app can guarantee:

1. Authenticated owner/project authorization for every input asset.
2. Explicit user approval and a durable budget reservation before POST.
3. One-shot idempotent submission (never retry a POST after an ambiguous timeout without reconciliation).
4. Durable interaction ID and state tracking.
5. Private ingestion of Google-hosted output before user delivery.
6. Output validation, actual-cost reconciliation, audit evidence and retention/cleanup.
7. Region-aware gating for uploaded-video editing/extension.

Google API credentials must remain server-side. The planner's placeholder header is documentation only and must never be sent as a real credential.
