# ADR: Video generation persistence boundary

**Status:** accepted design direction; implementation pending  
**Date:** 2026-11-04  
**Scope:** Executive Visuals video-generation jobs, provider submissions, usage reservations and private output assets

## Context

The current video enqueue service and submission ledger use the local SQLite database (server/video-generation-jobs.mjs and server/video-generation-submissions.mjs). The cloud worker queue uses Supabase Postgres through the executive_visuals schema and RPC functions (server/cloud-queue.mjs).

These are separate persistence systems. A SQLite job is not visible to the Supabase worker. Copying jobs between them or dual-writing from the API would create failure windows in which a budget reservation, job, submission state and provider task ID disagree.

The cloud queue already provides atomic job claims, type filtering, lease renewal, lease recovery and terminal completion through database RPCs. The core Supabase migration defines a richer jobs table and server-only queue functions. This is the best fit for a future hosted video worker, provided the isolated migration is reviewed and applied deliberately to a dedicated environment first.

## Decision

For hosted video generation, make Supabase Postgres the single source of truth for the job, budget reservation, usage reservation and provider-submission ledger. Do not bridge SQLite jobs into the cloud queue and do not dual-write.

Keep SQLite video enqueue/executor code isolated for local tests and local-only development until a separate local execution contract is deliberately supported. A hosted API must not enqueue into SQLite while a hosted worker claims from Supabase.

The hosted enqueue path must use one Postgres transaction, exposed through a narrowly scoped server-side RPC or transaction service, to:
1. Re-check authenticated owner and project write authorization against the authoritative project/member records.
2. Resolve the provider/model against a server-side enabled capability registry and enforce all declared request limits.
3. Validate the caller's explicit budget approval and reserve the maximum approved amount in a durable budget ledger.
4. Reserve the rolling-window provider request allowance.
5. Insert the video.generate job with a stable idempotency key and normalized request hash.
6. Insert audit/job events and return the existing job on an identical idempotent replay without reserving again.

The provider-submission ledger must be stored in the same Postgres schema and keyed uniquely by job ID. The transition into submitting must be an atomic compare-and-set. Persist a provider task ID before polling. A timeout or worker crash after a possible provider POST must transition to unknown, never to an automatic resubmission. Only an explicit reconciliation action with provider-side evidence may move an unknown attempt back to a pollable state.

The existing cloud queue's type filter should be used by a dedicated video worker. The timeline worker must remain restricted to timeline.render; the local SQLite worker must remain restricted to its local workflow/media allowlist. Worker lease recovery must not itself cause a provider POST retry.

## Data model direction

Add server-only Postgres tables in executive_visuals for:
- budget reservations and immutable settlement/release events;
- rolling-window provider usage reservations;
- provider submission attempts (one logical submission per job, immutable task ID once recorded, explicit unknown/quarantine state);
- provider cost observations and reconciliation events.

Use foreign keys to executive_visuals.jobs, projects, and auth.users; enforce owner/project consistency with constraints or triggers. Enable RLS and revoke direct access from public, anon, and authenticated; grant only the minimum required operations to service_role. Do not store provider secrets or raw authorization headers in these records. Keep prompts and provider responses bounded and apply existing data-retention policy.

The existing executive_visuals.jobs table has a different status vocabulary from SQLite (for example, cloud uses processing while local uses running). Keep adapters explicit; do not assume status strings or JSON column names are interchangeable.

## Output ingestion boundary

The provider executor must not treat a provider URL as a trusted asset. Before registering an asset:
- require HTTPS and an exact provider-owned hostname allowlist grounded in provider documentation;
- resolve and reject loopback, private, link-local, multicast, reserved and IPv4-mapped IPv6 destinations;
- disable redirects or revalidate every redirect target and DNS resolution;
- enforce connection, total-time and byte limits while streaming;
- sniff actual media/container content and run FFprobe with resource limits;
- calculate SHA-256 while downloading;
- store bytes in a private bucket under a server-generated object path;
- register an asset tied to the same owner and project, with a derivative relationship to the generation job/source as applicable;
- make ingestion idempotent by job ID, provider task ID and output index;
- clean up orphaned temporary objects on failure without deleting unrelated assets.

Do not use browser-visible provider URLs as permanent asset URLs. Serve registered assets through existing authenticated/authorized asset delivery.

## Migration and rollout gates

1. Implement schema migration and SQL tests in a dedicated development Supabase project or disposable local Postgres; never apply this migration to shared staging or production as part of this PR.
2. Implement transactional enqueue and idempotency RPC tests, including concurrent identical requests and budget exhaustion.
3. Implement atomic submission-state transitions and crash/timeout reconciliation tests.
4. Implement provider output downloader and private asset ingestion tests for unsafe DNS, redirects, content mismatch, oversized responses, timeouts and duplicate outputs.
5. Implement a dedicated cloud video worker that claims only video.generate, renews leases, observes cancellation and polls stored task IDs without resubmitting.
6. Reconcile estimated, reserved and actual provider cost before terminal success; settle or release unused reservations exactly once.
7. Run end-to-end tests with a mock provider and isolated Supabase/storage environment.
8. Keep all providers disabled until operator-controlled credentials, budgets, legal/terms review, provider allowlisting and release approval are complete.

