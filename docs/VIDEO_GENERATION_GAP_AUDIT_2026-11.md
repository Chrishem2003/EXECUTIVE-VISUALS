# Video Generation Reverse-Engineering Gap Audit

**Date:** 2026-11-01  
**Repository:** `Chrishem2003/EXECUTIVE-VISUALS`  
**Working branch:** `feat/executive-visuals-unified-platform`  
**Purpose:** Convert public video-generation product capabilities into an evidence-backed, provider-neutral implementation backlog.

## Scope and method

This is a public-surface capability audit, not a claim of inspecting private product internals. Public marketing pages and developer documentation establish only what the provider documents; availability, plan limits, regional restrictions, and API access must be checked at implementation time. We implement independent equivalents and use documented APIs or legally usable open-source components; we do not copy proprietary code, private prompts, model weights, protected brand assets, or bypass access controls.

## Competitive capability map

| Capability family | Publicly documented examples | Executive Visuals implementation target | Initial status based on existing PR description |
|---|---|---|---|
| Text-to-video and image-to-video | Runway, Kling, Google video APIs, Luma, Wan, MiniMax | Provider-neutral generation contract; typed input validation; asynchronous jobs; polling/webhooks; private output asset; provenance | Gap: external video adapters not production-complete |
| Reference-driven subject and character continuity | Kling Omni Reference; Luma character/style references; multimodal video APIs | Reusable project-scoped character/reference bundles; reference permissions; consistency metadata; shot-to-shot continuity checks | Partial foundation; reference inputs/adapters incomplete |
| Keyframes, shot planning and multi-shot narratives | Kling keyframes/storyboarding; Google frame/extension workflows; multi-shot generation platforms | Shot board with start/end frame, camera direction, duration, dialogue, continuity locks and per-shot regeneration | Planning/timeline foundation exists; generator handoff incomplete |
| Video editing and targeted changes | Kling video editing; Google conversational video editing; Wan video editing | Edit/extend/replace-region jobs; preserve source and version history; explicit before/after review | Gap |
| Motion control and image animation | Kling motion control; Wan motion transfer; image-to-video systems | Motion-reference assets, consent checks, supported-input validation and adapter capability declarations | Gap |
| Talking avatars, voice and lip-sync | HeyGen, VEED, Kling avatar features, provider speech APIs | Approved presenter identity registry; script/audio alignment; lip-sync adapter; subtitle and transcript linkage | Narration/STT/captions foundation exists; cloning, dubbing and lip-sync incomplete |
| Native or synchronized audio | Google video APIs, multimodal providers, audio/video generation platforms | Explicit audio mode; dialogue/music/SFX tracks; alignment validation; fallback to existing audio pipeline | Partial; verify per-model capabilities |
| Upscaling, enhancement and restoration | Provider-specific enhancement tools and video platforms | Queueable enhancement nodes, quality metadata, original-preserving derivatives and measurable acceptance checks | Gap / needs inventory against code |
| Editing, rendering and interchange | FFmpeg/FFprobe; professional timeline/export workflows | Extend existing timeline renderer; proxies, frame-rate/resolution conversion, subtitle burn-in, audio mix, export presets and round-trip tests | Local core exists; advanced effects remain incomplete |
| Cost, model routing and evaluation | Unified multi-model APIs and model aggregators | Provider/model registry, capability matrix, cost estimates when sourced, latency/reliability metrics, evaluation clips and user-selectable routing | Gap: provider cost estimation explicitly absent |
| Asset lineage and safety | Production asset-management patterns | SHA-256, source/model/version/prompt metadata, consent scope, immutable job history, private-by-default storage and deletion/export controls | Several foundations already exist |
| Review and delivery | Team video platforms and publishing tools | Time-coded comments, share links with expiry/revocation, approval states, export packaging and opt-in publishing adapters | Gap: review links and publishing incomplete |

## Public primary-source research

