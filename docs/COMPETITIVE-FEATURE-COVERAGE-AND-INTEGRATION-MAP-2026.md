# Competitive feature coverage and integration map — 2026

**Research date:** 7 November 2026  
**Repository:** `Chrishem2003/EXECUTIVE-VISUALS`  
**Research branch:** `research/production-platform-benchmark-2026`  
**Purpose:** Extend the production-platform benchmark into a feature-level reverse-engineering inventory, distinguish current-main behavior from open-PR/branch-only work, and define the safest implementation sequence.

> Evidence discipline: a provider's public API documentation establishes the documented API surface, not guaranteed account entitlement or production availability. A GitHub PR description establishes proposed branch scope, not that the feature is merged, deployed, or accepted in hosted staging. Every capability must be labelled separately as specified, coded, tested, staging-verified, and production-enabled.

## 1. Product systems worth learning from

### Runway Dev: a creative production API, not just a video endpoint

The current public API surface includes:
- Text-to-video and image-to-video.
- Video-to-video editing, including model-specific keyframes and output formats.
- Video upscaling and frame-rate enhancement.
- Video-to-HDR conversion.
- Audio generation synchronized to a video.
- Text-to-speech, speech-to-speech, voice dubbing and voice isolation.
- Character performance/control and avatar video generation.
- Multi-shot video recipes, product/UGC recipes and product swap workflows.
- Model Router for model-agnostic generation, budget caps, optimization preferences and non-billable dry runs.
- Asynchronous task status and cancellation/deletion.
- Ephemeral file uploads for larger inputs.

Important implementation lessons:
1. Treat editing, upscaling, HDR, audio, speech, avatar and generation as different capability families with separate request/response schemas.
2. A source video must be uploaded or supplied using a provider-supported URI; do not expose temporary provider URLs to users.
3. Keep long-running work asynchronous. Persist provider task IDs and reconcile status in workers.
4. Retrieve and store output promptly: Runway output URLs expire, and should not become permanent asset references.
5. Model Router's dry-run capability can support cost/capability preflight without starting a billable task. Use it only where configured and tested.
6. Multi-shot recipe outputs need shot-level metadata and a deliberate path into the editable storyboard/timeline, not one opaque flattened file.

Official sources:
- API reference: https://docs.dev.runwayml.com/api/
- Video-to-video, upscale, HDR and audio API reference: https://docs.dev.runwayml.com/api/
- Ephemeral uploads: https://docs.dev.runwayml.com/assets/uploads/
- Output expiry and storage: https://docs.dev.runwayml.com/assets/outputs/
- Workflow execution: https://docs.dev.runwayml.com/workflows/running/
- Video editing and finishing guide (22 October 2026): https://dev.runway.com/learn/edit-and-finish-video-api

### Kling: controllable multimodal generation and editing

Public Kling 4.0 documentation describes:
- Text-to-video, image-to-video, Omni Reference and video-editing workflows.
- Up to 30-second generation.
- Up to 10 keyframe images in the keyframe workflow.
- Up to 15 reference assets across image, video, element and voice-profile references in Omni Reference.
- Video editing with a primary clip plus reference clips, subject to per-clip and aggregate duration constraints.
- Role-labelled references and prompt instructions that distinguish what to preserve from what to change.
- Synchronized native audio on supported model families.

Implementation lessons:
1. A generic `referenceImages[]` field is insufficient: references need typed roles (character, style, action/motion, camera, scene, voice, source video).
2. Keyframes require timestamp/frame ordering, uniqueness, bounds and supported-count validation.
3. Video edit prompts must distinguish the source to edit, requested modifications and invariants to preserve.
4. Native audio is a per-model capability, not a global toggle.
5. Preserve the original and create a derivative with source lineage; never overwrite the source clip.

Official sources:
- Kling 4.0 usage guide: https://kling.ai/document-api/api/usage-guide/kling-4-0
- Kling developer API: https://kling.ai/dev/api
- Kling pricing: https://kling.ai/dev/pricing

