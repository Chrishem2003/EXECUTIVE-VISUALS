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


## Media enhancement follow-up — 2026-11-01

The local `media.upscale` operation has been improved without misrepresenting it as AI super-resolution:

- Explicit scaler algorithms: Lanczos (default), bicubic, and spline36.
- Optional bounded unsharp-mask sharpening (0–1.5) for controlled edge enhancement.
- Invalid algorithms and out-of-range sharpening are rejected before FFmpeg executes.
- The existing source-preserving derivative workflow, output checksums, queue, and FFmpeg/FFprobe validation remain in place.
- The media verification script now includes a spline36 + sharpening output case and invalid-option checks.

This is still classical interpolation/sharpening, not learned detail reconstruction. A true AI super-resolution adapter remains a separate milestone and must be tied to an installed, license-reviewed model/runtime with explicit capability checks; until then the UI and job metadata must not label this operation as AI.

### Immediate next steps

1. Obtain a clean CI run for the current feature-branch head; the GitHub connector has not returned a fresh run for the latest commits yet.
2. Confirm the media-operation verification script and all server tests on a worker with FFmpeg/FFprobe installed.
3. Add explicit output probe assertions (dimensions, codec, duration, audio preservation) for every scaler mode.
4. Implement learned super-resolution as a separate adapter after validating runtime compatibility and deployment cost, keeping the current zero-cost FFmpeg fallback.


### Enhancement UI integration

The asset library now exposes QHD Lanczos, QHD spline36 with controlled sharpening, and 4K Lanczos as explicit derivative-job presets. These are selectable from existing video asset actions and submit through the existing authenticated queue. The 4K preset remains bounded by the media operation's 4,320-pixel dimension limits and output validation. These presets perform classical scaling only; they do not claim AI-generated detail.


### Output-quality verification hardening — 2026-11-01

The FFmpeg/FFprobe enhancement verifier now checks more than file existence: each generated derivative must expose an H.264 video stream, the expected output dimensions (including the explicit 640×360 upscale fixture), a preserved audio stream, and a duration close to the one-second source. This strengthens the local acceptance gate for scaling, denoise, color, and frame interpolation. The change is committed, but execution still depends on a CI/worker environment with FFmpeg and FFprobe; it is not marked passed until that environment reports a successful run.


### Cloud upscale publication gate — 2026-11-01

The cloud media executor now treats upscaling as a verified derivative operation: after FFmpeg finishes, FFprobe must confirm a video stream with the exact requested even-pixel dimensions before the asset can be published. A mismatch fails closed and leaves the derivative unpublished. Published asset metadata and the job result record the explicit classical-resampling method, selected interpolation algorithm, sharpening amount, target dimensions and probed output stream. This is an integrity/traceability gate, not a learned super-resolution model. Dedicated cloud-executor tests cover successful metadata capture and rejection without publication when dimensions are wrong. CI execution is still required before this change is considered verified.


### Cloud upscale fixture correction — 2026-11-01

The first CI run after adding the cloud-upscale publication tests exposed a JavaScript syntax error in the test fixture's nested shell/JSON quoting (the application typecheck succeeded; the cloud media test file could not be parsed). The fixture now uses a raw template literal for the shell command, keeping its JSON payload valid without over-escaping. The correction is committed as `58e0186032ba9cb13e4b93f9ea7baf33f074b2bc`; a new CI run for this head is still awaited. The earlier run had 100 passing tests and one test-file parse failure; this is not a clean suite result.


### Cloud upscale duration validation — 2026-11-01

The cloud upscale publication gate now validates both output dimensions and a finite, positive container duration from FFprobe before publishing. The duration is persisted in derivative processing metadata and returned with the job result for downstream review and provenance. Tests now assert the duration metadata alongside normalized dimensions. This remains a structural media-integrity check; it does not assess perceptual sharpness or claim learned super-resolution. A fresh CI run is still required.


### Cloud upscale audio-integrity gate — 2026-11-01

Cloud upscaling now probes the source before processing and records whether an audio stream exists. If the source contains audio, the output must also contain an audio stream or publication is blocked. The derivative metadata records source/output audio stream counts and an explicit preservation result; silent sources remain valid without synthetic audio. Regression tests cover successful audio retention and rejection of an output that drops source audio. This is a stream-presence guarantee, not a claim of bit-perfect audio fidelity.


### Cloud upscale source/output integrity comparison — 2026-11-01

The cloud upscaler now probes both the source and derivative. In addition to positive duration validation, it rejects a derivative whose duration drifts from the source by more than the larger of 250 ms or 2% of source duration. Audio presence is also compared: if the source has audio, the derivative must retain at least one audio stream. Processing metadata records source/output duration, duration delta, and audio stream counts. These gates catch truncation, unexpected timing changes, and silent derivatives before publication; they do not replace perceptual video/audio quality review.


