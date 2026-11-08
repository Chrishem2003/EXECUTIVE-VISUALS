# P0 Video Workflow Cloud Bridge — execution boundary

## Current behavior

The interactive `video.generate` workflow node still uses the existing synchronous Runway/FAL gateways and local generated-asset persistence. The durable provider-aware cloud video queue is a separate execution surface; this document does not claim that the surfaces are integrated.

## Fail-closed mode selector

`server/video-workflow-execution-mode.mjs` defines the explicit workflow execution mode:

- `legacy` (default): preserves the existing behavior while the bridge is unfinished.
- `cloud`: currently rejects with `CLOUD_VIDEO_WORKFLOW_BRIDGE_NOT_CONFIGURED` before identity checks, private-asset reads, budget reservations or provider submission.
- Any other value rejects with `VIDEO_WORKFLOW_EXECUTION_MODE_INVALID`.

This prevents an operator from assuming that setting a cloud-mode flag will route Studio workflow nodes through the durable worker. It deliberately does not add a second queue or pretend to provide hosted generation.

## Additional integration finding

The repository contains a Runway Model Router adapter with a non-billable `preflight()`, durable routing metadata on submit, task polling, private output ingestion and actual-cost resolution from the completed task's realized `cost.credits`. This is valuable existing infrastructure and should be reused rather than reimplemented.

The application enqueue layer recognizes the logical `runway/model-router` identity behind explicit remote, worker, saved-config and USD budget gates, and the worker composition contains the router adapter. However, the source-controlled PostgreSQL function `enqueue_video_generation_job` still only allows `runway/gen4.5` and `google/gemini-omni-1.1-flash`; the worker's default `runwayModels` allowlist also omits `model-router`. The router is therefore not end-to-end enqueueable through the current SQL/worker contract. Enabling it requires a reviewed migration and explicit worker model registration, then disposable-PostgreSQL tests. Do not work around this by changing only the application allowlist.

## Aleph 2 transformation submission blocker and implementation (2026-11-08)

A source trace confirmed two separate blockers in the existing transformation path:

1. The approval handler stored an `approvalId` only in the transformation plan's `jobs.estimated_cost` JSON. It did not create the matching row required in `video_generation_budget_approvals`.
2. The durable enqueue SQL allowlist accepted only `runway/gen4.5` and `google/gemini-omni-1.1-flash`, even though the application enqueue layer and worker adapter already contained Aleph 2 support.

The worker does not need a new adapter for Aleph 2: `createProviderAwareCloudVideoWorkerComposition` accepts an explicit `RUNWAY_VIDEO_MODELS=aleph2` registration and requires task-level billing resolution. It remains opt-in behind the existing remote execution flags.

### Current implementation in the integration branch

The branch `fix/aleph2-transformation-budget-approval` contains a source-controlled migration and API changes intended to close these gaps:

- A service-role-only SQL function creates a short-lived approval ledger row, verifies project ownership and an existing enabled owner/project `runway/aleph2` budget policy, and checks per-job and remaining spend limits.
- The approval is bound to the server-derived canonical request hash, provider, model, project, USD amount and a 10-minute expiry.
- The approval endpoint creates the durable approval record before marking the plan approved. Submission recomputes the same canonical request hash and rejects changed inputs before enqueue.
- The SQL enqueue function allows only Aleph 2 `video-to-video` MP4 requests with a 2–30 second duration and a conservative floor of max(USD 0.56, USD 0.28 × output seconds), matching Runway Dev's published Aleph 2.0 pricing.
- The existing Aleph 2 worker registration remains explicit; this migration does not switch on remote execution or create customer budget policies.

The migration is source-controlled only. It has not been applied to staging or production. Disposable PostgreSQL assertions for service-role RPC privileges, approval consumption, Aleph 2 pricing floor and operation restrictions are in `scripts/cloud-video-postgres-integration.sql`. The GitHub Actions workflow now applies the cloud video migrations and runs this script against a fresh PostgreSQL 16 service for each integration PR. Exact-head CI and isolated staging acceptance are still required before the transformation submit route can be considered operational.


