# Unified creative-production platform — consolidation blueprint

**Revision:** 1 November 2026  
**Target:** existing Executive Visuals application  
**Delivery branch:** `feat/executive-visuals-unified-platform`  
**Status:** architecture and capability mapping; implementation gates remain authoritative.

## Product outcome

Build one independent creative-production operating system from three complementary capability families:

1. **Creative direction and cinematic generation** — brief-to-production planning, reusable characters and visual references, shot-level camera/lighting/motion direction, image/video creation, multi-shot continuity, campaign creative and node-based production.
2. **Presenter-led production and localization** — scripts, presenters, consented identity/voice profiles, speech, lip-sync, scene composition, captions, translation, dubbing and repeatable/batch outputs.
3. **Image/video enhancement and post-production** — repair, denoise, upscale, retouch, object/background operations, frame expansion/interpolation, color correction, conversion, compression and repeatable processing recipes.

These are not three separate applications or navigation silos. They are capability families inside one project, asset, workflow, timeline, review and publishing system. The user should move from one brief to a finished deliverable without exporting/importing between disconnected workspaces.

## Shared domain model

All capabilities use the same canonical records:

- **Workspace / project:** tenant, owner, members, permissions, brand, policy and revision.
- **Production brief:** objective, audience, message, channel, aspect ratio, duration, style, constraints and acceptance criteria.
- **Production bible:** characters, approved identity references, voice profiles, wardrobe, locations, props, brand kit, glossary and rights/consent.
- **Scene / shot:** ordered scene and shot IDs, script range, duration, composition, camera, lens, movement, lighting, subject/action, continuity constraints and references.
- **Asset:** immutable source or derivative, MIME, dimensions/duration, checksum, provenance, rights, parent asset and storage location.
- **Workflow:** typed DAG with validated ports, provider-neutral parameters, immutable run snapshot and node-level outcomes.
- **Job / run:** idempotency, budget ceiling, approval, queue lease, retries, cancellation, provider request ID, status events and output assets.
- **Timeline:** non-destructive multi-track edit decision list, rational frame timing, source ranges, audio, captions, overlays, markers and render settings.
- **Review / delivery:** timecoded comments, decisions, versions, exports, publishing destination and audit events.

Avoid duplicate character, asset, project, job or provider models in individual studios. Workspaces are views over shared records.

## Unified user journey

1. Capture an idea, script, reference, product, source footage or campaign brief.
2. AI Director drafts a structured brief and production plan; the user can edit every decision.
3. Resolve missing inputs, source rights, identity/voice consent, brand rules and output requirements.
4. Build production bible, script, storyboard, scene and shot plan.
5. Select one or more compatible generation/enhancement providers using live capability schemas.
6. Show input validation, expected outputs, limits, cost/time estimate where verified, data handling and approval requirements before execution.
7. Execute approved workflow nodes asynchronously; persist intermediate assets and provenance.
8. Assemble results on the shared timeline; refine shots, presenter performances, audio and visual quality.
9. Run automated quality/continuity checks and human review.
10. Render, localize, create campaign variants and export/publish under explicit approval.

## Cross-family workflows that must work

### Campaign film
Brief -> brand/product ingestion -> concept -> script -> storyboard -> shot plan -> generated stills/video -> enhancement -> presenter/voice if needed -> timeline -> captions -> review -> export.

### Presenter-led multilingual episode
Topic research -> sourced script -> presenter/identity consent -> voice selection -> scene plan -> speech/avatar render -> transcript -> translation/glossary -> captions/dubbing -> timeline -> review -> language exports.

### Existing-footage restoration
Upload -> probe -> scene/face/quality analysis -> repair recipe -> denoise/stabilize/upscale/color/audio cleanup -> before/after review -> timeline replacement -> export.

### Product creative batch
Catalog/product references -> campaign angles -> approved templates -> parallel image/video variants -> quality/brand checks -> human selection -> channel-specific exports.

Each workflow is a saved graph over the same asset and job contracts, not a hard-coded one-off pipeline.

## Implementation truth as of this revision

### Working locally (verified by repository tests/build design)
- Unified browser shell, project workspace, capability explorer and asset library.
- 110 provider-neutral capability definitions across 23 domains.
- Typed visual workflow graph, server validation, immutable run snapshots, targeted reruns, node states and approval pause/resume.
- Persistent local API, project roles, audit trail, asset checksums and local job queue with leases/retries.
- FFmpeg media processing, timeline assembly and MP4 master rendering.
- Image/video prompt-only remote adapters and speech synthesis/transcription/caption/localization paths are present behind server-side gates; external provider execution is not asserted as live/verified.
- Dedicated cloud schema and private storage policy are written and statically guarded, but are not applied to shared infrastructure.

