# Video Provider Reverse-Engineering Matrix

**Research snapshot:** 2026-11-04  
**Scope:** Public developer APIs and capabilities relevant to Executive Visuals. This is an API capability study, not a copy of provider-owned UI, assets, prompts, or source code.

## Executive decision

Build a **provider-neutral generation gateway** inside Executive Visuals. Do not hard-wire the editor to a single provider or expose provider credentials in the browser. Use a capability registry and explicit provider adapters behind the existing job, approval, usage, asset, and audit boundaries.

Recommended initial adapter order:

1. **Runway Dev** — strongest first integration candidate because its API has broad model coverage, task management, workflow endpoints, and Model Router dry-runs with hard credit ceilings.
2. **Luma Agents / Ray 3.2** — strong second adapter for multi-keyframe generation, video editing, reframing, and predictable per-request pricing.
3. **Kling 4.0** — direct adapter after a schema and billing validation pass; it offers 30-second output and a rich mixed-media reference surface. Runway already exposes Kling models, so compare direct-vs-routed costs and feature parity before duplicating integration effort.
4. **Google Gemini Omni Flash** — strategic multimodal conversational-editing adapter; its Interactions API and previous-interaction chaining need a dedicated conversation-to-asset lifecycle.
5. **OpenAI Sora** — do not implement against the retired Sora 2 Videos API. As of this snapshot, current official deprecation documentation lists shutdown on 2026-09-24 and does not name a replacement video-generation API. Re-check official availability before implementation.

All providers remain **disabled by default**. This research does not authorize account creation, credential entry, test generations, billing, or paid usage.

## Capability matrix

| Provider / API | Verified capabilities | Async / lifecycle | Cost and safety implications | Recommendation |
|---|---|---|---|---|
| Runway Dev | Text/image-to-video; video-to-video; broad catalog including Gen-4.5, Kling 4, Seedance 2.5, Veo 3.1, Gemini Omni Flash and others; model-agnostic routers; image/video/audio endpoints; published workflows | POST generation returns task; GET `/v1/tasks/{id}`; DELETE can cancel/delete. Polling more often than every 5 seconds is discouraged. | Credits are $0.01 each at list price; per-model rates vary. Router can enforce per-generation credit ceilings and dry-run eligibility/cost. Cancellation does not guarantee refund. Output URLs are ephemeral (24–48 hours after access): ingest output into private storage immediately. | **P1 first adapter**; use direct model calls for fixed workflows and Model Router for cost/latency/quality routing. |
| Luma Agents / Ray 3.2 | Text/image-to-video with start/end anchors and up to 64 indexed keyframes; video edit; extend; reframe; HDR and EXR options; 540p/720p/1080p documented video tiers; 5s/10s. 360p appears as a draft pricing tier, not in the model capability table. | POST `/v1/generations`; poll GET `/v1/generations/{id}`; asynchronous submit-poll-download. No cancel endpoint; active job TTL is 1 hour. Output URLs are presigned for 1 hour. | Standard generation list prices: $0.15/$0.30/$1.20 for 5s at 540p/720p/1080p; 10s: $0.45/$0.90/$3.60. HDR/EXR and video-edit operations have separate rate tables. Prices may change before GA; no staging environment. | **P1/P2**; strong for keyframes and finishing. Implement no-cancel semantics, per-operation pricing and URL expiry explicitly. |
| Kling 4.0 direct API | Text-to-video, image-to-video, Omni references; up to 30s; 720p/1080p; 21:9/adaptive aspect ratios; up to 10 keyframes, 10 reference images, 5 reference videos, and 15 combined inputs including voice references | Provider API exposes distinct text/image/Omni request paths. Confirm exact create/status/cancel schemas from current API reference before coding. | Billing is based on total duration, including input video and output duration rules. Current published units differ by resolution; prepaid package price per unit depends on package. Do not hard-code a USD estimate without the account's active unit rate. | **P2**; compare direct API cost/features against Runway's Kling model route first. |
| Google Gemini Omni Flash | Text/image/video input; text-to-video and image-to-video; multi-turn conversational edits using prior interaction ID; video extension; first/last-frame interpolation; 3–10s, 24fps; 360p/720p/1080p/4K output | Interactions API returns an interaction object; follow-up edits chain with `previous_interaction_id`. REST output video is base64 inside the response steps; SDK convenience output is not the raw REST schema. | Standard paid-tier pricing is token-metered; official pricing estimates about $0.10 per second for 720p output. Free tier unavailable for this model. | **P2 strategic**; adapter must persist interaction lineage and safely decode/store base64 outputs. |
| OpenAI Sora 2 API | Historical text/image-to-video, character references, extensions and edits | Official deprecation notice says Videos API and Sora 2 aliases/snapshots shut down 2026-09-24. | Do not send requests to retired endpoints or build on archived cookbook examples. | **Hold** until a current official successor API is documented. |

