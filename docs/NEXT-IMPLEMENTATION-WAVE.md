# Next implementation wave — integration and scale gates

**Date:** 1 November 2026  
**Branch:** feat/executive-visuals-unified-platform  
**Status:** active engineering backlog; no cloud resources or production settings changed.

This backlog turns the consolidation blueprint into verifiable engineering slices. The objective is one production system, not disconnected feature demos.

## Wave A — durability before remote media providers

### A1. Isolated persistence proof
- Provision or select a dedicated non-production Postgres project; never point tests at production.
- Apply the reviewed migration only to that isolated database and run RLS/security checks.
- Implement a storage adapter with a local test implementation and a private object-store implementation.
- Persist asset bytes and immutable derivatives with content hashes, MIME/format checks, size limits, parent-asset lineage and short-lived access.
- Move jobs, workflow runs, node events, worker leases and audit events behind the same persistence interfaces.
- Add restart and two-worker concurrency tests: no duplicate execution for one idempotency key, expired lease recovery, cancellation propagation, retry limits and stable terminal states.
- Prove tenant isolation for project records, assets, workflow inputs/outputs, downloads and audit records.

**Acceptance:** an end-to-end test creates a project, uploads a reference, approves a local processing workflow, produces and stores a derivative, adds it to a timeline, renders an MP4, restarts API/worker processes and verifies records and bytes remain available. Cross-tenant access must fail. Use isolated test infrastructure only.

### A2. Runtime boundaries
- Keep local mode available for development and deterministic tests.
- Add deployment-mode diagnostics: local-only, isolated-cloud-ready, connected, verified.
- Readiness must distinguish configured credentials from successful authenticated storage/database checks.
- Never echo secrets or enable remote/billable providers simply because credentials exist.
- Fail startup for unsafe production configuration combinations rather than silently falling back to ephemeral persistence.

## Wave B — versioned media-provider contracts

Define provider-neutral capability contracts before adding providers. Each capability declares:
- input/output ports and MIME constraints;
- operation types: text-to-image, image-edit, image-to-video, start/end-frame, video-edit, audio-conditioned video, speech, transcription, enhancement;
- reference image/frame/audio/mask support and limits;
- model-specific parameters with typed bounds;
- dimensions, aspect ratios, duration, frame rate, resolution and output format limits;
- synchronous/asynchronous execution, polling/callback support and cancellation semantics;
- authentication mode, data-retention notes, verified pricing source/date, maximum budget;
- normalized provider job IDs, retryability, safety refusal, rate limit and validation errors.

Adapter states are specified, implemented, contract-tested, connected, and live-verified. A configured key alone never means available. Unsupported inputs must fail before dispatch and explain the missing capability. Keep provider-specific fields out of shared project records; store them in validated adapter configuration.

### B1. Contract tests
For every adapter, run mock-server tests for valid requests, authentication failure, malformed configuration, unsupported references, rate limits, timeout, cancellation, malformed/oversized output, checksum verification and resumable download. Live smoke tests are opt-in, budget-capped and use non-sensitive fixtures.

### B2. Reference-conditioned workflows
Add reference image, image edit, first/last frame, video continuation, masks and audio conditioning as distinct typed ports rather than ambiguous prompt JSON. Preserve source assets and record conditioning inputs and consent/right basis in provenance. Never silently drop an input an adapter cannot honor.

### C2. Deterministic derivative provenance — implemented, awaiting CI
- Local FFmpeg-derived media assets now record a versioned processing provenance object: operation, engine, method, allowlisted parameters, source asset ID and source SHA-256.
- Deterministic scaling is explicitly labeled as deterministic resampling, not neural inference; the provenance marks `aiInferencePerformed: false`.
- Unknown job types return no generic provenance record, and arbitrary input fields are not copied into metadata.
- The media-operation verification script checks provenance, lineage, method labels and parameter allowlisting. CI/local execution still needs confirmation.

## Wave C — upscale and post-production truthfulness
### C3. Recipe input boundary hardening — implemented, awaiting CI
### C4. Recipe-to-workflow compilation — implemented, awaiting CI
- Validated video/audio enhancement recipes can now compile into the platform's existing typed workflow graph.
- The generated graph starts with an accessible source-asset node, pauses at a dedicated human approval node, then runs the requested operations in order.
- The compiler validates the resulting graph with the same workflow graph validator used by workflow execution.
- Compilation is dry-run only: it does not enqueue jobs, run FFmpeg, activate providers or spend credits.
- Regression tests assert graph validity, operation order, approval placement and rejection of unsupported recipe operations.
- The actual queue submission/resume path remains a separate integration and must preserve the approval boundary.

- Recipe steps now reject null, array and non-object step payloads.
- Parameters must be plain object-shaped input; only operation-specific allowlisted keys are retained before the media argument validator runs.
- Unknown fields are discarded so credentials, arbitrary metadata and unrelated caller values cannot flow into the dry-run plan.
- Tests cover unknown-field removal, malformed parameter payloads and invalid step entries.
- This remains a dry-run planner: it does not queue or execute a recipe, and no AI inference is claimed.


- Keep Real-ESRGAN fail-closed until the configured executable and model files pass an execution self-test. Report execution verification separately from inference-quality verification: a successful process and plausible file header do not prove neural inference or perceptual quality. Mock binaries test contracts only.
- Add verified engine/model readiness, input/output dimensions and format checks, resource/time/output ceilings, cancellation and derivative lineage. Do not report `inferenceVerified` from file metadata or process exit alone; require independent fixture-based checks before asserting model inference/quality.
- Add optional deterministic FFmpeg recipes for transcode, proxy, audio extraction, loudness normalization and scaling, labeled as deterministic processing rather than neural enhancement.
- Do not label denoise, face restoration, inpainting, frame interpolation or stabilization as AI-powered unless a corresponding tested engine actually runs.
- Add enhancement recipes with ordered steps, parameter validation, dry-run plan, approval, batch budget and resumable per-asset status.

