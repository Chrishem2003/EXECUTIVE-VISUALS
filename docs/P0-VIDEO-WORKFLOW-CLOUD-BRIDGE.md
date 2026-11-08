# P0 Video Workflow Cloud Bridge — execution boundary

## Current behavior

The interactive `video.generate` workflow node retains its existing synchronous Runway/FAL path for legacy providers. A second, explicitly configured `runway/model-router` path now connects the workflow executor to the durable cloud quote/approval/queue/worker pipeline and imports verified outputs into local workflow assets. The cloud path is source-integrated but remains operationally disabled until all authentication, worker, provider, saved-config and budget gates are deliberately configured.

## Fail-closed mode selector

`server/video-workflow-execution-mode.mjs` defines the explicit workflow execution mode:

- `legacy` remains the default for existing local provider adapters.
- The explicit `runway/model-router` node path requires an injected authenticated cloud timeline API; without it, it rejects with `CLOUD_VIDEO_WORKFLOW_BRIDGE_NOT_CONFIGURED` before provider submission.
- Even with the bridge present, cloud approval/enqueue rejects unless the saved router, worker, remote gateway, API key and enabled project budget policy are configured.
- Any other value rejects with `VIDEO_WORKFLOW_EXECUTION_MODE_INVALID`.

This prevents an operator from assuming that a UI-only provider selection activates hosted generation. The bridge reuses the existing durable cloud queue and never submits provider work from the request handler.

## Additional integration finding

The repository contains a Runway Model Router adapter with a non-billable `preflight()`, durable routing metadata on submit, task polling, private output ingestion and actual-cost resolution from the completed task's realized `cost.credits`. This is valuable existing infrastructure and should be reused rather than reimplemented.

The application enqueue layer, source-controlled `20261108210000_runway_model_router_enqueue_contract.sql` migration and provider-aware worker composition now register the logical `runway/model-router` identity behind explicit remote, worker, saved-config and USD budget gates. The router is registered as its own adapter rather than added to the fixed legacy `runwayModels` list. Disposable PostgreSQL integration applies the migration and verifies the enqueue contract. This does not switch on remote execution or create a customer budget policy.

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


## Workflow-node integration implementation (2026-11-08)

The feature branch now contains the first end-to-end source integration in `server/workflow-cloud-video-bridge.mjs`:

1. The workflow executor recognizes the explicit `video.generate` identity `provider=runway, model=model-router` and requires a completed upstream human-approval node.
2. It verifies the local project, establishes the same-UUID cloud project link when the local user owns the project, and refuses to create a link on behalf of a non-owner.
3. Every connected local image/video/audio asset is read through an owner/project access check, path-validated, byte-size checked and SHA-256 verified before upload to private cloud storage. The returned cloud asset ID is recorded in local asset metadata for reuse.
4. The executor obtains a fresh non-billable quote and requires an explicit `node.config.approvedMaxAmount` USD ceiling that covers the current estimate. It then invokes the explicit-confirmation approval endpoint only after the upstream approval node has completed.
5. The existing service-role-only RPC atomically creates the approval, reserves the project budget, enqueues the idempotent cloud job and consumes the quote. The cloud provider worker remains responsible for provider submission, task polling, private output ingestion and authoritative actual-cost settlement.
6. The local workflow runner polls the authorized cloud job at a five-second minimum interval while renewing its existing local worker lease. On success it obtains short-lived private asset URLs, requires the configured Supabase origin, checks the returned media type and byte count, verifies SHA-256, and stores local MP4 assets with request provenance and cloud-asset lineage.
7. The node output exposes the imported local asset IDs to downstream workflow nodes and the local timeline. Failed or unavailable cloud paths fail closed; budget, project-link and release-gate problems become blocked workflow runs.

The bridge has focused tests for the approval/quote/asset-import path, insufficient budget ceilings and missing cloud API configuration. It does not turn on any provider flags, create budget policies, provision secrets, run a paid task or deploy a hosted service. The branch still needs exact-head quality CI, review of the stacked integration base, and isolated staging acceptance before operators should enable the cloud worker.

### Required per-node configuration

For a cloud-backed `video.generate` node, set:
- `provider: "runway"`
- `model: "model-router"`
- `approvedMaxAmount: <USD ceiling>`

Connect a completed human-approval node upstream. The approval node click is the human confirmation; the numeric ceiling is a separate hard upper bound and must cover the fresh quote. Do not set a ceiling automatically from the quote or use an unlimited default. Other providers/models continue to use the legacy execution path.

### Current release boundary

