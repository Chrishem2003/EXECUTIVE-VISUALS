# Neon staging integration — guarded bootstrap

**Status:** repository-side preparation only. No Neon project, branch, database, Data API, bucket, credential, or Render setting is created or changed by adding this document or workflow.

## Why this is manual-only

The Neon GitHub integration normally makes these repository values available:

- Repository variable: `NEON_PROJECT_ID`
- Repository secret: `NEON_API_KEY`

The integration does not by itself configure the Render application, apply this repository's SQL migrations, enable the Neon Data API, create a private object-storage bucket, or make the current Supabase-backed worker compatible with Neon.

Official references:

- [Neon GitHub branching workflow](https://neon.com/docs/get-started/workflow-primer)
- [Neon create-branch GitHub Action](https://github.com/neondatabase/create-branch-action)
- [Neon Data API security](https://neon.com/docs/data-api/get-started)
- [Neon plans and quotas](https://neon.com/docs/introduction/plans)
- [Neon Free quota FAQ](https://neon.com/docs/faqs/free-plan-limits-and-quotas)
- [Neon Object Storage](https://neon.com/docs/storage/overview)

## Free-plan capacity — conservative planning values

Neon's current public documentation is inconsistent on the PostgreSQL storage allowance: the Free-plan FAQ says **1 GB per project**, while the plans page still contains a **0.5 GB per project** statement. Until the account console confirms the allowance for this project, plan against 0.5 GB and treat 1 GB as unconfirmed.

| Resource | Public Free allowance / constraint |
| --- | ---: |
| Monthly plan price | $0 |
| Projects | 100 |
| Branches | 10 per project |
| PostgreSQL storage | 1 GB/project in current FAQ; older plans page still says 0.5 GB; 20 GB account-wide |
| Compute | 100 CU-hours/project/month |
| Maximum autoscaling | 2 CU (approximately 8 GB RAM) |
| Scale-to-zero | After 5 minutes; cannot be disabled on Free |
| Public network transfer | 5 GB/project/month, shared by Postgres, Object Storage and Functions |
| Object Storage | 5 GB/project |
| Object Storage API | S3-compatible; private buckets supported |
| Object storage egress | Counts toward the shared project transfer allowance |

The Free allowance is suitable for integration testing and low-volume staging, not a media-production workload with large video files. The 5 GB object store and 5 GB shared transfer allowance are the practical bottlenecks.

## Workflow safety contract

`.github/workflows/neon-staging-bootstrap.yml` is deliberately `workflow_dispatch` only. It:

1. Requires an explicit boolean confirmation.
2. Requires the GitHub integration's `NEON_PROJECT_ID` variable and `NEON_API_KEY` secret to exist.
3. Creates only the branch `executive-visuals-staging` from a parent named `staging-base`.
4. Does not fall back to the Neon default branch.
5. Fails if the target branch already exists rather than silently reusing it.
6. Never prints, uploads, or stores the database connection URI.
7. Does not apply migrations, enable Data API, create buckets, or modify Render settings.

**Before running it:** verify in the Neon Console that the connected Neon project is dedicated to Executive Visuals staging, and that `staging-base` exists and contains no production/customer data. If that parent does not exist, stop; do not substitute `main`, `production`, or another unverified branch.

The workflow uses the Neon create-branch Action pinned to commit `fb620d43d4c565abaf088b848a4e28e5c4ea4d9c` (v6).

## Compatibility gap that must be resolved before application connection

The current cloud worker uses Supabase-specific REST conventions:

- `apikey` and `Authorization: Bearer <service-role-key>`
- PostgREST `/rest/v1` table and RPC routes
- Supabase schema profile headers
- Existing RPC names for queue leasing, submission idempotency, and customer-credit settlement

Neon's Data API is also PostgREST-compatible, but its authorization model is JWT + PostgreSQL GRANT/RLS. It is **not** a drop-in replacement for a Supabase service-role key. The Data API documentation explicitly states that the endpoint has no independent permission layer and that all access is determined by PostgreSQL grants and RLS.

The safer server-side design is to add a separate Neon/PostgreSQL adapter using a server-only pooled connection string and a least-privilege database role, then port and test the required schema/functions. Keep the existing Supabase adapter intact. Do not put a Neon API key or database URL in Vite/browser variables.

## Storage compatibility gap

The asset service now includes a dedicated `neon-object-storage.mjs` adapter and accepts `CLOUD_MEDIA_STORAGE_PROVIDER=neon`. It uses path-style S3 requests and AWS Signature Version 4, matching Neon documentation. It supports private uploads, streaming file uploads, short-lived presigned GET URLs, object deletion, readiness checks, and streamed size/content-type/SHA-256 verification.\n\nThe adapter does not create buckets or credentials. It requires a bucket to exist on the selected branch and server-only environment values: `NEON_STORAGE_ENDPOINT`, `NEON_STORAGE_REGION`, `NEON_STORAGE_ACCESS_KEY_ID` (Neon `token_id`), `NEON_STORAGE_SECRET_ACCESS_KEY` (Neon `s3_secret_access_key`), and `NEON_STORAGE_BUCKET`. It also accepts Neon standard `AWS_ENDPOINT_URL_S3`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY` names. Issue a credential with both `storage:read` and `storage:write` scopes for server-side upload, download signing and deletion. Never expose these values to the browser.\n\nCurrent adapter upload size defaults to 250 MiB, intentionally below the Neon single-PUT maximum and the application's existing media upload policy. Neon supports S3 path-style addressing only; the adapter uses the branch endpoint exactly as returned by Neon. The existing canonical bucket contract remains `executive-visuals-media`; the adapter refuses a custom bucket until metadata and cleanup contracts support configurable bucket identifiers.\n\nThis is a storage-provider integration only: cloud asset metadata, authorization and publication RPCs still use the existing Supabase repository boundary. It does not make the video worker or database layer Neon-compatible, and it does not enable Neon in any deployed environment.

The existing canonical bucket contract also expects `executive-visuals-media`. Any Neon bucket adapter must preserve that logical bucket contract or introduce a reviewed migration for configurable bucket identifiers. No existing storage provider should be switched automatically.

## Connected Neon account — read-only verification (19 November 2026)

The connected Neon account was inspected without changing resources:

- Project: `Executive-Visuals Pro` (`dawn-credit-96457353`), Free plan.
- Branch chain: `production` → `staging-base` → `executive-visuals-staging`.
- The application staging branch is currently `br-cool-meadow-befe3yf4`; its parent is `staging-base`, and its initialization source is `parent-data`.
- The staging branch is **not data-isolated or sanitized yet**. It inherits its parent's data lineage; do not connect application traffic or run migrations until a reviewed sanitization/empty-staging plan is approved.
- The branch record is `ready`, but read-only database structure inspection returned `endpoint not found`; no usable database endpoint was confirmed.
- Neon Object Storage reports enabled on the branch, but the branch currently has **no buckets**.
- No database migrations, buckets, credentials, endpoints, compute resources or application settings were created or changed during this inspection.

This evidence supersedes any assumption that a ready branch record means the application database is reachable or safe for staging. The staging release gate remains blocked until database connectivity, data isolation, private bucket configuration and worker execution are independently verified.

## Current repository implementation\n\n- `server/neon-object-storage.mjs` — server-side Neon S3-compatible adapter.\n- `server/cloud-asset-service.mjs` — explicit `neon` provider selection; existing Supabase/R2/B2 providers remain available.\n- `server/tests/neon-object-storage.test.mjs` — request signing, path-style addressing, signed downloads, streamed upload, integrity verification, deletion and path validation tests.\n- `npm run verify:neon-storage` — focused adapter and composition test command.\n\nThese tests use mocked S3 responses. They prove the local adapter contract, not live Neon credentials, bucket provisioning, or deployed connectivity.\n\n## Atomic video enqueue — migration 0006

Migration `0006_atomic_video_enqueue.sql` adds `enqueue_video_generation_job_v1`, a single transaction boundary for application admission:

- It creates/replays the `video.generate` job through the owner-scoped idempotent queue admission function.
- It reserves the approved provider budget and customer credits before the transaction can commit.
- The durable input must include the exact provider, model and SHA-256 request hash used by the approval.
- Credit reservation idempotency is derived from the durable job UUID, so a replay cannot create a second charge.
- A reservation conflict, expired/invalid approval, disabled policy or insufficient credit balance aborts the entire transaction, including the new job and enqueue event.
- The new `server/neon-postgres-video-enqueue.mjs` adapter validates identifiers, request evidence and reservation bounds before calling the RPC.
- `createNeonStagingRuntime()` exposes this as `runtime.videoEnqueue` and includes its read-only readiness probe in the overall staging gate.
- `server/tests/neon-postgres-video-enqueue.test.mjs` covers adapter validation and receipts. `scripts/verify-neon-video-enqueue-postgres.sql` exercises real PostgreSQL admission, exact replay, changed-reservation rejection and rollback on insufficient credits.

The GitHub Actions disposable PostgreSQL workflow now applies migration 0006 and runs the new integration script. `createCloudVideoEnqueue()` also accepts an explicitly supplied `videoEnqueueAdapter`; in that mode the existing provider/model/capability, request-hash, quote and budget-ceiling validation remains in place, then admission is sent to the Neon atomic RPC without requiring Supabase REST credentials. The caller must supply server-quoted `reservedCredits`; client-supplied credit quantities are not trusted. The current `server/index.mjs` approval-dispatch route is still wired to the legacy Supabase approval/job repositories and does not instantiate this Neon adapter yet. This does not switch the live Supabase enqueue route. A staging-specific approval/repository bridge, verified identity/authorization integration and explicit cutover plan remain necessary before Neon can receive user traffic.

## Multi-shot approval bridge — migration 0007

Migration `0007_video_approval_bridge.sql` adds durable Neon-side mirrors for the existing server-approved production snapshot and its individual shots. It does not replace the local approval record or the verified Supabase identity boundary.

- `server/neon-postgres-video-approvals.mjs` implements owner/project-scoped approval registration, immutable replay checks and durable per-shot enqueue.
- Each shot receives a deterministic SHA-256 request hash and stable idempotency key derived from the approval ID and shot index.
- Each shot's server-quoted customer-credit amount and budget-approval ID are persisted before admission. Retries reuse those exact values instead of issuing a new approval or changing the credit quote.
- The bridge runs the entire multi-shot admission batch in one PostgreSQL transaction. If any shot fails budget or customer-credit reservation, all newly admitted jobs and reservations in that batch roll back.
- Each shot is admitted through `enqueue_video_generation_job_v1`, preserving the existing atomic job + provider-budget + customer-credit reservation boundary.
- `createNeonStagingRuntime()` exposes `runtime.videoApprovals` only when the host supplies a server-side `quoteCustomerCredits` policy. Readiness reports `applicationDispatchReady` separately from base database/worker readiness.
- The quote policy is intentionally injected and must be deterministic, synchronous and server-owned. No customer-credit conversion rate is guessed or accepted from a browser request. A production/staging host must explicitly define its conversion policy before dispatch can be enabled.
- The disposable PostgreSQL workflow applies migration 0007 and verifies the approval/shot tables, indexes, foreign keys and required enqueue/financial functions.

The authenticated approval route is now wired through an explicitly gated staging composition:
- `server/neon-staging-application-runtime.mjs` creates the Neon runtime only when `NEON_STAGING_APPLICATION_DISPATCH_ENABLED=true`, `NEON_STAGING_RUNTIME_ENABLED=true`, and the exact branch name is `executive-visuals-staging`.
- The composition requires the existing Supabase authentication boundary and the application's project-write authorization callback. It does not replace Supabase identity or enable provider execution.
- Startup performs a read-only readiness check and refuses to start this route unless migrations, queue, financial controls and approval tables all pass `applicationDispatchReady`.
- The server-owned customer-credit conversion must be explicitly configured with `NEON_CUSTOMER_CREDITS_PER_USD` as an integer. The current policy accepts USD quotes only, uses integer arithmetic, and rejects missing or out-of-bounds rates; it never trusts browser-supplied credit quantities.
- `server/index.mjs` routes the existing `POST /api/video-production-approvals/:id/submit` endpoint through the Neon bridge when the feature flag is enabled. The legacy Supabase dispatch remains the default when it is disabled. The runtime pool is closed during graceful shutdown.
- The bridge only admits jobs to the durable Neon staging queue. It does not call providers or start a worker.
- `server/neon-postgres-queue.mjs` now provides owner-scoped job and event reads. The authenticated `GET /api/neon-staging/video-generation-jobs/:id` endpoint returns a minimal status projection, bounded lifecycle events and successful asset IDs without exposing lease tokens, raw job input or provider task credentials.
- The Video Studio's workflow-run approval route (`POST /api/workflows/:id/run/approve`) still uses the existing `cloudTimelineApi`/Supabase quote and approval path. It has **not** been migrated to Neon by this change. The new Neon application dispatch currently covers the direct `/api/video-production-approvals/:id/submit` path and its separate status endpoint only.
- Provider execution, private asset publication, actual-cost reconciliation and live Neon branch verification remain separate release gates.

This is now application-route integration with unit coverage and disposable PostgreSQL CI, not a live Neon deployment. No migration has been applied to the connected Neon project, no storage bucket or credentials have been provisioned, and the Render environment has not been changed.

## Pre-ingestion customer-credit settlement — migration 0005

The existing video executor settles customer credits after provider usage is authoritatively measured but before generated outputs are ingested into private storage. Migration `0005_pre_ingestion_credit_settlement.sql` now gives the Neon adapter the same explicit `settleJob` contract:

- `settle_video_generation_customer_credits_v1` validates the owner/job/provider scope, requires a durable submitted provider task matching the evidence ID, and checks the active budget and credit reservations.
- Customer-credit settlement is idempotent: replaying the same measured usage evidence returns the original settlement; a different amount or evidence tuple is rejected.
- The final financial closeout accepts an already-settled customer-credit reservation, but still requires the provider budget reservation to be active and settles provider cost exactly once.
- A settled customer-credit reservation cannot be released as a failed/no-charge job. Only a still-reserved credit reservation can be released, and only with verified no-charge/no-submission evidence.
- The adapter method is named `settleJob` to match the current worker's customer-credit interface.

The disposable PostgreSQL integration now exercises pre-ingestion settlement, exact replay and subsequent worker finalization. This resolves one known accounting contract mismatch; it does **not** complete worker composition, tenant authorization, provider reconciliation, or private asset publication. The migration remains source-controlled and has not been applied to the real Neon branch.

## Neon-backed provider worker composition

The next integration layer is source-controlled in `server/neon-cloud-video-worker.mjs`.

- `createNeonVideoWorkerContracts()` maps the existing object-shaped worker API onto the Neon queue, submission ledger and financial finalizer.
- Successful jobs pass the provider task receipt, measured actual spend and measured customer credits to the lease-fenced `finish_video_generation_job_v1` transaction.
- The generation executor now carries measured `actualCredits` through to finalization; the worker persists this field with the output evidence.
- Failed jobs without verified no-charge evidence are quarantined into `blocked`; they are not automatically refunded. The generic worker now preserves this backend's structured `blocked` outcome instead of reporting a false terminal failure.
- Deferral and expired-lease recovery use the Neon queue's fenced RPCs.
- `createNeonCloudVideoWorker()` requires explicit staging and remote-execution flags, exact provider/model adapters, and an application-supplied owner/project authorization callback. Every prepare, submit, poll, cost-reconciliation and private-publication operation is gated by that callback.
- Added focused tests and included them in `npm run verify:neon-postgres`.

This composes the worker contracts but does not yet switch the application's live enqueue route or hosted worker process to Neon. A Neon enqueue API that atomically creates the job and its financial reservation, plus an application identity/authorization implementation and storage adapter, are still required. The new worker factory has not yet been verified by CI on the latest commit and has not been connected to Render or the real Neon branch.

## Required acceptance before connecting Render staging

- [ ] Confirm the Neon project is dedicated to staging and its region/Free entitlement.
- [ ] Confirm the `staging-base` branch is empty or contains only synthetic test fixtures.
- [ ] Create the isolated child branch through the manual workflow after separate operator confirmation.
- [ ] Establish a migration baseline for the Executive Visuals schema; do not replay Supabase migration history blindly.
- [ ] Port and test queue claim/renew/recover/finish functions and submission/budget/settlement functions.
- [ ] Verify transactionality, idempotency, row locking, lease fencing, RLS and tenant isolation against real Neon PostgreSQL.
- [x] Implement and unit-test a dedicated private Neon Object Storage adapter, signed downloads, streamed uploads, deletion and object integrity verification.\n- [ ] Provision the private bucket and issue branch-scoped storage credentials after separate approval.\n- [ ] Run an authenticated integration test against the actual Neon staging branch.\n- [ ] Add multipart/resumable upload orchestration for media exceeding the current 250 MiB application limit.
- [ ] Verify backup/restore and object cleanup/reconciliation.
- [ ] Only then prepare a separate Render staging environment-variable change for review and approval.

No production database, shared Supabase project, production Render service, customer data, or paid provider configuration is part of this plan.


## Neon PostgreSQL worker foundation — repository implementation

The next isolated implementation milestone adds a PostgreSQL-backed queue without changing the running Supabase queue:

- `server/neon-postgres-pool.mjs` validates a pooled Neon URL (requires `-pooler`) for application traffic and a separate direct URL for migrations. It uses a small, bounded pool (default maximum 3), TLS certificate verification, and no connection-string logging.
- `server/neon-postgres-queue.mjs` implements the worker queue contract: atomic claim, lease renewal, lease assertion, cancellation lookup, expired-lease recovery, terminal finish, and a read-only readiness check.\n- `server/neon-postgres-video-submissions.mjs` implements the fenced provider-submission ledger: prepare, begin, record task ID, mark ambiguous submission, reconcile with evidence, terminal finish and lookup. All values are parameterized.
- `database/neon/migrations/0001_worker_queue.sql` defines an isolated queue schema and functions.\n- `database/neon/migrations/0002_video_submission_ledger.sql` adds the provider submission ledger and locks the job row while checking the current worker fencing token. Claims use `FOR UPDATE SKIP LOCKED`; each claim receives a fresh database-generated UUID fencing token; renew/finish require the current unexpired token; recovery clears the token before a retry.
- `server/tests/neon-postgres-queue.test.mjs` verifies URL safety, pool bounds/TLS, parameterized calls, fencing checks, cancellation lookup, recovery, finish, readiness, and migration invariants.\n- `server/tests/neon-postgres-video-submissions.test.mjs` verifies provider submission idempotency contracts, fencing tokens, ambiguity reconciliation evidence and metadata bounds.
- `npm run verify:neon-postgres` is included in product verification batch 01.

### Important limitations — not yet a complete Neon worker cutover

This is a **queue + provider-submission foundation**, not a claim that the complete video-generation backend is already Neon-compatible. The existing worker also depends on budget approvals, customer-credit reservations/settlement, asset publication, and user/project identity. Those contracts must be ported and verified as separate transactional migrations before a Neon queue can safely run real video work.

The migration is source code only and has **not** been executed. The pool factory dynamically loads the Node `pg` package; that runtime dependency and lockfile update must be completed before enabling the Neon backend. No `NEON_DATABASE_URL` is configured by this PR. The Supabase queue remains the active path.

### Connection policy

Use the pooled `NEON_DATABASE_URL` (`-pooler` hostname) for application queries. Use a separate direct `NEON_DATABASE_DIRECT_URL` only for migration tooling. Do not run schema migrations over PgBouncer transaction pooling. The pool is deliberately capped at 3 connections per process to avoid exhausting a small Free compute. See Neon's [pooling guidance](https://neon.com/docs/connect/connection-pooling) and [serverless connection guidance](https://neon.com/docs/guides/serverless-connection-pooling).

### Queue admission and recovery lifecycle

`database/neon/migrations/0004_queue_admission_and_recovery.sql` adds Neon-native queue admission and fenced recovery operations:

- `enqueue_job_v1` creates durable jobs and the initial event atomically; owner-scoped idempotency keys serialize concurrent submissions and reject payload/project/type mismatches rather than silently reusing a job.
- `defer_job_v1` releases only the currently valid worker lease and schedules bounded retry availability.
- `quarantine_job_v1` moves only the currently leased job to the non-runnable `blocked` state, records structured error evidence and appends an event.
- All three SECURITY DEFINER functions pin `search_path` and revoke default PUBLIC execution.
- `createNeonPostgresQueue` exposes parameterized `enqueue`, `defer` and `quarantine` methods with bounded input validation and strict result checks.
- The disposable PostgreSQL CI workflow applies migration 0004 and runs `scripts/verify-neon-queue-postgres.sql` to exercise duplicate admission, idempotency conflict, deferral, lease release, quarantine and event history.

### Worker compatibility gap discovered during orchestration review

The existing provider-aware worker is not a drop-in consumer of the Neon adapters yet:

- Its queue contract expects `claim/renew/assertLease` plus an enqueue facade with object-shaped `finish/defer/quarantine/recoverExpiredVideo` calls. The Neon queue now has the underlying queue primitives, but the facade and recovery/reconciliation semantics are not wired.
- Its provider executor calls the customer-credit `settleJob` contract after provider cost reconciliation and before private output ingestion.
- The current Neon financial finalizer combines customer-credit settlement, provider-budget settlement and terminal job update in one transaction. It expects both reservations to remain `reserved`, so calling it after a separate pre-ingestion credit settlement would conflict.
- A safe Neon worker therefore needs a dedicated idempotent customer-credit settlement RPC and a finalizer that accepts a previously settled credit reservation while settling the provider budget and job exactly once. Failure paths must continue to require verified no-charge evidence.
- The worker composition also requires an owner/project-scoped asset repository and authoritative provider-cost evidence; do not replace those with an unverified owner UUID or client-supplied estimate.

This incompatibility is intentional release-blocking evidence, not a reason to bypass the accounting or ingestion stages. The next adapter milestone must add real PostgreSQL integration tests for success, pre-ingestion credit settlement, output-ingestion failure, ambiguous provider submission, and exactly-once terminal finalization before the existing worker can be composed against Neon.

These are queue primitives, not yet a production worker cutover. The live video worker still needs its complete orchestration adapted to call these Neon operations together with verified identity, provider submission reconciliation, atomic financial reservations/finalization and asset publication. Do not enable remote paid generation on this path until that end-to-end contract is implemented and tested.

### Opt-in Neon staging runtime composition

`server/neon-staging-runtime.mjs` now composes the existing PostgreSQL queue, provider-submission ledger and financial controls behind an explicit staging-only factory.

- Requires `NEON_STAGING_RUNTIME_ENABLED=true` and the exact branch label `NEON_STAGING_BRANCH_NAME=executive-visuals-staging`.
- Accepts an injected pool for deterministic tests; otherwise creates the bounded, TLS-verifying PostgreSQL pool from `NEON_DATABASE_URL`.
- Constructs queue, submission and financial adapters without making network calls during composition.
- Exposes a read-only readiness probe across queue schema, financial schema and optional explicitly supplied private object storage.
- Closes the shared pool exactly once and rejects readiness checks after shutdown.
- Does not change the existing Supabase worker, register a production route, apply migrations, create buckets or enable a deployed worker.
- `server/tests/neon-staging-runtime.test.mjs` covers opt-in gating, no-I/O construction, readiness aggregation, optional storage failure and idempotent shutdown. It is included in `npm run verify:neon-postgres`.

**Dispatch safety gate:** database/financial/approval schema readiness alone is not application dispatch readiness. `applicationDispatchReady` now remains false unless a provider worker is composed and private storage passes its live readiness probe. This prevents the authenticated approval route from accepting work that no worker can execute. The API bootstrap intentionally fails closed if Neon application dispatch is enabled without those dependencies.

The runtime now optionally composes the provider-aware Neon video worker and a single-flight long-lived process controller. It remains **explicit-start only**: construction never starts polling, and `startVideoWorker()` first requires application/financial readiness plus ready private storage. The controller runs expired-lease recovery, polls asynchronously, backs off after failures, prevents overlapping cycles, and drains in-flight work during shutdown. The worker still requires injected provider adapters and an owner/project authorization callback; this does not claim a live provider execution against the connected Neon account.

Provider task polling is rate-limited by the adapter contract: adapters default to a 5-second minimum, may declare a longer interval (up to 15 minutes), and provider retry hints can only lengthen that delay. Transient status-read failures use the same minimum. This prevents worker retry configuration from accidentally polling a provider more frequently than its documented cadence.

Worker readiness diagnostics now also report the exact registered provider/model adapters, cycle/claim/finish/recovery counters, last successful cycle and recovery timestamps, current failure count, and the last sanitized error code. These counters are process-local operational telemetry, not durable business records; queue and financial ledgers remain the source of truth.

### Neon video worker lifecycle — repository implementation

- `server/neon-cloud-video-worker.mjs` adapts Neon queue, submission and financial contracts to the existing provider-aware executor. Provider operations require an injected owner/project authorization callback.
- `server/cloud-video-worker-process.mjs` provides a single-flight polling loop, expired-lease recovery, bounded error backoff, sanitized lifecycle events and graceful drain.
- `createNeonStagingRuntime({ workerAdapters, workerAuthorizeJob, workerId, includeStorage: true })` composes the worker only when all inputs and private storage are explicitly supplied.
- The runtime exposes `startVideoWorker()` and `stopVideoWorker()`; it never starts the worker automatically. Start checks the approval/financial/database readiness and private storage readiness first. Runtime shutdown drains the worker before closing the PostgreSQL pool.
- `server/tests/cloud-video-worker-process.test.mjs` covers recovery ordering, duplicate-start prevention, graceful shutdown, error backoff and bounded settings. `server/tests/neon-staging-runtime.test.mjs` covers fail-closed worker composition and the private-storage start gate. These tests run through `npm run verify:neon-postgres`.

This is a tested process/lifecycle composition, not proof of successful remote generation or asset publication. No worker was started against the connected Neon project.

### Remaining gates

- [x] Add the `pg` runtime dependency and lockfile entry.
- [x] Port the provider submission ledger and evidence-backed provider-task reconciliation, retaining lease-fencing wrappers.
- [ ] Port enqueue + approval/budget + customer-credit reserve/settle transactions as atomic functions.
- [ ] Port asset publication metadata and cleanup outbox, preserving private storage path lineage.
- [ ] Define staging identity strategy; do not assume Supabase `auth.users` exists in Neon.
- [ ] Add database-owner and least-privilege worker roles with explicit grants; no browser credentials.
- [ ] Run migration on the isolated Neon staging branch only after separate approval.
- [ ] Add real integration/concurrency/restart tests against Neon.
- [x] Add an explicit-start worker lifecycle composition; actual staging start remains blocked until all preceding gates pass.

No branch, database, schema, credential, bucket, Render setting, or production resource was changed by this repository implementation.


## Neon financial controls — migration 0003

The isolated PostgreSQL foundation now includes `database/neon/migrations/0003_video_financial_controls.sql` and `server/neon-postgres-video-financials.mjs`.

### What it implements

- A server-owned, append-only customer credit ledger and reservation records, with account suspension support.
- Provider/model/project-scoped spend policies: total spend ceiling, per-job ceiling, rolling 24-hour request ceiling, currency and enable/disable state.
- Short-lived, one-use budget approvals bound to the exact owner, project, provider, model and SHA-256 request hash.
- Atomic reservation of provider budget and customer credits in one PostgreSQL transaction. The function locks the job, approval, customer account and budget policy; validates the exact request; checks available credits, policy headroom and request-rate limits; then consumes the approval.
- Provider-evidence-backed settlement or release. Successful/partial completion requires measured actual amount, measured customer-credit units, provider task receipt/invoice/usage evidence and a matching provider/model/task/reference in the output. Failed/cancelled jobs with reservations are refunded only with explicit verified-no-submission or verified-no-charge-cancellation evidence; ambiguous provider charges remain quarantined.
- A single lease-fenced `finish_video_generation_job_v1` function that finalizes financial reservations, writes the immutable provider-cost record, updates the job terminal state and emits the job event in the same database transaction.
- Idempotent reservation replay even after the one-use approval has been consumed. Replays must match the original reservation owner, approval, budget and credit quantities.
- A read-only financial schema readiness function and adapter tests.
- A new GitHub Actions workflow starts a disposable PostgreSQL 17 service, applies migrations 0001–0007, and exercises real SQL reservation replay, success settlement, provider cost ledger insertion, no-charge evidence rejection, failure release, atomic video admission and approval-bridge schema. This CI database is ephemeral and is not the connected Neon project.

### Important safeguards and limitations

- Neon has no assumed Supabase `auth.users` table. Owner IDs are opaque UUIDs supplied only after the application's server-side identity verification; no browser database credential is supported.
- All financial functions are revoked from PostgreSQL `PUBLIC`. The staging plan must create/review a least-privilege login role and grant only the required RPC execution privileges. Do not use the Neon project owner role as the application role.
- Customer-credit grants and budget policy/approval issuance are privileged server-side operations; this migration does not provide browser-facing routes or self-service admin UI.
- The financial adapter is a database boundary, not yet wired into the existing Supabase cloud-worker composition. The Neon worker cutover still requires the complete auth/session strategy, provider gateway, private asset publication, approval UX and a staged integration test.
- Successful provider work is deliberately blocked without a budget reservation, credit reservation and matching provider cost evidence. Actual charges greater than the reserved cap are quarantined for review rather than silently overdrawn.
- The SQL remains source-controlled only. It has not been executed against Neon.

### Required grants before any staging worker can connect

After separately approving the isolated branch and creating a dedicated non-owner login role, review and grant only:
- `EXECUTE` on `configure_video_budget_policy_v1`, `issue_video_budget_approval_v1`, `reserve_video_generation_financials_v1`, `finish_video_generation_job_v1`, `get_video_financial_readiness_v1` to the server worker/service role as appropriate.
- `EXECUTE` on `grant_generation_credits_v1` only to the billing administration service identity, never the ordinary worker or browser role.
- The worker queue and submission RPCs only to the dedicated worker identity.

No table grants to browser roles are needed. Recheck function ownership, SECURITY DEFINER search paths and role membership during the migration review.

### Neon pooling compatibility

The financial functions use transaction-scoped row locks and `pg_advisory_xact_lock`, not session-scoped advisory locks or session `SET search_path`. Queries fully qualify schema objects. This is intentional for Neon's PgBouncer transaction pooling. Application traffic must use the pooled `-pooler` endpoint; migrations and administrative work use the direct endpoint. See the official [Neon connection-pooling guide](https://neon.com/docs/connect/connection-pooling) and [PostgreSQL explicit-locking guide](https://www.postgresql.org/docs/16/explicit-locking.html).

### Remaining release gates

- [ ] Install and lock the `pg` runtime dependency after reviewing the existing lockfile.
- [x] Add the Neon database pool, queue, submission ledger, financial adapter, provider worker composition and atomic video enqueue adapter to a separate, opt-in staging runtime; keep Supabase default unchanged.
- [ ] Port the existing budget quote/preflight and approval API into the Neon identity model.
- [ ] Add authenticated owner/project authorization before issuing approvals or grants.
- [ ] Integrate real provider cost resolvers and map cost evidence to the financial finalization contract.
- [ ] Add live Neon tests for concurrent reservations, approval replay, insufficient balance, spend caps, worker lease loss, process restart and exactly-once settlement.
- [ ] Review and apply migrations only on the separately approved isolated Neon staging branch.