### Regression correction and duration-drift test — 2026-11-01

A CI run confirmed the broader server test suite executed but exposed two failures: the cloud probe fixture omitted format duration expected by its assertion, and normalized output dimensions were scoped inside validation but later referenced when constructing processing metadata. Both have been corrected. A new negative test verifies that a duration change beyond the source-relative tolerance blocks publication even when output dimensions and audio are otherwise valid. CI must rerun against the corrected head before this slice is considered green.


### Cloud upscale codec and pixel-format gate — 2026-11-01

The cloud publication check now also requires the expected H.264 video codec and yuv420p pixel format produced by the current enhancement pipeline. Codec and pixel-format details are retained in output-video provenance. The regression fixtures now include these fields and assert the published metadata. This makes the cloud worker's accepted output contract explicit rather than assuming successful FFmpeg exit guarantees a compatible derivative.


### Codec rejection regression coverage — 2026-11-01

A negative-path cloud-worker test now supplies a correctly sized, duration-aligned output with an incompatible video codec. The worker must reject it before derivative publication, complementing the existing pixel-format, dimensions, duration and audio-presence gates. This protects downstream editor compatibility and makes the output acceptance contract testable. A fresh CI result is still required.


### FFmpeg scaler compatibility correction — 2026-11-01

A full GitHub Actions build reached the media-operation integration verifier and exposed that the FFmpeg build on the CI runner does not accept `spline36` as a swscale flag. The public enhancement option remains `spline36`, but the command builder now maps it to FFmpeg's supported `spline` scaler flag. The integration verifier expectation was updated so the actual FFmpeg execution—not only argument construction—covers this compatibility path. This is a compatibility fix, not an AI super-resolution implementation.


### Output codec and pixel-format negative coverage — 2026-11-01