## Verified provider details

### Runway Dev

- API reference: https://docs.dev.runwayml.com/api/
- Models: https://docs.dev.runwayml.com/guides/models/
- Model Router: https://docs.dev.runwayml.com/model-routers/
- Router generation and dry-run: https://docs.dev.runwayml.com/model-routers/generating/
- Pricing: https://docs.dev.runwayml.com/guides/pricing/
- Output formats: https://docs.dev.runwayml.com/assets/outputs/

Implementation implications:
- Require the documented `X-Runway-Version: 2024-11-06` header.
- Normalize provider task states into the platform job state machine.
- Honor provider polling guidance (no more frequent than 5 seconds).
- Support DELETE but describe it as a best-effort cancellation, not a guaranteed stop/refund.
- Router dry-run should be used before submission; inspect `routing.model`, `routing.estimatedCost`, and `routing.resolvedSettings`.
- Apply both platform budget ceilings and provider router credit ceilings.
- Download completed outputs server-side immediately and persist them as private, checksum-verified assets; never expose ephemeral provider output URLs as durable asset links.
- For published workflows, inspect node-level errors even if the overall invocation status is SUCCEEDED.

### Luma Agents

- Quickstart and base URL: https://docs.agents.lumalabs.ai/
- Video workflows: https://docs.agents.lumalabs.ai/guides/videos/
- Create generation API: https://docs.agents.lumalabs.ai/api/resources/generations/
- Models: https://docs.agents.lumalabs.ai/guides/model/
- Pricing: https://docs.agents.lumalabs.ai/guides/pricing/
- FAQ / lifecycle: https://docs.agents.lumalabs.ai/guides/faq/

Implementation implications:
- Use base URL `https://agents.lumalabs.ai/v1`, Bearer API key, POST `/generations`, GET `/generations/{id}`.
- Treat the provider as asynchronous and do not create a fake cancel action; there is no cancel endpoint.
- Use `ray-3.2` for `video`, `video_edit`, and `video_reframe` with provider-validated field combinations.
- Validate duration (5s or 10s), resolution (540p/720p/1080p), aspect ratio, keyframe count (up to 64 indexed anchors), and source media type before creating a job. HDR is only supported for 5-second 720p/1080p video generation; EXR requires HDR. Editing and reframing have distinct pricing and parameter constraints.
- Use `file_id` when possible to avoid repeated upload/ingest and preserve provider-side pre-moderated artifact linkage.
- Output URLs expire after one hour; fetch and store output in Executive Visuals private storage before expiry.
- Record provider-reported credits and the active account/contract rate. The default list rate is not necessarily the user's contracted rate.

### Kling 4.0

- API updates: https://kling.ai/document-api/updates/api
- Developer API: https://kling.ai/dev/
- Model reference: https://kling.ai/dev/apiReference/model
- Pricing: https://kling.ai/dev/pricing

Implementation implications:
- Treat 30-second duration, up to 10 keyframes, and up to 15 mixed references as model-specific constraints, not generic provider guarantees.
- Model billing depends on input-video and output-video duration. Quote the exact billing formula before user approval.
- Preserve voice references and character/subject references as explicit typed assets with consent/rights metadata.
- Direct Kling API and Runway-routed Kling are separate adapter choices; compare availability, parameter coverage, output quality, price and task semantics before choosing one.

### Google Gemini Omni Flash

- Video generation: https://ai.google.dev/gemini-api/docs/video
- Omni guide: https://ai.google.dev/gemini-api/docs/omni
- Model: https://ai.google.dev/gemini-api/docs/models/gemini-omni-flash
- Pricing: https://ai.google.dev/gemini-api/docs/pricing
- Deprecations: https://ai.google.dev/gemini-api/docs/deprecations