## Consequences

- No silent queue migration or hidden dual-write path.
- Hosted jobs and hosted workers share one transactional source of truth.
- Provider ambiguity is handled conservatively to prevent duplicate paid generation.
- The current isolated SQLite implementation remains useful for unit tests but is not a hosted production path.
- This ADR does not authorize provider activation, migration application, merge or deployment.
## Cloud submission-ledger implementation checkpoint (2026-11-04)

The source-only migration `20261104120000_cloud_video_submission_ledger.sql` and `server/cloud-video-submissions.mjs` add a server-role-only Postgres ledger contract for hosted workers. The ledger is unique per job, checks that provider/model/request hash match the queued `video.generate` input, and supports `prepared → submitting → submitted/unknown → terminal` transitions.

Only the currently leased worker may begin a provider submission, record a task ID, mark an ambiguous attempt unknown, or finish a submission. The task ID is unique and conflicting IDs are rejected. Ambiguous attempts cannot be moved back into `submitting`; reconciliation is a separate explicit operation requiring an evidence reference. A succeeded terminal ledger state requires a recorded provider task ID.

The RPC client uses the `executive_visuals` PostgREST profile, server-only service-role credentials, bounded requests/timeouts, strict response validation and credential redaction. Mock transport tests cover RPC mapping, lease-bound lifecycle calls, malformed responses, invalid inputs, timeout and error redaction.

This is persistence infrastructure only. It is not wired to a cloud video worker or enqueue API, no provider calls are made, and the migration is not applied to any Supabase project. A dedicated worker must inspect the ledger before any provider POST and must never POST for `submitted`, `unknown` or terminal records.

## Cloud budget and enqueue implementation checkpoint (2026-11-04)

The source-only migration `20261104143000_cloud_video_budget_enqueue.sql` adds owner/project/provider/model-scoped budget policies, short-lived explicit per-request approvals, budget reservations, and rolling-24-hour request reservations. Policies default disabled and request limits default to zero. Clients can configure policy limits but cannot insert or update the server-maintained reserved/spent counters or change the policy owner/scope. Per-request approvals are owner-bound, expire within 15 minutes, and are single-use.

`enqueue_video_generation_job` is a service-role-only, invoker-rights RPC. It serializes idempotency and per-owner usage checks, verifies project ownership, checks the enabled policy and matching approval, enforces the per-job and cumulative spend ceilings, then inserts the queued job, budget reservation, usage reservation, audit event and queue event in one Postgres transaction. Identical idempotent replay returns the existing job and reservation without consuming a second approval or budget reservation; conflicting reuse is rejected.

`finish_video_generation_job` is the matching atomic finalizer (rather than a separate budget-settlement RPC). It requires the current unexpired worker lease and commits job terminal status, submission-ledger terminal state, budget release/settlement, and audit/job events in one transaction. Successful/partial completion requires a recorded provider task ID and actual cost not exceeding the reservation; failed/cancelled completion releases the reservation. This avoids a crash window in which a reservation is settled but the still-processing job is automatically requeued.

The server-only client is `server/cloud-video-enqueue.mjs`; mock transport tests are in `server/tests/cloud-video-enqueue.test.mjs`. The cloud migration guard now checks the budget tables, RLS, column-level accounting protections, short-lived approval, serialization, lease fencing and atomic finalization.

This remains source-controlled infrastructure only. No budget policy is created, no approval is issued, no migration is applied, and no worker/API path calls these RPCs. Before worker integration, test this migration against disposable/local PostgreSQL (including concurrent identical enqueues, approval reuse, budget exhaustion, project isolation, worker lease expiry and crash recovery). Provider dispatch and private output ingestion remain disabled release gates.


## Private provider-output ingestion checkpoint (2026-11-04)

`server/private-video-output-ingestion.mjs` adds a reusable ingestion boundary for remote video provider outputs. It requires a deployment-supplied hostname allowlist (there is no permissive default), HTTPS URLs on port 443, bounded URL/output counts and byte budgets, DNS resolution with all returned addresses checked, and a pinned public IP for the TLS request. Private, loopback, link-local, unique-local, multicast, reserved, and mixed public/private DNS answers are rejected. Redirects are not followed; the request carries no provider or Supabase credentials.

Downloads are written to isolated temporary directories with an overall timeout and streaming byte limit. A mandatory media-validation callback (intended to be FFprobe-backed and to inspect actual streams/duration/container) must approve the file before it is passed to the existing cloud asset repository's `createFromFile`, which writes to the private media bucket and registers owner/project-scoped asset metadata. Multi-output ingestion attempts compensating soft-deletion of earlier registered assets if a later output fails and flags `cleanupPending` when compensation cannot complete.

