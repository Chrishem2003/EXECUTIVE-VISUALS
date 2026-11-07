# Production platform reverse-engineering benchmark and implementation blueprint

**Research date:** 7 November 2026  
**Repository baseline:** `main` at `18cb97bf027dc5037fc1d932f36dd4d00f6e6c67`  
**Branch:** `research/production-platform-benchmark-2026`  
**Status:** research and architecture proposal; no production configuration, billing, credentials, database, or provider execution changed.

## Executive conclusion

Executive Visuals should be engineered as a multi-tenant creative-production control plane with replaceable model providers, durable asynchronous execution, private asset storage, a ledger-backed commercial system, and observable operations. It should not be implemented as a thin UI that forwards prompts to whichever provider key happens to be configured.

Public product and API documentation from Runway, Kling, Canva, fal.ai, Supabase, Render and Dodo Payments exposes several repeatable production patterns. This document records those patterns and maps them to the current repository. It is independent reverse engineering from public documentation and product behavior; it does not copy proprietary source code, private APIs, model weights, or private prompts.

## 1. Public platform patterns observed

### Runway: asynchronous media tasks and workflow orchestration

Public Runway Dev documentation exposes a task-oriented API: submit a generation request, receive a task identifier, retrieve task state, and cancel/delete tasks where supported. Task states include pending/running/succeeded/failed patterns; consumers should not poll more frequently than the documented interval. The API also exposes workflow invocations and node-level errors. Its current API lists multiple model families behind a consistent developer surface.

Commercial lesson:
- A successful HTTP submission is not a successful generation.
- Persist the provider task ID and map provider states into our own stable lifecycle.
- Poll or consume callbacks with backoff; do not resubmit merely because a task is still processing.
- Inspect partial workflow failures rather than trusting only the overall status.
- Cancellation and refunds are separate facts. Cancellation may race with execution and must not promise a refund unless the provider confirms it.

Sources:
- https://docs.dev.runwayml.com/api/
- https://dev.runway.com/pricing
- https://help.runwayml.com/hc/en-us/articles/46974685288467-Creating-with-Gen-4-5

### Kling: task lifecycle, reference controls and model-specific constraints

Kling 4.0 public API guidance documents native multimodal video creation, up to 30-second generation, Omni Reference and up to 10 keyframe inputs (availability depends on product/API access and purchased resources). Its API workflow is explicitly asynchronous: prepare API credentials and credits, submit one task, query that task's status, then retrieve output only after success. The docs warn that a task ID means accepted/created, not generated; callers should query the original task rather than resubmitting while it is processing. Output URLs may expire.

Commercial and product lesson:
- Capability controls must be model-specific and schema-driven, not one generic form pretending every model accepts every parameter.
- Keyframes, references, durations, aspect ratios, resolutions and audio support must be represented as capability metadata.
- Download successful outputs promptly into our own private asset store; provider result URLs are not durable asset storage.
- A retry must distinguish a failed submission from an already accepted asynchronous task.

Source:
- https://kling.ai/document-api/api/usage-guide/kling-4-0

### fal.ai: model catalogue, queue and metered usage

fal documents a queue API that returns a request ID plus status, result and cancellation URLs. A job remains queued until a runner is available. Pricing varies by model and billing unit: per image, megapixel, video second, request or compute time. Its public pricing guide says successful outputs are billed, while server errors and queue wait time are not billed; prepaid credits fund usage.

Commercial lesson:
- Maintain a normalized model catalogue with per-model pricing units and effective dates.
- Store provider-reported usage and reconcile it against our own estimate.
- Keep queue wait time distinct from inference time.
- A model catalogue needs provider, model/version, capabilities, input constraints, pricing basis, availability and verification evidence.
- Prepaid internal user credits are useful, but they must be an accounting layer over provider costs—not a guessed fixed multiplier.

Sources:
- https://fal.ai/docs/documentation/model-apis/pricing
- https://fal.ai/docs/api-reference/inference-api/queue/submit
- https://fal.ai/docs/api-reference/inference-api/queue/status

### Canva: integrated workspace, reusable templates, assets and events

Canva's public developer platform exposes three broad integration surfaces: apps inside Canva, Canva APIs for external platforms, and Canva capabilities for AI assistants. Its content automation includes Autofill, Brand Templates and webhooks for collaboration events such as comments, approvals and sharing. Assets and folders APIs support integration with external asset libraries.