### Canva: a content operations layer

Canva's developer platform separates:
- Design creation/editing APIs.
- Brand templates and datasets.
- Asynchronous Autofill jobs.
- Asset and folder management.
- Export and resize operations.
- Comments, approvals and sharing webhooks.
- In-editor apps and integrations for AI assistants.

Implementation lessons:
1. Brand kits must be structured data (logo variants, colors, fonts, voice, safe zones and usage rules), not just uploaded images.
2. Templates should expose typed fields and validation schemas; campaign rows can fill templates in batches.
3. Social platform resizing should be a derivative workflow with per-destination aspect ratio, safe-area and export constraints.
4. Approval events should be explicit workflow events, not just a status label in the UI.
5. Canva integration should be optional. Executive Visuals needs its own brand assets and design editor, with an integration adapter where customers authorize Canva.

Official sources:
- Canva developer platform: https://www.canva.dev/docs/
- Autofill API: https://www.canva.dev/docs/apps/rest-apis/reference/autofills/
- Brand templates, assets, exports, resize and webhooks: https://www.canva.dev/docs/

### Adobe Firefly: governed creative production

Adobe's public Firefly Services surface is a reference for professional API-based image/video operations and enterprise integration. The transferable product requirements are:
- Documented model/service capability contracts.
- Source and derivative lineage.
- Usage rights, provenance and consent metadata.
- Controlled transformations and review before delivery.
- Integration with established editing and asset-management workflows.

Official source:
- https://developer.adobe.com/firefly-services/

### fal.ai: provider aggregation and metered inference

fal's public API surface provides:
- Per-model endpoint catalogue.
- Queue submit/status/result/cancel patterns.
- Pricing APIs with explicit units.
- Usage and spend reporting.
- Prepaid credits and concurrency controls.

Implementation lessons:
- Price unit may be image, megapixel, video second, request or compute second.
- Queue waiting time is distinct from billable inference.
- Server errors are not equivalent to successful output.
- Persist the exact price snapshot used for each quote and job; provider prices change.
- Do not use one universal multiplier for all modalities.

Official sources:
- Pricing: https://fal.ai/docs/documentation/model-apis/pricing
- Queue API: https://fal.ai/docs/api-reference/inference-api/queue/submit
- Status: https://fal.ai/docs/api-reference/inference-api/queue/status

### Payment systems: Dodo and Flutterwave patterns

Dodo's public adapter and SDK materials show payment, refund, dispute, subscription, credit, dunning and entitlement-grant events. The webhook adapter verifies signatures; the application still needs to enforce ownership, deduplicate event IDs, reconcile out-of-order state and process events durably.

Flutterwave's Uganda documentation demonstrates UGX mobile-money collection. Its webhook guidance says:
- Verify the configured webhook secret hash.
- Re-query the transaction API before granting value.
- Match status, amount, currency and transaction reference.
- Acknowledge promptly and perform heavier work asynchronously.
- Make event processing idempotent.
- Poll pending transactions as a fallback when webhooks fail.

Commercial lessons:
1. Payment status must be verified server-to-server; never trust the browser redirect or a client-supplied success flag.
2. A webhook inbox should store provider event ID, signature verification result, received timestamp, processing state and redacted payload digest.
3. Subscription state must be derived from verified payment/provider state and local policy.
4. Duplicate, delayed and out-of-order events must not double-grant credits or restore suspended access incorrectly.
5. Local mobile money one-time collection does not automatically prove recurring subscription debit support. Verify merchant account capabilities and method/currency support.
6. Payment, subscription entitlement, internal credit ledger and actual AI provider cost are separate ledgers.

Sources:
- Dodo Express adapter/webhook documentation: https://github.com/dodopayments/dodo-adapters/tree/main/packages/express
- Dodo TypeScript webhook event types: https://github.com/dodopayments/dodopayments-typescript/blob/main/src/resources/webhook-events.ts
- Flutterwave webhooks: https://developer.flutterwave.com/docs/webhooks
- Flutterwave Uganda mobile money: https://developer.flutterwave.com/docs/uganda