## Required work before cloud mode can be enabled

### Customer transformation API — partially implemented

The authenticated cloud timeline API now exposes:
- `GET/POST /api/cloud/transformations` for project-scoped plan listing and idempotent draft creation.
- `POST /api/cloud/transformations/:id/approve` for server-probed source metadata, provider-derived cost estimation and a short-lived exact-request approval ledger entry.
- `POST /api/cloud/transformations/:id/submit` for approval-hash verification, budget reservation and durable enqueue.
- `GET /api/cloud/transformations/:id` and `GET /api/cloud/jobs/:id` for plan/job status.

These endpoints remain behind verified Supabase authentication and the cloud timeline API feature gate. Submit remains fail-closed until all eight readiness gates below are explicitly true. This is not yet an end-to-end interactive workflow-node bridge.

### Remaining work

1. **Completed in integration:** `POST /api/cloud/transformations/quote` provides a non-mutating, source-probed Aleph 2 estimate with provider/model, USD amount, pricing evidence/date, source metadata including server-probed frame rate, 5-minute quote expiry and explicit non-billable/approval-required flags. It requires project editor access and media-rights confirmation, checks person-replacement consent, rejects source clips outside 2–30 seconds, and performs no approval, reservation, job write or provider submission.
2. **Cancellation intent API implemented in integration:** `POST /api/cloud/jobs/:id/cancel` requires verified identity plus project-owner/editor authorization, writes a durable idempotent cancellation request through a service-role-only RPC, records an audit/event trail, and exposes `cancel_requested_at`. Provider cancellation dispatch, worker pickup/retry, authoritative post-cancel usage reconciliation, and evidence-backed partial settlement remain outstanding. Provider-reported cancellation without verified final billing is still quarantined as `needs_input`; the reservation is not released.
3. Bind quote and approval to the authenticated actor, tenant, project, canonical request hash, provider/model/operation, private asset IDs and expiry.
4. Complete server-side media eligibility checks for provider limits, including frame rate and resolution, in addition to ownership, media type, checksum, duration, size and project scope.
5. Atomically reserve customer credits and provider budget; idempotently enqueue using the existing durable queue and submission ledger.
6. Map durable job state into workflow run/node state and publish stable private asset IDs for downstream timeline nodes.
7. Settle only from provider-authoritative realized usage; reconcile ambiguous submission, cancellation, partial output and refunds without double charging.
8. Add disposable-PostgreSQL end-to-end tests for tenant isolation, replay, idempotency, retry/recovery, cancellation and downstream asset consumption.
9. Complete isolated staging acceptance, rollback and operational runbooks before enabling the mode.

## CI integration finding

The current GitHub Actions quality workflow originally targeted only pull requests whose base is `main`. PR #211 targets the integration branch, so its changes did not receive the repository's full quality workflow. The workflow trigger now includes both `main` and `integration/omni-provider-workers-2026`, and pushes to that integration branch. This ensures feature PRs stacked on the integration branch can receive the same typecheck/build checks. Confirm the workflow actually triggers on the next push before treating CI as active.

## Verification

The existing `verify:workflow-executor` build step now asserts:
- explicit legacy mode remains compatible;
- cloud mode fails closed with the stable bridge-not-configured code;
- unknown modes fail closed.

These policy tests do not constitute end-to-end cloud workflow acceptance. Paid generation and production deployment remain disabled until the full bridge is implemented and accepted.


## Workflow-node cloud contract foundation (2026-11-08)

Branch `feat/workflow-cloud-node-contract` introduces a pure, side-effect-free
`createVideoWorkflowCloudRequest()` contract builder for validated
`video.generate` nodes. The first adapter is deliberately limited to the
explicit `runway/model-router` identity and derives text-to-video,
image-to-video or video-to-video from the configured/connected source assets.
It preserves stable request identity, project scope, source/reference asset IDs,
settings and a canonical SHA-256 request hash.