Implementation implications:
- Use `gemini-omni-1.1-flash` through the Interactions API, not the retired Veo 3.1 Preview identifiers.
- Preserve `previous_interaction_id` as generation lineage so follow-up editing is reproducible.
- REST responses expose video data in the interaction `steps`; don't assume the SDK-only `output_video` field exists in raw REST responses.
- The model is paid-tier only; price before request and reserve budget before submission.

### OpenAI Sora

- Official deprecations: https://developers.openai.com/api/docs/deprecations
- Archived Sora prompting guide: https://developers.openai.com/cookbook/examples/sora/sora2_prompting_guide

Implementation implications:
- The official deprecation page lists the Videos API and Sora 2 models as shut down on 2026-09-24.
- Archived cookbook examples are not evidence of a live endpoint.
- Keep the provider registry entry unavailable/disabled until a current official API reference and model availability are verified.

## Platform adapter contract

The gateway should expose a stable internal contract while preserving provider-specific details in a versioned capability record:

```ts
type ProviderCapability =
  | "text_to_video"
  | "image_to_video"
  | "multi_keyframe_video"
  | "video_to_video"
  | "video_edit"
  | "video_extend"
  | "video_reframe"
  | "native_audio"
  | "reference_image"
  | "reference_video"
  | "reference_voice"
  | "hdr"
  | "exr";

interface VideoProviderAdapter {
  id: string;
  discoverCapabilities(): Promise<ProviderModelCapability[]>;
  estimate(request: NormalizedVideoRequest): Promise<CostEstimate>;
  submit(request: NormalizedVideoRequest, idempotencyKey: string): Promise<ProviderJobReceipt>;
  getStatus(providerJobId: string): Promise<ProviderJobStatus>;
  cancel?(providerJobId: string): Promise<ProviderCancelResult>;
  downloadOutput(providerJobId: string): Promise<ProviderOutput[]>;
}
```

Provider-specific behavior must remain explicit:
- Optional `cancel` only where a provider actually supports it.
- Cost estimates include currency, units, duration basis, resolution, native audio, reference-video duration and provider routing decisions.
- Persist provider model ID, adapter version, API version, raw normalized request hash, provider job ID, request timestamps, status history, usage/cost receipt, and output checksums.
- Validate outputs (container, codec, resolution, duration, audio streams, checksum) before promoting them to the asset library.
- Keep raw provider output URLs short-lived and server-only.
- Separate provider request IDs from internal job IDs; make submission idempotent and recoverable.

## Security, governance and cost gates

1. Provider adapters run server-side only. API keys are never returned to the browser or stored in timeline documents.
2. Every remote generation requires an authenticated owner/project, rights confirmation, and subject/voice consent where relevant.
3. Before submission: validate inputs, capability match, provider account state, cost estimate, user/project budget, rate limits, idempotency key and approval policy.
4. Reserve budget before provider submission. Reconcile actual provider usage after completion/failure; release reservations only according to provider billing semantics.
5. Apply per-user and per-project concurrency limits and durable polling/retry schedules.
6. Download provider outputs into private storage before the provider URL expires; verify media signatures, FFprobe streams, checksums and provenance.
7. No remote call in CI. Tests use mock adapters and fixture responses.
8. No automatic provider activation or billing. User approval is required before credentials are configured or paid generations are submitted.

## Next implementation sequence

- [ ] Add provider capability schema and provider registry entries from this matrix.
- [ ] Add mock adapter contract tests for submit, poll, failure, cancellation/no-cancel, output expiry and cost reconciliation.
- [ ] Implement Runway adapter behind a disabled-by-default feature flag.
- [ ] Implement Luma Ray 3.2 adapter with no-cancel lifecycle.
- [ ] Add Kling direct-vs-Runway routing comparison and capability conformance tests.
- [ ] Add Gemini Omni conversation lineage and base64 output ingestion.
- [ ] Re-check OpenAI official API status before adding any Sora replacement.
- [ ] Add UI cost preview, per-project hard budget, approval checkpoints, job progress, output lineage and retry controls.

**Release gate:** no provider adapter may be enabled for end users until contract tests pass, credential storage is verified, cost ceilings are enforced, output ingestion is private and durable, and hosted acceptance is explicitly approved.
