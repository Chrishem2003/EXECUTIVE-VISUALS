# Execution architecture

## Target API
- POST /api/projects
- GET /api/projects/:projectId
- POST /api/projects/:projectId/briefs
- POST /api/projects/:projectId/workflows/validate
- POST /api/projects/:projectId/jobs
- GET /api/jobs/:jobId
- POST /api/jobs/:jobId/cancel
- POST /api/assets/upload-intents
- POST /api/assets/complete
- GET /api/assets/:assetId/download
- POST /api/consents
- GET /api/providers/capabilities
- POST /api/webhooks/:provider

## Orchestration
Authenticate user; resolve workspace permissions; validate graph, inputs, file types, rights and consent; estimate cost and enforce budgets; choose adapter by capability, quality, price, latency, region and licensing; create idempotent job; dispatch; persist provider ID; poll or accept signed webhook; normalize outputs; validate media; checksum and store lineage; record usage and audit; notify client. Retry transient failures only.

## Media infrastructure
Use private object storage, short-lived signed URLs, streaming uploads and checksum verification. Never store media blobs in localStorage. Use FFmpeg or another licensed processing engine for deterministic transcode, trim, concat, audio mix, subtitles, frame extraction and thumbnails. Route AI operations through authorized providers or a user-managed local inference service.

## Consent record
Store subject, scope, permitted operations, proof reference, timestamp, expiry/revocation and verifying actor. Do not store raw identity documents unless essential. A UI toggle alone is not production-grade consent evidence.


## Worker leases and recovery

The local queue uses database-conditional claims so two API processes sharing the same SQLite database cannot both claim the same queued job. A claimed job records its worker ID, lease expiry and heartbeat timestamp. Workers renew leases while work is active. If a process disappears, another worker can recover an expired lease, retry within the bounded attempt count and apply exponential delay before the next attempt.

Cancellation is persisted in the job row. Media workers poll that state while an external process is running, so a cancellation request can stop a process even when the API request reaches a different worker process. The active child is also terminated immediately when the owning worker loses its lease.

This is multi-process coordination on one shared SQLite database and media volume. It is not a multi-host distributed queue: multiple machines require a shared transactional database, shared object storage, and a separately deployed worker service. The cloud SQL migration includes corresponding lease fields but remains unapplied until an isolated staging database is approved.

## Worker lease finalization ordering

The shared cloud worker stops scheduling heartbeats and awaits any in-flight lease renewal before attempting a terminal `succeeded` or `failed` transition. This prevents a renewal RPC that began during execution from racing the finish RPC and producing a misleading lease-lost event after a successful completion. If renewal fails or the lease is no longer owned, the worker does not finalize the job; normal expired-lease recovery remains responsible for reclaiming it. Regression coverage holds a renewal request open while execution returns and verifies that the terminal transition waits for renewal settlement.

## Worker-pool-scoped expired-job recovery

Cloud worker pools must recover only the job types they own. The timeline worker passes its explicit `timeline.render` allowlist, and the media worker passes its explicit media-processing allowlist, to a dedicated `recover_expired_jobs_by_type` RPC. The original all-job `recover_expired_jobs` RPC remains unchanged for general queue administration and existing callers; worker-pool adapters do not call it. The scoped RPC preserves the same bounded attempt count, exponential retry delay, terminal failure and append-only job event behavior while selecting only expired rows whose `job_type` is in the requested allowlist. Its execution is revoked from public/anonymous/authenticated roles and granted only to `service_role`. The migration is staged in source control and has not been applied to any database. The worker supervisor invokes recovery independently for every enabled worker family, rather than recovering only the first registered pool. A failure in one pool's recovery is reported without suppressing recovery attempts for the other pools; recovery counts are logged with the originating worker-family index.


## Worker supervisor shutdown and recovery coordination

The cloud worker supervisor prevents overlapping expired-job recovery passes. It tracks the active recovery operation, skips a scheduled pass while one is already running, and waits for in-flight recovery to settle during shutdown. If shutdown is requested while startup recovery is running, startup does not proceed to worker execution or install polling timers after the stop request. Each worker pool still recovers independently, so one pool's recovery failure does not suppress another pool's attempt.


## Bounded retries for transient cloud job failures

Cloud worker errors are classified using an explicit transient allowlist: queue/storage/media timeouts, selected connection failures, and retryable HTTP statuses (408, 425, 429, 500, 502, 503 and 504). Invalid media, unsupported operations, integrity mismatches, permission failures and other unclassified errors remain terminal. A service-role-only `retry_job` RPC checks the current unexpired worker lease, schedules an exponential delay capped at 60 seconds, respects each job's `max_attempts`, clears the lease and appends a `job.retry_scheduled` or `job.failed` event. The migration is source-controlled only until an isolated staging database is explicitly approved.