The builder performs no authentication, private asset lookup, signing, quoting,
approval, reservation, enqueue, provider submission or storage writes. Those
are mandatory responsibilities of the future authenticated orchestration layer;
the helper must not be called as a substitute for those gates. Unsupported
node kinds, provider/model pairs, mismatched operations, invalid media
combinations and unsupported Model Router settings fail closed.

Focused tests cover deterministic hashing, all three operation families,
existing workflow image-port compatibility, project/request identity, and
unsupported operation/adapter combinations. This is a contract foundation only:
it does not enable `VIDEO_WORKFLOW_EXECUTION_MODE=cloud` and does not change
legacy workflow execution.


## Runway Model Router durable enqueue contract (2026-11-08)

The integration branch now contains the guarded application and PostgreSQL enqueue contract for the dedicated `runway/model-router` worker adapter. The contract accepts only explicit `text-to-video`, `image-to-video` and `video-to-video` operations, and enforces a 2–30 second duration at the SQL boundary. The migration is source-controlled and exercised by the disposable PostgreSQL 16 integration job. It does not activate remote execution, create customer budget policies or call the provider. The worker's non-billable preflight must remain within the exact approved USD ceiling before paid submission, and settlement must use provider-reported realized task cost.

This closes the previously documented application/SQL allowlist gap. It does **not** complete the general Studio workflow bridge: authenticated workflow-node orchestration, quote/approval binding, atomic credit and provider-budget reservation, durable job-to-node status mapping, cancellation/recovery, private output publication and actual-cost reconciliation remain required under P0 issue #209.

## Authenticated non-billable workflow quote endpoint (2026-11-08)

Branch `feat/p0-video-workflow-bridge-quote` adds
`POST /api/cloud/workflows/video/quote` as the first API-facing bridge slice.

- The request requires a verified Supabase caller and owner/editor write access to the exact project.
- It accepts only a `video.generate` node with the explicit `runway/model-router` contract.
- Private image/video/audio references are resolved server-side by the existing owner/project-scoped source resolver before the provider dry-run.
- The Model Router dry-run quote returns the exact canonical request hash, routed provider/model, estimated credits/USD, pricing source, short expiry and explicit `billable:false` / `requiresExplicitApproval:true` markers.
- Dry-run quoting now requires a server-side API key/configuration but does not require the paid-execution opt-in flags. Actual `submit()` still requires both `RUNWAY_MODEL_ROUTER_ENABLED=true` and `RUNWAY_VIDEO_ALLOW_REMOTE=true`.
- The endpoint does not create an approval, reserve provider budget or customer credits, enqueue a job, or invoke paid generation. It is a quote surface only, not the P0 bridge acceptance.

Remaining P0 work is exact quote/actor approval persistence, atomic customer-credit plus provider-budget reservation, durable idempotent enqueue through the existing queue, workflow run/node status mapping, cancellation dispatch/reconciliation, stable private output asset propagation, and isolated staging end-to-end acceptance.

## Durable workflow quote ledger (2026-11-08)

Branch `feat/p0-workflow-quote-ledger` adds a server-controlled quote record
for the authenticated non-billable Model Router preflight. The quote API now
persists the quote ID, actor, project, stable request ID/hash, provider/model/
operation, routed provider/model, estimated credits/USD, configuration ID,
pricing source and five-minute expiry before returning a quote to Studio.

The new `video_workflow_quotes` table is private to the service role; browser
roles cannot read or mutate quote records directly. The PostgreSQL CI job
applies the migration and verifies service-role-only access, exact quote
scope, and rejection of invalid amounts. A failed persistence call prevents
the API from returning a usable quote.

This is still a non-billable quote ledger only. It does not approve a quote,
reserve customer credits or provider budget, enqueue work, or enable paid
execution. The next slice must bind an explicit authenticated approval to
the persisted quote and request hash, then atomically reserve both budgets
and enqueue exactly one durable job.