The cloud upscale test suite now explicitly rejects an output encoded with an unexpected video codec and an output using an incompatible pixel format. Both tests assert that the invalid derivative is not published. This complements the existing success, dimensions, audio-preservation and source-relative duration checks. The preceding CI baseline (run #1493) completed successfully after the FFmpeg scaler compatibility correction; these newest negative tests require their own CI result.


### Video model capability contract hardening — 2026-11-01

The configured video adapter now exports its own capability declaration, and workflow execution consumes that declaration rather than duplicating supported settings inline. The declaration reflects the actual adapter contract: 1–30 whole seconds, 16:9/9:16/1:1, provider-selected resolution, no selectable audio modes, and reference-image support only when a supported model input field is explicitly configured. The payload builder now rejects invalid durations, unsupported aspect ratios, blank prompts and prompts beyond the normalized 12,000-character limit rather than silently rounding, clamping or changing them. Regression tests cover the declaration and strict payload behavior. External execution remains disabled unless existing server-side enablement, remote opt-in, usage guardrails and approval requirements are all satisfied.


### Local media capability catalog alignment — 2026-11-01

The provider readiness catalog now lists the concrete local media operations actually implemented by the worker, including proxy creation, audio cleanup, denoise, color, resize, interpolation and upscaling. Previously these were compressed into a generic enhancement label, which made capability discovery less precise. Registry tests now assert the operation list when FFmpeg/FFprobe are available and confirm that upscaling is represented even when the local worker is currently unavailable. This is capability discovery only; it does not trigger media execution.


### Series and episodic production foundation — 2026-11-01

A dedicated Series Producer workspace now organises work as series → seasons → episodes → scenes → planned shots. The shared production contract supports 1–5 seasons, up to 20 episodes per season, selectable episode runtimes up to 1800 seconds (30 minutes), and per-shot clip targets up to 30 seconds. A weighted scene allocator distributes each episode's exact runtime across five reusable narrative beats; each scene is subdivided into shot-sized clips and validation confirms that shot durations sum exactly to scene and episode runtimes. The contract supports long-form episode runtimes while rejecting overlength episodes, unsupported formats/aspect ratios, invalid season/episode counts, duplicate identifiers and malformed runtime allocations.

The workspace exposes project-level defaults for aspect ratio, frame rate, master delivery resolution, visual direction, camera language, shot composition, pacing, color grade, language, voice approach, caption mode and music direction. It includes a reusable continuity-notes field for recurring characters, wardrobe, locations, visual identity and brand rules. Series plans persist as local drafts and can be saved into an authenticated cloud project's creative-production settings using the existing revision-checked project API. Generated media is not fabricated: episodes and shots remain planned until a compatible provider is configured and an approved workflow is executed.

**Architectural extensions to build next:** (1) episode-specific overrides over series defaults; (2) a versioned story-world graph linking characters, props, locations, wardrobe and timeline events across episodes; (3) reference-lock and continuity-drift review across approved frames; (4) season arcs, episode loglines, recap/next-episode hooks and story beat coverage; (5) per-shot provider capability routing with a runtime-aware cost/budget estimate before approval; (6) automated aspect-ratio reframing and localized caption/voice variants from one master edit; (7) review annotations, approvals and immutable cut versions; and (8) final-delivery quality gates for duration, black frames, audio peaks, caption coverage, resolution, frame rate, checksums and asset lineage.


## Story-world continuity and episode direction controls — 2026-11-01

The Series Producer now includes a versioned story-bible registry for recurring characters/presenters, locations, props, wardrobe, voice identity and brand rules. Each record has a stable ID, descriptive and visual constraints, tags, timestamps and optional private asset IDs; binary media is never embedded in project settings.

Episode-level direction overrides can inherit series defaults or set runtime, aspect ratio, frame rate, resolution, visual style, camera language, shot composition, pacing, colour grade, language, voice, captions and music. Runtime overrides rebalance scene and shot durations while preserving the five-minute episode cap and the 30-second planned-clip cap. The timeline scaffold uses the effective episode aspect ratio and frame rate.

The first UI controls are live for adding story-bible records and setting runtime, aspect ratio, visual style and camera language per episode. Other supported overrides are available through the shared contract for later UI expansion. Story bible and episode overrides persist with the series plan in cloud project settings.

Still to build: visual reference matching and similarity review, per-entity timeline bindings, episode script authoring, season arc editor, provider capability/cost routing, shot generation approvals and final render quality gates.


## Engine-neutral episode shot packages — 2026-11-01

A deterministic shot-package compiler now turns each planned episode into a structured JSON handoff. Each shot carries its own prompt assembled from series premise, episode and scene context, shot direction, effective episode settings, continuity rules, negative prompt guidance and story-bible reference asset IDs. The package records episode identity, season, effective runtime, settings, story-bible schema version, shot count and duration totals.

The Series Producer exposes a per-episode download action. This is a planning/export operation only: it does not invoke a generation provider, spend credits, create media or claim engine compatibility. Provider routing remains a separate approval-gated stage and must validate every requested field against the selected model's declared capabilities.

Next integration steps:
1. Bind story-bible entries to specific shots/scenes rather than applying all references indiscriminately.
2. Add a capability-aware routing preview with explicit unsupported-setting warnings and provider-neutral cost estimates only where verified pricing is available.
3. Add per-shot approval, retry, seed and reference-lock metadata with immutable prompt revisions.
4. Add actual generation job submission through the existing authenticated workflow executor, preserving identity-consent checks, budget limits, audit provenance and user approval.
5. Add real AI super-resolution as a separately selected, capability-tested enhancement stage; retain classical scaling as the no-model fallback and label the two methods accurately.


## Implementation update — shot-level production controls

The Series Producer now supports explicit shot-level as well as scene-level story-bible bindings. Shot packages include only the bound story-world references for a shot, plus series-wide continuity rules. The interface also exposes editable shot action prompts, camera direction, framing, movement, lens guidance and negative prompts. Updates are immutable, bounded and isolated to the selected shot; package compilation carries these fields into the engine-neutral handoff. Validation rejects unknown/duplicate story-bible IDs and overlong shot-direction fields. These controls plan and compile generation instructions; they do not imply a provider has generated footage.

### Remaining integration gates
- Provider/model-specific capability declarations must be populated from verified provider metadata before a shot can be marked generation-ready.
- Shot queue submission must use the existing authenticated workflow executor, remote opt-in, approval and usage guardrails.
- AI super-resolution requires a separately validated model/runtime adapter and objective output checks; classical FFmpeg resampling remains clearly labelled as non-AI.


## Implementation update — shot generation readiness preflight

Added `src/core/shot-readiness.ts` with a provider-neutral, no-network readiness assessment for every compiled shot. It compares aspect ratio, resolution, frame rate, duration, negative-prompt support and reference-image limits against explicit model declarations. Each feature is classified as supported, unsupported or unverified; unsupported requirements block readiness, while missing declarations remain unverified rather than being guessed. Reports include per-shot reasons and aggregate counts. The report explicitly records that no provider was submitted and no prices were estimated. The check is included in the production build verification sequence.

This is a preflight contract, not a live provider capability feed. The next integration must populate declarations from a verified adapter/catalog and pass approved requests through the existing authenticated workflow and usage guardrails.


## Implementation update — real provider capability visibility

The provider catalog now exposes the actual configured video adapter capability declaration separately from the generic video.generate capability. This includes supported aspect ratios, provider-default resolution, duration limits, audio modes, negative-prompt support and whether the configured model input field accepts a reference image. The shot-readiness evaluator now understands explicit boolean reference-image support. Tests compare shot requirements with the real adapter declaration, rather than a fabricated generic profile.

## AI upscaling research and selection

Added docs/AI_UPSCALING_ENGINE_SELECTION.md. The initial low-cost candidate is Real-ESRGAN NCNN/Vulkan because its upstream documentation describes portable Intel/AMD/NVIDIA GPU executables without requiring CUDA or PyTorch. It is not enabled or claimed as installed. Video2X is not selected as the hosted dependency because of its AGPL-3.0 licence. The design requires runtime/device probing, adaptive tiling, frame/audio/timebase preservation, temporal-flicker review, derivative-only publishing and explicit licence checks. The existing FFmpeg scaler remains the verified fallback.


## Implementation update — asynchronous FAL task adapter — 2026-11-05

Added `server/fal-video-async.mjs` as a non-blocking queue client. It separates provider submission, one-shot status polling, result retrieval and cancellation into distinct operations. It returns a bounded task descriptor (provider, model, request ID and validated queue URLs) that a future durable job handler can persist and resume.

Safety properties:
- Reuses the existing FAL payload validator; no second provider payload schema is introduced.
- Requires both existing server-side enablement and remote opt-in flags.
- Sends FAL's documented `X-Fal-No-Retry: true` header on submission.
- Validates every task URL against the expected `queue.fal.run` origin and exact model/request path; redirects are rejected.
- Does not poll, sleep, download, or hold a worker lease while waiting.
- Treats transport timeout, connection failure or provider 5xx during submission as an ambiguous outcome (`VIDEO_GATEWAY_SUBMISSION_UNKNOWN`) and never automatically resubmits. The caller must reconcile the task before any retry.
- Status and result retrieval are separate calls; output ingestion and private asset persistence remain the responsibility of the durable worker.
- Six offline tests cover submission, separate status/result operations, URL validation, ambiguous submission, opt-in gates and provider failure states.

**Integration status:** adapter module and offline tests are added on an isolated feature branch. The existing `workflow-executor.mjs` still calls the legacy blocking `generateFalVideo` path; this change does not claim that production workflow execution has been migrated. The next slice must persist the returned provider task descriptor into the existing job/checkpoint model, schedule status checks through a worker, then ingest the verified MP4 into private storage. No provider request, database migration, production deployment or paid generation was performed.


### Durable worker adapter follow-up

Added `server/fal-cloud-video-adapter.mjs`, which implements the provider-aware cloud worker's exact adapter contract:
- Provider/model identity is fixed and checked before submission.
- Only the short FAL request ID is persisted as the ledger task ID; the known model and request ID reconstruct the three task URLs.
- `IN_QUEUE` and `IN_PROGRESS` map to nonterminal worker states; completion retrieves bounded output URLs without sleeping or blocking inside the adapter.
- Authenticated private-reference preparation, private output ingestion, and authoritative actual-cost resolution are mandatory injected handlers where applicable. The adapter will not invent a cost or store provider URLs as final assets.
- The existing remote-enable and remote-opt-in flags are checked even when a client is injected.
- Output URLs are restricted to HTTPS FAL media hosts before they are handed to the private-ingestion handler.

The adapter contract tests cover the durable task-ID handoff, status mapping, private reference resolution requirements, handler injection, exact model matching, output URL validation and remote opt-in. This adapter is designed to be registered with the exact-match provider router from the separate provider-aware worker branch; it is not yet registered in the production worker composition. The cloud-worker chain and its migrations remain separate draft work and must be reviewed together before any deployment.


### Request-level billing reconciliation

Added `server/fal-billing-cost-resolver.mjs`. It queries FAL's documented `GET /v1/models/billing-events` endpoint using both the exact request ID and exact model endpoint, requires one matching billed event, and derives USD cost from the precision-preserving `cost_estimate_nano_usd` field. It cross-checks the value against `cost_total` and records a request/timestamp evidence reference.

No model list-price estimate or generated-duration heuristic is treated as actual cost. Missing billing events return a retryable not-ready code; duplicate or inconsistent events fail closed. The resolver requires a FAL API key with the documented billing permissions (`billing:usage:read`, `auth:keys:read`, `account:users:read`; BILLING or FULL preset). The FAL adapter still requires the resolver to be explicitly injected, so no production billing credential or permission is assumed.