Product lesson:
- Creative planning, brand assets, reusable templates, review and delivery should live in one project context.
- Structured campaign data should be reusable to produce consistent branded outputs.
- Collaboration events should be observable and trigger workflow transitions.
- External design integrations should be optional adapters; the core product must remain useful without Canva credentials.

Sources:
- https://www.canva.dev/docs/
- https://www.canva.dev/docs/apps/quickstart/

### Adobe Firefly: professional integration and governance

Adobe's Firefly Services / API surface is a relevant reference for enterprise-oriented creative integration. Executive Visuals should compete on governance and workflow traceability rather than claim that model access alone provides commercial-grade safety. The concrete controls we should build are source/rights records, consent scope, immutable originals, derivative lineage, review checkpoints, provenance and auditable exports.

Reference:
- https://developer.adobe.com/firefly-services/

### Supabase: security, availability and recovery are explicit launch gates

Supabase's production checklist separates security, performance, availability and deployment. Its security checklist specifically calls for RLS on all exposed tables, storage access control, SSL/network restrictions, protected organization access, hardened auth and an application-specific threat review. Its backup documentation distinguishes plan-based backups and PITR. Free projects have meaningful backup/availability limitations.

Implementation lesson:
- A database migration is not complete until RLS, grants, storage policies, auth configuration, indexes, backup policy and restore procedures are tested.
- Tenant isolation must be enforced in database policies and server authorization, not merely hidden in the UI.
- Run load tests against staging.
- A backup is not accepted until a restore rehearsal succeeds.

Sources:
- https://supabase.com/docs/guides/deployment/going-into-prod
- https://supabase.com/docs/guides/security/production-checklist
- https://supabase.com/docs/guides/platform/backups

### Render: free infrastructure is for preview, not dependable customer data

Render's current free-tier documentation explicitly says not to use free instances for production applications. Free web services have ephemeral filesystems and cannot attach persistent disks; free Postgres expires after 30 days and lacks backups; free Key Value is in-memory and loses data on restart. Paid services can use persistent disks, while Render also offers managed Postgres and background workers.

Implementation lesson:
- Keep the existing free production service as a public preview only until an approved durable architecture and cost decision exist.
- Do not store the authoritative user database or media on ephemeral service filesystems.
- Separate web/API processes from background media workers.
- Make recurring infrastructure costs explicit before provisioning.

Sources:
- https://render.com/docs/free
- https://render.com/docs/service-types
- https://render.com/docs/disks

### Dodo Payments: AI/SaaS-oriented billing candidate

Dodo's public product material advertises subscriptions, one-time payments, usage metering, credit-based billing, overages and merchant-of-record services. Its webhook ecosystem includes subscription lifecycle, payment, refund and dispute events. Uganda merchant eligibility appears in current country-acceptance material, but onboarding, business type, payout route, product approval, fee schedule and supported local methods must be confirmed directly before selecting it.

Implementation lesson:
- Do not hardwire a payment provider into the core subscription model.
- Verify signed webhooks and process events idempotently.
- Treat provider events as evidence to reconcile into our own subscription and entitlement state.
- Test renewals, failed payments, grace periods, cancellation, plan changes, refunds, chargebacks and duplicate/out-of-order webhooks.

Sources:
- https://dodopayments.com/products
- https://dodopayments.com/
- https://github.com/dodopayments/dodopayments-cli
- Country eligibility reference (secondary): https://www.theinternets.money/providers/dodo-payments/in/uganda

## 2. What the repository already has

The repository README and implementation/release documents describe a substantial foundation:
- One integrated project/asset/workflow/timeline/review concept.
- 110 typed capabilities across 23 domains.
- A typed workflow graph, validation, immutable run snapshots and approval pauses.
- A local queue with idempotency, leases, retry/backoff and cancellation.
- Local FFmpeg probe, proxy, transcode, audio extraction and timeline render.
- Original/derivative metadata, audit records and role concepts.
- Provider-neutral adapter contracts and a readiness catalogue.
- A cloud storage adapter contract and cloud worker components, but not connected end-to-end to the active asset API and production queue.
- A dedicated Supabase migration and staging blueprint, but no isolated application Supabase project has been provisioned or approved.
- A public release gate that explicitly says NOT APPROVED.

The active Render production deployment was independently inspected read-only in the connected workspace. It is on the free plan, has no persistent disk, and its active health handler reports SQLite and local-disk storage. A second service runs a credits feature branch, also on free compute with ephemeral data. Neither service is a safe durable customer-data environment.

## 3. Target architecture

### A. Control plane