## 2. Feature-level product map

| Product capability | Target behavior | Existing repository evidence | Remaining verification/gap |
|---|---|---|---|
| Text/image-to-video | Provider-neutral generation with capability truth | Runway gateway, FAL gateway, normalized video contract, PRs #34/#56/#62/#189 | Exact live provider account/model readiness; staging end-to-end |
| Video-to-video edit | Source video + prompt + optional supported keyframes; immutable derivative | Current Runway adapter docs explicitly say unsupported | New adapter endpoint, secure source upload, output format validation, UI and worker path |
| Multi-keyframe | Timestamped first/middle/last frames with ordering and bounds | Normalized contract has start/end frame IDs; PR #189 supports first frame only | Intermediate frames, model-specific limits, asset authorization and UI |
| Omni/multi-reference | Typed image/video/element/voice roles | Contract has generic reference asset IDs; Kling public docs support typed roles | Typed role schema, per-model payload adapters, project-level reference bundles |
| Multi-shot storytelling | Editable scene/shot plan, per-shot generation and regeneration | PRs #76/#78/#80; Runway multi-shot recipe planner PR #47 | Dependency chain, integration, provider result-to-shot attachment |
| Video upscale/HDR | Preserve source, create quality-labelled derivative | Local enhancement work and FFmpeg pipeline exist | Runway provider upscale/HDR adapter and format-specific output validation |
| Audio generation from video | Synchronized SFX/music as a separate audio asset | Existing timeline audio/mixer/mastering foundations | Provider adapter, duration alignment, stem/asset handoff |
| Speech/dubbing/avatar | Voice identity and consent, transcript alignment, per-speaker dubbing/lip-sync | Existing captions, transcription/VAD and audio workflow foundations | Dedicated adapter contracts, consent registry, language/voice QA and user controls |
| Timeline editor | Multitrack edit, transitions, speed, audio, captions, preview/export parity | Many editor PRs (#103–#113, #127–#136) | Merge-stack review, exact-head CI, hosted media acceptance |
| Brand studio | Brand kits, templates, reusable campaign briefs | Product concept/workspace foundation | Brand token schema, template compiler, bulk/autofill pipeline |
| Review/collaboration | Frame comments, replies, reactions, approval, version awareness | PRs #140–#142 and review PR families | Merge/stack reconciliation, notifications and end-to-end workspace acceptance |
| Publishing/delivery | Export variants, channel-specific presets and approval before publish | Delivery preset/export PRs | Authorized social destination connectors, post status and analytics |
| Model marketplace/router | Model catalogue, capability filtering, cost/latency/quality routing | Provider registry, Runway router preflight PRs #39/#44/#63–#67, FAL/Luma routing PRs #43/#53/#57/#62 | Exact-head CI, safe branch integration, live provider price snapshots and routing evaluations |
| Subscription billing | Plans, entitlements, subscription lifecycle, credit ledger | PR #184 branch foundation | PR is open and currently non-mergeable; payment checkout/webhooks and cost settlement remain unimplemented |
| Admin/finance | Account controls, support/admin roles, cost, margin, audit and provider kill switches | PR #184 | Merge/rebase, payment reconciliation and production data source |
| Durable storage | Private assets, object integrity, recovery, durable job publication | Storage branches/PRs #100, #169, #171, #174–#179 | Dependency order, migration review, isolated hosted staging, backup and restore |
| Authentication/tenant isolation | Normal sessions, workspace roles, RLS and cross-tenant denial | Auth PRs #23 and #158; cloud asset auth tests | Confirm exact branch integration and hosted auth acceptance |
| Observability | Job lifecycle, provider errors, worker health, spend and incident alerts | PR #154 and job-stage observability branch | Hosted worker metrics, alerts, log redaction and incident drill |

## 3. Current repository integration inventory

The repository has extensive work in open PRs and long-lived branches. These must be treated as a dependency graph, not a list of changes to merge all at once.

### Billing and admin
- PR #184: secure admin console and subscription billing foundation.
- The PR description states that checkout is disabled, manual grants are pilot-only, model price references are not wired to automatic credit reservation/settlement, and SQLite/local storage prevent multi-user commercial promotion.
- The inspected PR is open and the GitHub API reported it as not mergeable at inspection time.
- Safe next step: reconcile its diff against current main in a fresh integration branch; do not merge the divergent branch blindly.

### Provider routing and model orchestration
- PRs #34, #38–#47, #53–#67 cover Runway adapters, model catalogue, Luma/FAL routing, workflow contracts, dry-run preflight, budget approval and worker composition.
- PR #189 adds first-frame image-to-video and says last/middle frames, multiple references, video-to-video, native audio and advanced model-specific controls remain outstanding.
- Safe next step: inspect exact dependency/base SHAs, identify the latest clean integration branch, then run exact-head CI. Do not duplicate an existing provider adapter.

### Storyboard and creative direction
- PR #76 adds model-backed Creative Director.
- PR #78 compiles editable scenes and shots.
- PR #80 converts reviewed storyboards into timeline plans.
- PR #47 adds a Runway multi-shot recipe contract planner.
- Safe next step: integrate in dependency order and verify plan-to-asset-to-timeline handoff; a plan is not a generated clip.

### Storage and cloud execution
- PR #58 wires a provider worker to Supabase/private media.
- PR #57 composes provider-aware cloud worker execution.
- PRs #169–#179 address cleanup, immutable publication, leases, storage integrity and preview persistence truth.
- PR #178 requires its dependency chain and PostgreSQL migration review.
- Safe next step: clean dependency reconciliation, isolated staging migration and restore rehearsal. Never apply these migrations to unrelated or shared projects.

### Timeline/audio/review
- PR families #103–#113, #120–#136, #140–#166 show significant transition, speed, multitrack, audio mastering, VAD, captions, review and annotation work.
- Safe next step: merge stack audit and exact-head parity tests (browser preview vs FFmpeg output), then hosted acceptance with real non-sensitive test media.

## 4. Critical architecture additions

### 4.1 Capability registry v2

Each provider/model/capability tuple needs:
- provider, model ID, model version and adapter version;
- modality and operation (generate, edit, extend, upscale, HDR, speech, dub, transcribe, avatar);
- supported input roles and MIME types;
- max input size/duration/count;
- duration, resolution, ratio, frame-rate, keyframe and reference limits;
- audio modes, languages, voice controls and output formats;
- provider queue/cancel/webhook support;
- pricing unit, currency, source URL, captured-at and effective-at;
- region/account availability evidence;
- status: specified, implemented, contract-tested, configured, staging-tested, live-verified, enabled;
- reason and evidence for any unavailable state.

Never infer support from the provider brand or model family. An adapter must reject unsupported controls instead of silently dropping them.

### 4.2 Durable media job lifecycle

Every long-running task must persist:
- internal job ID, idempotency key, tenant, project, asset IDs and immutable input manifest;
- provider/model/capability and exact price snapshot;
- approved cost ceiling and credit reservation;
- provider task ID, timestamps and normalized status;
- lease owner/token/expiry, heartbeat and attempt count;
- retry classification, cancellation intent and provider cancellation result;
- output manifest, checksums, MIME/container/codec verification and derivative lineage;
- provider usage, final charge and ledger settlement.

Unknown submission outcomes must be reconciled before retrying. A provider timeout does not prove the provider rejected the request.

### 4.3 Credit and payment ledger invariants

- Append-only ledger; corrections are compensating entries.
- Atomic reserve before dispatch, settle after verified completion, release only under documented provider billing/refund semantics.
- Unique idempotency for both provider jobs and payment events.
- Signed webhook verification, server-side transaction verification and out-of-order event reconciliation.
- Separate customer credits, provider spend, payment fees, tax, refunds, storage/compute and gross margin.
- Hard spend caps at user, project, workspace, model and platform level.
- A kill switch that prevents new paid tasks while allowing already-running jobs to reconcile.

### 4.4 Brand and content operations

- Brand kit versions: logos, colors, fonts, typography hierarchy, voice, image treatment, prohibited combinations and legal footers.
- Template schema with required/optional typed fields and validation.
- Campaign data model: audience, offer, key message, proof, CTA, channels, locales and dates.
- Bulk generation as bounded jobs, with per-row status and per-output review.
- Resize/export derivatives with safe-area and channel constraints.
- Publishing requires an authorized account connection, preview, explicit confirmation, idempotent publish request and delivery receipt.

### 4.5 Trust, consent and provenance

- Distinguish user-owned source media, licensed assets, synthetic outputs and provider references.
- Consent records must include subject/voice identity, permitted use, scope, expiry and revocation state.
- Character/voice identity libraries must be project/workspace scoped.
- Preserve source checksum and derivative lineage.
- Provide export/deletion workflows and legal hold behavior.
- Do not infer permission to clone a real person's voice or likeness from an uploaded file.

## 5. Implementation sequence (dependency-aware)

### Track A — Integration and release evidence
1. Build a PR dependency graph for open branches and identify clean merge bases.
2. Reconcile storage/auth/worker foundations before provider features.
3. Use disposable PostgreSQL in CI and isolated staging only for hosted migrations.
4. Add browser-level multi-tenant acceptance tests and storage restore rehearsal.
5. Keep the public Render Free service as a preview, not authoritative customer storage.

### Track B — Video model completeness
1. Add a typed operation contract for text-to-video, image-to-video, video-to-video, upscale, HDR and video-to-audio.
2. Implement secure ephemeral input upload and task lifecycle handling.
3. Add video-to-video on a model with documented support, starting with an isolated provider contract test.
4. Add keyframe and reference-role schemas with per-model limits.
5. Connect the adapter to the existing provider-aware worker and private output asset publication.
6. Add timeline handoff and review-before-replace. Original assets remain immutable.

### Track C — Audio, voice and avatar
1. Separate speech, dubbing, SFX, voice isolation and avatar generation contracts.
2. Add transcript/word-time/speaker alignment records.
3. Add voice/likeness consent registry and revocation checks.
4. Integrate output as independent audio/video assets and align to the timeline.
5. Verify audio/video sync and preview/export parity.

### Track D — Creative operations
1. Finish brand-kit schema and versioning.
2. Build structured campaign brief and reusable template compiler.
3. Add batch generation with row-level retries and per-output approvals.
4. Add resize/export presets and destination adapters.
5. Add review events, notifications and controlled publishing.

### Track E — Commercial launch
1. Reconcile PR #184 onto a clean branch.
2. Choose payment provider only after Uganda merchant onboarding, recurring payment method, fee, payout and content-policy verification.
3. Add provider webhook inbox, signature checks, transaction verification, idempotent processing and reconciliation.
4. Wire actual provider price snapshots to credit reservation/settlement.
5. Build contribution-margin dashboards and emergency spend controls.
6. Run full sandbox lifecycle tests before enabling live checkout.

## 6. Non-negotiable safety boundaries

- No production deploy, restart, scaling, environment edits or migrations in this research phase.
- No live provider generation, paid model calls or payment transactions in CI.
- No credentials or provider secrets in source control, browser bundles, logs or documentation.
- No reuse of NEMA or unrelated shared platform databases/storage.
- No merging divergent feature branches based only on their names or PR titles.
- No user-facing capability marked ready until adapter tests, staging acceptance and operational configuration evidence exist.
- No paid subscription advertised until real payment verification and unit economics are implemented.

## 7. Research status

This is an engineering specification and repository integration map. It does not assert that all listed features are merged, deployed or operational. The next implementation PR should be selected only after reviewing current main, dependency SHAs, exact-head CI and staging constraints.
