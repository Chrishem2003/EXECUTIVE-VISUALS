# Integration strategy and provider shortlist

**Reviewed:** 31 October 2026  
**Repository:** Executive Visuals  
**Purpose:** Select integrations that expand real capability while keeping the platform provider-neutral, testable, secure, and economical.

This is an engineering shortlist, not a claim that any provider is already connected. Public documentation establishes that an integration exists; a provider is only marked connected after credentials, permissions, a real request, output persistence, failure handling, and tests have been verified.

## Executive decision

Build a provider-neutral adapter layer and add integrations in this order:

1. **Keep FFmpeg/FFprobe as the default local media engine.** It already underpins probe, thumbnail, transcode, audio extraction, proxy generation, and timeline rendering. Use capability detection and safe argument construction; never accept arbitrary shell strings from workflow input.
2. **Standardize asynchronous generation jobs.** Model remote generation as submit → queued/running → callback or polling → validate output → copy output to our own durable storage → record provenance. Never depend on a provider's temporary output URL as permanent storage.
3. **Use an OpenAI-compatible gateway for text and image where supported.** Keep server-side credentials, strict HTTPS rules for remote endpoints, timeouts, bounded inputs, cost limits, and opt-in remote access. Preserve the current disabled-by-default safety posture.
4. **Add a multi-provider image/video adapter, with per-capability contracts.** Evaluate fal.ai and Replicate first for broad model coverage and async job handling; evaluate Runway Dev as a unified commercial option. Use Hugging Face Inference Providers as an additional open-model routing path. Do not hardwire the UI to a provider's model catalogue.
5. **Add a structured composition/render layer.** Continue the working FFmpeg renderer. Evaluate Remotion for React-driven motion graphics, data-driven templates, captions, and repeatable compositions. Integrate it as a separate renderer behind the same job contract rather than replacing the existing renderer in one risky change.
6. **Add speech and audio as separate adapters.** Support transcription, TTS, translation/dubbing and audio cleanup independently; normalize outputs and keep a human-review step for names, language, timing and voice rights.
7. **Make storage and observability production-grade before opening remote generation broadly.** Add durable object storage and a persistent database/migration path, provider-call audit records, cost/latency/failure metrics, queue recovery, rate limits and per-project quotas before enabling costly providers.

## Candidate integration matrix

| Integration | Best role | Why it fits | Cost/operational caveat | Priority |
|---|---|---|---|---|
| FFmpeg + FFprobe | Local media foundation | Broad codecs, filters, probing, deterministic media processing; current engine already uses it | Codec availability/licensing differs by build; CPU-heavy jobs need concurrency limits | P0 — retain and harden |
| OpenAI-compatible endpoint | Text/image gateway compatibility | Allows a shared request contract across compatible local or hosted gateways | Compatibility is not identical feature parity; provider-specific parameters need capability negotiation | P0 — harden current gateways |
| fal.ai | Image/video/audio generation adapter | Broad model catalog and async inference patterns; Hugging Face lists it for image, video and speech-to-text inference | Usage-based charges; webhook verification, polling, retries and temporary outputs need careful handling | P1 — first remote media adapter candidate |
| Replicate | Model experimentation and long-running predictions | Model-level API, prediction status, webhooks, and flexible model choice | Model versions can change; outputs are temporary unless copied; cost/latency vary by model | P1 — second remote media adapter |
| Runway Dev | Unified commercial media API | Public docs describe image/video/audio models, workflows, recipes, characters and cost/latency/quality routing | Commercial usage pricing; avoid coupling internal data structures to its provider-specific model names | P1 — evaluate alongside fal.ai |
| Hugging Face Inference Providers | Open-model discovery and routing | Multiple inference providers through a common client; documents cheapest/fastest/preferred routing policies | Not every provider supports every task; availability and model licensing must be checked per model | P1 — open-model routing |
| ComfyUI (optional local/remote node server) | Advanced node-graph workflows | Useful for user-controlled diffusion pipelines and custom model workflows | Requires explicit endpoint hardening, workflow validation, GPU capacity and isolation; not a safe public endpoint by default | P2 — opt-in adapter |
| Remotion | Programmatic motion graphics and template renderer | React components, parameterized templates, server-side rendering, audio and caption workflows | Check current licensing for the actual organization/use case; browser/CPU capacity and render queue are required | P1/P2 — prototype separate renderer |
| Supabase/Postgres | Durable multi-user application data | Structured records, relational constraints and row-level access policies | Must apply and verify migrations, RLS, backup/restore and connection pooling; never expose service-role keys to clients | P0 — before production scale |
| S3-compatible object storage | Durable media and generated artifacts | Separates media bytes from app compute and allows private access/presigned URLs | Configure private buckets, lifecycle rules, size limits, malware/media validation and signed URL expiry | P0 — before broad remote generation |
| OpenTelemetry-compatible observability | Cross-service traces/metrics | Makes provider latency, queue delays, retries, failures and render performance measurable | Do not capture prompts, secrets or user media by default; scrub attributes and apply retention policy | P1 — before scaling workers |