The module is not yet wired to the Runway worker. Deployment must explicitly configure the exact output CDN hostnames observed from the provider contract; do not use broad wildcards without reviewing the provider's redirect/CDN behavior. The production validator must be an actual FFprobe-backed implementation, not a permissive stub. DNS pinning, redirect denial and content validation are defense in depth, not a reason to accept arbitrary user-supplied URLs.


## Cloud video recovery and ambiguous-cost safeguards (2026-11-04)

A finalizer review identified a critical edge case: a provider POST can be accepted even when the client loses the response. Such a job must not be marked failed and have its reserved budget released merely because the worker cannot see a provider task ID. The atomic finalizer now rejects failure/cancellation while the submission ledger is `submitting` or `unknown`, and successful completion requires a known `submitted` task ID.

Three additional service-role-only RPCs preserve this invariant:
- `defer_video_generation_job`: requeues a still-running provider task after a bounded delay, only when a durable provider task ID exists and the budget reservation remains reserved.
- `quarantine_video_generation_job`: moves an ambiguous submission to `needs_input`, clears the worker lease, and preserves the budget reservation for manual reconciliation.
- `resume_reconciled_video_generation_job`: resumes a quarantined job only after the submission ledger has been evidence-reconciled to `submitted` with a provider task ID and the reservation remains active.

The server client and migration guard cover these RPCs. This closes the dangerous automatic-release path, but the worker must still be integrated so it routes poll deferrals to the defer RPC and ambiguous POST outcomes to quarantine—not to the generic job failure finalizer.


## Postgres-backed worker implementation checkpoint (2026-11-04)

The hosted execution path now has separate modules, still not enabled by the process supervisor:

- `server/cloud-video-generation-executor.mjs` uses the Postgres submission ledger rather than the local SQLite ledger. It submits once, resumes a known task ID, defers transient status failures, requires a cost resolver with evidence and enforces the approved amount/currency before private output ingestion.
- `server/cloud-video-worker.mjs` claims only `video.generate` jobs, renews the lease, and routes outcomes to the correct transactional boundary: successful generation to the atomic finalizer, active polling to the defer RPC, ambiguous submissions/cost or ingestion uncertainty to quarantine, and confirmed provider failures to the failure finalizer.
- Quarantined jobs require an evidence reference before operator resume. Cleanup-pending output ingestion is separately surfaced for review.
- The atomic success finalizer now verifies that every output asset ID exists, is active, belongs to the job owner/project, is stored in the private Executive Visuals media bucket, and matches the recorded provider task ID before it marks the job successful or settles the budget.

This is a code foundation, not a live worker activation. The existing cloud process supervisor does not instantiate this worker, and no Runway key, provider allowlist, budget policy, approval, or provider request has been configured. Before connecting it to the supervisor, the new PostgreSQL migration/RPCs must pass isolated database integration tests and the worker must be tested with mock adapters, real FFprobe, private test storage and fault-injection for lease loss and ambiguous RPC responses.


### Idempotent output asset registration

The private asset repository now exposes an owner/project/task/output-index scoped lookup for active generated-video assets. The output ingestor checks this before downloading or registering each provider output, stores the output index in asset metadata, and reuses a matching active asset on retry. Only assets created during the current ingestion attempt are eligible for compensating deletion; previously registered assets are not deleted if a later output fails. This reduces duplicate assets when a worker loses its lease after registration but before the job finalizer commits.


### PostgreSQL migration verification harness (2026-11-04)

A disposable PostgreSQL 16 integration workflow now applies the cloud submission-ledger and budget/enqueue migrations against a minimal Supabase-compatible schema. It verifies the actual SQL parser accepts both migrations, owner-bound approval/RLS behavior, column-level protection of budget counters, atomic enqueue, idempotent replay, one-time approval consumption, submission lifecycle, private-asset ownership checks, atomic job/budget/submission finalization, and rollback when actual cost exceeds the reservation. A separate two-connection test races identical enqueue requests and asserts one job, one budget reservation and one usage reservation are created.

The harness lives in `scripts/cloud-video-postgres-bootstrap.sql`, `scripts/cloud-video-postgres-integration.sql`, `scripts/cloud-video-postgres-concurrency-approval.sql` and `scripts/cloud-video-postgres-concurrency.sh`; workflow: `.github/workflows/cloud-video-postgres.yml`. It uses an ephemeral GitHub Actions PostgreSQL service and does not connect to any Supabase account. It is not a substitute for a later isolated Supabase branch test, but it catches PostgreSQL syntax, privilege, transaction and concurrency defects before any remote migration is considered.

During this review, the static guard was found to have missed malformed dollar quoting in the budget approval trigger. The trigger was corrected, and the guard now explicitly rejects untagged single-dollar PL/pgSQL delimiters. Project-scoped budget approvals are now owner-only; project editors cannot approve provider spend.