Use one dedicated application database for:
- users, workspaces, memberships and invitations;
- projects, brand kits, templates and creative briefs;
- assets, versions, rights/consent records and provenance;
- workflow definitions, immutable run snapshots and approvals;
- jobs, leases, provider task mappings and event history;
- subscriptions, entitlements, credit ledger, invoices/payment references;
- audit, support, moderation and operational events.

Tenant ownership must be explicit in every row. RLS and server-side role checks must agree. Never reuse the existing NEMA or shared platform Supabase projects.

### B. Media data plane

Use private object storage for source uploads, proxies, generated outputs, previews and final exports. Keep database rows as metadata and object references, not media blobs. Use:
- short-lived signed URLs;
- per-tenant/project object prefixes and authorization checks;
- upload size/type limits and checksums;
- immutable originals and traceable derivatives;
- resumable multipart uploads for large files;
- lifecycle rules, retention controls and quota accounting;
- malware/content inspection where appropriate;
- tested backup and restore strategy.

Provider output URLs are temporary ingress, not the permanent user asset location.

### C. Durable job orchestration

Keep the API responsive. Submit long-running media work to a durable queue and independent workers. Each job should have:
- stable internal job ID and idempotency key;
- tenant, project, user, capability, provider and model version;
- validated input manifest and consent/rights checks;
- estimated cost and user-approved maximum spend;
- provider task ID, submit response and request correlation ID;
- queued/running/succeeded/failed/cancel-requested/cancelled/partial states;
- lease owner, heartbeat, attempt count, retry classification and next retry time;
- progress events and output manifest;
- provider-reported usage, final cost and refund/credit adjustment.

Use an outbox or equivalent transactional event pattern so a committed job cannot be lost between database write and queue dispatch. Never blindly retry a provider submission when the request outcome is unknown; reconcile by idempotency key/provider task ID first.

### D. Provider gateway and capability registry

Keep vendor credentials server-side. Every adapter implements a normalized contract:
- `validate(input, capabilitySchema)`
- `estimateCost(input, currentPriceBook)`
- `submit(input, idempotencyKey)`
- `getStatus(providerTaskId)`
- `cancel(providerTaskId)`
- `fetchOutputs(providerTaskId)`
- `normalizeUsage(response)`
- `normalizeError(response)`

Capability readiness must be distinct:
1. specified;
2. implemented;
3. contract-tested;
4. credentials/configuration verified;
5. staging smoke-tested;
6. live-verified;
7. enabled for eligible plans.

Do not mark a model "available" because its API key exists. Keep remote paid execution disabled by default and never execute billable generation in CI.

Provider matrix should include:
- text/image/video/audio modality;
- text-to-image, image editing, inpainting/outpainting, reference images;
- text-to-video, image-to-video, start/end frame, multi-keyframe, video-to-video;
- audio generation, speech, transcription, dubbing and localization;
- duration, resolution, aspect ratios, frame rates, input count/size, seed and negative prompt;
- model version, region, retention terms, consent requirements;
- pricing unit, currency, source URL, effective date and confidence;
- submit/status/cancel/webhook capabilities and rate limits.

### E. Subscription and monetization engine

Use provider-independent internal domain objects:
- plans and plan versions;
- subscription and lifecycle state;
- entitlements and feature limits;
- included monthly credits;
- top-up credit packages;
- usage events and immutable credit ledger;
- provider cost records and margin calculations;
- payment intents, provider customer/subscription IDs and webhook inbox;
- refunds, disputes, tax/payment reconciliation.

Suggested launch tiers (pricing to be researched and validated, not invented):
- Free: limited projects, small monthly trial credits, low concurrency, watermark/limited export where appropriate.
- Creator: individual use, monthly allowance, standard queue priority.
- Professional: higher credits, commercial workflow tools, larger storage and faster queue.
- Studio: team seats, roles, shared brand kits, collaboration and pooled credits.

Credit accounting:
1. Quote expected cost and user-credit charge before dispatch.
2. Verify plan entitlement, remaining credits, concurrency and project budget.
3. Reserve credits atomically before submitting.
4. Submit with idempotency key.
5. Settle against actual provider usage on success.
6. Release or adjust reservation on provider failure according to provider billing policy.
7. Record a compensating ledger entry for refunds/adjustments; never edit historical ledger rows.
8. Stop or require confirmation when actual cost exceeds the approved ceiling.

Use a safety margin derived from measured provider costs, payment fees, storage, worker compute, support, taxes and refunds. Do not promise unlimited generation on fixed-price subscriptions.

