# Runway Dev model catalog reverse-engineering snapshot

**Research date:** 2026-11-04  
**Scope:** Public Runway Dev API model catalog, model identifiers, documented capabilities, pricing formulas, and integration implications for Executive Visuals.  
**Implementation state:** Metadata-only catalog expansion. All newly listed models remain disabled and have no production adapter.

## Why this matters

The existing Runway adapter is deliberately limited to Gen-4.5. The current official Runway Dev API catalog is materially broader: it exposes models from Runway and other labs behind one API, including Kling, Seedance, Gemini, MiniMax, Alibaba and xAI. The official API guide enumerates 60 models while the product catalog landing page currently reports 64; treat both as live catalog surfaces, not a fixed count.

Sources:
- Model list and exact API model identifiers: https://docs.dev.runwayml.com/guides/models/
- Model catalog and capabilities: https://dev.runwayml.com/models/catalog
- Current credits and pricing formulas: https://docs.dev.runwayml.com/guides/pricing/
- API reference and task endpoints: https://docs.dev.runwayml.com/api/
- Output lifecycle: https://docs.dev.runwayml.com/assets/outputs/
- Attribution requirements: https://docs.dev.runwayml.com/usage/attribution/

## Catalog additions represented in the code registry

These records are **catalog-only**. They are not a claim that the corresponding adapter, request validation, cost estimator, output handling, or UI is implemented.

| API model ID | Model | Documented capability surface | Pricing contract to preserve | Implementation priority |
|---|---|---|---|---|
| `gen4_turbo` | Gen-4 Turbo | Image-to-video | 5 credits/second | P1: low-cost image-to-video after Gen-4.5 |
| `aleph2` | Aleph 2.0 | In-context video editing; keyframe-guided control | 28 credits/second; 56-credit minimum | P1: edit existing footage |
| `kling_4` | Kling 4.0 via Runway Dev | Text/image/video inputs; video editing; 720p/1080p; 3–30 seconds; native audio | Resolution-dependent; input-video billing; temporary 20% discount ends 2026-11-30 UTC | P1/P2: rich references and longer clips |
| `seedance2_5` | Seedance 2.5 via Runway Dev | Text/image/video generation and edit/extend modes; up to 30 seconds; 480p/720p/1080p; draft preview then 1080p enhancement | Output duration plus input/reference-video duration; resolution-specific rates; 80-credit minimum | P1/P2: efficient draft-and-enhance workflow |
| `gemini_omni_flash_1.1` | Gemini Omni Flash 1.1 via Runway Dev | Multimodal video with native audio, reference images/video and resolution tiers | Resolution-specific output rate plus reference-image and input-video charges | P2: conversational and multimodal workflows |

The existing direct-provider research records for Kling and Google remain separate. A model routed through Runway Dev is not interchangeable with a direct Kling or Google adapter: authentication, API request shapes, billing, task state, output URLs, and provider support responsibilities differ.

## Pricing details captured on 2026-11-04

Runway Dev credits are listed at USD $0.01 per credit. Pricing is not uniformly “seconds × one flat rate”; model-specific input assets, resolution, audio, minimum charges, promotions and output formats can alter the total.

### Selected model formulas

- **Gen-4.5:** 12 credits per output second.
- **Gen-4 Turbo:** 5 credits per output second.
- **Aleph 2.0:** 28 credits per second, with a 56-credit minimum.
- **Kling 4.0:** 720p is temporarily discounted through 2026-11-30 UTC to 12.56 credits/second without input video; with input video, 7.52 credits/second of output plus 7.52 credits/second of the greater of total input-video duration and output duration. 1080p uses 18.8 credits/second without input video or 11.28 plus 11.28 for the duration basis with input video. List prices apply from 2026-12-01 UTC.
- **Seedance 2.5:** 480p is 20 credits/second of output plus 10 credits/second of input/reference video; 720p is 30 plus 15; 1080p is 68 plus 34. Combined input/reference video is capped at 30 seconds, reference images and audio are free, and the minimum is 80 credits. Draft mode uses the 480p rate; enhancement to 1080p is a second billable request.
- **Gemini Omni Flash 1.1:** 360p is 3.4 credits/second, 720p 10, 1080p 15, and 4K 30; add 1 credit per reference image and 1 credit per second of input video.

Never copy these numbers into a task-level actual-cost ledger. They are published list-price rules as of the snapshot date. A user-facing estimate must be versioned and must include all request settings and reference-media charges. Actual settlement requires authoritative task-correlated usage evidence; an estimate is not an invoice.

