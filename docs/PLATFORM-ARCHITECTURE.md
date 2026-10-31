# Executive Visuals — original implementation architecture

## Product principle
One production system with many focused studios. All studios share projects, assets, identities, workflows, jobs, approvals and cost records. Implement capabilities independently or through documented, authorized provider APIs.

## Runtime topology

    Browser / Desktop
      ├── Command Centre and Creative Studios
      ├── Project, Asset, Timeline and Workflow UI
      └── Realtime progress and review
              │ authenticated API
              ▼
    API Gateway / BFF
      ├── Identity and Tenant Policy
      ├── Project and Production Bible
      ├── Asset and Upload Service
      ├── Workflow Graph Validator
      ├── Approval and Cost Preflight
      ├── Job Orchestrator
      └── Audit and Usage Ledger
              │
              ├── Provider Gateway
              │     ├── Image and Video models
              │     ├── Avatar, Voice and Translation
              │     └── Enhancement and Editing providers
              ├── Local Media Workers
              │     ├── FFmpeg deterministic transforms
              │     ├── Image processing
              │     └── Optional GPU model workers
              ├── Object Storage and CDN
              ├── Postgres
              ├── Queue and Scheduler
              └── Realtime event channel

## Domain modules

### Project domain
Projects, folders, creative brief, audience, brand kit, production bible, scripts and versions, scenes, shots, continuity, reusable characters, locations, props, voice profiles and rights.

### Asset domain
Source uploads, generated outputs, derivatives and external references. Store MIME type, size, duration, dimensions, codec, checksum, owner, project, source and lineage. Support signed upload/download URLs, thumbnails, proxies, versioning, retention and deletion.

### Workflow domain
Typed directed acyclic graph. Node types: prompt, text, upload, reference, image generation, video generation, avatar, speech, transcription, translation, edit, enhancement, QC, approval, export and connector action. Include typed ports, graph validation, cycle detection, immutable run snapshots, reusable templates and selective recomputation.

### Job domain
Internal job IDs, provider job IDs, immutable request snapshots, idempotency key, queue position, progress, retry budget, timeout, cancellation, webhook state, normalized errors and separate estimated/actual cost.

### Provider domain
Adapter SDK, capabilities, model versions, constraints, server-side credentials, safe health checks, model routing, circuit breakers and rate limits. Never use undocumented private endpoints as an integration strategy.

### Media processing domain
Deterministic FFmpeg pipelines for transcode, trim, concat, audio extraction, conversion, compression and basic timeline render. AI adapters for super-resolution, restoration, denoise, segmentation, inpainting, interpolation, retouch, color match and generative expansion. QC checks for duration, resolution, codec, sync, black frames, silence, subtitle timing and file integrity.

### Trust domain
Consent grants for face/voice likeness and synthetic performance, source rights declarations, spend/publication/destructive-action approvals, audit events, provenance, synthetic-media labels, retention, export and deletion.

## Shared capability contract

A capability declares ID, label, description, input/output schema, accepted MIME types, size limits, model constraints, optional parameters, consent/rights requirements, pricing unit and estimate method.

Every adapter declares provider ID/version, capabilities, accepted schemas, model constraints, authentication requirements, pricing metadata, job create/status/cancel methods, webhook verification, data region/retention where documented, known limitations and normalized error handling.

    interface MediaProviderAdapter {
      id: string;
      version: string;
      capabilities(): Promise<CapabilityDescriptor[]>;
      validate(input: unknown): Promise<ValidationResult>;
      estimate(input: unknown): Promise<CostEstimate>;
      submit(input: unknown, context: JobContext): Promise<ProviderJob>;
      getStatus(providerJobId: string): Promise<ProviderJobStatus>;
      cancel?(providerJobId: string): Promise<void>;
      normalizeError(error: unknown): NormalizedProviderError;
    }

Authorization, consent, approval and spend checks happen before adapter submission. An adapter must never decide whether the user is allowed to execute a job.

## Job state machine

    draft → validated → awaiting_approval → queued → running
        → succeeded | failed | cancelled

