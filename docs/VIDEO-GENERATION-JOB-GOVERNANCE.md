# Governed video-generation job boundary

**Branch:** `feat/runway-video-adapter`  
**Status:** durable enqueue foundation; not connected to HTTP routes or a worker.

## What is implemented

`server/video-generation-jobs.mjs` adds a testable service boundary over the existing `jobs` table. It:

1. Requires an authenticated owner identifier and an explicit project-write authorization callback for project-scoped requests.
2. Normalizes the provider-neutral generation request and requires an explicit provider/model.
3. Resolves the provider against an injected registry and rejects anything not explicitly marked `enabled`.
4. Validates all requested options against declared model capabilities before reserving anything.
5. Requires an explicit approved budget reservation with a durable reservation identifier.
6. Reserves the existing rolling-24-hour remote request allowance.
7. Inserts a `video.generate` job and its reservation references in one SQLite transaction.
8. Supports stable idempotent replay; replays return the original job without making a second budget or usage reservation.
9. Rejects conflicting reuse of an idempotency key.

The budget callback must be synchronous and must write its reservation in the same SQLite transaction/database. An asynchronous or externally side-effecting callback is rejected because it cannot be rolled back atomically with the job.\n\n`server/video-generation-submissions.mjs` adds a durable per-job provider-submission ledger. It enforces one transition from `prepared` to `submitting`, records provider task IDs, and moves timeouts or interrupted submissions to an `unknown` quarantine state. An ambiguous submission cannot be automatically started again; stale in-flight attempts can be moved to `unknown` by the recovery method, after which an operator must verify the provider task and explicitly reconcile it. This is a duplicate-cost safety boundary, not a claim of exactly-once provider execution.

## Deliberate non-claims

`server/video-generation-executor.mjs` now provides an isolated leased-job execution boundary. It starts a provider submission once, persists the task ID, resumes polling on later leased attempts, quarantines ambiguous POST outcomes, and delegates output ingestion to a required injected callback. It does not itself download media or create assets. The callback must be idempotent by job/task ID and must enforce provider-host allowlisting, HTTPS-only downloads with redirects disabled, private-address/DNS protections, byte/time limits, media probing, checksums, private storage and asset registration.\n\nThe executor is not wired into the local worker dispatch or cloud worker supervisor, and no authenticated route queues video jobs. The current provider catalog keeps Runway, Luma, Kling and Gemini disabled, so the production resolver rejects every remote provider by default.

## Remaining integration gates

- Add an authenticated HTTP route that uses the real project authorization and budget-ledger implementation.
- Wire the isolated executor into the existing local worker dispatch and/or a dedicated cloud worker only after confirming the target job database is shared with the enqueue service. Preserve leases, heartbeats, cancellation and retry semantics; the current cloud queue is Supabase-backed while the enqueue ledger is SQLite-backed, so do not connect them without an explicit persistence migration.
- Integrate the submission ledger with a dedicated worker. On process recovery, move stale `submitting` records to `unknown`; never blindly retry a provider POST when acceptance may have occurred. Runway task creation documentation does not advertise an idempotency key or exactly-once guarantee, so ambiguous outcomes require provider-side reconciliation.
- Poll according to provider rate limits; handle provider cancellation and terminal states.
- Download only validated HTTPS provider outputs, enforce byte/time limits, inspect the container with FFprobe, compute SHA-256 and upload to private project storage.
- Create the platform asset record and durable usage/cost ledger event before marking the job succeeded.
- Add acceptance tests for worker crash/recovery, provider timeout, duplicate dispatch, budget exhaustion, output expiry, malformed media and project isolation. Isolated tests now cover one-time submission, stale-attempt quarantine, ambiguous-outcome reconciliation, task-ID persistence, resumed polling, no duplicate POSTs and required output-ingestion injection; worker dispatch and real private-storage ingestion remain outstanding.

No provider is enabled by this change. No production data, credentials, deployments or provider billing are touched.