## Model Router: a potential task-level cost evidence path

Runway Dev now documents a Model Router API. A named router can constrain eligible models, optimize for cost/latency/quality, set a maximum credit cap per generation, and accept a no-bill `dryRun` request. A successful live routed response reports the selected model, config ID, optimization preference, and realized cost in credits. The router request-history endpoint also exposes request IDs, selected model, estimated credits and task IDs.

This is materially stronger than the direct adapter's preflight estimate and daily/model/API-key aggregate usage for cost attribution. It may provide a task-correlated settlement source, but the exact live response schema and lifecycle timing must be contract-tested before implementing `resolveActualCost`. Do not infer a field name from prose or treat `estimatedCost` / dry-run `estimatedCost` as realized usage.

Recommended route contract:
1. Configure a server-owned router in the Runway Developer Portal with an explicit model allowlist (start with Gen-4.5 only), cost optimization, and a conservative per-generation credit cap.
2. Persist the router config ID/version and dry-run routing decision with the user's approval and budget reservation.
3. Submit the identical live request through `POST /v1/generate/video` and persist the returned provider task ID, selected model and realized-cost evidence reference.
4. Validate the returned cost field against the approved reservation; if absent, malformed, or above the approved ceiling, quarantine the job and keep the budget unsettled.
5. Keep a direct-model adapter only as a separately gated route; do not silently fall back between direct and routed requests after an ambiguous POST.

Sources:
- https://docs.dev.runwayml.com/model-routers/
- https://docs.dev.runwayml.com/model-routers/generating/
- https://docs.dev.runwayml.com/api/

## Additional API capabilities beyond generation

The official API reference exposes separate endpoints or model families for:

- Video-to-video generation and editing.
- Image upscaling and video upscaling.
- Video-to-HDR conversion.
- Frame-rate enhancement.
- Character control and avatar video generation from text or audio.
- Sound-effect generation and audio-from-video generation.
- Text-to-speech, speech-to-speech, voice dubbing and voice isolation.
- Task retrieval and cancellation/deletion.
- File upload and reusable provider-side inputs.
- Model Router, including routed video/image/audio generation.
- Published workflow execution and invocation status.

These map naturally to existing Executive Visuals workspaces: asset preparation, timeline finishing, character/voice production, audio post, and workflow orchestration. They should be represented as distinct typed operations, not hidden under a generic “generate video” button.

## Output and governance implications

1. Runway task results return output URLs that expire within 24–48 hours after accessing the task API. Download immediately into the platform's private asset store; never persist or expose the provider URL as a durable asset link.
2. Keep model IDs, API version, normalized request hash, provider task ID, usage receipt and output checksums in the job provenance.
3. Implement exact per-model request schemas and price formulas before exposing a model in the selector.
4. Reserve a maximum approved budget before submission. Reconcile provider-reported task usage against task-level authoritative evidence before marking a job financially settled.
5. Maintain provider/model feature flags off by default and fail closed when an adapter, pricing contract, private asset reader, output ingestor, or cost evidence resolver is missing.
6. Runway's attribution guide requires the phrase **“Powered by Runway”** with a link to Runwayml.com when attributing the integration in the UI.
7. Provider cancellation is not a guaranteed refund. Treat cancellation and billing as separate states.

## Implementation sequence

1. Finish and verify the existing Gen-4.5 text/image-to-video adapter, private input resolver, secure output ingestion and cloud job lifecycle.
2. Implement a model-contract test harness that validates each model's accepted fields, duration, aspect ratio, resolution, reference-media types and pricing formula without live calls.
3. Add Gen-4 Turbo and Aleph 2.0 adapters as separate operations, retaining their different input and output contracts.
4. Add Seedance 2.5 draft/upgrade and video-to-video modes, including the two-charge preview/enhancement lifecycle.
5. Add Kling 4.0 and Gemini Omni Flash 1.1 with explicit video-reference and native-audio handling.
6. Add video upscaling, frame-rate enhancement and HDR as finishing jobs that create new private derivative assets and preserve source provenance.
7. Add character, speech and sound-effect workflows only after voice/likeness consent, rights metadata and provider-specific billing are modeled.
8. Add Model Router only after dry-run cost ceilings, routing provenance, provider fallback rules and task-level cost reconciliation are proven.

No model in this snapshot is enabled. This document does not authorize credentials, provider calls, paid generations, migrations, deployment or merge.
