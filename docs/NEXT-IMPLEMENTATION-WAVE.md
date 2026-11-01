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

## Wave C — upscale and post-production truthfulness
- Keep Real-ESRGAN fail-closed until a real inference self-test succeeds; fake binaries/mock output test contracts, not model quality.
- Add verified engine/model readiness, input/output dimensions and format checks, resource/time/output ceilings, cancellation and derivative lineage.
- Add optional deterministic FFmpeg recipes for transcode, proxy, audio extraction, loudness normalization and scaling, labeled as deterministic processing rather than neural enhancement.
- Do not label denoise, face restoration, inpainting, frame interpolation or stabilization as AI-powered unless a corresponding tested engine actually runs.
- Add enhancement recipes with ordered steps, parameter validation, dry-run plan, approval, batch budget and resumable per-asset status.

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