The following are starting points for implementation research. Provider features change frequently; use the linked official documentation to validate the exact endpoint, supported model, input limits, output format, regional availability, and commercial terms before enabling an adapter.

- Google video generation API: https://ai.google.dev/gemini-api/docs/video
- Kling developer API and model capabilities: https://kling.ai/dev/apiReference/model
- Alibaba Cloud Model Studio video generation (Wan): https://www.alibabacloud.com/help/en/model-studio/use-video-generation/
- VEED API: https://api.veed.io/docs
- ElevenLabs image/video capabilities: https://elevenlabs.io/docs/overview/capabilities/image-video
- Vercel AI SDK video generation integration overview: https://vercel.com/kb/guide/ai-sdk-video-generation
- OpenRouter video generation announcement and unified API overview: https://openrouter.ai/blog/announcements/video-generation/
- Curated API and open-source ecosystem index (discovery only; verify claims at primary sources): https://github.com/backblaze-labs/awesome-video-generation

## Priority implementation sequence

### P0 — Close the generation-to-asset loop
1. Inventory current workflow node types, media adapter interfaces, job state machine, storage abstraction, environment flags and test helpers.
2. Define one normalized video-generation request/response contract: prompt, negative prompt when supported, duration, aspect ratio, resolution, seed when supported, start/end frame, reference assets, audio mode, provider/model, idempotency key and provenance.
3. Implement provider capability declarations and strict request validation; never silently discard unsupported parameters.
4. Add a deterministic mock adapter and contract tests before any real provider integration.
5. Implement one optional remote adapter behind server-side configuration, explicit opt-in, approval checkpoint, timeout/size limits, safe polling and clear cost disclosure.
6. Persist completed output as a private asset with checksum, MIME/file-signature validation, source job, provider/model, request hash, timestamps and audit record.
7. Add end-to-end tests from approved workflow node to queued job, mock provider completion, asset persistence and timeline selection.

### P1 — Make generation production-usable
1. Multi-shot storyboard with per-shot prompts, references, durations and regeneration.
2. Character/reference library with project-level access controls and scope-specific documented authorization.
3. Start/end frame and motion-reference support only where the selected adapter confirms support.
4. Retry, cancellation, idempotency, provider rate limits, resumable polling and failed-job recovery.
5. Cost estimation only when supported by current published prices or explicit configured rates; label unknown costs rather than inventing them.
6. Provider-independent quality evaluation: prompt adherence, temporal consistency, audio sync, visual defects, latency and user rating.

### P2 — Advanced post-production and collaboration
1. Enhancement/upscaling and frame interpolation adapters.
2. Audio/video synchronization, voice tracks, captions, localization and lip-sync integration with explicit permission gates.
3. Timeline transitions, color adjustments, motion graphics, audio ducking and export presets.
4. Time-coded review comments, expiring share links, version comparisons and approval sign-off.
5. Publishing integrations with explicit destination/account authorization and preview-before-publish.

### P3 — Local and open-source engines
1. Inventory models by license, hardware needs, VRAM, resolution, temporal length, maintenance state and inference cost.
2. Keep local execution optional and capability-gated; do not assume the user's desktop is always online or has sufficient GPU memory.
3. Support remote GPU execution as a separate worker adapter with isolated jobs, quotas and artifact transfer.
4. Benchmark representative scenes and compare quality/cost/latency before promoting an engine.

## Required architecture contracts

- **Provider-neutral UI:** user workflows should not depend on provider-specific branding or endpoint shapes.
- **Adapter truthfulness:** advertise only capabilities verified for that provider/model/configuration.
- **Approval and spend gates:** remote generation disabled by default; human approval required before external generation; server-side credentials only.
- **No silent mutation:** generation, enhancement, timeline edits, publishing and identity-sensitive operations produce explicit versions and auditable transitions.
- **Privacy:** private-by-default assets; project-scoped authorization on every read/write; signed share links must expire and be revocable.
- **Resilience:** idempotent submission, bounded retries, cancellation, timeouts, output-size caps, checksum validation and worker lease recovery.
- **Evidence labels:** distinguish implemented, tested, provider-documented, inferred, unavailable and unverified.
- **No false readiness:** UI must show whether an adapter is configured, disabled, unavailable, mock-only or live-ready.