### C1. Readiness catalog hardening — implemented, awaiting CI
- The provider catalog now distinguishes engine availability, execution verification and independent fixture-based quality evidence.
- A caller-supplied `inferenceVerified` flag or successful execution check alone cannot advertise the AI-upscale capability as ready.
- Quality readiness requires a recorded fixture identifier and parseable evidence timestamp; the current Real-ESRGAN adapter does not yet emit that evidence, so the capability remains unverified by design.
- Tests cover disabled, execution-only, claimed-inference-only and evidence-backed states.
- CI is pending; do not treat this slice as verified until the workflow completes successfully.

### E1. Local derivative validation before publication — implemented, awaiting CI
- Local media jobs now run FFprobe against the produced derivative before registering it as an asset.
- Publication is rejected when the expected audio/video stream is absent, duration is invalid/unverifiable, metadata is malformed, or the output file is empty.
- Validation reports stream count, duration and expected stream type; this is structural validation, not perceptual quality scoring.
- Verification script includes valid video/audio/image-thumbnail probe cases and malformed/mismatched output rejection. CI/local execution remains to be confirmed.

### C3. Approval-gated enhancement recipe planner — implemented, awaiting CI
- Added a reusable dry-run planner for ordered video/audio enhancement steps, with operation-specific parameter validation and media-type compatibility checks.
- Recipes are limited to 12 steps, reject unsupported operations (including unverified AI upscale), and whitelist parameters before returning the plan.
- Each planned step carries a truthful engine/method label and explicit approval requirement; plans report no fabricated duration or cost estimate.
- Added focused tests and included them in the main build verification command. Planner does not yet enqueue or execute batch jobs; that requires the next approval-aware workflow integration.

### E2. Cloud derivative validation before publication — implemented, awaiting CI
- Cloud FFmpeg derivatives now require FFprobe and must contain the expected audio/video stream before the asset repository can publish them.
- Audio/video derivatives require a positive, verifiable duration; image thumbnails require verified image dimensions.
- Malformed metadata, missing streams, unverifiable duration, or invalid image dimensions fail closed before publication.
- Existing stricter video-upscale checks remain in place for codec, pixel format, requested dimensions, audio preservation and duration drift.
- Added a cloud executor regression test proving a structurally invalid derivative is never published. Structural checks do not establish visual quality or correct creative content.

## Wave D — presenter, dubbing and continuity
- Keep narration TTS, transcription, translation, avatar rendering, voice cloning and lip-sync as separate capabilities with separate readiness and permissions.
- Add timestamped transcript alignment and optional diarization only through tested adapters.
- Require purpose-scoped, unexpired authorization for likeness/voice operations; support revocation and re-check permission immediately before dispatch.
- Preserve source/target transcript lineage, glossary version, subtitle cue order and timing; detect drift and missing dialogue.
- Add scene/shot continuity records for identity, wardrobe, location, props, camera movement, lighting and color. Surface evidence-backed warnings without silently rewriting creative decisions.

## Wave E — editorial, QA and delivery
- Add proxy-backed timeline preview, frame-accurate seeking, multi-video compositing, transitions, overlays and effect graphs in incremental tested slices.
- Run FFprobe checks for streams, duration, frame rate, dimensions, audio layout and codec after render.
- Add visual/audio regression fixtures, black-frame/silence checks, clipping and caption timing checks.
- Add review decisions, timecoded comments, version comparison and export manifests.
- Treat publishing and share links as explicit permissioned actions; assets remain private by default and signed links expire.

## Required release dashboard
Every capability must report state/evidence date, supported inputs/outputs, local and CI test results, provider health separately from credential presence, privacy/rights/cost/approval gates, known limitations and reproducible acceptance evidence.

## Execution order
1. Audit existing migrations, storage interfaces and cloud queue tests against Wave A; close gaps in isolated test infrastructure.
2. Run the full CI suite and preserve passing commit/PR history.
3. Implement the smallest provider-contract slice with mock tests; do not add live credentials.
4. Wire only contract-tested nodes into the workflow canvas and shared asset lineage.
5. Add real media fixtures for upscale/render QA.
6. Revisit cloud deployment and live provider smoke tests only after relevant gates pass.

## Preservation rules
- Work only on feat/executive-visuals-unified-platform until reviewed and accepted.
- Preserve main, open PRs and production services.
- Do not apply migrations to connected shared or production databases.
- Do not expose credentials, bypass provider access controls, scrape private endpoints or copy proprietary source/weights/prompts.
- Do not claim cloud durability, live generation, model quality or provider parity without reproducible tests.

### C5. Workflow media quality reports — implemented, awaiting CI
- Existing `quality-check` workflow nodes now turn FFprobe metadata into a structured quality report.
- Reports include duration, stream counts, video codec/dimensions/frame rate, audio codec/sample rate/channels, and actionable missing-stream/invalid-metadata/below-HD findings.
- Severity is explicit: structural errors need attention; warnings request review.
- A test suite covers valid HD A/V, missing audio, invalid duration/frame rate, below-HD dimensions and audio-only files.
- This is structural QA only. It does not claim black-frame, silence, clipping, sync, colour, face, motion or perceptual-quality detection; those require separate signal-analysis and human-review stages.