### F. Payment integration

Evaluate Dodo Payments and Flutterwave (especially for Uganda/local payment acceptance) through a written provider checklist before choosing:
- Ugandan business onboarding and required legal entity documents;
- local mobile money, card and international payment methods;
- payout currencies, timing, minimums and FX;
- merchant-of-record/tax responsibility;
- recurring subscription support for each method;
- usage billing and top-ups;
- refunds, chargebacks, disputes and fraud tooling;
- webhook signatures, retry policy and sandbox fidelity;
- content policy acceptance for AI-generated media;
- total fees and reserve/hold terms.

Do not enable live checkout until sandbox tests pass and merchant approval is confirmed.

### G. Admin, trust and operations

The admin console must provide:
- user/workspace lookup and account status;
- plan/subscription/payment state;
- credit ledger and usage by model/provider;
- provider health, error rates, latency and queue backlog;
- gross revenue, payment fees, provider spend, storage/compute cost and contribution margin;
- refunds, disputes, abuse flags and support notes;
- model/plan/price configuration with approval and audit trail;
- emergency provider kill switch and per-model spend caps.

Use least-privilege roles, MFA for privileged operators, immutable audit events and dual approval for high-impact actions. Support access should be scoped and time-limited.

## 4. Release and reliability gates

Do not call the product production-ready until evidence exists for each gate:

1. Dedicated isolated database and private object storage.
2. RLS and storage policy tests for owner/editor/reviewer/viewer and cross-tenant denial.
3. Normal authentication flow: sign-up, confirmation, login, refresh, logout, recovery, session expiry, disabled account and abuse throttling.
4. Durable upload/download and object retention across service restarts and deployments.
5. Worker heartbeat, duplicate-claim prevention, cancellation, retry, stale lease recovery and dead-letter handling.
6. Provider adapter contract tests and staging smoke tests; CI must never spend money.
7. Price estimate, reservation, settlement, refund and hard budget ceiling tests.
8. Payment webhook signature, idempotency, ordering, replay and reconciliation tests.
9. Multi-user hosted acceptance tests and concurrent load tests.
10. Backup restore rehearsal, rollback rehearsal and incident runbook.
11. Observability: request/job IDs, structured redacted logs, metrics, alerts and retention.
12. Explicit owner approval of recurring infrastructure and provider costs.

## 5. Prioritized implementation roadmap

### P0 — Safe customer-data foundation
- Provision only after approval: isolated Executive Visuals database and private bucket.
- Review migration, RLS, grants and storage policies before applying.
- Complete normal Supabase Auth UX and session lifecycle.
- Integrate private object storage into the active asset API and UI.
- Connect durable Postgres-backed job queue and separate worker.
- Implement health/readiness split: liveness, database, storage, worker, queue and provider readiness.
- Backups, restore test, logs, quotas and abuse controls.

### P1 — Actual production media workflow
- Complete provider task state machine and normalized adapter contract.
- Implement first fully verified image provider and first fully verified video provider.
- Add temporary output ingestion into private storage.
- Complete video-to-video and multi-keyframe only where a selected model actually supports them.
- Add preview playback, timeline editing parity, audio controls, render profiles and checkpointed renders.
- Build per-job budget approval and provider-cost reconciliation.

### P2 — Commercial launch
- Select payment provider after Uganda onboarding and policy checks.
- Implement webhook inbox, idempotency and subscription state machine.
- Implement immutable credit ledger, plan entitlements, top-ups and overage policy.
- Build admin operations, user support and financial dashboards.
- Test cancellations, renewals, failed payments, grace period, refunds and disputes.

### P3 — Growth and scale
- Model router based on quality, latency, cost, region and capability fit.
- Evaluation harness with fixed prompt/reference sets and human review.
- Workspace templates, batch workflow, team collaboration and brand governance.
- Autoscaling worker pools, queue partitioning and multi-region delivery when measured demand justifies it.
- Public API, webhooks and partner integrations with tenant-scoped API keys and rate limits.

## 6. Decisions deliberately not made

- No payment provider selected or activated.
- No live provider keys inspected or changed.
- No paid generation executed.
- No new Render service, database, bucket or paid infrastructure provisioned.
- No production deployment, migration or environment setting changed.
- No branch with divergent history merged.
- No subscription price or margin represented as validated.

The next engineering change should be implemented on a dedicated feature branch, reviewed in a pull request, verified in isolated staging, and only then considered for production.