## Acceptance gates

- Unit tests cover request validation, capability mismatch, authorization, cost unknowns and provenance.
- Contract tests pass against a local mock provider without external network calls.
- Integration tests cover approval -> job -> completion/failure -> private asset -> timeline handoff.
- Security tests cover project isolation, SSRF protections for remote import, URL/redirect handling, payload limits, file signatures, and secret non-disclosure.
- CI typecheck, full test suite and production build pass.
- No production deployment, database migration, or paid provider request is performed as part of the audit.
- Update this document when code evidence changes; never mark a capability complete based only on UI presence.

## First concrete milestone

Implement and test the normalized video-generation contract, mock adapter, adapter capability registry, and job-to-private-asset lifecycle first. Then connect one real provider behind explicit opt-in. This creates a reusable foundation for adding additional engines without rewriting the UI or workflow engine.


## Implementation update — 2026-11-01

The first video-generation integration slice is now committed to the working branch:

- A provider-neutral request contract validates prompt length, aspect ratio, duration, reference-asset IDs, seed and optional frame/motion inputs without silently dropping options.
- The existing remote video gateway remains behind both the provider registry and explicit server-side remote opt-in; the workflow still requires an upstream completed approval checkpoint.
- The current gateway declares only the inputs it actually sends: prompt, duration, aspect ratio and an explicitly configured reference-image field. Requests that demand unsupported resolution/audio/reference capabilities fail closed. Resolution is recorded as provider_default unless a future model-specific adapter can prove and implement a concrete output size.
- Generated MP4s keep the existing private storage path, signature/size validation, SHA-256 and prompt hash; asset metadata now also stores request hash, provider/model identity, adapter version and request ID for traceability.
- Optional project scope is supported for personal workflows; ownership and private asset access remain enforced by the existing executor and asset store.
- Contract tests now cover defaults, malformed bounds, unsupported capabilities, mock no-network behavior, optional project scope and provenance stability.

**Verification status:** GitHub Actions quality checks were queued for the latest branch head during this implementation session. No successful result is claimed until that run completes. The local container could not resolve GitHub DNS, so tests could not be run locally in this environment. The pull request remains draft, main remains untouched, and no deployment or paid provider call was performed.

## Next engineering milestones

1. **Provider adapter contract tests:** exercise the existing queue gateway with a local mock HTTP server, including unsafe status/result URLs, timeout, failed state, oversized response, non-MP4 output and a successful bounded MP4 fixture.
2. **Model capability registry:** add explicit per-model declarations and config validation so each provider/model only exposes parameters it demonstrably supports.
3. **AI upscaling:** distinguish current FFmpeg Lanczos enlargement from learned super-resolution. Add an optional model-backed adapter only after selecting a license-compatible model/runtime and validating VRAM, throughput, output limits and reproducibility; never label classical scaling as AI upscaling.
4. **Edit/version workflow:** retain source versions, derivative lineage and before/after quality metadata; add frame/scene quality checks before promoting outputs to the timeline.
5. **Cloud durability and review:** use private object storage, authenticated review links, expiring access and explicit publishing approval before production release.


### CI follow-up — 2026-11-01

The first quality-check run after the integration edits failed at TypeScript typecheck because the application shell imported renderTimelineWorkspace while the timeline module had not exported it. The missing export has now been added on the same feature branch. Contract validation was tightened in the same follow-up: durations must be whole seconds to match the current adapter, non-string project IDs are rejected, and the gateway's model-selected resolution is represented as provider_default rather than falsely claiming a fixed output size. Additional commits are on the PR head; the GitHub connector has not yet reported a new workflow run for that latest head, so the fix and test suite remain pending CI confirmation.