## Adapter contracts

Every adapter should implement the same lifecycle, even when the upstream API differs:

- `capabilities()`: supported operations, models, input types, dimensions/durations, reference count and known constraints.
- `validate(input)`: reject unsupported or oversized requests before a paid call.
- `estimate(input)`: return a cost estimate or explicitly state that pricing is unknown.
- `submit(input, idempotencyKey)`: create an upstream job and persist the upstream ID before returning.
- `getStatus(upstreamId)`: normalize queued, running, succeeded, failed and cancelled states.
- `cancel(upstreamId)`: best-effort cancellation with a recorded result.
- `normalizeOutput(result)`: validate output MIME/signature/size and normalize metadata.
- `persistOutput(output)`: copy generated files into platform-controlled durable storage.
- `recordProvenance`: provider, model/version, request/job ID, timestamps, duration, estimated/actual cost when available, source asset IDs, approval ID and content hash.
- `healthCheck()`: distinguish unconfigured, disabled, reachable, degraded and failed states without exposing credentials.

All remote jobs must be idempotent, bounded by timeouts and retry policy, rate-limited, and associated with a project and user. A retry must not silently create duplicate paid generations. Callback endpoints must authenticate provider signatures when supported and be safe against replay.

## Capability-by-capability implementation order

### Phase A — reliability and contracts
- Keep remote image/text disabled unless explicitly configured and approved.
- Add provider registry and capability discovery without exposing API keys to the browser.
- Add a shared remote-job record/state machine and idempotency keys.
- Add tests for timeout, malformed response, rate limiting, provider errors, duplicate callbacks, cancellation and missing output files.
- Record estimated/actual cost when known; stop before submission when project budget or policy would be exceeded.

### Phase B — first production adapter
- Select one image provider after a small acceptance bake-off: valid output rate, latency, output quality for agreed test prompts, reference-image support, moderation/rights requirements, and cost per accepted asset.
- Implement server-side submission, polling/webhook handling, output download, MIME/signature checks, durable persistence, asset provenance and user-visible progress.
- Test failure recovery and ensure generated output survives the provider's temporary URL expiry.

### Phase C — video and audio
- Add video generation as asynchronous jobs with explicit duration/resolution/aspect-ratio/reference constraints.
- Add transcription, TTS, translation/dubbing and voice alignment as distinct capability contracts.
- Add human approval before publication or external distribution.
- Add a provider fallback only when the alternate provider can meet the same input/output contract and the cost policy permits it.

### Phase D — composition and scale
- Prototype Remotion beside FFmpeg using one representative captioned, multi-scene template.
- Compare output quality, render time, memory, licensing and operational complexity before selecting it for more workloads.
- Add durable object storage, Postgres migrations/RLS, worker separation, backups, observability and quota enforcement before scaling remote jobs.

## Security and reliability gates

- API keys remain server-side and are never returned by health/config endpoints.
- Remote providers require HTTPS; no arbitrary user-supplied endpoint URLs without explicit administrative allowlisting.
- No direct provider call from the browser.
- Validate MIME and file signatures; cap bytes, dimensions, duration and reference count.
- Use provider signature verification for webhooks, timestamp tolerance and replay protection.
- Never trust remote output URLs as permanent assets; download promptly and persist a verified copy.
- Do not log raw prompts, auth headers, signed URLs or private media by default.
- Use per-user/project quotas, cost ceilings, concurrency limits and a kill switch for every paid provider.
- Keep original uploaded media and generated assets private unless the owner explicitly shares them.
- Verify license, usage rights, consent and model-specific terms before enabling each capability.

## Official references

- Hugging Face Inference Providers: https://huggingface.co/docs/inference-providers/index
- Hugging Face Diffusers: https://huggingface.co/docs/diffusers/main/index
- Runway developer API: https://docs.dev.runwayml.com/
- Replicate webhooks: https://replicate.com/docs/topics/webhooks
- Remotion rendering: https://www.remotion.dev/docs/render
- FFmpeg documentation: https://www.ffmpeg.org/documentation.html
- n8n documentation/API: https://docs.n8n.io/ and https://docs.n8n.io/api/
- Google Gemini API video generation: https://ai.google.dev/gemini-api/docs/video
- OpenAI audio guide: https://developers.openai.com/api/docs/guides/audio

## Evidence and status discipline

This matrix is a recommended integration plan derived from public official documentation and the repository's inspected gateway/media architecture. It does not mean a provider has been connected, credentials have been configured, or live generation has been tested. Keep each provider in `planned`, `adapter-ready`, `configured`, `connected`, `verified`, or `disabled` state based on evidence.