### Important gaps — do not represent as complete
- Dedicated Postgres and private object storage are not connected to the runtime.
- Multi-host durable queue/worker deployment is not complete.
- Cloud identity, tenant isolation and production session hardening need end-to-end verification.
- Image/video adapters currently have prompt-only input limitations; reference image, start/end frame, mask, audio conditioning, model-specific parameters and robust provider capability discovery need explicit adapter contracts and tests.
- Speech transcription is present; diarization, voice cloning, dubbing, presenter/avatar rendering and verified lip-sync are not complete.
- Timeline preview, multi-video compositing, transitions, animated overlays and advanced effects are pending.
- Neural enhancement, temporal object removal/inpainting, advanced stabilization, face-aware retouch and scene-aware enhancement require real tested adapters; deterministic FFmpeg operations are not equivalent.
- Webhooks, provider callback verification, usage-based pricing and cost estimates need verified provider contracts.
- Publishing connectors and external review links are not complete.

## Delivery order and release gates

### P0 — safe durable foundation
1. Review and test isolated schema/RLS against a dedicated non-production database.
2. Implement a storage adapter contract and private object storage with signed, short-lived access.
3. Move jobs/workflow runs/events to Postgres with atomic claim, lease heartbeat, idempotency, retry and cancellation semantics.
4. Deploy separately scalable API and worker processes.
5. Add cloud identity verification, tenant-scoped authorization and security tests.
6. Prove restart recovery, concurrent workers, cross-tenant denial, large asset upload/download and checksum integrity.

**Gate:** no paid provider execution until durable identity, storage, job state and audit are verified.

### P1 — complete provider-neutral media contracts
1. Define versioned provider capability schemas: accepted ports, formats, dimensions, duration, reference types, model parameters, limits, callbacks and output validation.
2. Implement image reference/edit, image-to-video, start/end-frame, video edit, mask, audio conditioning and model-specific parameters only against documented provider contracts.
3. Add async submit/poll/webhook lifecycle with signed callback verification, cancellation, timeout and resumable download.
4. Implement provider health/readiness probes and safe fallback based on capability compatibility, not provider name alone.
5. Add deterministic mock-server contract tests and opt-in live smoke tests with budget caps.

**Gate:** an adapter is marked available only after schema, auth, request, result, failure and asset-integrity tests pass.

### P2 — presenter and localization
1. Add transcript alignment and diarization.
2. Add explicit consent lifecycle for voice/likeness capture, training, use, expiry and revocation.
3. Add presenter/avatar generation and lip-sync as distinct provider capabilities.
4. Add dubbing and localization graph with source/target transcript lineage, glossary and timing validation.
5. Add scene-level presenter composition and review.

**Gate:** no identity/voice training or generation without a current purpose-scoped consent record and explicit approval.

### P3 — editor and enhancement
1. Add browser timeline preview from proxies and frame-accurate seeking.
2. Add multi-video tracks/compositing, transitions, animated overlays and effect graph.
3. Add scene-aware enhancement adapters and before/after controls.
4. Add mask tracking and temporal object/background operations.
5. Add quality scoring, artifact warnings and repeatable batch recipes.

**Gate:** verify outputs with real media fixtures, FFprobe and visual/audio regression checks.

### P4 — production intelligence and scale
1. AI Director generates editable, explainable production graphs.
2. Continuity checks across character, wardrobe, location, props, camera and color.
3. Campaign variant/batch generation with per-output budgets and approvals.
4. Webhooks, scheduled jobs, publishing connectors and delivery analytics.
5. Project templates, reusable recipes and collaboration/review links.

**Gate:** no unattended batch or publishing without tenant budgets, policy, approvals and audit.

## Non-negotiable engineering rules

- Preserve `main`; develop only on the dedicated feature branch until release gates pass.
- Do not alter existing production services, shared databases or secrets during this phase.
- Do not expose credentials in browser code, project JSON, logs or error messages.
- Do not call a provider merely because a key exists; require explicit enablement, remote opt-in, approved job and budget.
- Keep source assets immutable; store edits as derivatives with hashes and lineage.
- Keep all generated and imported content private by default.
- Treat source prompts, captions, uploaded documents and provider output as untrusted data.
- Enforce consent and rights for identity, voice, product, brand and source media.
- Distinguish specification, prototype, adapter-ready, connected and verified states.
- Prefer reusable capability contracts and workflow nodes over duplicating features across studios.
- Never claim parity or completion without reproducible acceptance evidence.

## Immediate next engineering task

Complete P0 in a dedicated isolated environment: connect the existing schema to a dedicated Postgres project, add private object storage and migrate queue/worker persistence without touching shared production resources. Then validate one end-to-end path: upload reference -> create project -> draft workflow -> approve -> process a local media job -> store derivative -> review -> export -> restart worker -> confirm all records and assets remain intact.

Only after this is proven should reference-conditioned paid generation be enabled.