The code path is implemented but not activated. `CLOUD_TIMELINE_API_ENABLED`, Supabase auth, the saved Runway router config, provider API credentials, cloud worker, remote video gateway flags, and an enabled per-project budget policy are separate operational prerequisites. All must be deliberately configured and tested in isolated staging before any paid generation is possible. Production remains untouched.

## Remaining acceptance work before paid cloud mode can be enabled

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
3. **Implemented in integration:** bind quote and approval to the authenticated actor, project, canonical request hash, provider/model/operation, private asset IDs, saved router config and short expiry.
4. Complete server-side media eligibility checks for provider limits, including frame rate and resolution, in addition to ownership, media type, checksum, duration, size and project scope.
5. **Implemented in integration:** atomically create the approval, reserve the project provider budget and enqueue through the idempotent durable queue. Customer-credit billing remains a separate reconciliation boundary and must not be assumed to be settled by the provider reservation.
6. **Implemented in source:** poll the durable cloud job from the local workflow executor and publish verified private outputs as local asset IDs for downstream nodes and timeline use.
7. **Partially implemented:** the cloud worker settles against provider-authoritative realized usage and quarantines ambiguous submissions/output/cancellation. Remaining work is complete recovery, cancellation, partial-output and customer-credit reconciliation evidence without double charging.
8. **Partially implemented:** disposable PostgreSQL CI verifies quote, approval, budget reservation, enqueue and replay; focused Node tests verify workflow orchestration and output import. Extend coverage to full tenant-isolation, worker recovery, cancellation and downstream editor consumption.
9. Complete isolated staging acceptance, rollback and operational runbooks before enabling the mode.

## CI integration finding

The current GitHub Actions quality workflow originally targeted only pull requests whose base is `main`. PR #211 targets the integration branch, so its changes did not receive the repository's full quality workflow. The workflow trigger now includes both `main` and `integration/omni-provider-workers-2026`, and pushes to that integration branch. This ensures feature PRs stacked on the integration branch can receive the same typecheck/build checks. Confirm the workflow actually triggers on the next push before treating CI as active.

## Verification

The build now includes focused workflow-cloud-bridge tests for:
- non-billable quote → explicit upstream approval → durable cloud enqueue → completed job → checksum-verified private output import;
- rejection of an approval ceiling below the fresh quote;
- rejection when the authenticated cloud API is unavailable.

Disposable PostgreSQL CI separately applies and verifies the quote and approval/enqueue migrations. These tests do not constitute hosted staging acceptance. Paid generation and production deployment remain disabled until the full bridge is implemented and accepted.


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

## Durable quote → explicit approval → atomic enqueue (2026-11-08)

The feat/p0-workflow-quote-ledger branch now extends the first quote-ledger slice into an explicit, server-authorized approval and durable enqueue transaction:

- POST /api/cloud/workflows/video/quote performs a non-billable Model Router dry-run and persists the exact quote, actor, project, canonical request hash, routed model, estimated credits/USD, router config and short expiry before returning it.
- POST /api/cloud/workflows/video/approve requires an explicit confirmed: true action, a positive USD approval ceiling and project editor authorization. It revalidates private workflow inputs and the configured router identity.
- The service-role-only approve_and_enqueue_video_workflow RPC locks the quote, pins the router config, verifies actor/project/request/operation/expiry and that the approved ceiling covers the estimate, creates the exact-request budget approval, invokes the existing atomic queue/reservation RPC, and marks the quote consumed in one PostgreSQL transaction.
- Retries with the same quote, request ID and request hash return the original job, approval and reservation; conflicting retries fail.
- The database requires an enabled project-scoped runway/model-router budget policy. Policy and remote-worker flags remain disabled by default; no default policy or provider activation is created.
- Both disposable PostgreSQL workflows now apply the quote and approval migrations before their shared integration assertions. The Google Drive integration workflow also applies these migrations because it reuses the cloud-video PostgreSQL integration script.

This is a queue/approval bridge, not a claim of end-to-end workflow execution. The interactive workflow executor still defaults to legacy mode; cloud-mode node progress, cancellation reconciliation, worker output publication into workflow node outputs, and full staging acceptance remain separate release gates. No provider task is submitted by either API handler.

## Local/cloud project identity link (2026-11-08)

The local API can now link an active, locally owned project to the cloud workspace using the exact same UUID. The server verifies ownership in the local SQLite project store before forwarding the ID; callers cannot link a project they merely view or edit. The cloud repository validates the UUID, refuses IDs owned by another account or archived cloud projects, and makes repeated same-owner linking idempotent without overwriting cloud metadata. This gives later workflow-node bridge calls, cloud assets and timelines a stable project scope across the local and cloud services.

This is identity alignment only. It does not yet synchronize local project settings/documents, memberships, asset bytes or workflow run records to cloud storage.