Additional states: retry_wait, needs_input, provider_pending, partially_succeeded, expired.

Rules:
- Every execution has an immutable input/config snapshot.
- Provider IDs are not internal primary keys.
- Idempotency prevents duplicate paid generations.
- Webhooks are authenticated and idempotent.
- Retry only transient errors within a configured budget.
- Never automatically retry an uncertain paid request before determining whether a provider job already exists.
- Persist estimates and actual usage separately.

## Media pipeline

    ingest → validate → probe → normalize → process → QC
           → store derivative → review → export

Probe metadata; validate codecs, dimensions, duration and size; generate thumbnails/proxies; preserve the source; record transforms non-destructively; store checksums and lineage; run visual/audio QC; export using named platform profiles.

## Initial persistence entities

tenants, users, memberships, roles, provider_connections, projects, project_revisions, brand_kits, production_bibles, scripts, script_versions, characters, character_looks, voice_profiles, consent_grants, assets, asset_versions, asset_derivations, references, scenes, shots, workflows, workflow_revisions, workflow_nodes, workflow_edges, jobs, job_attempts, provider_events, approvals, comments, export_profiles, usage_ledger, audit_events.

## Release gates

### Gate A — durable domain foundation
- [ ] Replace localStorage-only persistence with a repository abstraction and durable backend.
- [ ] Implement project/asset/script/shot/character CRUD with schema validation.
- [ ] Add authentication, tenant isolation and role checks.
- [ ] Add migrations and seed fixtures.

### Gate B — workflow and job runtime
- [ ] Implement DAG schema, cycle detection and type validation.
- [ ] Implement job state machine and immutable snapshots.
- [ ] Add queue, retries, idempotency, cancellation and webhook validation.
- [ ] Add cost preflight and approval policy.
- [ ] Add audit and usage ledger.

### Gate C — media infrastructure
- [ ] Add signed uploads and object storage.
- [ ] Add FFmpeg worker for deterministic operations.
- [ ] Add thumbnail/proxy generation and asset QC.
- [ ] Add timeline render graph and export presets.

### Gate D — real engine integrations
- [ ] First provider adapter using documented public API.
- [ ] Image generation and edit adapters.
- [ ] Video generation and reference-frame support.
- [ ] TTS, transcription, translation and lip-sync adapters.
- [ ] Consent-gated avatar/digital-twin workflows.
- [ ] Enhancement/restoration adapters.
- [ ] Local/open-source fallback only where hardware, license and runtime allow.

### Gate E — product completeness
- [ ] AI Director emits editable structured production plans.
- [ ] Cinematic Studio has global production bible and per-shot controls.
- [ ] Canvas executes nodes, branches and saved templates.
- [ ] Campaign Studio supports product ingestion, templates and variants.
- [ ] Enhancement recipes chain, batch, preview and resume.
- [ ] Team review and collaboration.
- [ ] Observability, security review, load tests and cost controls.

## Definition of done
A capability is operational only when a real authorized adapter or local engine executes it, the output is persisted, the job lifecycle is visible, costs are accounted for, failure handling works, and an automated test verifies the result. A UI control, prompt template or provider documentation link is not completion.

## Unified production engine

The application combines three capability families under one project and asset model:

1. **Presenter and identity production:** reusable character/presenter profiles, approved likeness and voice records, script-driven presenter workflows, localization and lip-sync capability contracts.
2. **Cinematic generation and direction:** briefs, scripts, storyboards, shot lists, camera/lens/lighting controls, image and video generation contracts, scene continuity and campaign variants.
3. **Finishing and delivery:** shared editorial timeline, captions, audio tracks, local FFmpeg processing, image/video enhancement operations, export and asset provenance.

The families are not separate products. They share project permissions, creative briefs, assets, workflow graphs, approval checkpoints, job status, output lineage and export paths. Provider/model integrations are replaceable adapters behind the capability contracts. A capability remains unavailable until its implementation and readiness evidence are verified; a catalog entry alone is not an executable feature.
